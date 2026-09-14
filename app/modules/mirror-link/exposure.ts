// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-fovea exposure override: one frame integrates one scan revolution.
// Pure over a `Camera`-shaped timing seam, so it unit-tests with a fake whose
// exposure ceiling tracks its frame rate (the real constraint the write order
// exists for). Vue-free, core-free.
// spec: docs/spec/mirror-link.md#exposure

/** The subset of a leased `Camera` the override touches. */
export interface TimingCamera {
  frame_rate_enable: boolean;
  frame_rate: number;
  readonly frame_rate_range: { min: number; max: number };
  exposure: number;
  readonly exposure_range: { min: number; max: number };
  exposure_auto: "Off" | "Once" | "Continuous";
}

/** The pre-scan timing, restored verbatim on stop / idle / re-apply. */
export type TimingSnapshot = {
  frame_rate_enable: boolean;
  frame_rate: number;
  exposure_auto: TimingCamera["exposure_auto"];
  exposure: number;
};

/** Default mismatch tolerance: 2 % of the revolution period. */
const DEFAULT_MISMATCH_TOL = 0.02;

const clamp = (v: number, r: { min: number; max: number }): number =>
  Math.min(Math.max(v, r.min), r.max);

/** One scan revolution, in microseconds. */
export function scanPeriodUs(hz: number): number {
  return 1e6 / hz;
}

/** True when the APPLIED exposure misses the revolution period by more than
 *  `tol` (fractional) — the frame then spans less/more than one revolution and
 *  the ring readout is incomplete. */
export function exposureMismatch(
  exposureUs: number,
  periodUs: number,
  tol: number = DEFAULT_MISMATCH_TOL,
): boolean {
  return Math.abs(exposureUs - periodUs) > tol * periodUs;
}

/** Read the camera's current timing, to be restored verbatim later. */
export function snapshotTiming(cam: TimingCamera): TimingSnapshot {
  return {
    frame_rate_enable: cam.frame_rate_enable,
    frame_rate: cam.frame_rate,
    exposure_auto: cam.exposure_auto,
    exposure: cam.exposure,
  };
}

/**
 * Override the camera's timing so one frame integrates one revolution:
 * `exposure = 1e6 / hz`, `frame_rate = hz`, frame-rate enable on, exposure-auto
 * Off. The exposure ceiling depends on the live frame rate, so exposure is
 * written BOTH before the rate write (fits the old ceiling) and after (fits the
 * new one), clamped to the range read at each write. A camera slower than `hz`
 * keeps its max rate with `exposure = period` (dead time between frames — still
 * one revolution per frame).
 *
 * @returns the values the camera actually took.
 */
export function applyScanTiming(
  cam: TimingCamera,
  hz: number,
): { exposure_us: number; frame_rate: number } {
  const target = scanPeriodUs(hz);
  cam.exposure_auto = "Off"; // first: an auto exposure would fight every write
  cam.exposure = clamp(target, cam.exposure_range);
  cam.frame_rate_enable = true;
  cam.frame_rate = clamp(hz, cam.frame_rate_range);
  cam.exposure = clamp(target, cam.exposure_range);
  return { exposure_us: cam.exposure, frame_rate: cam.frame_rate };
}

/**
 * Restore {@link snapshotTiming}'s values — the same two-sided exposure write as
 * {@link applyScanTiming} (the ceiling moves with the rate), with `exposure_auto`
 * written LAST so a `Continuous` mode never re-drives the intermediate writes.
 */
export function restoreTiming(cam: TimingCamera, snap: TimingSnapshot): void {
  cam.exposure = clamp(snap.exposure, cam.exposure_range);
  cam.frame_rate = clamp(snap.frame_rate, cam.frame_rate_range);
  cam.frame_rate_enable = snap.frame_rate_enable;
  cam.exposure = clamp(snap.exposure, cam.exposure_range);
  cam.exposure_auto = snap.exposure_auto;
}
