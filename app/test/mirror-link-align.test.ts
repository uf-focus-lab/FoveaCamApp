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
  findSpot,
  solveAlignment,
  spotOffsetAngle,
  SPOT_TO_ANGLE_SIGN,
  type AlignImage,
} from "@modules/mirror-link/align";
import { createSpotKernel } from "@orchestrator/spot-kernel";
import { PID2D } from "@lib/pid";
import { makeMat } from "@lib/mat";
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

describe("findSpot (the spot kernel's per-frame work)", () => {
  it("matches the full-resolution centroid after its decimated first pass", () => {
    const img = dotFrame(41.25, 22.75, 255, 6);
    const full = brightestSpot(img)!;
    const got = findSpot(img)!;
    expect(got.x).toBeCloseTo(full.x, 1);
    expect(got.y).toBeCloseTo(full.y, 1);
  });

  it("returns null on a frame with no emitter", () => {
    expect(findSpot(dotFrame(20, 30, 20))).toBeNull();
  });

  it("recovers a TIGHT dot the decimated pass can only bracket", () => {
    // Sub-pixel dot on odd coordinates: the coarse grid never samples its core,
    // so the answer has to come from the refine window (or the full-res
    // fallback) — either way within a pixel of the truth.
    const tight = dotFrame(21, 31, 255, 0.7);
    const got = findSpot(tight)!;
    expect(got.x).toBeCloseTo(21, 0);
    expect(got.y).toBeCloseTo(31, 0);
  });
});

describe("spot kernel", () => {
  const frameOf = (img: AlignImage) => ({
    mat: makeMat(img.data, [img.height, img.width], img.channels),
    seq: 1,
  });

  it("emits nothing while disabled, a per-role measurement once enabled", () => {
    const k = createSpotKernel({ kind: "spot" });
    const frames = {
      L: frameOf(dotFrame(20, 30, 255, 6)),
      R: frameOf(dotFrame(44, 12, 255, 6)),
    } as never;
    expect(k.process(frames)).toBeNull();
    k.setParams({ enabled: true });
    const out = k.process(frames) as { values: Record<string, unknown> };
    expect(out).not.toBeNull();
    const L = out.values.L as { x: number; y: number };
    const R = out.values.R as { x: number; y: number };
    expect(L.x).toBeCloseTo(20, 0);
    expect(L.y).toBeCloseTo(30, 0);
    expect(R.x).toBeCloseTo(44, 0);
    expect(R.y).toBeCloseTo(12, 0);
  });

  it("reports null for an eye with no emitter", () => {
    const k = createSpotKernel({ kind: "spot", enabled: true });
    const out = k.process({
      L: frameOf(dotFrame(20, 30, 255, 6)),
      R: frameOf(dotFrame(20, 30, 10)),
    } as never) as { values: Record<string, unknown> };
    expect(out.values.L).not.toBeNull();
    expect(out.values.R).toBeNull();
  });
});

describe("the servo's step math", () => {
  // The session's loop, reduced to arithmetic: error → PID → desired angles →
  // one collective solve. Proves the sign convention CLOSES the loop (the error
  // shrinks) rather than running away.
  const focal = { x: 4000, y: 4000 };
  const center = { x: 320, y: 240 };
  const baseline = 200;

  function run(steps: number, kp: number) {
    // Truth: the emitter sits at a fixed angle; each eye's spot is where that
    // angle lands in its fovea frame given the eye's current gaze.
    const truth = { x: 0.02, y: -0.01 };
    const desired = {
      L: { x: 0, y: 0 },
      R: { x: 0, y: 0 },
    };
    const pid = {
      L: new PID2D({ x: { kp }, y: { kp } }),
      R: new PID2D({ x: { kp }, y: { kp } }),
    };
    let last = Infinity;
    for (let i = 0; i < steps; i++) {
      for (const side of ["L", "R"] as const) {
        const d = desired[side];
        // Where the emitter appears, inverting spotOffsetAngle.
        const spot = {
          x:
            center.x + Math.tan(truth.x - d.x) * focal.x * SPOT_TO_ANGLE_SIGN.x,
          y:
            center.y + Math.tan(truth.y - d.y) * focal.y * SPOT_TO_ANGLE_SIGN.y,
        };
        const err = spotOffsetAngle(spot, center, focal);
        const step = pid[side].step(err, 1);
        desired[side] = { x: d.x + step.x, y: d.y + step.y };
        last = Math.hypot(err.x, err.y);
      }
    }
    return { desired, residual: last };
  }

  it("drives the measured error to zero with the default sign", () => {
    const { desired, residual } = run(40, 0.5);
    expect(residual).toBeLessThan(1e-4);
    expect(desired.L.x).toBeCloseTo(0.02, 4);
    expect(desired.R.y).toBeCloseTo(-0.01, 4);
  });

  it("converges onto a solvable pair the fixation model reproduces", () => {
    const { desired } = run(40, 0.5);
    const solved = solveAlignment(desired.L, desired.R, baseline);
    const back = inverseTriangulate(
      solved.angle,
      baseline,
      solved.distanceMm,
      solved.shiftRad,
    );
    expect(back.l.x).toBeCloseTo(desired.L.x, 9);
    expect(back.r.y).toBeCloseTo(desired.R.y, 9);
  });

  it("diverges when the sign is inverted — the rig's tell", () => {
    // Same loop with the opposite convention: the error must GROW.
    const focalNeg = { x: -focal.x, y: -focal.y };
    const pid = new PID2D({ x: { kp: 0.5 }, y: { kp: 0.5 } });
    let d = { x: 0, y: 0 };
    const truth = { x: 0.02, y: 0 };
    const errAt = (g: { x: number; y: number }) =>
      spotOffsetAngle(
        {
          x: center.x + Math.tan(truth.x - g.x) * focal.x,
          y: center.y,
        },
        center,
        focalNeg,
      );
    const first = Math.abs(errAt(d).x);
    for (let i = 0; i < 5; i++) {
      const step = pid.step(errAt(d), 1);
      d = { x: d.x + step.x, y: d.y + step.y };
    }
    expect(Math.abs(errAt(d).x)).toBeGreaterThan(first);
  });
});
