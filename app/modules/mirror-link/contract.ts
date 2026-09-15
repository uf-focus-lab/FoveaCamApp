// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the mirror-link session — a calibrated L/C/R triple whose
// two fovea mirrors trace a fast CIRCULAR scan around a hand-aimed center while
// each fovea's exposure spans exactly one revolution. Behavior spec:
// docs/spec/mirror-link.md.

import { cmd, defineContract } from "@lib/orchestrator/protocol";
import {
  captureCommands,
  captureTelemetry,
} from "@lib/orchestrator/contracts";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import type { Stat } from "@lib/orchestrator/contracts";
import type { RingReadout } from "@lib/ring-code";

/** The applied scan timing, published exactly while the scan is ACTIVE (spec
 *  §lifecycle). `exposure_us`/`frame_rate` are the values the cameras actually
 *  took (post-clamp), so a rig that can't reach `hz` is visible; `mismatch` is
 *  set when the applied exposure misses `period_us` by more than the tolerance.
 *
 *  MUST stay a `type` alias, NOT an `interface` — a telemetry slot's value is
 *  constrained to `Serializable` (an index-signature type), which an interface
 *  does not satisfy implicitly. */
export type ScanTelemetry = {
  hz: number;
  amp_deg: number;
  period_us: number;
  exposure_us: { L: number; R: number };
  frame_rate: { L: number; R: number };
  mismatch: boolean;
};

/** The auto-align SERVO's live readout (spec §targeting) — non-null exactly
 *  while engaged. `error_deg` is the per-eye angular error the PID nodes are
 *  driving to zero; a wrong `SPOT_TO_ANGLE_SIGN` shows up as it GROWING.
 *  A type alias, NOT an interface (telemetry values must be `Serializable`). */
export type AlignTelemetry = {
  engaged: boolean;
  /** Where the emitter was last seen in each fovea frame (fovea px). */
  spots: { L: Point2d | null; R: Point2d | null };
  /** Residual angular error per eye (degrees); null while that eye has no spot. */
  error_deg: { L: Point2d | null; R: Point2d | null };
  /** What the last step applied. */
  applied: {
    angle: Point2d;
    distance_mm: number | null;
    shift_deg: number;
  } | null;
  /** Why the servo is not converging, when it is not (both eyes blind). */
  reason?: string;
};

