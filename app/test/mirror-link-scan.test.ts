// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Scan-pattern geometry (spec docs/spec/mirror-link.md §scan-patterns): the
// ellipse/line/triangle offset, the MCU samples + trigger markers, window
// clamping + sync mirroring, the drawn paths, the axis handle, and the per-eye
// composition — the vertical shift is the fixation model's own toe parameter
// and a zero offset reduces to plain `inverseTriangulate`.

import { describe, expect, it, vi } from "vitest";

// The firmware-limit validator lives in the controller module, which imports
// the native addon at load — stub the addon (only the validator is used).
vi.mock("core/Controller", () => ({
  createMirrorSink: () => null,
  Protocol: {},
  Device: class {},
}));
vi.mock("serialport", () => ({ SerialPort: { list: async () => [] } }));
import {
  activeWindows,
  axisDegFromPixelRay,
  axisHandleOffset,
  clampWindow,
  ELLIPSE_SAMPLES,
  normalizeAxisDeg,
  patternOffset,
  patternPath,
  patternPeriodUs,
  patternSamples,
  scanAngles,
  SCAN_AMP_RANGE,
  SCAN_AXIS_RANGE,
  SCAN_HZ_RANGE,
  SCAN_RATIO_RANGE,
  SHIFT_RANGE_DEG,
  sweepUs,
  WINDOW_MAX,
  WINDOW_MIN,
  windowMarkers,
  windowPaths,
  type WindowState,
} from "@modules/mirror-link/scan";
import { VSHIFT_LIMIT_DEG } from "@lib/vergence/tuning";
import { inverseTriangulate } from "@lib/stereo";
import { validateTrajectorySpec } from "@orchestrator/controller";
import type { Point2d } from "core/Geometry";

const DEG = Math.PI / 180;
const radius = (p: Point2d) => Math.hypot(p.x, p.y);
const A0: Point2d = { x: 0.03, y: -0.02 };
const close = (a: Point2d, b: Point2d, digits = 12) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

/** The OLD circle (the pre-pattern `scanOffset`), for the ratio-1 regression. */
const oldCircle = (phase: number, ampDeg: number): Point2d => ({
  x: ampDeg * DEG * Math.cos(2 * Math.PI * phase),
  y: ampDeg * DEG * Math.sin(2 * Math.PI * phase),
});

describe("patternOffset — ellipse", () => {
  it("reproduces the old circle at ratio 1, axis 0", () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.77]) close(patternOffset("ellipse", p, 0, 0.75, 1), oldCircle(p, 0.75));
  });

  it("traces a circle of RADIUS amp at ratio 1 for ANY axis", () => {
    for (const axis of [0, 33, -120, 180])
      for (const p of [0, 0.13, 0.5, 0.9])
        expect(radius(patternOffset("ellipse", p, axis, 0.75, 1))).toBeCloseTo(0.75 * DEG, 12);
  });

  it("collapses to a LINE along the axis at ratio 0", () => {
    const axis = 30;
    const dir = { x: Math.cos(axis * DEG), y: Math.sin(axis * DEG) };
    for (const p of [0, 0.1, 0.3, 0.6, 0.85]) {
      const o = patternOffset("ellipse", p, axis, 1, 0);
      // Perpendicular component vanishes; along-axis is a cos(2πφ).
      expect(o.x * -dir.y + o.y * dir.x).toBeCloseTo(0, 12);
      expect(o.x * dir.x + o.y * dir.y).toBeCloseTo(DEG * Math.cos(2 * Math.PI * p), 12);
    }
  });

  it("scales the minor axis by the ratio", () => {
    const q = patternOffset("ellipse", 0.25, 0, 1, 0.4); // quarter turn → minor axis
    close(q, { x: 0, y: 0.4 * DEG });
    expect(patternOffset("ellipse", 0, 0, 1, 0.4).x).toBeCloseTo(DEG, 12);
  });

  it("rotates the whole ellipse counter-clockwise by the axis (+x → +y)", () => {
    const r = patternOffset("ellipse", 0, 90, 1, 0.5); // major end at +y
    close(r, { x: 0, y: DEG });
    const m = patternOffset("ellipse", 0.25, 90, 1, 0.5); // minor end at −x
    close(m, { x: -0.5 * DEG, y: 0 });
  });

  it("clamps an out-of-range ratio and degenerates at zero amplitude", () => {
    close(patternOffset("ellipse", 0.25, 0, 1, 3), patternOffset("ellipse", 0.25, 0, 1, 1));
    expect(patternOffset("ellipse", 0.3, 40, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(patternOffset("triangle", 0.3, 40, 0, 1)).toEqual({ x: 0, y: 0 });
  });
});

