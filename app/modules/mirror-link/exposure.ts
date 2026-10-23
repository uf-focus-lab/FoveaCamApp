// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-fovea TRIGGERED exposure override: each trajectory marker's trigger pulse
// IS the exposure window (`ExposureMode = TriggerWidth`), with a Timed fallback
// for a model without TriggerWidth. Pure over a `Camera`-shaped timing seam, so
// it unit-tests with a fake. The trigger mode itself (TriggerMode/Source, the
// strobe line) is programmed by `enableHardwareTrigger` in the session, not
// here. Vue-free, core-free.
// spec: docs/spec/mirror-link.md#exposure-windows

/** The subset of a leased `Camera` the override touches. */
export interface TimingCamera {
  frame_rate_enable: boolean;
  frame_rate: number;
  readonly frame_rate_range: { min: number; max: number };
  exposure: number;
  readonly exposure_range: { min: number; max: number };
  exposure_auto: "Off" | "Once" | "Continuous";
  /** `arv_camera_set_exposure_mode`; false when the model refuses the mode. */
  setExposureMode(mode: string): boolean;
  getFeature(name: string): string;
  setFeature(name: string, value: string): void;
}

/** How the cameras take the window (contract `ScanTelemetry.exposure_mode`). */
export type TriggeredExposureMode = "TriggerWidth" | "Timed";

/** The pre-scan timing, restored verbatim on stop / idle. `exposure_mode` /
 *  `trigger_activation` are null when the model has no such node (the restore
 *  then skips them rather than writing a value it never read). */
export type TimingSnapshot = {
  frame_rate_enable: boolean;
  frame_rate: number;
  exposure_auto: TimingCamera["exposure_auto"];
  exposure: number;
  exposure_mode: string | null;
  trigger_activation: string | null;
};

/** What the camera actually took: the mode, the Timed exposure (0 in
 *  TriggerWidth — the pulse is the exposure) and the readback frame rate. */
export type TriggeredTiming = {
  exposure_mode: TriggeredExposureMode;
  exposure_us: number;
  frame_rate: number;
};

/** Default mismatch tolerance: 2 % of the requested window. */
const DEFAULT_MISMATCH_TOL = 0.02;

const clamp = (v: number, r: { min: number; max: number }): number =>
  Math.min(Math.max(v, r.min), r.max);

/** True when the APPLIED exposure misses the requested window by more than
 *  `tol` (fractional) — the frame then integrates less/more of the path than
 *  the marker asked for. */
export function exposureMismatch(
  exposureUs: number,
  windowUs: number,
  tol: number = DEFAULT_MISMATCH_TOL,
): boolean {
  return Math.abs(exposureUs - windowUs) > tol * windowUs;
}

const readOrNull = (read: () => string): string | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/** Read the camera's current timing, to be restored verbatim later. */
export function snapshotTiming(cam: TimingCamera): TimingSnapshot {
  return {
    frame_rate_enable: cam.frame_rate_enable,
    frame_rate: cam.frame_rate,
    exposure_auto: cam.exposure_auto,
    exposure: cam.exposure,
    exposure_mode: readOrNull(() => cam.getFeature("ExposureMode")),
    trigger_activation: readOrNull(() => cam.getFeature("TriggerActivation")),
  };
}

/** `setExposureMode` → true on success; a thrown write counts as refused. */
function trySetExposureMode(cam: TimingCamera, mode: string): boolean {
  try {
    return cam.setExposureMode(mode);
  } catch {
    return false;
  }
}

/**
 * Override the camera's timing for a TRIGGERED scan, AFTER the trigger mode is
 * on (`enableHardwareTrigger` — whose `arv_camera_set_trigger` resets
 * TriggerActivation to RisingEdge, so this runs second):
 *
 * 1. `exposure_auto = Off` (an auto exposure would fight every write), then
 *    frame-rate enable OFF (the trigger paces the frames; with the rate limit
 *    off the exposure ceiling only widens, so one exposure write fits).
 * 2. `preferTriggerWidth` and the model takes `ExposureMode = TriggerWidth` AND
 *    `TriggerActivation = LevelHigh`: the trigger pulse IS the exposure — no
 *    exposure value is written, so the triangle's two windows may differ.
 * 3. Otherwise the Timed fallback: `ExposureMode = Timed`,
 *    `TriggerActivation = RisingEdge`, `exposure = clamp(pulseUs,
 *    exposure_range)` (min AND max, read at the write).
 *
 * Throws when neither mode can be set — the session restores and refuses.
 * @returns the values the camera actually took.
 */
export function applyTriggeredTiming(
  cam: TimingCamera,
  { pulseUs, preferTriggerWidth }: { pulseUs: number; preferTriggerWidth: boolean },
): TriggeredTiming {
  cam.exposure_auto = "Off";
  cam.frame_rate_enable = false;
  if (preferTriggerWidth && trySetExposureMode(cam, "TriggerWidth")) {
    try {
      cam.setFeature("TriggerActivation", "LevelHigh");
      return { exposure_mode: "TriggerWidth", exposure_us: 0, frame_rate: cam.frame_rate };
    } catch {
      // TriggerWidth without a level activation would expose for nothing —
      // fall through to Timed.
    }
  }
  if (!trySetExposureMode(cam, "Timed"))
    throw new Error("camera refused both ExposureMode=TriggerWidth and ExposureMode=Timed");
  cam.setFeature("TriggerActivation", "RisingEdge");
  cam.exposure = clamp(pulseUs, cam.exposure_range);
  return { exposure_mode: "Timed", exposure_us: cam.exposure, frame_rate: cam.frame_rate };
}

/**
 * Restore {@link snapshotTiming}'s values verbatim: the exposure MODE first (so
 * a Timed exposure is writable again), then TriggerActivation, then the
 * two-sided exposure write around the frame rate (the ceiling moves with the
 * rate), and `exposure_auto` LAST so a `Continuous` mode never re-drives the
 * intermediate writes. Run AFTER `disableHardwareTrigger`.
 */
export function restoreTiming(cam: TimingCamera, snap: TimingSnapshot): void {
  if (snap.exposure_mode !== null && !trySetExposureMode(cam, snap.exposure_mode))
    cam.setFeature("ExposureMode", snap.exposure_mode);
  if (snap.trigger_activation !== null)
    cam.setFeature("TriggerActivation", snap.trigger_activation);
  cam.exposure = clamp(snap.exposure, cam.exposure_range);
  cam.frame_rate = clamp(snap.frame_rate, cam.frame_rate_range);
  cam.frame_rate_enable = snap.frame_rate_enable;
  cam.exposure = clamp(snap.exposure, cam.exposure_range);
  cam.exposure_auto = snap.exposure_auto;
}
