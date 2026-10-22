// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the manage-cameras session — a live property snapshot per
// camera (`telemetry.views`, keyed by serial); edits + the pixel-format
// reconfigure flow are commands. The L/R fovea-pair link rides telemetry
// as `pair` with its own paired write commands.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import type { AutoMode, CameraControlsView, Range, Role } from "@lib/camera-config";
import type { CameraInfo } from "@lib/orchestrator/contracts";

export type { CameraInfo };
// Canonical `Range`/`AutoMode` live with the control schema (@lib/camera-config);
// re-exported here so existing `./contract` importers keep working.
export type { Range, AutoMode };

/** Live UI-bound property snapshot for one camera. A flat `type` literal (not
 *  `& CameraControlsView`) so it keeps an implicit index signature assignable to
 *  the wire `Serializable` constraint; the tunable half is schema-guarded below. */
export type CameraView = {
  description: string;
  role?: Role;
  pixel_format: string;
  pixel_format_options: string[];
  frame_rate_available: boolean;
  frame_rate_enable: boolean;
  frame_rate: number;
  frame_rate_range: Range;
  exposure_auto_available: boolean;
  exposure_auto: AutoMode;
  exposure: number;
  exposure_range: Range;
  gain_auto_available: boolean;
  gain_auto: AutoMode;
  gain: number;
  gain_range: Range;
  black_level_available: boolean;
  black_level_auto_available: boolean;
  black_level_auto: AutoMode;
  black_level: number;
  black_level_range: Range;
};

// Drift guard: the control half of `CameraView` must be structurally
// identical to the schema-owned `CameraControlsView` in @lib/camera-config —
// `readControlFields` is typed to produce that, and `readView` spreads it into
// a `CameraView`. If either side gains/loses/retypes a control field, one of
// these assignments fails to compile.
type ControlHalf = Omit<CameraView, "description" | "role" | "pixel_format" | "pixel_format_options">;
type _AB = CameraControlsView extends ControlHalf ? true : never;
type _BA = ControlHalf extends CameraControlsView ? true : never;
const _controlsConform: [_AB, _BA] = [true, true];
void _controlsConform;

/** Trigger budget derived from the pair's exposure config (`pairTriggerBudget`)
 *  — the pair panel's readout row. Settle hold is NOT included here (it is
 *  per-triple and added by the tracking apps that drive the trigger). */
export type PairBudgetView = {
  /** Trigger pulse width (µs, the wire unit — `FrameArg.pulse`). */
  pulseUs: number;
  maxRateHz: number;
  minIntervalMs: number;
  exposureUsL: number;
  exposureUsR: number;
};

/** Fovea Pair link: present while exactly one camera holds role L and one
 *  holds role R. Pair values persist into BOTH cameras' existing config docs
 *  (no new store doc — every other config reader stays untouched). */
export type FoveaPairView = {
  left: string;
  right: string;
  /** Divergent pair-linked keys — non-empty gates the pair panel behind the
   *  explicit unify prompt (`unifyPair`); never silently overwrite either side. */
  divergent: string[];
  budget: PairBudgetView;
};

/** One camera's trigger self-test verdict (§Trigger test): the SOFTWARE leg
 *  (camera → convert-pipe frame path, `TriggerSource=Software` + a software
 *  trigger) and the HARDWARE leg (one real MCU pulse on camera `Line3` —
 *  proves the trigger INPUT chain only; the `Line2` strobe RETURN line is only
 *  proven by a live trigger-sync engage). `sw: "fail"` indicts the camera/stream path;
 *  `sw: "ok"` + `hw: "fail"` isolates the trigger wiring; `"no-controller"` =
 *  the hardware leg could not run; `"unavailable"` = the convert producer's
 *  frame probe is dead (pipe parked) — not a pass or a fail. */
export type TriggerTestVerdict = {
  sw: "ok" | "fail" | "skipped" | "unavailable";
  hw: "ok" | "fail" | "no-controller" | "unavailable";
};

/** Latest fovea-pair trigger self-test result, or null (never run / reset on
 *  idle). `at` = completion epoch ms. `C` is present when exactly one camera
 *  holds the Wide Angle role: the V0.1 board cables the center camera's
 *  trigger too, and CMD_TRIGGER pulses every camera's trigger line, so the
 *  same test checks its wiring. */
export type TriggerTestResult = {
  at: number;
  L: TriggerTestVerdict;
  R: TriggerTestVerdict;
  C?: TriggerTestVerdict;
};

export const manageCameras = defineContract({
  state: {},
  telemetry: {
    list: [] as CameraInfo[],
    /** Per-camera live snapshot, keyed by serial. */
    views: {} as Record<string, CameraView>,
    /** The L/R fovea-pair link, or null while unlinked. */
    pair: null as FoveaPairView | null,
    /** Why the link is BLOCKED despite fovea roles being claimed (duplicate
     *  role claims), or null — an actionable hint; the pair panel silently
     *  vanishing reads as a bug. */
    pair_blocked: null as string | null,
    /** Latest fovea-pair trigger self-test verdicts (§Trigger test), or null
     *  (never run this session / reset on idle). */
    trigger_test: null as TriggerTestResult | null,
  },
  // Preview channels are dynamic, one per serial (e.g. `frame(serial)`).
  frames: [] as const,
  commands: {
    /** Rescan connected cameras; also pushed as telemetry. */
    refresh: cmd<void, CameraInfo[]>(),
    /** Set a camera property (or `role`) and persist it. */
    set: cmd<{ serial: string; key: string; value: unknown }>(),
    /** Change pixel format (pauses/reconfigures acquisition) and persist it. */
    setPixelFormat: cmd<{ serial: string; format: string }>(),
    /** Set a pair-linked property on BOTH fovea cameras (refused while the
     *  pair is divergent — unify first). */
    setPair: cmd<{ key: string; value: unknown }>(),
    /** Change BOTH fovea cameras' pixel format (two sequential reconfigures). */
    setPairPixelFormat: cmd<{ format: string }>(),
    /** Copy the pair-linked config of `source` (one of the pair's serials)
     *  onto the other camera — the explicit divergence resolution. */
    unifyPair: cmd<{ source: string }>(),
    /** Run the fovea-pair trigger self-test (§Trigger test): fires a real
     *  software then hardware trigger on BOTH fovea cameras (and the center
     *  camera, when one holds the Wide Angle role), restoring free-run, and
     *  publishes `trigger_test`. No-op unless the pair is linked. */
    testTrigger: cmd(),
    /** Reset a camera to auto defaults and clear its stored config. */
    reset: cmd<{ serial: string }>(),
  },
});

export type ManageCamerasContract = typeof manageCameras;