describe("patternOffset — triangle", () => {
  const a = 0.8 * DEG;
  it("sweeps −a → +a → −a over the 2T period (endpoints)", () => {
    close(patternOffset("triangle", 0, 0, 0.8, 1), { x: -a, y: 0 });
    close(patternOffset("triangle", 0.5, 0, 0.8, 1), { x: a, y: 0 });
    close(patternOffset("triangle", 1, 0, 0.8, 1), { x: -a, y: 0 });
  });

  it("passes the center at the midpoints and is LINEAR in between", () => {
    close(patternOffset("triangle", 0.25, 0, 0.8, 1), { x: 0, y: 0 });
    close(patternOffset("triangle", 0.75, 0, 0.8, 1), { x: 0, y: 0 });
    close(patternOffset("triangle", 0.125, 0, 0.8, 1), { x: -a / 2, y: 0 });
    close(patternOffset("triangle", 0.875, 0, 0.8, 1), { x: -a / 2, y: 0 });
    close(patternOffset("triangle", 0.375, 0, 0.8, 1), { x: a / 2, y: 0 });
  });

  it("rides the axis and ignores the ratio", () => {
    close(patternOffset("triangle", 0.5, -90, 0.8, 0.2), { x: 0, y: -a });
    close(patternOffset("triangle", 0.5, 45, 0.8, 0), {
      x: a * Math.SQRT1_2,
      y: a * Math.SQRT1_2,
    });
  });
});

describe("periods + samples", () => {
  it("is T for the ellipse and 2T for the triangle, in whole µs", () => {
    expect(patternPeriodUs("ellipse", 10)).toBe(100_000);
    expect(patternPeriodUs("triangle", 10)).toBe(200_000);
    expect(sweepUs(3)).toBe(333_333);
    expect(patternPeriodUs("triangle", 3)).toBe(2 * sweepUs(3));
  });

  it("samples the ellipse 128× over one period, each at its own rounded time", () => {
    for (const hz of [1, 3, 10, 100]) {
      const s = patternSamples("ellipse", hz, 20, 0.6, 0.5);
      const P = patternPeriodUs("ellipse", hz);
      expect(s).toHaveLength(ELLIPSE_SAMPLES);
      expect(s[0]!.tOffsetUs).toBe(0);
      for (let i = 1; i < s.length; i++) {
        expect(Number.isInteger(s[i]!.tOffsetUs)).toBe(true);
        expect(s[i]!.tOffsetUs).toBeGreaterThan(s[i - 1]!.tOffsetUs);
      }
      expect(s.at(-1)!.tOffsetUs).toBeLessThan(P);
      for (const { tOffsetUs, offset } of s)
        close(offset, patternOffset("ellipse", tOffsetUs / P, 20, 0.6, 0.5));
    }
  });

  it("samples the triangle with EXACTLY two points: t=0 → −a, t=T → +a", () => {
    const s = patternSamples("triangle", 10, 0, 0.5, 1);
    expect(s.map((x) => x.tOffsetUs)).toEqual([0, 100_000]);
    close(s[0]!.offset, { x: -0.5 * DEG, y: 0 });
    close(s[1]!.offset, { x: 0.5 * DEG, y: 0 });
  });

  it("builds samples + markers the firmware validator accepts (both modes)", () => {
    for (const mode of ["ellipse", "triangle"] as const)
      for (const hz of [1, 7, 100]) {
        const samples = patternSamples(mode, hz, 10, 1, 0.7).map((x) => ({
          tOffsetUs: x.tOffsetUs,
          left: x.offset,
          right: x.offset,
        }));
        const markers = windowMarkers(mode, hz, [
          [0.1, 0.9],
          [0.2, 0.95],
        ]);
        expect(() =>
          validateTrajectorySpec({
            samples,
            periodUs: patternPeriodUs(mode, hz),
            markers,
          }),
        ).not.toThrow();
      }
  });
});

