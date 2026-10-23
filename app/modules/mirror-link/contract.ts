// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Typed boundary for the mirror-link session — a calibrated L/C/R triple whose
// two fovea mirrors trace a fast periodic SCAN PATTERN (ellipse / line /
// triangle) around a hand-aimed center, run on the MCU as an uploaded
// trajectory whose markers trigger the fovea exposures at exact phases.
// Behavior spec: docs/spec/mirror-link.md (patterns: §scan-patterns).

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
  /** The pattern the trajectory was built from (spec §scan-patterns). */
  mode: ScanMode;
  /** Base scan frequency (`state.scan_hz`). The trajectory period is `1/hz`
   *  for the ellipse and `2/hz` for the triangle (one rising + one falling
   *  sweep per cycle). */
  hz: number;
  amp_deg: number;
  /** The TRAJECTORY period on the MCU (µs): T, or 2T for the triangle. */
  period_us: number;
  /** Trigger markers per period: 1 (ellipse) or 2 (triangle), in marker
   *  order. Each window is `{ t_offset_us, pulse_us }` — the exposure starts
   *  at the offset and lasts the pulse (TriggerWidth exposure). */
  windows: { t_offset_us: number; pulse_us: number }[];
  /** How the cameras take the window: `TriggerWidth` (the trigger pulse IS
   *  the exposure, the primary mode) or `Timed` (fallback on a model without
   *  TriggerWidth: exposure = the first window's pulse; unequal triangle
   *  windows then mismatch). */
  exposure_mode: "TriggerWidth" | "Timed";
  /** Per-eye applied values (post-clamp): the Timed exposure (0 in
   *  TriggerWidth mode) and the camera's readback frame rate limit. */
  exposure_us: { L: number; R: number };
  frame_rate: { L: number; R: number };
  /** Set when the cameras cannot take the requested windows as asked: a
   *  Timed clamp, unequal triangle windows in Timed mode (every marker then
   *  carries marker 0's pulse), a trigger rate above a camera's maximum frame
   *  rate, or two exposures closer end-to-end than the sensor readout. */
  mismatch: boolean;
  /** One sentence naming WHY `mismatch` is set; null when it is not. */
  mismatch_reason: string | null;
};

/** Scan pattern family (spec §scan-patterns). */
export type ScanMode = "ellipse" | "triangle";

/** A fraction-of-slope exposure window `[start, end]`: `0 <= start < end <=
 *  WINDOW_MAX` (0.95, scan.ts) with `end - start >= WINDOW_MIN`. */
export type ScanWindow = [number, number];

