#!/usr/bin/env python3
"""Offline ring-code analyzer for captured MirrorLink fovea frames.

    python3 scripts/ring-debug.py <left-fovea.png|tiff> [--plot out.png]
    python3 scripts/ring-debug.py --selftest      # synthetic ellipse / gradient / blur cases

Self-contained REFERENCE of the reader pipeline in docs/spec/ring-code.md §reader
(two-pass ridge, arc-length resampling, envelope normalization, run-length leader
candidates, joint template+phase bit decisions, regression period tracking,
length-driven termination). Prints every stage so a failing frame explains itself.
Needs numpy (+ Pillow to open images, matplotlib for --plot).
"""
import sys, json
import numpy as np

# ---------------------------------------------------------------- codec (spec §frame)
GAP = [0, 0, 0]
LEADER = [1, 1, 1, 1, 0, 1, 1, 0]
LEADER_ON = 4


def crc8(bits):
    """CRC-8 poly 0x07, init 0, MSB-first over bits; returns the 8 CRC bits."""
    reg = 0
    for b in bits:
        fb = ((reg >> 7) & 1) ^ b
        reg = ((reg << 1) & 0xFF) ^ (0x07 if fb else 0)
    return [(reg >> i) & 1 for i in range(7, -1, -1)]


def to_bits(value, n):
    return [(value >> i) & 1 for i in range(n - 1, -1, -1)]


def manchester(bits):
    return [c for b in bits for c in ((1, 0) if b else (0, 1))]


def encode(data: bytes):
    """One frame: [GAP][LEADER][Manchester(LEN | DATA | CRC8)]."""
    payload = to_bits(len(data), 8) + [b for x in data for b in to_bits(x, 8)]
    return GAP + LEADER + manchester(payload + crc8(payload))


# ---------------------------------------------------------------- image -> ring
def luminance(img):
    a = np.asarray(img)
    if a.ndim == 3:
        a = a[..., :3].max(axis=2)
    return a.astype(np.float64)

def fit_circle(lum, bright_fraction=0.5, refits=2):
    """Bright mask on a 2x decimated copy, Kasa fit, robust 3-sigma refits."""
    d = lum[::2, ::2]
    lo, hi = d.min(), d.max()
    if hi <= lo:
        return None, "flat frame"
    ys, xs = np.nonzero(d >= lo + bright_fraction * (hi - lo))
    xs, ys = xs.astype(float), ys.astype(float)
    if len(xs) < 24:
        return None, "too few bright px"
    def kasa(x, y):
        A = np.column_stack([x, y, np.ones_like(x)])
        b = x * x + y * y
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        cx, cy = sol[0] / 2, sol[1] / 2
        rr = sol[2] + cx * cx + cy * cy
        return (cx, cy, np.sqrt(rr)) if rr > 0 else None
    c = kasa(xs, ys)
    for _ in range(refits):
        if c is None:
            return None, "degenerate fit"
        dist = np.hypot(xs - c[0], ys - c[1])
        sig = dist.std()
        keep = np.abs(dist - c[2]) <= 3 * sig if sig > 0 else np.ones_like(dist, bool)
        xs, ys = xs[keep], ys[keep]
        if len(xs) < 24:
            return None, "too few inliers"
        c = kasa(xs, ys)
    ang = np.arctan2(ys - c[1], xs - c[0])
    cover = len(np.unique(np.floor((ang + np.pi) / (2 * np.pi) * 72))) / 72
    if cover < 0.5:
        return None, f"angular coverage {cover:.2f} < 0.5 (a dot, not a ring)"
    return (c[0] * 2, c[1] * 2, c[2] * 2), None

