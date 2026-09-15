// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// RING vision kernel: turns a fovea frame that integrated one MirrorLink
// revolution into a binary ring, decodes the optical frame on it, and
// back-annotates the result in frame px/radians. Runs INSIDE the vision worker,
// one reader per input role (L/R). Pixel work is plain typed-array math — no
// core/Vision call — so the extraction unit-tests without the native addon.
// spec: docs/spec/ring-code.md#reader

import {
  decodeRing,
  ringHex,
  ringText,
  type RingDecode,
  type RingFieldName,
  type RingReadout,
} from "@lib/ring-code";
import type { Mat } from "core/Vision";
import { makeMat } from "@lib/mat";
import type {
  FrameSet,
  KernelFrameOut,
  KernelOutput,
  VisionKernel,
} from "./vision-kernel.js";

/** Bright-mask level between the frame's dark floor and its peak. */
const DEFAULT_BRIGHT_FRACTION = 0.5;
/** Mask decimation for the fit — the ring is many px wide, full res buys nothing. */
const DECIMATE = 2;
/** Fewer inliers than this is speckle, not a ring. */
const MIN_RING_POINTS = 24;
/** Below this radius (frame px) no chip could be resolved. */
const MIN_RADIUS_PX = 16;
/** Angular-coverage bins and the fraction of them a real ring must occupy. */
const COVERAGE_BINS = 72;
const MIN_COVERAGE = 0.5;
/** Robust re-fits after the algebraic fit, each dropping >3σ radial residuals. */
const ROBUST_REFITS = 2;
const PROFILE_MIN = 512;
const PROFILE_MAX = 4096;
/** COARSE ridge pass: a wide radial band (fraction of the fitted radius, min
 *  px) found at 2 px steps — the real path is an ELLIPSE (mirror-axis gain and
 *  phase never match), so the fitted circle is only a seed.
 */
const RIDGE_COARSE_BAND = 0.35;
const RIDGE_COARSE_MIN_PX = 6;
const COARSE_STEP_PX = 2;
/** FINE pass: the max within this many px of the smoothed track, at 1 px. */
const RIDGE_FINE_PX = 6;
const FINE_STEP_PX = 1;
/** Circular moving-average windows (fraction of the turn) for the radius track
 *  in the coarse pass and in the arc-length resampling. */
const TRACK_WINDOW_DIV = 24;
const ARC_WINDOW_DIV = 36;
/** Envelope window for the local normalization, as a fraction of the turn.
 *  M/24 is the HALF width, so the span covers several chips either side. */
const ENVELOPE_DIV = 24;
/** Floor for the local span, as a fraction of the global p95-p5 span. */
const ENVELOPE_FLOOR = 0.1;
/** A frame the reader consumes — a plain view over interleaved 8-bit pixels. */
export type RingImage = {
  data: Uint8Array;
  width: number;
  height: number;
  /** 4 = BGRA/RGBA (luminance = max channel), 1 = mono. */
  channels: number;
};

export type RingReadOptions = {
  minChipPx?: number;
  minContrast?: number;
  brightFraction?: number;
  /** Also build the debug strip (spec mirror-link.md §ring-views). */
  debug?: boolean;
};

/** One eye's read: the readout, plus the debug strip when it was asked for. */
export type RingRead = {
  readout: RingReadout;
  strip?: { data: Uint8Array; rows: number; width: number };
};

export type RingCircle = { x: number; y: number; r: number };

/** A reader owns its scratch buffers — one per input role, reused every frame
 *  (the hot path allocates only when the profile length grows). */
export interface RingReader {
  read(img: RingImage, opts?: RingReadOptions): RingRead;
}

const luma = (img: RingImage, index: number): number => {
  const p = index * img.channels;
  if (img.channels < 3) return img.data[p];
  const b = img.data[p];
  const g = img.data[p + 1];
  const r = img.data[p + 2];
  return b > g ? (b > r ? b : r) : g > r ? g : r;
};

