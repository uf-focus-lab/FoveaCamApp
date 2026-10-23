// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The value math behind `dual-range-slider.vue`, kept pure so it is unit-tested
// without a DOM: two thumbs on [min, max] that never cross and never come closer
// than `minGap`. Ranges are ASCENDING (min < max); a degenerate range collapses
// both thumbs onto `min`.
//
// `minGap` holds EXACTLY in floating point: a thumb stopped by the gap lands on
// the `step` grid (anchored at `min`) and is nudged outward by ULPs until
// `hi − lo >= minGap` evaluates true — so a consumer re-checking the gap with
// the same comparison (the mirror-link session's `clampWindow`) never has to
// rewrite the pair.

export type Pair = [number, number];
export type Thumb = 0 | 1;
export type DualRangeBounds = {
  min: number;
  max: number;
  minGap: number;
  /** The grid a gap-limited thumb snaps to; omitted (or ≤ 0) = no grid. */
  step?: number;
};

/** The usable gap: never negative, never wider than the range itself. */
function gapOf({ min, max, minGap }: DualRangeBounds): number {
  return Math.max(0, Math.min(minGap, Math.max(0, max - min)));
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Relative tolerance (in steps) under which a value counts as ON the grid. */
const GRID_EPS = 1e-6;

/** At least one ULP of `v`. */
const ulp = (v: number) => Math.max(Math.abs(v) * Number.EPSILON, Number.MIN_VALUE);

/**
 * The limit `gap` away from `from` in direction `dir`: on the step grid
 * (rounded OUTWARD, so the gap never shrinks) when that grid point lies in the
 * range, then nudged outward until `dir · (v − from) >= gap` holds in floating
 * point. The caller clamps the result to the range.
 */
export function gapEdge(
  from: number,
  dir: 1 | -1,
  gap: number,
  bounds: DualRangeBounds,
): number {
  if (!(gap > 0)) return from;
  const { min, max, step } = bounds;
  let v = from + dir * gap;
  if (step !== undefined && step > 0) {
    const k = (v - min) / step;
    const near = Math.round(k);
    const kk =
      Math.abs(k - near) < GRID_EPS ? near : dir > 0 ? Math.ceil(k) : Math.floor(k);
    // `toPrecision(12)` strips the k·step float noise (0.1 + 0.2 → 0.3).
    const g = Number((min + kk * step).toPrecision(12));
    if (g >= min && g <= max) v = g;
  }
  while (dir * (v - from) < gap) v += dir * ulp(v);
  return v;
}

/**
 * Move ONE thumb to `value`; the other stays put. The moved thumb stops at the
 * range ends and `minGap` short of the other thumb — it never pushes it, so a
 * drag can never move the value the operator is not touching.
 */
export function moveThumb(
  pair: Pair,
  which: Thumb,
  value: number,
  bounds: DualRangeBounds,
): Pair {
  const { min, max } = bounds;
  if (!(max > min)) return [min, min];
  const gap = gapOf(bounds);
  const [lo, hi] = normalizePair(pair, bounds);
  // The gap edge wins over the range end it may overshoot by a ULP: the
  // normalized pair already guarantees the range end itself keeps the gap.
  if (which === 0)
    return [Math.max(min, Math.min(gapEdge(hi, -1, gap, bounds), value)), hi];
  return [lo, Math.min(max, Math.max(gapEdge(lo, 1, gap, bounds), value))];
}

/**
 * Bring an arbitrary pair (a model value from elsewhere, a `neutral`) into the
 * slider's invariant: sorted, inside [min, max], at least `minGap` apart. The
 * START wins when the two conflict (the end is pushed out, then the start back
 * in if the end hit `max`).
 */
export function normalizePair(pair: Pair, bounds: DualRangeBounds): Pair {
  const { min, max } = bounds;
  if (!(max > min)) return [min, min];
  const gap = gapOf(bounds);
  const a = Math.min(pair[0], pair[1]);
  const b = Math.max(pair[0], pair[1]);
  const lo = clamp(a, min, gapEdge(max, -1, gap, bounds));
  const hi = Math.min(max, Math.max(b, gapEdge(lo, 1, gap, bounds)));
  return [lo, hi];
}

/**
 * Which thumb a press at `value` grabs: the nearer one. When the press is
 * equidistant (coincident thumbs at `minGap = 0`, or exactly midway) the side
 * decides — at or past the end thumb grabs the end, otherwise the start — so a
 * pair stacked at `max` can still be pulled apart from the left.
 */
export function nearestThumb(pair: Pair, value: number): Thumb {
  const d0 = Math.abs(value - pair[0]);
  const d1 = Math.abs(value - pair[1]);
  if (d0 < d1) return 0;
  if (d1 < d0) return 1;
  return value >= pair[1] && value > pair[0] ? 1 : 0;
}
