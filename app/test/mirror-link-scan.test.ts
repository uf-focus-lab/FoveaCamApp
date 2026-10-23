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
  AXIS_HANDLE_MIN_DEG,
  axisDegFromPixelRay,
  axisHandleOffset,
  clampWindow,
  ELLIPSE_SAMPLES,
  FLIP_TOLERANCE_FLOOR_US,
  flipEdges,
  flipRebuildNeeded,
  flipToleranceUs,
  minExposureEndSpacingUs,
  minFlipEdgeGapUs,
  timedWindowMarkers,
  normalizeAxisDeg,
  patternOffset,
  patternPath,
  patternPeriodUs,
  patternSamples,
  sameWindowValue,
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
    for (const p of [0, 0.1, 0.25, 0.5, 0.77])
      close(patternOffset("ellipse", p, 0, 0.75, 1), oldCircle(p, 0.75));
  });

  it("traces a circle of RADIUS amp at ratio 1 for ANY axis", () => {
    for (const axis of [0, 33, -120, 180])
      for (const p of [0, 0.13, 0.5, 0.9])
        expect(radius(patternOffset("ellipse", p, axis, 0.75, 1))).toBeCloseTo(
          0.75 * DEG,
          12,
        );
  });

  it("collapses to a LINE along the axis at ratio 0", () => {
    const axis = 30;
    const dir = { x: Math.cos(axis * DEG), y: Math.sin(axis * DEG) };
    for (const p of [0, 0.1, 0.3, 0.6, 0.85]) {
      const o = patternOffset("ellipse", p, axis, 1, 0);
      // Perpendicular component vanishes; along-axis is a cos(2πφ).
      expect(o.x * -dir.y + o.y * dir.x).toBeCloseTo(0, 12);
      expect(o.x * dir.x + o.y * dir.y).toBeCloseTo(
        DEG * Math.cos(2 * Math.PI * p),
        12,
      );
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
    close(
      patternOffset("ellipse", 0.25, 0, 1, 3),
      patternOffset("ellipse", 0.25, 0, 1, 1),
    );
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

describe("flip tolerance + exposure spacing", () => {
  /** The triangle's markers at `hz` for the two windows, as flip edges. */
  const edges = (hz: number, rise: [number, number], fall: [number, number]) =>
    flipEdges(windowMarkers("triangle", hz, [rise, fall]));

  it("the gap is between EDGES of markers of different flip, circularly", () => {
    const T = sweepUs(10);
    // Default windows [0.05, 0.95]: the rising end (0.95 T) → the falling
    // start (1.05 T), and the falling end (1.95 T) → the next rising start
    // (2.05 T): 0.1 T either way — not the T between the marker starts.
    expect(minFlipEdgeGapUs(edges(10, [0.05, 0.95], [0.05, 0.95]), 2 * T)).toBe(
      0.1 * T,
    );
    // The wrap alone can be the closest: falling [0, 0.95] ends at 1.95 T,
    // rising [0.01, 0.5] starts 0.01 T into the next period → 0.06 T.
    expect(
      minFlipEdgeGapUs(edges(10, [0.01, 0.5], [0, 0.95]), 2 * T),
    ).toBeCloseTo(0.06 * T, 9);
    // Same flip never counts; one marker (the ellipse) → the period.
    expect(
      minFlipEdgeGapUs(
        [
          { startUs: 0, endUs: 10, flip: false },
          { startUs: 11, endUs: 20, flip: false },
        ],
        100,
      ),
    ).toBe(100);
    expect(
      minFlipEdgeGapUs(flipEdges(windowMarkers("ellipse", 10, [[0, 0.95]])), T),
    ).toBe(T);
    // Overlapping exposures → 0.
    expect(
      minFlipEdgeGapUs(
        [
          { startUs: 0, endUs: 60, flip: false },
          { startUs: 50, endUs: 90, flip: true },
        ],
        100,
      ),
    ).toBe(0);
  });

  it("defaults at 10 Hz: 0.4 × the 0.1 T edge gap", () => {
    const T = sweepUs(10);
    expect(
      flipToleranceUs(2 * T, T, edges(10, [0.05, 0.95], [0.05, 0.95])),
    ).toEqual({
      toleranceUs: 0.04 * T, // 4 ms (cap 4.5 ms)
      capUs: 0.045 * T,
      tooClose: false,
    });
  });

  it("defaults at 100 Hz: cap 0.45 ms < the 1 ms floor → tooClose, tolerance = the cap", () => {
    const T = sweepUs(100); // 10 ms; edge gap 0.1 T = 1 ms
    const r = flipToleranceUs(2 * T, T, edges(100, [0.05, 0.95], [0.05, 0.95]));
    expect(r.tooClose).toBe(true);
    expect(r.toleranceUs).toBeCloseTo(450, 9);
  });

  it("the round-1 'OK' case at 50 Hz is too close by its edges", () => {
    // T = 20 ms. Rising [0.88, 0.95] ends at 19 ms, falling [0, 0.5] starts
    // at 20 ms: the STARTS are 2.4 ms apart (round 1 floored it to 1 ms and
    // called it fine), the EDGES 1 ms → cap 0.45 ms < floor.
    const T = sweepUs(50);
    const r = flipToleranceUs(2 * T, T, edges(50, [0.88, 0.95], [0, 0.5]));
    expect(r).toEqual({ toleranceUs: 450, capUs: 450, tooClose: true });
  });

  it("floors at 1 ms, capped at 0.45 × the edge gap", () => {
    const e = (gap: number) => [
      { startUs: 0, endUs: 1_000, flip: false },
      { startUs: 1_000 + gap, endUs: 2_000 + gap, flip: true },
    ];
    // 3 ms gap: 0.4·3 = 1.2 ms (above the floor, below the 1.35 ms cap).
    expect(flipToleranceUs(20_000, 10_000, e(3_000))).toEqual({
      toleranceUs: 1_200,
      capUs: 1_350,
      tooClose: false,
    });
    // 2.4 ms gap: 0.96 ms → floored to 1 ms (cap 1.08 ms).
    const r = flipToleranceUs(20_000, 10_000, e(2_400));
    expect(r.toleranceUs).toBe(FLIP_TOLERANCE_FLOOR_US);
    expect(r.tooClose).toBe(false);
    // 2 ms gap: cap 0.9 ms < floor → too close.
    expect(flipToleranceUs(20_000, 10_000, e(2_000))).toEqual({
      toleranceUs: 900,
      capUs: 900,
      tooClose: true,
    });
    // min(T, gap): a wide gap is bounded by the sweep.
    expect(flipToleranceUs(20_000, 5_000, e(8_000)).toleranceUs).toBe(2_000);
  });

  it("a frame within the tolerance of its own edge is out of reach of every other-flip edge", () => {
    for (const [hz, rise, fall] of [
      [10, [0.05, 0.95], [0.05, 0.95]],
      [10, [0.9, 0.95], [0, 0.5]],
      [37, [0.2, 0.7], [0.1, 0.95]],
    ] as const) {
      const T = sweepUs(hz);
      const m = edges(hz, [...rise], [...fall]);
      const { toleranceUs: tol } = flipToleranceUs(2 * T, T, m);
      const dist = (a: number, b: number) => {
        const d = Math.abs(a - b) % (2 * T);
        return Math.min(d, 2 * T - d);
      };
      for (const own of m)
        for (const stamp of [
          own.startUs - tol,
          own.startUs + tol,
          own.endUs - tol,
          own.endUs + tol,
        ])
          for (const other of m.filter((o) => o.flip !== own.flip))
            for (const edge of [other.startUs, other.endUs])
              expect(dist(stamp, edge)).toBeGreaterThan(tol);
    }
  });

  it("rebuild only an UNSAFE or STALE tolerance (round-3 hysteresis)", () => {
    const rule = (gap: number, sweep = 10_000) =>
      flipToleranceUs(20_000, sweep, [
        { startUs: 0, endUs: 1_000, flip: false },
        { startUs: 1_000 + gap, endUs: 2_000 + gap, flip: true },
      ]);
    // Unsafe: the tolerance in force exceeds the new cap → tighter.
    expect(flipRebuildNeeded(1_200, rule(2_400))).toBe(true); // cap 1.08 ms
    expect(flipRebuildNeeded(1_000, rule(2_000))).toBe(true); // cap 0.9 ms
    // Stale below the floor: a tightened 450 µs once the floor fits again.
    expect(flipRebuildNeeded(450, rule(3_000))).toBe(true);
    // ...but not while the floor still exceeds the cap (the cap IS the rule).
    expect(flipRebuildNeeded(900, rule(2_000))).toBe(false);
    expect(flipRebuildNeeded(800, rule(2_000))).toBe(false);
    // Stale: below half the new tolerance (windows moved far apart).
    expect(flipRebuildNeeded(1_000, rule(6_000))).toBe(true); // wants 2.4 ms
    // In between the brick keeps its value: a shrinking gap still above the
    // current tolerance's cap, and a growing one not yet twice as wide.
    expect(flipRebuildNeeded(1_200, rule(2_800))).toBe(false); // cap 1.26 ms
    expect(flipRebuildNeeded(1_200, rule(5_000))).toBe(false); // wants 2 ms
    // After a rebuild the rule's own tolerance is always kept (no oscillation).
    for (const gap of [500, 2_000, 2_400, 3_000, 6_000, 40_000]) {
      const r = rule(gap);
      expect(flipRebuildNeeded(r.toleranceUs, r)).toBe(false);
    }
  });

  it("end-to-end spacing is T(1 + w1f − w1r) / T(1 + w1r − w1f), the smaller", () => {
    const T = sweepUs(10);
    const m = windowMarkers("triangle", 10, [
      [0.1, 0.9],
      [0.2, 0.5],
    ]);
    // ends at 0.9 T and 1.5 T: 0.6 T = T(1 + 0.5 − 0.9) and 1.4 T across the wrap.
    expect(minExposureEndSpacingUs(2 * T, m)).toBe(Math.round(0.6 * T));
    expect(
      minExposureEndSpacingUs(T, windowMarkers("ellipse", 10, [[0, 0.5]])),
    ).toBe(T);
  });
});

describe("timedWindowMarkers (the Timed fallback)", () => {
  it("gives every marker the one pulse, each kept inside its own slope", () => {
    const T = sweepUs(10);
    // Unequal, unsynced: rising [0.1, 0.9] (80 ms), falling [0.8, 0.95]
    // (15 ms). The falling marker takes the rising length: starting at 0.8 T
    // it would run to 1.6 T past its slope (into the next rising trigger), so
    // it moves to 0.95 T − 0.8 T = 0.15 T into its slope.
    const raw = windowMarkers("triangle", 10, [
      [0.1, 0.9],
      [0.8, 0.95],
    ]);
    const r = timedWindowMarkers("triangle", 10, raw, 80_000);
    expect(r.overrun).toBe(false);
    expect(r.markers).toEqual([
      { tOffsetUs: 10_000, pulseUs: 80_000 },
      { tOffsetUs: T + 15_000, pulseUs: 80_000 },
    ]);
    for (const [k, m] of r.markers.entries()) {
      expect(m.tOffsetUs).toBeGreaterThanOrEqual(k * T);
      expect(m.tOffsetUs + m.pulseUs).toBeLessThanOrEqual(
        k * T + WINDOW_MAX * T,
      );
    }
  });

  it("keeps a start that already fits, and never moves before the slope start", () => {
    const raw = windowMarkers("ellipse", 10, [[0.2, 0.4]]);
    expect(timedWindowMarkers("ellipse", 10, raw, 20_000).markers).toEqual([
      { tOffsetUs: 20_000, pulseUs: 20_000 },
    ]);
    // A clamp-lengthened exposure (97 ms > 0.95 T) starts AT the slope and
    // still fits before the next trigger (T) — no overrun.
    const r = timedWindowMarkers("ellipse", 10, raw, 97_000);
    expect(r).toEqual({
      markers: [{ tOffsetUs: 0, pulseUs: 97_000 }],
      overrun: false,
    });
  });

  it("a pulse that still runs into the next trigger is clamped there and flagged", () => {
    const T = sweepUs(10);
    const raw = windowMarkers("triangle", 10, [
      [0.1, 0.9],
      [0.1, 0.9],
    ]);
    const r = timedWindowMarkers("triangle", 10, raw, 120_000);
    expect(r.overrun).toBe(true);
    expect(r.markers).toEqual([
      { tOffsetUs: 0, pulseUs: T }, // up to the falling trigger at T
      { tOffsetUs: T, pulseUs: T }, // up to the next rising trigger at 2T
    ]);
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
    const [a, b] = clampWindow([0.4, 0.401]);
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

  it("is float-safe on every 0.005-grid position: passes its own check, idempotent", () => {
    const n = Math.round(WINDOW_MAX / WINDOW_MIN);
    for (let k = 0; k <= n; k++) {
      const a = Number((k * WINDOW_MIN).toPrecision(12));
      // A zero-length window, and the grid neighbour the pane would produce.
      for (const w of [
        [a, a],
        [a, Number((a + WINDOW_MIN).toPrecision(12))],
      ] as [number, number][]) {
        const c = clampWindow(w);
        expect(c[1] - c[0]).toBeGreaterThanOrEqual(WINDOW_MIN);
        expect(c[0]).toBeGreaterThanOrEqual(0);
        expect(c[1]).toBeLessThanOrEqual(WINDOW_MAX);
        // Clamping the clamp changes nothing, and the result is the input up
        // to float noise wherever the input was already a valid grid window.
        expect(clampWindow(c)).toEqual(c);
        if (w[1] - w[0] > WINDOW_MIN / 2 && w[1] <= WINDOW_MAX)
          expect(sameWindowValue(c, w)).toBe(true);
      }
    }
  });

  it("sameWindowValue tolerates float noise, not a step", () => {
    expect(sameWindowValue([0.1, 0.105], [0.1, 0.1 + 0.005])).toBe(true);
    expect(sameWindowValue([0.1, 0.105], [0.1, 0.11])).toBe(false);
    expect(sameWindowValue([0.1, 0.105], [0.1])).toBe(false);
    expect(sameWindowValue(null, [0.1, 0.105])).toBe(false);
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
    expect(activeWindows("triangle", { ...w, tri_window_sync: false })).toEqual(
      [
        [0.2, 0.6],
        [0.3, 0.5],
      ],
    );
  });
  it("clamps what the state holds", () => {
    expect(activeWindows("ellipse", { ...w, scan_window: [0.5, 1] })).toEqual([
      [0.5, WINDOW_MAX],
    ]);
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
    p.offsets.forEach((o, k) =>
      close(o, patternOffset("ellipse", k / 8, 15, 1, 0.5)),
    );
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
    const [e] = windowPaths(
      "ellipse",
      10,
      0,
      1,
      1,
      windowMarkers("ellipse", 10, [[0, 0.5]]),
      48,
    );
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
    // The session's floor keeps a direction at amplitude 0.
    const h = axisHandleOffset(90, Math.max(0, AXIS_HANDLE_MIN_DEG));
    expect(Math.hypot(h.x, h.y)).toBeGreaterThan(0);
    expect(axisDegFromPixelRay({ x: 0, y: 0 }, h)).toBeCloseTo(90, 9);
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