/** Bilinear luminance at a (possibly fractional) pixel; 0 outside the frame. */
function sample(img: RingImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return 0;
  const fx = x - x0;
  const fy = y - y0;
  const row = y0 * img.width + x0;
  const a = luma(img, row);
  const b = luma(img, row + 1);
  const c = luma(img, row + img.width);
  const d = luma(img, row + img.width + 1);
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

/**
 * Algebraic (Kåsa) circle fit over `count` points: minimizes the ALGEBRAIC
 * residual of `x² + y² = A·x + B·y + C`, a 3×3 normal system. Null when the
 * points are degenerate (collinear / coincident).
 */
function kasaFit(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
): RingCircle | null {
  if (count < 3) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0,
    sz = 0,
    sxz = 0,
    syz = 0;
  for (let i = 0; i < count; i++) {
    const x = xs[i];
    const y = ys[i];
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sz += z;
    sxz += x * z;
    syz += y * z;
  }
  // Normal equations [sxx sxy sx; sxy syy sy; sx sy n] · [A B C]ᵀ = [sxz syz sz]ᵀ
  const m = [
    [sxx, sxy, sx, sxz],
    [sxy, syy, sy, syz],
    [sx, sy, count, sz],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = m[row][col] / m[col][col];
      for (let k = col; k < 4; k++) m[row][k] -= f * m[col][k];
    }
  }
  const A = m[0][3] / m[0][0];
  const B = m[1][3] / m[1][1];
  const C = m[2][3] / m[2][2];
  const cx = A / 2;
  const cy = B / 2;
  const rr = C + cx * cx + cy * cy;
  if (!(rr > 0) || !Number.isFinite(rr)) return null;
  return { x: cx, y: cy, r: Math.sqrt(rr) };
}

/** Occupied fraction of the angular bins around `circle` — a dot occupies a
 *  handful of bins, a ring most of them (spec §reader "Circle fit"). */
function coverage(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  circle: RingCircle,
  bins: Uint8Array,
): number {
  bins.fill(0);
  for (let i = 0; i < count; i++) {
    const a = Math.atan2(ys[i] - circle.y, xs[i] - circle.x);
    const bin = Math.floor(((a + Math.PI) / (2 * Math.PI)) * COVERAGE_BINS);
    bins[Math.min(COVERAGE_BINS - 1, Math.max(0, bin))] = 1;
  }
  let used = 0;
  for (let i = 0; i < COVERAGE_BINS; i++) used += bins[i];
  return used / COVERAGE_BINS;
}

