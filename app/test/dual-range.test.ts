// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The dual-range slider's value math (`app/src/inputs/dual-range.ts`): thumbs
// clamp to the range, never cross, keep `minGap` (exactly, in floating point,
// on the step grid), and a press grabs the nearer thumb.

import { describe, expect, it } from "vitest";
import {
  moveThumb,
  nearestThumb,
  normalizePair,
  type Pair,
} from "@src/inputs/dual-range";
import {
  WINDOW_MAX,
  WINDOW_MIN,
  clampWindow,
} from "@modules/mirror-link/scan";

const B = { min: 0, max: 0.95, minGap: 0.01 };

describe("moveThumb", () => {
  it("moves only the chosen thumb", () => {
    expect(moveThumb([0.1, 0.5], 0, 0.2, B)).toEqual([0.2, 0.5]);
    expect(moveThumb([0.1, 0.5], 1, 0.7, B)).toEqual([0.1, 0.7]);
  });

  it("clamps to the range ends", () => {
    expect(moveThumb([0.1, 0.5], 0, -3, B)).toEqual([0, 0.5]);
    expect(moveThumb([0.1, 0.5], 1, 3, B)).toEqual([0.1, 0.95]);
  });

  it("stops minGap short of the other thumb instead of crossing or pushing it", () => {
    const [a, b] = moveThumb([0.1, 0.5], 0, 0.9, B);
    expect(b).toBe(0.5);
    expect(a).toBeCloseTo(0.49, 12);
    const [c, d] = moveThumb([0.1, 0.5], 1, 0, B);
    expect(c).toBe(0.1);
    expect(d).toBeCloseTo(0.11, 12);
  });

  it("allows coincident thumbs at minGap 0", () => {
    expect(moveThumb([0.2, 0.5], 0, 0.8, { ...B, minGap: 0 })).toEqual([0.5, 0.5]);
  });

  it("collapses a degenerate range onto min", () => {
    expect(moveThumb([0.2, 0.5], 1, 0.8, { min: 1, max: 1, minGap: 0 })).toEqual([1, 1]);
  });
});

describe("normalizePair", () => {
  it("keeps a valid pair verbatim", () => {
    expect(normalizePair([0.05, 0.95], B)).toEqual([0.05, 0.95]);
  });

  it("sorts, clamps and opens the gap", () => {
    expect(normalizePair([0.9, 0.1], B)).toEqual([0.1, 0.9]);
    expect(normalizePair([-1, 2], B)).toEqual([0, 0.95]);
    const [a, b] = normalizePair([0.3, 0.3], B);
    expect(a).toBe(0.3);
    expect(b).toBeCloseTo(0.31, 12);
  });

  it("pulls the start back in when the gap would push the end past max", () => {
    const [a, b] = normalizePair([0.95, 0.95], B);
    expect(b).toBe(0.95);
    expect(a).toBeCloseTo(0.94, 12);
  });

  it("caps a gap wider than the range at the range", () => {
    expect(normalizePair([0.2, 0.3], { min: 0, max: 1, minGap: 5 })).toEqual([0, 1]);
  });
});

describe("nearestThumb", () => {
  const p: Pair = [0.2, 0.6];
  it("grabs the nearer thumb", () => {
    expect(nearestThumb(p, 0.1)).toBe(0);
    expect(nearestThumb(p, 0.35)).toBe(0);
    expect(nearestThumb(p, 0.45)).toBe(1);
    expect(nearestThumb(p, 0.9)).toBe(1);
  });

  it("breaks a tie on coincident thumbs by side", () => {
    expect(nearestThumb([0.5, 0.5], 0.4)).toBe(0);
    expect(nearestThumb([0.5, 0.5], 0.6)).toBe(1);
    // Stacked at max: a press on them grabs the START, the one that can move.
    expect(nearestThumb([0.95, 0.95], 0.95)).toBe(0);
  });
});

describe("minGap holds exactly on the step grid", () => {
  // The mirror-link pane's bounds: WINDOW_MIN as both step and gap.
  const G = { min: 0, max: WINDOW_MAX, minGap: WINDOW_MIN, step: WINDOW_MIN };
  const grid = (k: number) => Number((k * WINDOW_MIN).toPrecision(12));
  const N = Math.round(WINDOW_MAX / WINDOW_MIN);

  it("a thumb stopped by the gap keeps end − start >= minGap in floating point", () => {
    for (let k = 0; k < N; k++) {
      const lo = grid(k);
      const [a, b] = moveThumb([lo, WINDOW_MAX], 1, 0, G);
      expect(a).toBe(lo);
      expect(b - a >= WINDOW_MIN).toBe(true);
      expect(b).toBeCloseTo(lo + WINDOW_MIN, 12);
      const hi = grid(k + 1);
      const [c, d] = moveThumb([0, hi], 0, 1, G);
      expect(d).toBe(hi);
      expect(d - c >= WINDOW_MIN).toBe(true);
      expect(c).toBeCloseTo(hi - WINDOW_MIN, 12);
    }
  });

  it("so the session's clampWindow never rewrites a pane value", () => {
    for (let k = 0; k < N; k++) {
      const p = moveThumb([grid(k), WINDOW_MAX], 1, 0, G);
      expect(clampWindow(p)).toEqual(p);
      const q = moveThumb([0, grid(k + 1)], 0, 1, G);
      expect(clampWindow(q)).toEqual(q);
    }
  });

  it("an off-grid partner rounds the stopped thumb OUTWARD onto the grid", () => {
    expect(moveThumb([0.1003, 0.9], 1, 0, G)).toEqual([0.1003, 0.11]);
    expect(moveThumb([0.1, 0.5003], 0, 1, G)).toEqual([0.495, 0.5003]);
  });

  it("normalizePair opens a collapsed pair to an exact gap", () => {
    for (let k = 0; k <= N; k++) {
      const [a, b] = normalizePair([grid(k), grid(k)], G);
      expect(b - a >= WINDOW_MIN).toBe(true);
      expect(a >= 0 && b <= WINDOW_MAX).toBe(true);
    }
  });

  it("does not snap a free drag", () => {
    expect(moveThumb([0.1, 0.5], 1, 0.3217, G)).toEqual([0.1, 0.3217]);
  });
});
