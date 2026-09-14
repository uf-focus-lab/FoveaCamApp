// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Session-wide fovea GAIN override. Pure over a `Camera`-shaped seam (Vue-free,
// core-free) so it unit-tests with a fake; the same live-handle / snapshot /
// restore model as the exposure override, but active for the WHOLE session span.
// spec: docs/spec/mirror-link.md#gain

/** The subset of a leased `Camera` the gain override touches. */
export interface GainCamera {
  gain: number;
  readonly gain_range: { min: number; max: number };
  gain_auto: "Off" | "Once" | "Continuous";
}

/** The pre-session gain, restored verbatim on idle. `gain_auto` is absent on a
 *  camera without that node — the restore then writes the value alone. */
export type GainSnapshot = {
  gain: number;
  gain_auto?: GainCamera["gain_auto"];
};

/** An empty/unknown range — the UI reads `min === max` as "no slider yet". */
const EMPTY_RANGE = { min: 0, max: 0 } as const;

/**
 * The range BOTH foveas can honor. A disjoint pair has no common value, so it
 * degrades to the empty range (the slider stays disabled) rather than inventing
 * a bound one camera would reject.
 */
export function intersectRanges(
  a: { min: number; max: number },
  b: { min: number; max: number },
): { min: number; max: number } {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min <= max ? { min, max } : { ...EMPTY_RANGE };
}

/** Read the camera's current gain, to be restored verbatim later. A camera with
 *  no `gain_auto` node records the value alone. */
export function snapshotGain(cam: GainCamera): GainSnapshot {
  const snap: GainSnapshot = { gain: cam.gain };
  try {
    snap.gain_auto = cam.gain_auto;
  } catch {
    // no auto-gain node on this model — nothing to restore later
  }
  return snap;
}

/**
 * Drive the camera to `dB`, clamped to its LIVE range. `gain_auto` goes Off
 * first — an auto gain would otherwise fight the write; a model without that
 * node still gets its value.
 *
 * @returns the value the camera took.
 */
export function applyGain(cam: GainCamera, dB: number): number {
  try {
    cam.gain_auto = "Off";
  } catch {
    // no auto-gain node on this model — the value write below still stands
  }
  const { min, max } = cam.gain_range;
  cam.gain = Math.min(Math.max(dB, min), max);
  return cam.gain;
}

/** Reverts {@link applyGain} — the value first, then the auto mode (when the
 *  snapshot has one), so a restored `Continuous` never re-drives the value. */
export function restoreGain(cam: GainCamera, snap: GainSnapshot): void {
  const { min, max } = cam.gain_range;
  cam.gain = Math.min(Math.max(snap.gain, min), max);
  if (snap.gain_auto !== undefined) cam.gain_auto = snap.gain_auto;
}
