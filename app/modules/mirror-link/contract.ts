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
    trim_lx: 0, // per-eye fine alignment (deg, ±0.5)
    trim_ly: 0,
    trim_rx: 0,
    trim_ry: 0,
    /** Session-wide fovea gain override (dB, BOTH eyes; spec §gain). Null =
     *  never set — the session seeds it from the leased cameras instead of
     *  writing one. */
    gain: null as number | null,
    /** Ring-reader node ON/OFF (spec §reader). Default OFF: the decoder is a
     *  worker thread over both fovea pipes, built only while this is set. */
    ring_reader: false as boolean,
    // Scan parameters (spec §scan) — LIVE while active.
    scan_hz: 20,
    scan_amp: 0.5, // scan radius (deg)
  },
  telemetry: {
    ready: false as boolean, // calibrated triple leased + conversions loaded
    target: { x: 0, y: 0 } as Point2d, // scan center, wide px
    target_angle: { x: 0, y: 0 } as Point2d, // ...and in radians (angular)
    /** The INSTANTANEOUS commanded pose — the PosViews trace the circle at the
     *  telemetry throttle (spec §views). */
    volt: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } } as { L: Pos; R: Pos },
    // Per-eye wide-px projection of the offset-free CENTER pose (trims
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
    // Control-path latency — `c.actuate()` round-trip, throttled like `volt`.
    perf: { actuateMs: { mean: 0, max: 0 } as Stat },
    // Recording.
    recording_active: false as boolean,
    recordingStreams: {} as Record<
      string,
      { frames: number; dropped: number; fps: number; bytes: number }
    >,
  },
  // No session frames: every view binds a native pipe directly (spec §views).
  frames: [] as const,
  commands: {
    /** Move the scan CENTER to a wide-view pixel (spec §targeting). */
    steer: cmd<Point2d>(),
    /** Start the circular scan + the per-fovea exposure override. Resolves
     *  `false` when refused, with the reason on `telemetry.scan_blocked`. */
    startScan: cmd<void, boolean>(),
    /** Stop the scan and restore the pre-scan camera timing. */
    stopScan: cmd(),
    /** Start writing raw L/C/R streams to disk at `path`. */
    startRecording: cmd<{ path: string }, boolean>(),
    /** Stop the active recording. */
    stopRecording: cmd(),
  },
});

export type MirrorLinkContract = typeof mirrorLink;