/** Trajectory + flip bookkeeping while the scan runs (spec §actuation). */
export type TrajectoryTelemetry = {
  /** True while the MCU trajectory is RUNNING (the node owns the DAC). */
  running: boolean;
  /** Pushes seen this run by status. */
  pushes: { ok: number; timeout: number; busy: number; other: number };
  /** Last marker lateness vs its phase (µs; exact only for an explicit start). */
  lateness_us: number;
  /** Phase-continuous re-uploads this run (steer / slider moves while active). */
  reuploads: number;
  /** Triangle mode: frames the flip bricks flipped / could not match to a
   *  marker, per eye (0 in ellipse mode). Accumulated across brick rebuilds
   *  within one run. */
  flipped: { L: number; R: number };
  unmatched: { L: number; R: number };
  /** Triangle mode: the matched frames' signed offset from the anchor edge
   *  they matched (frame stamp − edge, µs, mean over the probe window), per
   *  eye. Near 0 = the camera stamps the edge the anchor describes; a value
   *  near ±pulse means it stamps the other edge (the brick matches either);
   *  anything else is a clock-alignment problem. */
  skew_us: { L: number; R: number };
  /** The flip bricks' match tolerance this run (µs). */
  flip_tolerance_us: number;
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
    // Scan parameters (spec §scan, §scan-patterns) — LIVE while active (a
    // change re-uploads the trajectory phase-continuously).
    /** Base frequency (Hz): one ellipse revolution, or one triangle SWEEP
     *  (the triangle period is 2/hz). Also the camera trigger rate per
     *  marker. */
    scan_hz: 10,
    /** Pattern family: elliptical (ratio 1 = the circle, 0 = a line) or
     *  triangular (a linear sweep out and back). */
    scan_mode: "ellipse" as ScanMode,
    /** Main-axis direction, degrees counter-clockwise from +x of the wide
     *  angular frame, (-180, 180]. Set by dragging the axis handle on the
     *  center view (`setAxis`) or the pane slider. */
    scan_axis_deg: 0,
    /** Semi-major half-length along the main axis (deg): the ellipse's major
     *  radius, the triangle's half sweep. */
    scan_amp: 0.5,
    /** Ellipse minor/major ratio, 0..1. 0 collapses the ellipse to a linear
     *  sinusoidal scan along the main axis. Ignored by the triangle. */
    scan_ratio: 1,
    /** Ellipse: the exposure window as fractions of the period. One trigger
     *  per period at `start`, exposing for `end - start` of it. */
    scan_window: [0, 0.95] as ScanWindow,
    /** Triangle: exposure window on the RISING sweep (−amp → +amp), as
     *  fractions of that sweep (T). */
    tri_window_rise: [0.05, 0.95] as ScanWindow,
    /** Triangle: exposure window on the FALLING sweep (+amp → −amp). Follows
     *  `tri_window_rise` while `tri_window_sync` is on. */
    tri_window_fall: [0.05, 0.95] as ScanWindow,
    /** Keep the falling window identical to the rising one. */
    tri_window_sync: true as boolean,
    /** Triangle mode: the per-eye FLIP pipe ids the views and the ring reader
     *  must bind instead of the raw convert pipes while the scan runs — the
     *  falling-sweep frame arrives vertically flipped from them (spec
     *  §triangle-flip). Null = bind the raw convert pipe. */
    flipPipes: { L: null, R: null } as { L: string | null; R: string | null },
  },
  telemetry: {
    ready: false as boolean, // calibrated triple leased + conversions loaded
    target: { x: 0, y: 0 } as Point2d, // scan center, wide px
    target_angle: { x: 0, y: 0 } as Point2d, // ...and in radians (angular)
    /** The commanded pose: the mirrors' idle pose, and while scanning the
     *  scan path's CENTER — the PosView crosshair stays put instead of flickering at
     *  the telemetry throttle (spec §views). */
    volt: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } } as { L: Pos; R: Pos },
    /** The commanded scan PATH in VOLT space, one polyline per eye
     *  (`SCAN_PATH_SAMPLES` points; the renderer closes the ellipse, draws the
     *  triangle/line as an open segment) — the PosViews draw the path itself.
     *  Empty uncalibrated; republished on every geometry change, never per
     *  tick (spec §views). */
    scan_path: { L: [], R: [] } as { L: Pos[]; R: Pos[] },
    /** The same path projected into WIDE px for the center view overlay;
     *  empty uncalibrated. `scan_path_closed` says whether to close it (an
     *  ellipse with ratio > 0) — published WITH the path so the renderer never
     *  pairs an old path with a new rule. */
    scan_path_px: [] as Point2d[],
    scan_path_closed: false as boolean,
    /** The EXPOSED portions of the path in wide px, one polyline per marker
     *  window (drawn emphasized; the rest of the path dim). */
    scan_window_px: [] as Point2d[][],
    /** The draggable main-axis handle: the +amp end of the axis in wide px
     *  ({0,0} uncalibrated — hidden). */
    axis_handle_px: { x: 0, y: 0 } as Point2d,
    // Per-eye wide-px projection of the offset-free CENTER pose (shift
    // included) — where each fovea is aimed; {0,0} uncalibrated (spec §views).
    L_PX: { x: 0, y: 0 } as Point2d,
    R_PX: { x: 0, y: 0 } as Point2d,
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
      // The MCU trajectory run + the triangle flip bricks (spec §actuation).
      trajectory: {
        running: false,
        pushes: { ok: 0, timeout: 0, busy: 0, other: 0 },
        lateness_us: 0,
        reuploads: 0,
        flipped: { L: 0, R: 0 },
        unmatched: { L: 0, R: 0 },
        skew_us: { L: 0, R: 0 },
        flip_tolerance_us: 0,
      } as TrajectoryTelemetry,
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
    /** Point the scan's MAIN AXIS at a wide-view pixel: the direction from the
     *  center to it (through the pixel→angle map) becomes `scan_axis_deg`
     *  (spec §scan-patterns). The pane slider writes the state directly. */
    setAxis: cmd<Point2d>(),
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
    /** Start the scan (upload + run the pattern trajectory, arm the fovea
     *  triggers). Resolves
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
