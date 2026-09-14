// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Ring READER (spec docs/spec/ring-code.md §reader): the extraction half —
// bright mask → Kåsa circle fit → angular profile → decode — driven with a
// synthesized fovea frame (a port of the reference plotter's ring synthesis:
// Gaussian dots swept along a circle, saturated, noisy). No native core.

import { describe, expect, it } from "vitest";
import { encodeFrame } from "@lib/ring-code";
import { createRingReader, type RingImage } from "@orchestrator/ring-kernel";

const W = 720;
const DOT_SIGMA = 3.2;

/** Deterministic LCG + Box–Muller, so the synthesized noise is reproducible. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  const unit = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () =>
    Math.sqrt(-2 * Math.log(unit())) * Math.cos(2 * Math.PI * unit());
}

/** One simulated fovea frame: `chips` painted as blurred dots around a circle
 *  of radius `r` centered at (cx, cy), in BGRA8. */
function synthesize(
  chips: Uint8Array,
  { cx = W / 2, cy = W / 2, r = 240, samples = 1500, seed = 7 } = {},
): RingImage {
  const gray = new Float32Array(W * W);
  const spc = samples / chips.length;
  const reach = Math.ceil(4 * DOT_SIGMA);
  for (let i = 0; i < samples; i++) {
    if (!chips[Math.floor(i / spc) % chips.length]) continue;
    const a = (2 * Math.PI * i) / samples;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    const x0 = Math.max(0, Math.floor(px) - reach);
    const x1 = Math.min(W - 1, Math.floor(px) + reach);
    const y0 = Math.max(0, Math.floor(py) - reach);
    const y1 = Math.min(W - 1, Math.floor(py) + reach);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        gray[y * W + x] += Math.exp(-d2 / (2 * DOT_SIGMA ** 2));
      }
  }
  let peak = 0;
  for (const v of gray) if (v > peak) peak = v;
  const gauss = noise(seed);
  const data = new Uint8Array(W * W * 4);
  for (let i = 0; i < gray.length; i++) {
    // Slightly saturated ring + a dim noise floor, as the reference renders it.
    const v =
      Math.min(1, (gray[i] / (peak || 1)) * 1.6) + 0.03 + gauss() * 0.02;
    const byte = Math.max(0, Math.min(255, Math.round(v * 255)));
    data[i * 4] = byte;
    data[i * 4 + 1] = byte;
    data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: W, channels: 4 };
}

describe("ring reader", () => {
  it("decodes a synthesized fovea frame and fits its circle to within a pixel", () => {
    const chips = encodeFrame(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    const img = synthesize(chips);
    const got = createRingReader().read(img);
    expect(got.ok, got.reason).toBe(true);
    expect(got.text).toBe("Hello");
    expect(got.hex).toBe("48656c6c6f");
    expect(got.circle).not.toBeNull();
    expect(got.circle!.x).toBeCloseTo(W / 2, 0);
    expect(got.circle!.y).toBeCloseTo(W / 2, 0);
    expect(Math.abs(got.circle!.r - 240)).toBeLessThan(1);
  });

  it("puts the leader arc over the leader's chips", () => {
    const chips = encodeFrame(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    const samples = 1500;
    const img = synthesize(chips, { samples });
    const got = createRingReader().read(img);
    expect(got.ok, got.reason).toBe(true);
    const arc = got.leaderArc!;
    // The LEADER occupies chips 3..10 of the frame, painted at angles
    // 2π·(chip·spc)/samples — the arc must open at the burst's first chip.
    const spc = samples / chips.length;
    const expected = (2 * Math.PI * (3 * spc)) / samples;
    const wrap = (a: number) =>
      ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const delta = Math.abs(wrap(arc.from - expected + Math.PI) - Math.PI);
    expect(delta).toBeLessThan((2 * Math.PI * spc) / samples); // within a chip
    // ...and span the LEADER's 8 chips.
    const span = Math.abs(wrap(arc.to - arc.from + Math.PI) - Math.PI);
    expect(span).toBeCloseTo((2 * Math.PI * 8 * spc) / samples, 1);
  });

  it("annotates every field and interior byte boundary", () => {
    const chips = encodeFrame(new Uint8Array([1, 2, 3]));
    const got = createRingReader().read(synthesize(chips));
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
  });

  it("decodes an OFF-CENTER ring (the fit is not assumed at the frame center)", () => {
    const chips = encodeFrame(new Uint8Array([0x48, 0x69]));
    const img = synthesize(chips, { cx: 300, cy: 400, r: 200 });
    const got = createRingReader().read(img);
    expect(got.ok, got.reason).toBe(true);
    expect(got.text).toBe("Hi");
    expect(got.circle!.x).toBeCloseTo(300, 0);
    expect(got.circle!.y).toBeCloseTo(400, 0);
  });

  it("rejects a single dot — no ring, no circle", () => {
    const one = new Uint8Array(1);
    one[0] = 1;
    const img = synthesize(one, { samples: 8 }); // 8 samples of a 1-chip 'ring'
    const dot: RingImage = { ...img, data: new Uint8Array(img.data.length) };
    // A lone Gaussian blob at the frame center: bright, but no angular spread.
    for (let y = 340; y < 380; y++)
      for (let x = 340; x < 380; x++) {
        const v = Math.exp(-((x - 360) ** 2 + (y - 360) ** 2) / (2 * 6 ** 2));
        const byte = Math.round(Math.min(1, v) * 255);
        const p = (y * W + x) * 4;
        dot.data[p] = dot.data[p + 1] = dot.data[p + 2] = byte;
        dot.data[p + 3] = 255;
      }
    const got = createRingReader().read(dot);
    expect(got.ok).toBe(false);
    expect(got.reason).toBe("no ring");
    expect(got.circle).toBeNull();
  });

  it("reuses its scratch across frames (same reader, repeated reads)", () => {
    const reader = createRingReader();
    const a = synthesize(encodeFrame(new Uint8Array([0x48, 0x69])));
    const b = synthesize(encodeFrame(new Uint8Array([0x6f, 0x6b])), { r: 200 });
    expect(reader.read(a).text).toBe("Hi");
    expect(reader.read(b).text).toBe("ok");
    expect(reader.read(a).text).toBe("Hi");
  });
});
