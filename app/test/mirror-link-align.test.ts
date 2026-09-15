// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Auto-align geometry (spec docs/spec/mirror-link.md §targeting): the spot
// finder's thresholds, and `solveAlignment` as the exact inverse of the
// fixation model both the pacer and manual-control command through.

import { describe, expect, it } from "vitest";
import {
  brightestSpot,
  solveAlignment,
  spotOffsetAngle,
  SPOT_TO_ANGLE_SIGN,
  type AlignImage,
} from "@modules/mirror-link/align";
import { inverseTriangulate } from "@lib/stereo";

/** A BGRA frame with a Gaussian dot at (cx, cy). */
function dotFrame(
  cx: number,
  cy: number,
  peak = 255,
  sigma = 3,
  w = 64,
  h = 48,
): AlignImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v =
        peak * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2));
      const b = Math.round(Math.min(255, v));
      const p = (y * w + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = b;
      data[p + 3] = 255;
    }
  return { data, width: w, height: h, channels: 4 };
}

describe("brightestSpot", () => {
  it("finds the dot's centroid", () => {
    const got = brightestSpot(dotFrame(20.5, 30.5));
    expect(got).not.toBeNull();
    expect(got!.x).toBeCloseTo(20.5, 1);
    expect(got!.y).toBeCloseTo(30.5, 1);
    expect(got!.peak).toBeGreaterThan(200);
  });

  it("refuses a dark frame (no emitter) and a single hot pixel", () => {
    expect(brightestSpot(dotFrame(20, 30, 20))).toBeNull(); // peak under the floor
    const hot = dotFrame(20, 30, 0);
    const p = (30 * 64 + 20) * 4;
    hot.data[p] = hot.data[p + 1] = hot.data[p + 2] = 255;
    expect(brightestSpot(hot)).toBeNull(); // one pixel is not a dot
  });

  it("reads mono frames too", () => {
    const rgba = dotFrame(10, 10);
    const mono: AlignImage = {
      data: new Uint8Array(64 * 48),
      width: 64,
      height: 48,
      channels: 1,
    };
    for (let i = 0; i < mono.data.length; i++) mono.data[i] = rgba.data[i * 4];
    const got = brightestSpot(mono);
    expect(got!.x).toBeCloseTo(10, 1);
    expect(got!.y).toBeCloseTo(10, 1);
  });
});

describe("solveAlignment", () => {
  it("is the exact inverse of inverseTriangulate", () => {
    let seed = 7;
    const rnd = (lo: number, hi: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return lo + (seed / 4294967296) * (hi - lo);
    };
    for (let i = 0; i < 200; i++) {
      const baseline = rnd(80, 400);
      const angle = { x: rnd(-0.3, 0.3), y: rnd(-0.3, 0.3) };
      const distance = i % 7 === 0 ? Infinity : rnd(300, 20000);
      const shift = rnd(-0.02, 0.02);
      const eyes = inverseTriangulate(angle, baseline, distance, shift);
      const got = solveAlignment(eyes.l, eyes.r, baseline);
      const label = `d=${distance} a=${angle.x},${angle.y} s=${shift}`;
      expect(got.angle.x, label).toBeCloseTo(angle.x, 9);
      expect(got.angle.y, label).toBeCloseTo(angle.y, 9);
      expect(got.shiftRad, label).toBeCloseTo(shift, 9);
      if (distance === Infinity) expect(got.distanceMm, label).toBe(Infinity);
      else expect(got.distanceMm / distance, label).toBeCloseTo(1, 6);
      // ...and re-commanding the solution reproduces the same eye angles.
      const back = inverseTriangulate(
        got.angle,
        baseline,
        got.distanceMm,
        got.shiftRad,
      );
      expect(back.l.x, label).toBeCloseTo(eyes.l.x, 9);
      expect(back.r.x, label).toBeCloseTo(eyes.r.x, 9);
      expect(back.l.y, label).toBeCloseTo(eyes.l.y, 9);
      expect(back.r.y, label).toBeCloseTo(eyes.r.y, 9);
    }
  });

  it("reports Infinity for parallel or diverging rays", () => {
    const parallel = solveAlignment({ x: 0.1, y: 0 }, { x: 0.1, y: 0 }, 200);
    expect(parallel.distanceMm).toBe(Infinity);
    expect(parallel.angle.x).toBeCloseTo(0.1, 12);
    // Diverging: L looks left of R — the rays never cross in front.
    const diverging = solveAlignment({ x: -0.1, y: 0 }, { x: 0.1, y: 0 }, 200);
    expect(diverging.distanceMm).toBe(Infinity);
  });
});

describe("spotOffsetAngle", () => {
  it("is the pinhole offset, signed by the rig-gated convention", () => {
    const focal = { x: 1000, y: 800 };
    const center = { x: 320, y: 240 };
    const got = spotOffsetAngle({ x: 420, y: 140 }, center, focal);
    expect(got.x).toBeCloseTo(SPOT_TO_ANGLE_SIGN.x * Math.atan(100 / 1000), 12);
    expect(got.y).toBeCloseTo(SPOT_TO_ANGLE_SIGN.y * Math.atan(-100 / 800), 12);
    // A spot already at the center asks for no correction.
    expect(spotOffsetAngle(center, center, focal)).toEqual({ x: 0, y: 0 });
  });

  it("degrades to no correction on a degenerate focal", () => {
    expect(
      spotOffsetAngle({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 0, y: NaN }),
    ).toEqual({ x: 0, y: 0 });
  });
});
