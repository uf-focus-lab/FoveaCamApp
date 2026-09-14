// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Circular-scan geometry (spec docs/spec/mirror-link.md §scan): the offset's
// period/radius/phase, and the per-eye composition — trims land on ONE eye each
// and a zero offset + zero trims reduce to plain `inverseTriangulate`.

import { describe, expect, it } from "vitest";
import {
  scanAngles,
  scanOffset,
  SCAN_AMP_RANGE,
  SCAN_HZ_RANGE,
  TRIM_RANGE_DEG,
} from "@modules/mirror-link/scan";
import { inverseTriangulate } from "@lib/stereo";
import type { Point2d } from "core/Geometry";

const DEG = Math.PI / 180;
const radius = (p: Point2d) => Math.hypot(p.x, p.y);
const A0: Point2d = { x: 0.03, y: -0.02 };
const NO_TRIM = { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } };

describe("scanOffset", () => {
  it("is periodic at the revolution period", () => {
    const hz = 20;
    const period = 1000 / hz;
    for (const t of [0, 3.7, 19.1]) {
      const a = scanOffset(t, hz, 0.5);
      const b = scanOffset(t + period, hz, 0.5);
      expect(b.x).toBeCloseTo(a.x, 12);
      expect(b.y).toBeCloseTo(a.y, 12);
    }
  });

  it("traces a circle of RADIUS `amp` (radians) at every phase", () => {
    const amp = 0.75;
    for (const t of [0, 1, 4.3, 11, 37.5]) {
      expect(radius(scanOffset(t, 20, amp))).toBeCloseTo(amp * DEG, 12);
    }
  });

  it("degenerates to the idle pose at zero amplitude", () => {
    expect(scanOffset(7.3, 50, 0)).toEqual({ x: 0, y: 0 });
  });

  it("starts on +x and is a quarter turn onto +y at t = period/4", () => {
    const hz = 25;
    const amp = 1;
    const start = scanOffset(0, hz, amp);
    expect(start.x).toBeCloseTo(amp * DEG, 12);
    expect(start.y).toBeCloseTo(0, 12);
    const quarter = scanOffset(1000 / hz / 4, hz, amp);
    expect(quarter.x).toBeCloseTo(0, 12);
    expect(quarter.y).toBeCloseTo(amp * DEG, 12);
  });

  it("derives phase from the wall clock — a SKIPPED tick lands at the same place", () => {
    const hz = 10;
    // One sample at t, one that "missed" the ticks between: identical phase.
    expect(scanOffset(33, hz, 0.4)).toEqual(scanOffset(33, hz, 0.4));
    const late = scanOffset(33 + 1000 / hz, hz, 0.4);
    expect(late.x).toBeCloseTo(scanOffset(33, hz, 0.4).x, 12);
  });
});

describe("scanAngles", () => {
  it("reduces to inverseTriangulate with a zero offset and zero trims", () => {
    const baseline = 200;
    for (const z of [Infinity, 1500]) {
      expect(scanAngles(A0, { x: 0, y: 0 }, baseline, z, NO_TRIM)).toEqual(
        inverseTriangulate(A0, baseline, z),
      );
    }
  });

  it("adds each eye's trim to THAT eye only", () => {
    const trims = { l: { x: 0.001, y: -0.002 }, r: { x: 0.003, y: 0.004 } };
    const base = scanAngles(A0, { x: 0, y: 0 }, 200, 1500, NO_TRIM);
    const trimmed = scanAngles(A0, { x: 0, y: 0 }, 200, 1500, trims);
    expect(trimmed.l.x - base.l.x).toBeCloseTo(trims.l.x, 12);
    expect(trimmed.l.y - base.l.y).toBeCloseTo(trims.l.y, 12);
    expect(trimmed.r.x - base.r.x).toBeCloseTo(trims.r.x, 12);
    expect(trimmed.r.y - base.r.y).toBeCloseTo(trims.r.y, 12);
  });

  it("moves BOTH eyes onto the offset center (the ring is one scene circle)", () => {
    const offset = scanOffset(0, 20, 1); // +x, 1 deg
    const moved = scanAngles(A0, offset, 200, Infinity, NO_TRIM);
    const expected = inverseTriangulate(
      { x: A0.x + offset.x, y: A0.y + offset.y },
      200,
      Infinity,
    );
    expect(moved).toEqual(expected);
  });

  it("keeps trims independent of the offset (they move the ring's CENTER, not its shape)", () => {
    const trims = { l: { x: 0.002, y: 0 }, r: { x: 0, y: 0.002 } };
    for (const t of [0, 5, 12.5]) {
      const offset = scanOffset(t, 20, 0.5);
      const withTrim = scanAngles(A0, offset, 200, 1500, trims);
      const without = scanAngles(A0, offset, 200, 1500, NO_TRIM);
      expect(withTrim.l.x - without.l.x).toBeCloseTo(trims.l.x, 12);
      expect(withTrim.r.y - without.r.y).toBeCloseTo(trims.r.y, 12);
    }
  });
});

describe("shared ranges", () => {
  it("pin the UI/session/test contract", () => {
    expect(SCAN_HZ_RANGE).toEqual({ min: 1, max: 100 });
    expect(SCAN_AMP_RANGE).toEqual({ min: 0, max: 2 });
    expect(TRIM_RANGE_DEG).toEqual({ min: -0.5, max: 0.5 });
  });
});
