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
import type { Point2d, Rect } from "core/Geometry";
import { DEFAULT_VERGENCE_TUNING } from "@lib/vergence/tuning";
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

/** Matched fovea footprint + confidence, lifted into wide-frame pixels — the
 *  disparity-scope `MatchInfo` shape (the loop is the same loop).
 *  A type alias, NOT an interface (telemetry values must be `Serializable`). */
export type MatchInfo = { rect: Rect; score: number };

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
    /** Auto-vergence ON/OFF (spec §targeting). Session-local intent, like the
     *  scan: the loop's nodes exist only while this is set. */
    auto_vergence: false as boolean,
    /** The vergence loop's tuning — the SHARED surface (@lib/vergence/tuning),
     *  identical keys/defaults to Disparity Scope so the two drawers read the
     *  same. Written as a WHOLE object (the session client only emits
     *  `setState` from a top-level key's ref). */
    tuning: DEFAULT_VERGENCE_TUNING,
    // Scan parameters (spec §scan) — LIVE while active.
    scan_hz: 10, // 100 ms revolution

    scan_amp: 0.5, // scan radius (deg)
    /** The native generator's tick rate (Hz, clamped 200–1000 by the brick).
     *  No slider — a config/rig knob for a serial link that cannot carry
     *  1 kHz; the geometry is unaffected, only the poses per revolution
     *  (spec §actuation). */
    orbit_pace_hz: 1000,
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
    /** The vergence loop's status: `off` / `tracking` / `paused: scanning` /
     *  `hold: match low score` / `hold: match stale` / `no calibration`. */
    vergence_status: "off" as string,
    /** Why the last `startVergence` was refused; null while engaged or never
     *  refused — the `scan_blocked` shape (spec §targeting). */
    vergence_blocked: null as string | null,
    /** Per-eye match footprint + confidence in ABSOLUTE wide px (spec
     *  §targeting) — the wide view draws their centers while engaged, so a
     *  `hold: match low score` shows WHAT was matched. */
    match_left: null as MatchInfo | null,
    match_right: null as MatchInfo | null,
    // Control-path latency — `c.actuate()` round-trip — and the pacer's own
    // tick interval: a stall on the orchestrator loop (an allocation, a
    // synchronous native call) shows up as a `tickGapMs.max` spike, which on
    // the rig is a straight chord across the scanned ring.
    perf: {
      actuateMs: { mean: 0, max: 0 } as Stat,
      tickGapMs: { mean: 0, max: 0 } as Stat,
      // The native scan generator. `emitHz` is the brick's own thread (a rate
      // that holds while `tickGapMs.max` spikes is the whole point of the
      // brick); `sinkHz` is what reaches the WIRE after the mirror sink's gate
      // and AIMD governor. `sinkHz / scan_hz` is the poses per revolution —
      // too few and the ring is drawn as a polygon, so the governor block says
      // which signal caused the backoff (spec §actuation).
      orbit: {
        native: false as boolean,
        emitHz: 0,
        sinkHz: 0,
        governor: {
          state: "off" as "off" | "steady" | "seeking" | "backoff",
          effectiveRateHz: 0,
          backoffs: 0,
          softFails: 0,
          outq: 0,
        },
      },
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
    /** Engage auto vergence — the fovea-into-wide template-match loop
     *  (spec §targeting). Resolves `false` when refused. */
    startVergence: cmd<void, boolean>(),
    /** Disengage (the mirrors hold the last integrated verge/shift). */
    stopVergence: cmd(),
    /** A Verge/Shift slider is under the pointer: suspend the loop's write-back
     *  so a fully-controlled slider cannot be yanked mid-drag (spec §targeting).
     *  Released with `false`, which re-seeds both controllers from the final
     *  slider values. */
    holdDof: cmd<boolean>(),
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
