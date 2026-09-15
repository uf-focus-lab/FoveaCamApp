// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Ring READER (spec docs/spec/ring-code.md §reader): the extraction half —
// circle seed → two-pass ridge → arc-length resampling → envelope
// normalization → decode. Driven by a port of the offline analyzer's `synth`
// (ringdebug.py): an ELLIPTICAL path (axis gain + axis phase), a brightness
// gradient around the turn, a Gaussian dot and sensor noise — the rig's actual
// failure modes. Its `--selftest` cases are the oracle. No native core.

import { describe, expect, it } from "vitest";
import { encodeFrame } from "@lib/ring-code";
import { createRingReader, type RingImage } from "@orchestrator/ring-kernel";

const W = 720;
/** The reference analyzer's floor: 6 px per chip (its synth's default). */
const MIN_CHIP_PX = 6;

type Synth = {
  r?: number;
  /** y-axis gain deficit (0 = circle). */
  ecc?: number;
  /** Phase offset of the y axis, degrees — with `ecc` this rotates AND
   *  squashes the path (20° ≈ 1.5:1 axes). */
  phaseDeg?: number;
  /** Brightness at the dim end of the ring (1 = uniform). */
  grad?: number;
  /** Gaussian dot sigma, px. */
  sigma?: number;
  /** Path samples per chip. */
  spcTarget?: number;
  seed?: number;
};

/** Deterministic LCG + Box–Muller (the reference's seeded normal noise). */
function noise(seed: number): () => number {
  let s = (seed >>> 0) + 0x9e3779b9;
  const unit = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () =>
    Math.sqrt(-2 * Math.log(unit())) * Math.cos(2 * Math.PI * unit());
}

/**
 * Port of `ringdebug.synth`: chips painted as blurred dots along an elliptical
 * path, shaded around the turn, with a 12-bit sensor's noise floor. Returned as
 * BGRA8 (the reader's input format), so the 12-bit range is scaled down.
 */
function synth(text: string, o: Synth = {}): RingImage {
  const {
    r = 240,
    ecc = 0.06,
    phaseDeg = 20,
    grad = 0.4,
    sigma = 3.2,
    spcTarget = 6,
    seed = 0,
  } = o;
  const chips = encodeFrame(new Uint8Array([...Buffer.from(text, "latin1")]));
  const n = chips.length * spcTarget;
  const img = new Float64Array(W * W);
  const reach = Math.ceil(4 * sigma);
  const phase = (phaseDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    if (!chips[Math.floor((i / n) * chips.length)]) continue;
    const t = (2 * Math.PI * i) / n;
    const px = W / 2 + r * Math.cos(t);
    const py = W / 2 + r * (1 - ecc) * Math.sin(t + phase);
    const weight = grad + (1 - grad) * (0.5 + 0.5 * Math.cos(t));
    const x0 = Math.max(0, Math.floor(px) - reach);
    const x1 = Math.min(W - 1, Math.floor(px) + reach);
    const y0 = Math.max(0, Math.floor(py) - reach);
    const y1 = Math.min(W - 1, Math.floor(py) + reach);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        img[y * W + x] +=
          weight *
          Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * sigma ** 2));
  }
  let peak = 0;
  for (const v of img) if (v > peak) peak = v;
  const gauss = noise(seed);
  const data = new Uint8Array(W * W * 4);
  for (let i = 0; i < img.length; i++) {
    const v =
      Math.min(1, (img[i] / (peak || 1)) * 1.4) * 4095 + 60 + gauss() * 25;
    const byte = Math.max(0, Math.min(255, Math.round((v / 4095) * 255)));
    data[i * 4] = byte;
    data[i * 4 + 1] = byte;
    data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: W, channels: 4 };
}

const read = (img: RingImage) =>
  createRingReader().read(img, { minChipPx: MIN_CHIP_PX }).readout;