def bilinear(lum, x, y):
    h, w = lum.shape
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    ok = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < w) & (y0 + 1 < h)
    x0c = np.clip(x0, 0, w - 2); y0c = np.clip(y0, 0, h - 2)
    fx = x - x0c; fy = y - y0c
    v = (lum[y0c, x0c] * (1 - fx) * (1 - fy) + lum[y0c, x0c + 1] * fx * (1 - fy)
         + lum[y0c + 1, x0c] * (1 - fx) * fy + lum[y0c + 1, x0c + 1] * fx * fy)
    return np.where(ok, v, 0.0)

def _band_max(lum, cx, cy, theta, r_lo, r_hi, step):
    """Per angle: max intensity over radii [r_lo, r_hi] (arrays per angle)."""
    k = int(np.ceil((r_hi - r_lo).max() / step)) + 1
    frac = np.linspace(0, 1, k)[:, None]
    radii = r_lo[None, :] + frac * (r_hi - r_lo)[None, :]        # (k, n)
    X = cx + radii * np.cos(theta)[None, :]; Y = cy + radii * np.sin(theta)[None, :]
    samples = bilinear(lum, X, Y)
    j = samples.argmax(axis=0)
    return samples.max(axis=0), radii[j, np.arange(len(theta))]

def _smooth_track(values, lit, n, window_div=24):
    """Circular interpolation of a per-angle track across dark angles, then a
    circular moving average — the ring's radius is only measurable where lit."""
    idx = np.arange(n)
    if lit.sum() < 8:
        return values
    v = np.interp(idx, idx[lit], values[lit], period=n)
    w = max(4, n // window_div)
    kern = np.ones(2 * w + 1) / (2 * w + 1)
    return np.convolve(np.concatenate([v[-w:], v, v[:w]]), kern, mode="valid")

def ridge_profile(lum, circle, coarse_band=0.35, fine_band_px=6.0):
    """Two-pass ridge: a WIDE coarse band finds the ring's radius at every lit
    angle (any smooth closed path — ellipse, distortion — not just a circle);
    that track is smoothed, then a NARROW fine pass samples the max around it.
    Returns (profile, ridge_r)."""
    cx, cy, r = circle
    n = int(np.clip(round(2 * np.pi * r), 512, 4096))
    theta = 2 * np.pi * np.arange(n) / n
    half = max(6.0, coarse_band * r)
    p_c, r_c = _band_max(lum, cx, cy, theta, np.full(n, r - half), np.full(n, r + half), 2.0)
    p5, p95 = np.percentile(p_c, [5, 95])
    lit = p_c > (p5 + p95) / 2
    track = _smooth_track(r_c, lit, n)
    p_f, r_f = _band_max(lum, cx, cy, theta, track - fine_band_px, track + fine_band_px, 1.0)
    return p_f, r_f

def resample_by_arc(profile, ridge_r, circle):
    """Resample the angular profile uniformly in ARC LENGTH along the detected
    ridge: the fitted circle's angle from an off-center point distorts chip arcs
    by up to +-25 % on an elliptical path; arc length along the ridge does not.
    Ridge radii are only meaningful where the ring is lit, so dark stretches are
    bridged by circular interpolation and the radius track is smoothed."""
    n = len(profile)
    p5, p95 = np.percentile(profile, [5, 95])
    lit = profile > (p5 + p95) / 2
    if lit.sum() < 8:
        return profile, np.ones(n)
    idx = np.arange(n)
    r = np.interp(idx, idx[lit], ridge_r[lit], period=n)
    w = max(4, n // 36)
    kern = np.ones(2 * w + 1) / (2 * w + 1)
    r = np.convolve(np.concatenate([r[-w:], r, r[:w]]), kern, mode="valid")
    dtheta = 2 * np.pi / n
    ds = np.hypot(r * dtheta, np.diff(np.concatenate([r, r[:1]])))
    s_cum = np.concatenate([[0], np.cumsum(ds)])            # arc length at each sample edge
    total = s_cum[-1]
    m = int(round(total))
    target = np.arange(m) * total / m
    src = np.interp(target, s_cum[:-1], idx)               # fractional source index per new sample
    out = np.interp(src, np.arange(n + 1), np.concatenate([profile, profile[:1]]))
    return out, ds

def normalize(profile, window_div=24, floor_frac=0.1):
    """Local envelope normalization: (p - runmin) / (runmax - runmin), circular."""
    n = len(profile)
    w = max(8, n // window_div)
    ext = np.concatenate([profile[-w:], profile, profile[:w]])
    from numpy.lib.stride_tricks import sliding_window_view
    win = sliding_window_view(ext, 2 * w + 1)
    rmax = win.max(axis=1); rmin = win.min(axis=1)
    p5, p95 = np.percentile(profile, [5, 95])
    floor = floor_frac * max(p95 - p5, 1e-9)
    return np.clip((profile - rmin) / np.maximum(rmax - rmin, floor), 0, 1)

# ---------------------------------------------------------------- decode
def median3(b):
    return np.median(np.stack([np.roll(b, 1), b, np.roll(b, -1)]), axis=0).astype(int)

def runs(b):
    n = len(b)
    start = next((i for i in range(1, n) if b[i] != b[i - 1]), None)
    if start is None:
        return []
    out, i = [], start
    while True:
        j = i
        while b[(j + 1) % n] == b[i]:
            j += 1
        out.append((int(b[i]), i % n, j - i + 1)); i = (j + 1) % n
        if i == start:
            return out

def leader_candidates(b):
    """Every (data_start, spc) whose RUN-LENGTH structure matches
    [OFF 3..5.5][ON 4][OFF ~1][ON ~2][OFF >=0.5] in units of the burst/4.
    Run lengths, not point samples: a 2-chip ON run read at half scale is
    followed by a 2-chip OFF (= 4 half-chips), which fails the ~1 rule."""
    rl = runs(b); n = len(b); m = len(rl)
    for k, (v, s, ln) in enumerate(rl):
        if v != 1 or m < 5:
            continue
        spc = ln / LEADER_ON
        gap, off1, on2, off2 = rl[k - 1][2], rl[(k + 1) % m][2], rl[(k + 2) % m][2], rl[(k + 3) % m][2]
        if not (2.5 * spc <= gap <= 5.5 * spc):
            continue
        if not (0.5 * spc <= off1 <= 1.5 * spc and 1.5 * spc <= on2 <= 2.5 * spc and off2 >= 0.5 * spc):
            continue
        spc5 = ((rl[(k + 2) % m][1] - s) % n) / 5
        spc = (spc + spc5) / 2
        yield s + 8 * spc, spc

def mean_circ(a, start, stop):
    n = len(a); i0 = int(round(start)); i1 = int(round(stop))
    if i1 <= i0:
        return float(a[i0 % n])
    idx = np.arange(i0, i1) % n
    return float(a[idx].mean())

def decode_norm(norm, min_chip=0.0, contrast=0.15, trace=None):
    """Decode from the NORMALIZED profile: leader on the binary, bits by
    half-chip integration, mid-bit edge re-anchoring, tracked chip period."""
    n = len(norm)
    binary = median3((norm >= 0.5).astype(int))
    best = dict(ok=False, reason="no leader", progress=-1)
    def fail(**kw):
        nonlocal best
        if kw.get("progress", 0) > best.get("progress", -1):
            best = dict(ok=False, **kw)
    for reverse in (False, True):
      b = binary[::-1] if reverse else binary
      p = norm[::-1] if reverse else norm
      for pos, spc in leader_candidates(b):
        if spc < min_chip:
            fail(reason=f"below resolution ({spc:.1f} px/chip)", progress=0); continue
        bits, edges, bad = [], [], None            # edges: (chip index of mid-bit edge, sample pos)
        total = None                                # bit count once LEN is known
        while True:
            if total is not None and len(bits) == total:
                # length-driven end: confirm the terminating gap (3 dark chips)
                if mean_circ(p, pos, pos + 3 * spc) > 0.35:
                    bad = dict(reason="no terminating gap", progress=len(bits), spc=spc, reverse=reverse)
                break
            # joint bit decision + phase resync: try both Manchester templates
            # over a range of phase offsets, keep the best-contrast alignment
            best_d, A, B = 0.0, 0.0, 0.0
            for d in np.linspace(-0.35 * spc, 0.35 * spc, 9):
                a_ = mean_circ(p, pos + d, pos + d + spc); b_ = mean_circ(p, pos + d + spc, pos + d + 2 * spc)
                if abs(a_ - b_) > abs(A - B):
                    best_d, A, B = d, a_, b_
            if abs(A - B) < contrast:
                bad = dict(reason="low contrast", bit=len(bits), contrast=abs(A - B), spc=spc,
                           reverse=reverse, progress=len(bits)); break
            bit = 1 if A > B else 0
            bits.append(bit)
            if len(bits) == 8:
                L = int("".join(map(str, bits)), 2)
                expected = n / (11 + 16 * (L + 2))
                if abs(spc - expected) > 0.35 * expected:
                    bad = dict(reason=f"chip period {spc:.1f} inconsistent with LEN {L} (expects {expected:.1f})",
                               spc=spc, reverse=reverse, progress=8); break
                total = 16 + 8 * L
            edge = pos + best_d + spc                          # this bit's mid-bit edge
            edges.append((2 * len(bits) - 1, edge))            # edge sits 1 chip into bit k -> chip 2k+1
            if len(edges) >= 3:
                # local chip period = slope of edge position vs chip index over the last 8 edges
                k = np.array([e[0] for e in edges[-8:]], float); x = np.array([e[1] for e in edges[-8:]])
                slope = np.polyfit(k, x, 1)[0]
                if 0.6 * spc < slope < 1.4 * spc:
                    spc = slope
            pos = edge + spc
            if trace is not None:
                trace.append((len(bits) - 1, bit, A, B, spc))
        if bad:
            fail(**bad); continue
        if len(bits) < 16:
            fail(reason="truncated", bits=len(bits), progress=len(bits)); continue
        L = int("".join(map(str, bits[:8])), 2)
        if len(bits) != 16 + 8 * L:
            fail(reason=f"length mismatch (LEN {L}, {(len(bits)-16)//8} bytes read)", spc=spc,
                 reverse=reverse, progress=len(bits)); continue
        payload, tail = bits[:-8], bits[-8:]
        if crc8(payload) != tail:
            fail(reason="crc mismatch", spc=spc, reverse=reverse, progress=len(bits) + 1); continue
        data = bytes(int("".join(map(str, payload[8 + 8 * i:16 + 8 * i])), 2) for i in range(L))
        return dict(ok=True, data=data, spc=spc, reverse=reverse)
    return best

def analyze(lum, min_chip=0.0, verbose=True):
    circle, why = fit_circle(lum)
    if circle is None:
        return dict(ok=False, reason=f"no ring: {why}")
    prof0, ridge = ridge_profile(lum, circle)
    prof, ds = resample_by_arc(prof0, ridge, circle)
    norm = normalize(prof)
    trace = []
    res = decode_norm(norm, min_chip, trace=trace)
    res.update(circle=circle, n=len(prof), arc_speed_var=float(ds.max() / ds.min()),
               ridge_dev=float(np.abs(ridge - circle[2]).max()),
               contrast_p5_p95=(float(np.percentile(prof, 5)), float(np.percentile(prof, 95))))
    if verbose:
        cx, cy, r = circle
        print(f"circle: ({cx:.1f}, {cy:.1f}) r={r:.1f}  arc samples n={len(prof)}  "
              f"angle->arc speed ratio max/min {res['arc_speed_var']:.2f}  "
              f"raw p5/p95={res['contrast_p5_p95'][0]:.0f}/{res['contrast_p5_p95'][1]:.0f}")
        if res["ok"]:
            print(f"DECODED {res['data']!r}  chip={res['spc']:.2f} px  "
                  f"{'reversed' if res['reverse'] else 'forward'}  bits={len(trace)}")
        else:
            print(f"FAILED: {res['reason']}", {k: v for k, v in res.items() if k in ('bit', 'contrast', 'spc')})
        if trace:
            worst = min(trace, key=lambda t: abs(t[2] - t[3]))
            print(f"weakest bit #{worst[0]}: A={worst[2]:.2f} B={worst[3]:.2f}  "
                  f"chip period drifted {trace[0][4]:.2f} -> {trace[-1][4]:.2f} px")
    return res

# ---------------------------------------------------------------- synthetic stress
def synth(text, W=720, r=240, ecc=0.06, phase_deg=20, grad=0.4, sigma=3.2, spc_target=None, seed=0):
    """Elliptical path (axis mismatch + axis phase), brightness gradient, Gaussian dot."""
    chips = encode(text.encode())
    n = len(chips) * (spc_target or 6)
    t = 2 * np.pi * np.arange(n) / n
    px = W / 2 + r * np.cos(t); py = W / 2 + r * (1 - ecc) * np.sin(t + np.radians(phase_deg))
    yy, xx = np.mgrid[0:W, 0:W]
    img = np.zeros((W, W))
    on = np.array([chips[int(i / n * len(chips))] for i in range(n)], bool)
    weight = grad + (1 - grad) * (0.5 + 0.5 * np.cos(t))     # brightness varies around the ring
    for i in np.nonzero(on)[0]:
        img += weight[i] * np.exp(-((xx - px[i]) ** 2 + (yy - py[i]) ** 2) / (2 * sigma ** 2))
    img = np.clip(img / img.max() * 1.4, 0, 1) * 4095
    img += np.random.default_rng(seed).normal(60, 25, img.shape)
    return np.clip(img, 0, 4095)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        for label, kw in [("circle, flat", dict(ecc=0, phase_deg=0, grad=1.0)),
                          ("mild ellipse 6% gain + 3deg phase", dict(ecc=0.06, phase_deg=3)),
                          ("mild ellipse + gradient x0.4", dict(ecc=0.06, phase_deg=3, grad=0.4)),
                          ("mild ellipse + gradient + fat dot", dict(ecc=0.06, phase_deg=3, grad=0.4, sigma=4.5)),
                          ("HARSH: 20deg axis phase (1.5:1 axes)", dict()),
                          ("HARSH + gradient + fat dot", dict(sigma=4.5)),
                          ("chips merged (dot 2x chip)", dict(sigma=9))]:
            print(f"\n== {label}")
            analyze(synth("Hello", **kw), min_chip=6)
        sys.exit(0)
    from PIL import Image
    path = sys.argv[1]
    img = Image.open(path)
    lum = luminance(np.array(img))
    print(f"{path}: {lum.shape[1]}x{lum.shape[0]} max={lum.max():.0f}")
    res = analyze(lum)
    meta = path.rsplit(".", 1)[0] + ".json"
    try:
        m = json.load(open(meta))
        ml = m.get("mirror_link") or {}
        print("meta:", json.dumps({k: ml.get(k) for k in ("scan", "ring") if k in ml})[:400])
    except FileNotFoundError:
        pass
    if "--plot" in sys.argv:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        circle, _ = fit_circle(lum); p0, rr = ridge_profile(lum, circle); prof, _ = resample_by_arc(p0, rr, circle); norm = normalize(prof)
        fig, ax = plt.subplots(2, 1, figsize=(12, 6))
        ax[0].plot(prof); ax[0].set_title("ridge profile (raw)")
        ax[1].plot(norm); ax[1].axhline(0.5, color="r", lw=0.5); ax[1].set_title("normalized")
        fig.savefig(sys.argv[sys.argv.index("--plot") + 1], dpi=110, bbox_inches="tight")