describe("windowMarkers", () => {
  it("ellipse: one marker at w0·T pulsing (w1 − w0)·T", () => {
    expect(windowMarkers("ellipse", 10, [[0.1, 0.6]])).toEqual([
      { tOffsetUs: 10_000, pulseUs: 50_000 },
    ]);
    expect(windowMarkers("ellipse", 10, [[0, 0.95]])).toEqual([
      { tOffsetUs: 0, pulseUs: 95_000 },
    ]);
  });

  it("triangle: rising at w0·T, falling at T + w0·T, each its own pulse", () => {
    expect(
      windowMarkers("triangle", 10, [
        [0.05, 0.95],
        [0.2, 0.5],
      ]),
    ).toEqual([
      { tOffsetUs: 5_000, pulseUs: 90_000 },
      { tOffsetUs: 105_000 + 15_000, pulseUs: 30_000 },
    ]);
  });

  it("triangle: a missing falling window reuses the rising one", () => {
    const [rise, fall] = windowMarkers("triangle", 20, [[0.1, 0.4]]);
    expect(fall!.pulseUs).toBe(rise!.pulseUs);
    expect(fall!.tOffsetUs - rise!.tOffsetUs).toBe(sweepUs(20));
  });

  it("clamps the windows it is handed (never past WINDOW_MAX, never zero)", () => {
    const [m] = windowMarkers("ellipse", 10, [[0.5, 2]]);
    expect(m).toEqual({ tOffsetUs: 50_000, pulseUs: 45_000 });
    const [z] = windowMarkers("ellipse", 10, [[0.3, 0.3]]);
    expect(z!.pulseUs).toBe(WINDOW_MIN * 100_000);
  });

  it("ends every window before the next marker (the engine is idle at the trigger)", () => {
    const T = sweepUs(10);
    const [r, f] = windowMarkers("triangle", 10, [
      [0.3, 0.95],
      [0.4, 0.95],
    ]);
    expect(r!.tOffsetUs + r!.pulseUs).toBeLessThan(f!.tOffsetUs);
    expect(f!.tOffsetUs + f!.pulseUs).toBeLessThan(2 * T); // wraps to marker 0
  });
});

describe("clampWindow", () => {
  it("keeps a valid window untouched", () => {
    expect(clampWindow([0.1, 0.8])).toEqual([0.1, 0.8]);
    expect(clampWindow([0, WINDOW_MAX])).toEqual([0, WINDOW_MAX]);
  });

  it("caps at WINDOW_MAX and floors at 0", () => {
    expect(clampWindow([-0.2, 1.5])).toEqual([0, WINDOW_MAX]);
  });

  it("swaps an inverted pair", () => {
    expect(clampWindow([0.7, 0.2])).toEqual([0.2, 0.7]);
  });

  it("enforces the minimum length (grows the end, or the start at the cap)", () => {
    const [a, b] = clampWindow([0.4, 0.405]);
    expect(a).toBe(0.4);
    expect(b - a).toBeCloseTo(WINDOW_MIN, 12);
    const [c, d] = clampWindow([0.95, 0.95]);
    expect(d).toBe(WINDOW_MAX);
    expect(d - c).toBeCloseTo(WINDOW_MIN, 12);
    expect(c).toBeGreaterThanOrEqual(0);
  });

  it("falls back on non-finite ends", () => {
    expect(clampWindow([NaN, NaN])).toEqual([0, WINDOW_MAX]);
  });
});

describe("activeWindows (sync mirroring)", () => {
  const w: WindowState = {
    scan_window: [0.1, 0.9],
    tri_window_rise: [0.2, 0.6],
    tri_window_fall: [0.3, 0.5],
    tri_window_sync: true,
  };
  it("ellipse: the one window", () => {
    expect(activeWindows("ellipse", w)).toEqual([[0.1, 0.9]]);
  });
  it("triangle synced: the falling window MIRRORS the rising one", () => {
    expect(activeWindows("triangle", w)).toEqual([
      [0.2, 0.6],
      [0.2, 0.6],
    ]);
  });
  it("triangle unsynced: the two windows stand on their own", () => {
    expect(activeWindows("triangle", { ...w, tri_window_sync: false })).toEqual([
      [0.2, 0.6],
      [0.3, 0.5],
    ]);
  });
  it("clamps what the state holds", () => {
    expect(activeWindows("ellipse", { ...w, scan_window: [0.5, 1] })).toEqual([[0.5, WINDOW_MAX]]);
  });
});

describe("drawn paths", () => {
  it("draws a closed ellipse and an open line (ratio 0) / triangle", () => {
    expect(patternPath("ellipse", 0, 1, 0.5, 48).closed).toBe(true);
    expect(patternPath("ellipse", 0, 1, 0, 48).closed).toBe(false);
    const tri = patternPath("triangle", 90, 1, 1, 5);
    expect(tri.closed).toBe(false);
    close(tri.offsets[0]!, { x: 0, y: -DEG });
    close(tri.offsets[4]!, { x: 0, y: DEG });
    close(tri.offsets[2]!, { x: 0, y: 0 });
  });

  it("draws the ellipse through the pattern's own offsets", () => {
    const p = patternPath("ellipse", 15, 1, 0.5, 8);
    p.offsets.forEach((o, k) => close(o, patternOffset("ellipse", k / 8, 15, 1, 0.5)));
  });

  it("draws one exposed polyline per marker, spanning exactly its window", () => {
    const markers = windowMarkers("triangle", 10, [
      [0, 0.5],
      [0, 0.5],
    ]);
    const [rise, fall] = windowPaths("triangle", 10, 0, 1, 1, markers, 48);
    close(rise![0]!, { x: -DEG, y: 0 });
    close(rise!.at(-1)!, { x: 0, y: 0 }); // half the rising sweep
    close(fall![0]!, { x: DEG, y: 0 });
    close(fall!.at(-1)!, { x: 0, y: 0 });
    const [e] = windowPaths("ellipse", 10, 0, 1, 1, windowMarkers("ellipse", 10, [[0, 0.5]]), 48);
    expect(e!.length).toBeGreaterThanOrEqual(2);
    close(e![0]!, { x: DEG, y: 0 });
    close(e!.at(-1)!, { x: -DEG, y: 0 });
  });
});