export const mirrorLink = defineContract({
  state: {
    /** Leased camera serials per role — the L/R views bind the RAW
     *  `camera/<serial>/convert` pipes (spec §views). Set on acquire. */
    serials: {} as Partial<Record<"L" | "C" | "R", string>>,
    /** The advertised center `undistort:<serial>` pipe id while active — null
     *  when unadvertised (no calibration); the renderer falls back to the raw
     *  convert pipe. */
    undistortPipe: null as string | null,
    // Alignment parameters (spec §targeting).
    baseline: 200, // stereo baseline (mm)
    verge: 0, // verge slider (0 → ∞ distance)
    shift: 0, // vertical toe shift (deg, ±0.5) — +s raises L, lowers R
    /** Session-wide fovea gain override (dB, BOTH eyes; spec §gain). Null =
     *  never set — the session seeds it from the leased cameras instead of
     *  writing one. */
    gain: null as number | null,
    /** Frames averaged into one capture shot (spec §capture). 1 = a single
     *  revolution, which is what a ring frame is. */
    cap_stack: 1,
    /** Ring-reader node ON/OFF (spec §reader). Default OFF: the decoder is a
     *  worker thread over both fovea pipes, built only while this is set. */
    ring_reader: false as boolean,
    /** Which histogram stage the drawer shows (spec §ring-views). "off" stops
     *  the worker building strips at all. */
    ring_view: "off" as "off" | "polar" | "binary" | "segments",
    // Auto-align servo gains, shared by all four controllers (spec §targeting)
    // — angle-out per angle-in, dt in seconds. FLAT keys: the session client
    // only emits `setState` from a top-level key's ref, so a nested object's
    // fields would never reach the orchestrator.
    pid_kp: 0.5,
    pid_ki: 0.05,
    pid_kd: 0,
    /** Per-step clamp on each controller's angle increment (degrees). */
    pid_max_step_deg: 0.2,
    // Scan parameters (spec §scan) — LIVE while active.
    scan_hz: 10, // 100 ms revolution

    scan_amp: 0.5, // scan radius (deg)
  },
  telemetry: {
    ready: false as boolean, // calibrated triple leased + conversions loaded
    target: { x: 0, y: 0 } as Point2d, // scan center, wide px
    target_angle: { x: 0, y: 0 } as Point2d, // ...and in radians (angular)
    /** The commanded pose: the mirrors' idle pose, and while scanning the
     *  ring's CENTER — the PosView crosshair stays put instead of flickering at
     *  the telemetry throttle (spec §views). */
    volt: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } } as { L: Pos; R: Pos },
    /** The commanded scan circle in VOLT space, one closed loop per eye
     *  (`SCAN_PATH_SAMPLES` points) — the PosViews draw the path itself.
     *  Empty uncalibrated; republished on every geometry change, never per
     *  tick (spec §views). */
    scan_path: { L: [], R: [] } as { L: Pos[]; R: Pos[] },
    // Per-eye wide-px projection of the offset-free CENTER pose (shift
    // included) — where each fovea is aimed; {0,0} uncalibrated (spec §views).
    L_PX: { x: 0, y: 0 } as Point2d,
    R_PX: { x: 0, y: 0 } as Point2d,
    /** Scan ring radius in wide px at the current center/amplitude; 0
     *  uncalibrated (spec §views). */
    scan_px: 0,
    /** The gain range BOTH foveas honor — the intersection of their
     *  `gain_range`s (spec §gain). `min === max === 0` until leased (or on a
     *  disjoint pair): the slider stays disabled. */
    gain_range: { min: 0, max: 0 } as { min: number; max: number },
    /** Per-eye ring-code readout (spec §reader) — null until the reader has
     *  produced a result for that eye this session. A failure carries the
     *  reason plus the LAST successful read, so the decoded value stays on
     *  screen across dropped frames. */
    ring: { L: null, R: null } as {
      L: RingReadout | null;
      R: RingReadout | null;
    },
    /** Applied scan timing — non-null exactly while ACTIVE (spec §lifecycle). */
    scan: null as ScanTelemetry | null,
    /** Human-readable reason the last `startScan` was refused (or why the
     *  override could not be applied); null while active or never refused. */
    scan_blocked: null as string | null,
    /** The auto-align servo's readout — non-null exactly while engaged
     *  (spec §targeting). */
    align: null as AlignTelemetry | null,
    // Control-path latency — `c.actuate()` round-trip — and the pacer's own
    // tick interval: a stall on the orchestrator loop (an allocation, a
    // synchronous native call) shows up as a `tickGapMs.max` spike, which on
    // the rig is a straight chord across the scanned ring.
    perf: {
      actuateMs: { mean: 0, max: 0 } as Stat,
      tickGapMs: { mean: 0, max: 0 } as Stat,
      // The native scan generator: whether it owns the wire, and its measured
      // emit rate (~1 kHz). A rate that holds while `tickGapMs.max` spikes is
      // the whole point of the brick.
      orbit: { native: false as boolean, rateHz: 0 },
    },
    // Capture manifest telemetry (spec §capture); image data pulled via
    // `getCapturePreview`.
    ...captureTelemetry(),
    // Recording.
    recording_active: false as boolean,
    recordingStreams: {} as Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >,
  },
  // The only session frames: the per-eye ring debug strips (spec §ring-views);
  // every other view binds a native pipe directly.
  frames: ["ring-L", "ring-R"] as const,
  commands: {
    /** Move the scan CENTER to a wide-view pixel (spec §targeting). */
    steer: cmd<Point2d>(),
    /** Engage the auto-align servo: it drives both foveas onto the emitter and
     *  keeps them there, rewriting verge + shift every step (spec §targeting).
     *  Resolves `false` when refused. */
    startAlign: cmd<void, boolean>(),
    /** Disengage the servo (the mirrors hold their last commanded pose). */
    stopAlign: cmd(),
    /** Start the circular scan + the per-fovea exposure override. Resolves
     *  `false` when refused, with the reason on `telemetry.scan_blocked`. */
    startScan: cmd<void, boolean>(),
    /** Stop the scan and restore the pre-scan camera timing. */
    stopScan: cmd(),
    // Shared capture mixin: `captureShot`/`getCapturePreview`/`saveCapture`/
    // `discardCapture` (spec §capture).
    ...captureCommands(),
    /** Start writing raw L/C/R streams to disk at `path`. */
    startRecording: cmd<{ path: string }, boolean>(),
    /** Stop the active recording. */
    stopRecording: cmd(),
  },
});

export type MirrorLinkContract = typeof mirrorLink;