export function createRingReader(): RingReader {
  // Scratch, grown on demand and reused across frames: the hot path allocates
  // only when a bigger ring arrives.
  let xs = new Float64Array(0);
  let ys = new Float64Array(0);
  // Angular-domain buffers (length n).
  let coarseP = new Float32Array(0);
  let coarseR = new Float32Array(0);
  let bandLo = new Float32Array(0);
  let bandHi = new Float32Array(0);
  let track = new Float32Array(0);
  let profile = new Float32Array(0);
  let ridgeR = new Float32Array(0);
  let arcCum = new Float64Array(0);
  /** theta×rho image of the annulus (rows × n), reused across frames. */
  let polar = new Float32Array(0);
  let polarRows = 0;
  /** Radius of polar row 0 (frame px). */
  let polarR0 = 0;
  // Arc-domain buffers (length m).
  let resampled = new Float32Array(0);
  let srcIndex = new Float32Array(0);
  let norm = new Float32Array(0);
  let envHi = new Float32Array(0);
  let envLo = new Float32Array(0);
  let sortBuf = new Float32Array(0);
  let deque = new Int32Array(0);
  const bins = new Uint8Array(COVERAGE_BINS);

  function ensurePoints(n: number): void {
    if (xs.length >= n) return;
    xs = new Float64Array(n);
    ys = new Float64Array(n);
  }

  function ensureBuffers(n: number, rows: number): void {
    if (polar.length < rows * n) polar = new Float32Array(rows * n);
    if (coarseP.length >= n) return;
    coarseP = new Float32Array(n);
    coarseR = new Float32Array(n);
    bandLo = new Float32Array(n);
    bandHi = new Float32Array(n);
    track = new Float32Array(n);
    profile = new Float32Array(n);
    ridgeR = new Float32Array(n);
    arcCum = new Float64Array(n + 1);
    resampled = new Float32Array(n);
    srcIndex = new Float32Array(n);
    norm = new Float32Array(n);
    envHi = new Float32Array(n);
    envLo = new Float32Array(n);
    sortBuf = new Float32Array(n);
    deque = new Int32Array(3 * n + 2);
  }

  function ensureSort(count: number): void {
    if (sortBuf.length < count) sortBuf = new Float32Array(count);
  }

  /** `q`-th percentile of `src[0..n)` (sorts into scratch). */
  function percentile(src: Float32Array, n: number, q: number): number {
    ensureSort(n);
    sortBuf.set(src.subarray(0, n), 0);
    sortBuf.subarray(0, n).sort();
    return sortBuf[Math.floor(q * (n - 1))];
  }

  /** Per angle: the brightest sample over the radial band [lo, hi] and the
   *  radius it sat at — the ring's own track, wherever it actually runs. */
  function bandMax(
    img: RingImage,
    circle: RingCircle,
    n: number,
    lo: Float32Array,
    hi: Float32Array,
    step: number,
    outP: Float32Array,
    outR: Float32Array,
  ): void {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const r0 = lo[i];
      const r1 = hi[i];
      const steps = Math.max(1, Math.ceil((r1 - r0) / step));
      let peak = -1;
      let peakAt = (r0 + r1) / 2;
      for (let k = 0; k <= steps; k++) {
        const rr = r0 + ((r1 - r0) * k) / steps;
        const v = sample(img, circle.x + rr * ca, circle.y + rr * sa);
        if (v > peak) {
          peak = v;
          peakAt = rr;
        }
      }
      outP[i] = peak;
      outR[i] = peakAt;
    }
  }

  /** Bridge a per-angle track across the DARK angles (where the radius is not
   *  measurable) by circular interpolation, then smooth it circularly. */
  function smoothTrack(
    values: Float32Array,
    litOf: (i: number) => boolean,
    n: number,
    windowDiv: number,
    out: Float32Array,
  ): void {
    let lit = 0;
    for (let i = 0; i < n; i++) if (litOf(i)) lit++;
    if (lit < 8) {
      out.set(values.subarray(0, n), 0);
      return;
    }
    // Nearest lit neighbour each way (two circular sweeps), then lerp.
    const prevAt = new Float32Array(n);
    const nextAt = new Float32Array(n);
    let last = -1;
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < n; i++) {
        if (litOf(i)) last = i;
        prevAt[i] = last;
      }
    last = -1;
    for (let pass = 0; pass < 2; pass++)
      for (let i = n - 1; i >= 0; i--) {
        if (litOf(i)) last = i;
        nextAt[i] = last;
      }
    for (let i = 0; i < n; i++) {
      if (litOf(i)) {
        out[i] = values[i];
        continue;
      }
      const p = prevAt[i];
      const q = nextAt[i];
      const dp = (((i - p) % n) + n) % n;
      const dq = (((q - i) % n) + n) % n;
      const w = dp + dq;
      out[i] = w > 0 ? (values[p] * dq + values[q] * dp) / w : values[p];
    }
    // Circular moving average over 2w+1 via a running sum.
    const w = Math.max(4, Math.floor(n / windowDiv));
    const at_ = (i: number) => out[((i % n) + n) % n];
    let sum = 0;
    for (let k = -w; k <= w; k++) sum += at_(k);
    const smoothed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      smoothed[i] = sum / (2 * w + 1);
      sum += at_(i + w + 1) - at_(i - w);
    }
    out.set(smoothed, 0);
  }

  /**
   * POLAR SAMPLING (spec ring-code.md §reader): one bilinear resample of the
   * annulus into a theta×rho image — `rows` radii spanning
   * `[r(1−W), r(1+W)]` at 1 px, `n` angles. Every later stage reads THIS buffer
   * instead of touching the frame again: the coarse lit mask and the ridge track
   * are its per-column argmax, and the fine profile is the per-column max within
   * ±`RIDGE_FINE_PX` of the smoothed track.
   *
   * @returns the angular sample count `n`.
   */
  function ridgeProfile(img: RingImage, circle: RingCircle): number {
    const n = Math.min(
      PROFILE_MAX,
      Math.max(PROFILE_MIN, Math.round(2 * Math.PI * circle.r)),
    );
    const half = Math.max(RIDGE_COARSE_MIN_PX, RIDGE_COARSE_BAND * circle.r);
    const rows = 2 * Math.round(half) + 1;
    ensureBuffers(n, rows);
    polarRows = rows;
    polarR0 = circle.r - half;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let peak = -1;
      let peakRow = 0;
      for (let k = 0; k < rows; k++) {
        const rr = polarR0 + k;
        const v = sample(img, circle.x + rr * ca, circle.y + rr * sa);
        polar[k * n + i] = v;
        if (v > peak) {
          peak = v;
          peakRow = k;
        }
      }
      coarseP[i] = peak;
      coarseR[i] = polarR0 + peakRow;
    }
    const p5 = percentile(coarseP, n, 0.05);
    const p95 = percentile(coarseP, n, 0.95);
    const level = (p5 + p95) / 2;
    smoothTrack(coarseR, (i) => coarseP[i] > level, n, TRACK_WINDOW_DIV, track);
    // FINE profile: the max within ±RIDGE_FINE_PX of the track, read back out
    // of the polar buffer (no second pass over the frame).
    for (let i = 0; i < n; i++) {
      const mid = track[i] - polarR0;
      const lo = Math.max(0, Math.round(mid - RIDGE_FINE_PX));
      const hi = Math.min(rows - 1, Math.round(mid + RIDGE_FINE_PX));
      let peak = -1;
      let peakRow = lo;
      for (let k = lo; k <= hi; k++) {
        const v = polar[k * n + i];
        if (v > peak) {
          peak = v;
          peakRow = k;
        }
      }
      profile[i] = peak;
      ridgeR[i] = polarR0 + peakRow;
    }
    return n;
  }

  /**
   * Resample the angular profile uniformly in ARC LENGTH along the detected
   * ridge (spec §reader): the fitted circle's angle from an off-center point
   * distorts chip arcs by up to ±25 % on an elliptical path; arc length does
   * not. `srcIndex` keeps the arc→angle table so the overlay can be reported
   * back in image angles.
   *
   * @returns the resampled length `m`.
   */
  function resampleByArc(n: number): number {
    const level =
      (percentile(profile, n, 0.05) + percentile(profile, n, 0.95)) / 2;
    smoothTrack(ridgeR, (i) => profile[i] > level, n, ARC_WINDOW_DIV, track);
    const dTheta = (2 * Math.PI) / n;
    arcCum[0] = 0;
    for (let i = 0; i < n; i++) {
      const dr = track[(i + 1) % n] - track[i];
      arcCum[i + 1] = arcCum[i] + Math.hypot(track[i] * dTheta, dr);
    }
    const total = arcCum[n];
    const m = Math.max(16, Math.min(n, Math.round(total)));
    let cursor = 0;
    for (let k = 0; k < m; k++) {
      const target = (k * total) / m;
      while (cursor < n - 1 && arcCum[cursor + 1] <= target) cursor++;
      const span = arcCum[cursor + 1] - arcCum[cursor];
      const frac = span > 0 ? (target - arcCum[cursor]) / span : 0;
      const src = cursor + frac;
      srcIndex[k] = src;
      const i0 = Math.floor(src);
      const f = src - i0;
      resampled[k] = profile[i0 % n] * (1 - f) + profile[(i0 + 1) % n] * f;
    }
    return m;
  }

  /** Local envelope normalization (spec §reader): brightness varies around the
   *  turn — vignetting, angular speed, the mirror's own roll-off — so the
   *  threshold has to be local. */
  function normalizeEnvelope(m: number): void {
    const w = Math.max(8, Math.floor(m / ENVELOPE_DIV));
    slidingExtreme(resampled, m, w, envHi, true);
    slidingExtreme(resampled, m, w, envLo, false);
    const p5 = percentile(resampled, m, 0.05);
    const p95 = percentile(resampled, m, 0.95);
    const floor = ENVELOPE_FLOOR * Math.max(p95 - p5, 1e-9);
    for (let i = 0; i < m; i++) {
      const v =
        (resampled[i] - envLo[i]) / Math.max(envHi[i] - envLo[i], floor);
      norm[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  /** Circular sliding min/max over ±`half`, monotonic-deque so the envelope
   *  costs one pass regardless of the window width. */
  function slidingExtreme(
    src: Float32Array,
    n: number,
    half: number,
    out: Float32Array,
    isMax: boolean,
  ): void {
    const val = (j: number) => src[((j % n) + n) % n];
    let head = 0;
    let tail = 0;
    for (let j = -half; j < n + half; j++) {
      const v = val(j);
      while (
        tail > head &&
        (isMax ? val(deque[tail - 1]) <= v : val(deque[tail - 1]) >= v)
      )
        tail--;
      deque[tail++] = j;
      const i = j - half;
      while (deque[head] < j - 2 * half) head++;
      if (i >= 0 && i < n) out[i] = val(deque[head]);
    }
  }

  /** Arc-domain sample index → image angle (radians), through the resampling
   *  table — the overlay is drawn in the frame, not in arc space. */
  function angleAt(index: number, m: number, n: number): number {
    const i = ((index % m) + m) % m;
    const i0 = Math.floor(i);
    const f = i - i0;
    const a = srcIndex[i0];
    let b = srcIndex[(i0 + 1) % m];
    if (b < a) b += n; // the table wraps once per turn
    return (2 * Math.PI * (a + (b - a) * f)) / n;
  }

  /** Bright mask on the decimated frame → the fitted circle in FULL-res px. */
  function fitCircle(
    img: RingImage,
    brightFraction: number,
  ): RingCircle | null {
    const dw = Math.floor(img.width / DECIMATE);
    const dh = Math.floor(img.height / DECIMATE);
    if (dw < 3 || dh < 3) return null;
    let dark = Infinity;
    let peak = -Infinity;
    for (let y = 0; y < dh; y++) {
      const row = y * DECIMATE * img.width;
      for (let x = 0; x < dw; x++) {
        const v = luma(img, row + x * DECIMATE);
        if (v < dark) dark = v;
        if (v > peak) peak = v;
      }
    }
    if (peak <= dark) return null;
    const level = dark + brightFraction * (peak - dark);
    ensurePoints(dw * dh);
    let count = 0;
    for (let y = 0; y < dh; y++) {
      const row = y * DECIMATE * img.width;
      for (let x = 0; x < dw; x++)
        if (luma(img, row + x * DECIMATE) >= level) {
          xs[count] = x;
          ys[count] = y;
          count++;
        }
    }
    if (count < MIN_RING_POINTS) return null;
    let circle = kasaFit(xs, ys, count);
    if (!circle) return null;
    for (let pass = 0; pass < ROBUST_REFITS; pass++) {
      let mean = 0;
      for (let i = 0; i < count; i++)
        mean += Math.hypot(xs[i] - circle.x, ys[i] - circle.y);
      mean /= count;
      let varSum = 0;
      for (let i = 0; i < count; i++) {
        const d = Math.hypot(xs[i] - circle.x, ys[i] - circle.y) - mean;
        varSum += d * d;
      }
      const sigma = Math.sqrt(varSum / count);
      if (!(sigma > 0)) break;
      let kept = 0;
      for (let i = 0; i < count; i++) {
        const d = Math.abs(
          Math.hypot(xs[i] - circle.x, ys[i] - circle.y) - circle.r,
        );
        if (d <= 3 * sigma) {
          xs[kept] = xs[i];
          ys[kept] = ys[i];
          kept++;
        }
      }
      if (kept < MIN_RING_POINTS) return null;
      count = kept;
      const next = kasaFit(xs, ys, count);
      if (!next) return null;
      circle = next;
    }
    if (coverage(xs, ys, count, circle, bins) < MIN_COVERAGE) return null;
    const full = {
      x: circle.x * DECIMATE,
      y: circle.y * DECIMATE,
      r: circle.r * DECIMATE,
    };
    if (!(full.r >= MIN_RADIUS_PX)) return null;
    if (!Number.isFinite(full.x) || !Number.isFinite(full.y)) return null;
    return full;
  }

  /**
   * DEBUG STRIP (spec mirror-link.md §ring-views): one mono8 image per eye that
   * shows every stage of the read at once. Width is the ANGULAR sample count
   * `n`; the arc-domain rows are mapped back through the same arc→angle table
   * the overlay uses, so every row lines up column-for-column with the polar
   * image above it. Rows, top to bottom:
   *
   *   [0 .. polarRows)  the polar image, normalized to the buffer's p1/p99
   *   [polarRows]       the envelope-normalized profile (0..255)
   *   [polarRows + 1]   the binary ring (0 / 255)
   *   [polarRows + 2]   segmentation: 0 none · 64 byte edge · 128 field edge ·
   *                     192 leader span · 255 data start
   *
   * A FRESH buffer per call: the worker TRANSFERS emitted frames, which would
   * neuter a reused scratch array.
   */
  function buildStrip(
    n: number,
    m: number,
    decoded: RingDecode,
  ): { data: Uint8Array; rows: number } {
    const rows = polarRows + 3;
    const out = new Uint8Array(rows * n);
    // Polar image, globally normalized (p1/p99 of the buffer itself).
    const count = polarRows * n;
    ensureSort(count);
    sortBuf.set(polar.subarray(0, count), 0);
    sortBuf.subarray(0, count).sort();
    const lo = sortBuf[Math.floor(0.01 * (count - 1))];
    const hi = sortBuf[Math.floor(0.99 * (count - 1))];
    const span = Math.max(1e-6, hi - lo);
    for (let k = 0; k < count; k++) {
      const v = ((polar[k] - lo) / span) * 255;
      out[k] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    // Arc-domain rows, scattered back to their angular column (a column no arc
    // sample lands on keeps the previous one — the two lengths differ by <1 %).
    const profRow = polarRows * n;
    const binRow = profRow + n;
    const segRow = binRow + n;
    let lastCol = 0;
    for (let k = 0; k < m; k++) {
      const col = Math.min(n - 1, Math.max(0, Math.round(srcIndex[k])));
      const v = Math.round(norm[k] * 255);
      for (let c = lastCol; c <= col; c++) {
        out[profRow + c] = v;
        out[binRow + c] = norm[k] >= 0.5 ? 255 : 0;
      }
      lastCol = col + 1;
    }
    if (decoded.ok) {
      const mark = (arcIndex: number, value: number): void => {
        const k = Math.min(m - 1, Math.max(0, Math.round(arcIndex)));
        const col = Math.min(n - 1, Math.max(0, Math.round(srcIndex[k])));
        out[segRow + col] = value;
      };
      // The leader span first, so the field/byte edges paint over it.
      const from = Math.round(decoded.leaderStart);
      const to = Math.round(decoded.dataStart);
      const steps = Math.abs(to - from);
      for (let i = 0; i <= steps; i++)
        mark(from + Math.sign(to - from) * i, 192);
      for (const e of decoded.fieldEdges)
        mark(e.at, e.name === "byte" ? 64 : 128);
      mark(decoded.dataStart, 255);
    }
    return { data: out, rows };
  }

  /** Peak deviation of the SMOOTHED ridge track from the fitted circle (frame
   *  px) — how far the real path departs from a circle. The raw per-angle peak
   *  is meaningless across the dark stretches; the track is interpolated. */
  function ridgeDeviation(n: number, r: number): number {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(track[i] - r);
      if (d > worst) worst = d;
    }
    return worst;
  }

  return {
    read(img, opts = {}): RingRead {
      const circle = fitCircle(
        img,
        opts.brightFraction ?? DEFAULT_BRIGHT_FRACTION,
      );
      if (!circle)
        return { readout: { ok: false, reason: "no ring", circle: null } };
      const n = ridgeProfile(img, circle);
      const m = resampleByArc(n);
      normalizeEnvelope(m);
      const ridgePx = ridgeDeviation(n, circle.r);
      const decoded = decodeRing(norm.subarray(0, m), {
        minChipPx: opts.minChipPx,
        minContrast: opts.minContrast,
      });
      const strip = opts.debug
        ? { ...buildStrip(n, m, decoded), width: n }
        : undefined;
      const stripMeta = strip
        ? { polarRows, width: strip.width, rows: strip.rows }
        : undefined;
      if (!decoded.ok)
        return {
          readout: {
            ok: false,
            reason: decoded.reason,
            bitIndex: decoded.bitIndex,
            contrast: decoded.contrast,
            chipPx: decoded.chipPx,
            ridgePx,
            circle,
            strip: stripMeta,
          },
          strip,
        };
      const angle = (i: number): number => angleAt(i, m, n);
      const dividers: { name: RingFieldName; angle: number }[] =
        decoded.fieldEdges.map((e) => ({ name: e.name, angle: angle(e.at) }));
      return {
        readout: {
          ok: true,
          text: ringText(decoded.data),
          hex: ringHex(decoded.data),
          circle,
          chipPx: decoded.chipPx,
          reverse: decoded.reverse,
          ridgePx,
          leaderArc: {
            from: angle(decoded.leaderStart),
            to: angle(decoded.dataStart),
          },
          dividers,
          strip: stripMeta,
        },
        strip,
      };
    },
  };
}

/** Kernel params (`kind: "ring"`). Disabled = no pixel work at all. */
export type RingParams = {
  kind?: "ring";
  enabled?: boolean;
  minChipPx?: number;
  brightFraction?: number;
  /** Emit the per-eye debug strip (`strip-<role>`) — only while a histogram
   *  view is actually on screen (spec mirror-link.md §ring-views). */
  debug?: boolean;
};

/** Worker→main values: one readout per input role that produced a frame. */
export type RingValues = Partial<Record<string, RingReadout>>;

/** The `ring` kernel: one reader per role, decoding every arriving fovea frame
 *  while the scan is running. */
export function createRingKernel(
  initial: Record<string, unknown>,
): VisionKernel {
  const p: Required<Omit<RingParams, "kind">> = {
    enabled: false,
    minChipPx: 0,
    brightFraction: DEFAULT_BRIGHT_FRACTION,
    debug: false,
  };
  const readers = new Map<string, RingReader>();

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as RingParams;
      if (d.enabled !== undefined) p.enabled = d.enabled;
      if (d.minChipPx !== undefined) p.minChipPx = d.minChipPx;
      if (d.brightFraction !== undefined) p.brightFraction = d.brightFraction;
      if (d.debug !== undefined) p.debug = d.debug;
    },

    process(frames: FrameSet): KernelOutput {
      if (!p.enabled) return null;
      const values: RingValues = {};
      const out: KernelFrameOut[] = [];
      let any = false;
      for (const [role, frame] of Object.entries(frames)) {
        if (!frame) continue;
        let reader = readers.get(role);
        if (!reader) readers.set(role, (reader = createRingReader()));
        const mat = frame.mat as Mat<Uint8Array>;
        const read = reader.read(
          {
            data: mat,
            width: mat.shape[1] ?? 0,
            height: mat.shape[0] ?? 0,
            channels: mat.channels,
          },
          {
            minChipPx: p.minChipPx > 0 ? p.minChipPx : undefined,
            brightFraction: p.brightFraction,
            debug: p.debug,
          },
        );
        values[role] = read.readout;
        if (read.strip)
          out.push({
            name: `strip-${role}`,
            mat: makeMat(read.strip.data, [read.strip.rows, read.strip.width], 1),
          });
        any = true;
      }
      if (!any) return null;
      return { values: values as Record<string, unknown>, frames: out };
    },

    dispose(): void {
      readers.clear();
    },
  };

  kernel.setParams(initial);
  return kernel;
}
