// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Session contracts: the single source of truth shared by the orchestrator
// (which implements them) and the renderer (which imports their `typeof`).
// As each sub-app is migrated, add its contract here (or co-locate it in the
// module and re-export) so both ends stay in lock-step.

import { cmd, defineContract } from "./protocol.js";
import type { Command, FramePayload, FrameTopicStats, Serializable } from "./protocol.js";
import type { GraphTopology } from "./graph-contract.js";
import type { Pos } from "../controller-codec.js";

/** Minimal camera descriptor — plain data, safe to cross the boundary. */
export type CameraInfo = {
  serial: string;
  model: string;
  vendor: string;
};

/** Rolling mean/max pair, the shape every perf-substrate stat publishes. */
export type Stat = { mean: number; max: number };

// --- recording mixin ---------------------------------------------------------
// Every app gets recording: this additive helper produces the
// `startRecording`/`stopRecording`/`recordingStats` telemetry+command shape the
// renderer's `Recording` facade (`@src/record`) + the title-bar RecordButton
// read. Spread the two helpers into a contract's `telemetry` / `commands` so a
// new app opts in with one line each instead of re-declaring the shape.

/** One recorded stream's live UI counters — the value type of
 *  `recordingStreams`. `published = frames + dropped` (pinned invariant); the
 *  drop split rides `droppedQueue + droppedRing == dropped`, optional so a
 *  contract that omits it still assigns cleanly (RecordButton reads `?? 0`). */
export type RecordingStreamInfo = {
  frames: number;
  dropped: number;
  droppedQueue?: number;
  droppedRing?: number;
  fps: number;
  bytes: number;
};

/** Telemetry fields a recording-capable app publishes. Spread into a contract's
 *  `telemetry`: `telemetry: { ...recordingTelemetry(), ...myFields }`. */
export function recordingTelemetry(): {
  recording_active: boolean;
  recordingStreams: Record<string, RecordingStreamInfo>;
} {
  return {
    recording_active: false as boolean,
    recordingStreams: {} as Record<string, RecordingStreamInfo>,
  };
}

/** Commands a recording-capable app exposes. Spread into a contract's
 *  `commands`: `commands: { ...recordingCommands(), ...myCommands }`. */
export function recordingCommands(): {
  startRecording: Command<{ path: string }, boolean>;
  stopRecording: Command<void, void>;
} {
  return {
    /** Start writing the app's default recordable streams to disk at `path`. */
    startRecording: cmd<{ path: string }, boolean>(),
    /** Stop the active recording (finalize → auto-open viewer). */
    stopRecording: cmd(),
  };
}

// --- capture mixin -----------------------------------------------------------
// Every triple-holding app gets capture: this additive helper produces the
// `captureShot`/`getCapturePreview`/`saveCapture`/`discardCapture` command shape
// + the `captureBusy`/`capture_meta` telemetry the renderer's `Capture` facade
// (`@src/capture`) + the shared `CapturePreview` window read. Spread the two
// helpers into a contract's `telemetry`/`commands` so a new app opts in with one
// line each.
//
// NAMING: the mixin uses `captureShot`/`getCapturePreview` — collision-free
// with app-local commands (calibrate-intrinsic already has a `capture` for
// calibration records). manual-control ALSO exposes `capture`/`getPreview`
// (aliased to the same helper) and additionally spreads this mixin so the
// shared preview window works.

/** Telemetry fields a capture-capable app publishes. Spread into a contract's
 *  `telemetry`: `telemetry: { ...captureTelemetry(), ...myFields }`. */
export function captureTelemetry(): {
  captureBusy: boolean;
  capture_meta: Record<string, Serializable>;
} {
  return {
    // A shot is draining/stacking in the capture worker (Save stays disabled).
    captureBusy: false as boolean,
    // Per-resource metadata (name -> meta object, or an array for a raster
    // capture) — the capture NODE's manifest, republished after each shot. The
    // renderer reads this for the resource list; image data is PULLED per
    // resource via `getCapturePreview`, never streamed on a channel.
    capture_meta: {} as Record<string, Serializable>,
  };
}

/** Commands a capture-capable app exposes. Spread into a contract's `commands`:
 *  `commands: { ...captureCommands(), ...myCommands }`. */