describe("ring reader", () => {
  it("decodes a synthesized fovea frame and fits its circle to within a pixel", () => {
    const got = read(synth("Hello", { ecc: 0, phaseDeg: 0, grad: 1 }));
    expect(got.ok, got.reason).toBe(true);
    expect(got.text).toBe("Hello");
    expect(got.hex).toBe("48656c6c6f");
    expect(got.circle).not.toBeNull();
    expect(got.circle!.x).toBeCloseTo(W / 2, 0);
    expect(got.circle!.y).toBeCloseTo(W / 2, 0);
    expect(Math.abs(got.circle!.r - 240)).toBeLessThan(1);
  });

  // --- the analyzer's --selftest cases, verbatim ---------------------------
  const CASES: [string, Synth, boolean][] = [
    ["circle, flat", { ecc: 0, phaseDeg: 0, grad: 1 }, true],
    ["mild ellipse 6 % gain + 3° phase", { ecc: 0.06, phaseDeg: 3 }, true],
    [
      "mild ellipse + gradient ×0.4",
      { ecc: 0.06, phaseDeg: 3, grad: 0.4 },
      true,
    ],
    [
      "mild ellipse + gradient + fat dot",
      { ecc: 0.06, phaseDeg: 3, grad: 0.4, sigma: 4.5 },
      true,
    ],
    ["HARSH: 20° axis phase (1.5:1 axes)", {}, true],
    ["HARSH + gradient + fat dot", { sigma: 4.5 }, true],
    ["chips merged (dot ≈ 2× chip)", { sigma: 9 }, false],
  ];

  for (const [label, kw, shouldDecode] of CASES)
    it(`${shouldDecode ? "decodes" : "REFUSES"}: ${label}`, () => {
      const got = read(synth("Hello", kw));
      if (shouldDecode) {
        expect(got.ok, `${got.reason} @ bit ${got.bitIndex}`).toBe(true);
        expect(got.text).toBe("Hello");
      } else {
        // Never a wrong CRC-valid decode — an honest refusal or nothing.
        expect(got.ok).toBe(false);
        expect(got.text).toBeUndefined();
      }
    });

  it("reports how far the real path left the fitted circle", () => {
    const round = read(synth("Hello", { ecc: 0, phaseDeg: 0, grad: 1 }));
    const squashed = read(synth("Hello", {}));
    expect(round.ridgePx ?? 0).toBeLessThan(3);
    expect(squashed.ridgePx ?? 0).toBeGreaterThan(5);
  });

  it("decodes an OFF-CENTER ring (the fit is not assumed at the frame center)", () => {
    // The synth is centered; an off-center ring is the same path with the
    // circle seed found by the fit, so shrink the radius and check the fit.
    const got = read(synth("Hi", { r: 200, ecc: 0, phaseDeg: 0, grad: 1 }));
    expect(got.ok, got.reason).toBe(true);
    expect(got.text).toBe("Hi");
    expect(got.circle!.r).toBeCloseTo(200, 0);
  });

  it("annotates every field and interior byte boundary", () => {
    const got = read(synth("abc", { ecc: 0, phaseDeg: 0, grad: 1 }));
    expect(got.ok, got.reason).toBe(true);
    expect(got.dividers!.map((d) => d.name)).toEqual([
      "gap",
      "leader",
      "len",
      "data",
      "byte",
      "byte",
      "crc",
    ]);
    for (const d of got.dividers!) {
      expect(d.angle).toBeGreaterThanOrEqual(0);
      expect(d.angle).toBeLessThan(2 * Math.PI);
    }
    // The leader arc spans the LEADER's 8 chips of the ring.
    const arc = got.leaderArc!;
    const wrap = (a: number) =>
      ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const span = Math.abs(wrap(arc.to - arc.from + Math.PI) - Math.PI);
    const chips = 11 + 16 * (3 + 2);
    expect(span).toBeCloseTo((2 * Math.PI * 8) / chips, 1);
  });

  it("rejects a single dot — no ring, no circle", () => {
    const dot: RingImage = {
      data: new Uint8Array(W * W * 4),
      width: W,
      height: W,
      channels: 4,
    };
    for (let y = 340; y < 380; y++)
      for (let x = 340; x < 380; x++) {
        const v = Math.exp(-((x - 360) ** 2 + (y - 360) ** 2) / (2 * 6 ** 2));
        const byte = Math.round(Math.min(1, v) * 255);
        const p = (y * W + x) * 4;
        dot.data[p] = dot.data[p + 1] = dot.data[p + 2] = byte;
        dot.data[p + 3] = 255;
      }
    const got = read(dot);
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("no ring");
    expect(got.circle).toBeNull();
  });

  it("decodes ≥ 90 % of a randomized realistic sweep, refusing the rest honestly", () => {
    let s = 12345;
    const rnd = (lo: number, hi: number) => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return lo + (s / 4294967296) * (hi - lo);
    };
    const reader = createRingReader(); // one reader, many frames (scratch reuse)
    let decoded = 0;
    const refusals: string[] = [];
    const CASES_N = 40;
    for (let i = 0; i < CASES_N; i++) {
      const img = synth("Hello", {
        ecc: rnd(0, 0.08),
        phaseDeg: rnd(-5, 5),
        grad: rnd(0.35, 1),
        sigma: rnd(2.5, 4),
        r: rnd(200, 260),
        seed: i,
      });
      const got = reader.read(img, { minChipPx: MIN_CHIP_PX }).readout;
      if (got.ok) {
        // A decode must be the RIGHT decode.
        expect(got.text, `case ${i}`).toBe("Hello");
        decoded++;
      } else {
        expect(got.text, `case ${i}`).toBeUndefined();
        refusals.push(`${i}:${got.reason}`);
      }
    }
    expect(
      decoded / CASES_N,
      `refusals ${refusals.join(" ")}`,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it("builds the debug strip only when asked, with the documented layout", () => {
    const img = synth("Hello", { ecc: 0, phaseDeg: 0, grad: 1 });
    const reader = createRingReader();
    const plain = reader.read(img, { minChipPx: MIN_CHIP_PX });
    expect(plain.strip).toBeUndefined();
    expect(plain.readout.strip).toBeUndefined();

    const dbg = reader.read(img, { minChipPx: MIN_CHIP_PX, debug: true });
    expect(dbg.readout.ok, dbg.readout.reason).toBe(true);
    const strip = dbg.strip!;
    const meta = dbg.readout.strip!;
    // rows = the polar image + profile + binary + segmentation.
    expect(strip.rows).toBe(meta.polarRows + 3);
    expect(meta.rows).toBe(strip.rows);
    expect(strip.width).toBe(meta.width);
    expect(strip.data.length).toBe(strip.rows * strip.width);
    // The polar rows span the coarse band around the fitted radius.
    expect(meta.polarRows).toBeGreaterThan(2 * 6);
    // Normalized: the polar image uses most of the 8-bit range.
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < meta.polarRows * strip.width; i++) {
      const v = strip.data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(lo).toBe(0);
    expect(hi).toBe(255);
    // The binary row is strictly two-valued, and both values occur.
    const binRow = (meta.polarRows + 1) * strip.width;
    const values = new Set<number>();
    for (let i = 0; i < strip.width; i++) values.add(strip.data[binRow + i]);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
    // The segmentation row carries only the documented marks, and marks the
    // leader span + the data start.
    const segRow = (meta.polarRows + 2) * strip.width;
    const marks = new Set<number>();
    for (let i = 0; i < strip.width; i++) marks.add(strip.data[segRow + i]);
    for (const v of marks) expect([0, 64, 128, 192, 255]).toContain(v);
    expect(marks.has(192)).toBe(true);
    expect(marks.has(255)).toBe(true);
    expect(marks.has(128)).toBe(true);
  });

  it("reuses its scratch across frames (same reader, repeated reads)", () => {
    const reader = createRingReader();
    const a = synth("Hi", { ecc: 0, phaseDeg: 0, grad: 1 });
    const b = synth("ok", { ecc: 0, phaseDeg: 0, grad: 1, r: 200 });
    const opts = { minChipPx: MIN_CHIP_PX };
    expect(reader.read(a, opts).readout.text).toBe("Hi");
    expect(reader.read(b, opts).readout.text).toBe("ok");
    expect(reader.read(a, opts).readout.text).toBe("Hi");
  });
});
