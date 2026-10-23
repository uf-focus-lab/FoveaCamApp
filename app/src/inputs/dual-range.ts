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

export type Pair = [number, number];
export type Thumb = 0 | 1;
export type DualRangeBounds = { min: number; max: number; minGap: number };

/** The usable gap: never negative, never wider than the range itself. */
function gapOf({ min, max, minGap }: DualRangeBounds): number {
  return Math.max(0, Math.min(minGap, Math.max(0, max - min)));
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

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
  if (which === 0) return [clamp(value, min, hi - gap), hi];
  return [lo, clamp(value, lo + gap, max)];
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
  const lo = clamp(a, min, max - gap);
  const hi = clamp(Math.max(b, lo + gap), lo + gap, max);
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