export function captureCommands(): {
  captureShot: Command<{ tag?: number }, void>;
  getCapturePreview: Command<{ resource: string; index?: number }, FramePayload | null>;
  saveCapture: Command<{ path: string; format: string }, void>;
  discardCapture: Command<void, void>;
} {
  return {
    /** Run ONE capture shot: stacks the raw L/R foveae + slices the center in
     *  the capture worker, holding the full-depth resources. `tag` present ⇒ a
     *  raster shot accumulating an indexed resource; absent/0 ⇒ a fresh
     *  accumulation. Refused while a recording is active. */
    captureShot: cmd<{ tag?: number }>(),
    /** Pull one held capture resource downconverted to 8-bit BGRA —
     *  `index` selects an entry of a raster resource (default: the latest). */
    getCapturePreview: cmd<{ resource: string; index?: number }, FramePayload | null>(),
    /** Persist the pending capture to disk and clear it. */
    saveCapture: cmd<{ path: string; format: string }>(),
    /** Discard the pending capture without saving. */
    discardCapture: cmd(),
  };
}

/** A structured timing measurement — boot phases, per-activation
 *  camera/calibration work, controller connect. Mirrors
 *  `orchestrator/diagnostics.ts`'s `Span`; duplicated here (not imported)
 *  since `contracts.ts` is the renderer-safe boundary and `diagnostics.ts`
 *  is orchestrator-only. */
export type Span = { name: string; ms: number; meta?: Record<string, unknown>; t: number };

/** One workload counter reading. Mirrors `orchestrator/metering.ts`'s snapshot
 *  shapes; duplicated here (not imported) for the same reason as `Span` —
 *  `contracts.ts` is the renderer-safe boundary and `metering.ts` is
 *  orchestrator-only. */
// `maxIntervalMs` = largest gap (ms) between consecutive events over the
// trailing window (mirrors `stats.WorkloadStreamStat`/`metering.ts`). Optional
// so snapshots that omit it still fit; the profiler reads it typed, not `as any`.
export type WorkloadCounterSnapshot = {
  count: number;
  ratePerSec: number;
  maxIntervalMs?: number;
};

/** One workload meter's aggregated document — `system.perfSnapshot`'s
 *  `workloads` values, keyed by workload name. */
export type WorkloadSnapshot = {
  name: string;
  window: { startedAt: number; snapshotAt: number; uptimeMs: number };
  /** Busy-time fraction of `window.uptimeMs`, clamped to [0, 1]. */
  utilization: number;
  busyMs: number;
  inputs: Record<string, WorkloadCounterSnapshot>;
  outputs: Record<string, WorkloadCounterSnapshot>;
  drops: { total: number; ratePerSec: number; byReason: Record<string, number> };
};

/** One `system.perfSnapshot` document — the artifact the zero-copy decision
 *  and regression checks consume. */
export type PerfSnapshot = {
  timestamp: string; // ISO 8601
  orchestrator: {
    loopLag: Stat;
  };
  /** Per-topic frame counters/timing, summed across every connected channel. */
  frames: Record<string, FrameTopicStats>;
  /** Per-name workload meters (native tracker/pipe thread probes, recorder
   *  workers). */
  workloads: Record<string, WorkloadSnapshot>;
  storeHub: { writes: number; updates: number; clears: number };
  /** Ring-buffer snapshot of recent boot/activation/connect timings. */
  spans: Span[];
  /** The live stream node graph, folded into this 1 Hz poll. Optional so
   *  snapshot documents without it stay valid. */
  graph?: GraphTopology;
  /** Clock-calibration health: per subject clock,
   *  offset/jitter (ns, stringified bigint) + sample count + method. Optional
   *  so pre-clock snapshots stay valid. */
  clocks?: Record<
    string,
    { offsetNs: string; jitterNs: string; samples: number; method: string }
  >;
};

/**
 * The always-on session. Owns process-wide concerns and is the smoke test that
 * `core` loads and runs inside the orchestrator process.
 */
export const system = defineContract({
  state: {},
  telemetry: {
    cameraCount: 0,
    // Event-loop lag probe — the "own libuv loop" metric.
    // Always-on, ≤ 1 Hz publish rate per the perf-substrate constraints.
    loopLag: { mean: 0, max: 0 } as Stat,
  },
  frames: [] as const,
  commands: {
    listCameras: cmd<void, CameraInfo[]>(),
    /**
     * Force-release every camera the orchestrator holds and resolve once the
     * native handles are closed. Non-migrated renderer modules call this before
     * opening cameras directly, so the orchestrator hands back the per-process
     * exclusive device claim (see camera registry).
     */
    releaseCameras: cmd<void, void>(),
    /** One-shot aggregated perf document — see `PerfSnapshot`. */
    perfSnapshot: cmd<void, PerfSnapshot>(),
  },
});

export type SystemContract = typeof system;