describe("main axis", () => {
  it("normalizes into (-180, 180]", () => {
    expect(normalizeAxisDeg(180)).toBe(180);
    expect(normalizeAxisDeg(-180)).toBe(180);
    expect(normalizeAxisDeg(270)).toBe(-90);
    expect(normalizeAxisDeg(-450)).toBe(-90);
    expect(normalizeAxisDeg(NaN)).toBe(0);
  });

  it("puts the handle on the +amp end of the axis", () => {
    close(axisHandleOffset(0, 1), { x: DEG, y: 0 });
    close(axisHandleOffset(90, 2), { x: 0, y: 2 * DEG });
  });

  it("recovers the axis from a center→point ray (the handle drag)", () => {
    for (const axis of [0, 30, 90, 135, 180, -45, -179]) {
      const h = axisHandleOffset(axis, 0.7);
      const deg = axisDegFromPixelRay(A0, { x: A0.x + h.x, y: A0.y + h.y });
      expect(deg).toBeCloseTo(normalizeAxisDeg(axis), 9);
    }
    expect(axisDegFromPixelRay(A0, A0)).toBeNull();
  });
});

describe("scanAngles", () => {
  it("reduces to inverseTriangulate with a zero offset", () => {
    const baseline = 200;
    for (const z of [Infinity, 1500]) {
      expect(scanAngles(A0, { x: 0, y: 0 }, baseline, z)).toEqual(
        inverseTriangulate(A0, baseline, z),
      );
      expect(scanAngles(A0, { x: 0, y: 0 }, baseline, z, 0.01)).toEqual(
        inverseTriangulate(A0, baseline, z, 0.01),
      );
    }
  });

  it("applies the vertical shift as a TOE: +s raises L, lowers R", () => {
    const shift = 0.004;
    const base = scanAngles(A0, { x: 0, y: 0 }, 200, 1500);
    const toed = scanAngles(A0, { x: 0, y: 0 }, 200, 1500, shift);
    expect(toed.l.y - base.l.y).toBeCloseTo(shift, 12);
    expect(toed.r.y - base.r.y).toBeCloseTo(-shift, 12);
    expect(toed.l.x).toBeCloseTo(base.l.x, 12);
    expect(toed.r.x).toBeCloseTo(base.r.x, 12);
  });

  it("moves BOTH eyes onto the offset center (the pattern is one scene path)", () => {
    const offset = patternOffset("ellipse", 0, 0, 1, 1);
    const moved = scanAngles(A0, offset, 200, Infinity);
    const expected = inverseTriangulate(
      { x: A0.x + offset.x, y: A0.y + offset.y },
      200,
      Infinity,
    );
    expect(moved).toEqual(expected);
  });

  it("keeps the shift independent of the offset (it toes the path, never reshapes it)", () => {
    const shift = 0.003;
    for (const p of [0, 0.25, 0.6]) {
      const offset = patternOffset("triangle", p, 30, 0.5, 1);
      const withShift = scanAngles(A0, offset, 200, 1500, shift);
      const without = scanAngles(A0, offset, 200, 1500);
      expect(withShift.l.y - without.l.y).toBeCloseTo(shift, 12);
      expect(withShift.r.y - without.r.y).toBeCloseTo(-shift, 12);
    }
  });
});

describe("shared ranges", () => {
  it("pin the UI/session/test contract", () => {
    expect(SCAN_HZ_RANGE).toEqual({ min: 1, max: 100 });
    expect(SCAN_AMP_RANGE).toEqual({ min: 0, max: 2 });
    expect(SCAN_AXIS_RANGE).toEqual({ min: -180, max: 180 });
    expect(SCAN_RATIO_RANGE).toEqual({ min: 0, max: 1 });
    expect(WINDOW_MAX).toBe(0.95);
    expect(WINDOW_MIN).toBeGreaterThan(0);
    // The shift slider IS the vergence loop's `v_shift` DOF — its range is
    // that controller's saturation limit.
    expect(SHIFT_RANGE_DEG).toEqual({
      min: -VSHIFT_LIMIT_DEG,
      max: VSHIFT_LIMIT_DEG,
    });
  });
});