/**
 * MEMS mirror controller (serial). A global singleton — the orchestrator owns
 * the serial device; renderers connect/enable/actuate via commands and read
 * status via telemetry. The session stays idle until `connect` is commanded
 * (the title-bar `Controller.vue`, a thin client over this session, connects on
 * mount).
 */
/** One live CMD_STREAM's telemetry row — the profiler's per-stream table. */
export type StreamStat = { id: number; hz: number; left: Pos; right: Pos };

/** The controller node's uploaded-trajectory row (v2.2.0 CMD_TRAJECTORY,
 *  MirrorLink) — null when no trajectory is open. Plain numbers (telemetry
 *  must stay JSON-friendly). spec: docs/spec/controller.md#trajectory-ownership */
export type TrajectoryStat = {
  /** The input port name the session opened it under. */
  name: string;
  /** MCU table id; null while detached (controller unbound / swapped). */
  id: number | null;
  state: "uploading" | "ready" | "running" | "detached" | "closed";
  running: boolean;
  periodUs: number;
  markers: number;
  /** Cycles observed in the current/last run (highest pushed cycle + 1). */
  cyclesSeen: number;
  /** Pushes per status since open (OK, STROBE_TIMEOUT, BUSY, CANCELLED,
   *  ENDED, UNKNOWN). */
  statusCounts: Record<string, number>;
  lastMarker: number | null;
  lastCycle: number | null;
  /** t_trigger − (t_start + cycle·period + marker offset), µs, of the last
   *  OK push; null before one. `latenessExact` is false when the run was
   *  started "now" (t_start = 0 on the MCU) — the host's start estimate then
   *  carries the serial latency. */
  lastLatenessUs: number | null;
  latenessExact: boolean;
  /** Position-input pushes held locally while the trajectory owned the DAC. */
  heldPushes: number;
  /** Successful `replace()` swaps since open (phase-continuous re-shapes
   *  while running, plain re-uploads from `ready`). */
  reuploads: number;
};

export const controller = defineContract({
  state: { vendorId: "16c0", productId: "0483" },
  telemetry: {
    connected: false as boolean,
    pending: false as boolean,
    enabled: false as boolean,
    // Firmware exposes the System::Reset MEMS recovery type (>= 2.1.0) —
    // gates the title-bar "Recover mirror" button. False while disconnected
    // or on older firmware.
    canRecoverMems: false as boolean,
    dv: 0,
    pos: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } } as {
      left: Pos;
      right: Pos;
    },
    // Serial + per-stream probes — sampled ~2 Hz by the session while
    // connected; rates derived from `Device.stats`' cumulative counters
    // (native) by diffing successive samples.
    serialRate: {
      txBytesPerSec: 0,
      rxBytesPerSec: 0,
      txPacketsPerSec: 0,
      rxPacketsPerSec: 0,
    },
    // Serial PRESSURE block: the Device.stats sensors + the AIMD governor's
    // view + the predictor's applied lookahead (null = no predictor session
    // active). Sampled by the same probe timer.
    serialPressure: {
      effectiveRateHz: 0,
      ceilingHz: 0,
      governorState: "off" as "off" | "steady" | "seeking" | "backoff",
      outqBytes: 0,
      outqHighWater: 0,
      outqSupported: true as boolean,
      txSoftFail: 0,
      ackRttMs: { p50: 0, p95: 0, max: 0, count: 0, baselineP50: 0 },
      appliedLookaheadMs: null as number | null,
    },
    streams: [] as StreamStat[],
    // The controller node's uploaded trajectory (v2.2.0), null when none.
    trajectory: null as TrajectoryStat | null,
  },
  frames: [] as const,
  commands: {
    connect: cmd<void, boolean>(),
    disconnect: cmd(),
    enable: cmd(),
    disable: cmd(),
    /** Re-initialize the MEMS DACs without dropping the session — sends
     *  System::Reset(MEMS). Resolves on ACK, rejects on REJ (firmware REJs
     *  when disabled / below v2.1.0). */
    recoverMems: cmd(),
    actuate: cmd<
      { left?: Pos; right?: Pos; settleTime?: number },
      { left: Pos; right: Pos; completeTime: number }
    >(),
    trigger: cmd<number>(),
    setBias: cmd<number, number>(),
    setLPF: cmd<number, number>(),
  },
});

export type ControllerContract = typeof controller;

// The viewer window doesn't talk to the orchestrator at all — there is no
// viewer session contract; playback lives in the window's own worker
// (`src/viewer/worker.ts`, protocol in `src/viewer/protocol.ts`).
