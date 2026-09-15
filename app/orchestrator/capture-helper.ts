// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Composable capture facility: the capture machinery (node wiring, on-demand
// per-shot raw L/R acquire, telemetry, the command surface, and the
// recording-vs-capture exclusivity guard) so any triple-holding session opts in
// with config. Includes the reverse-order acquire unwind and the burst-timeout
// forwarding.
// spec: docs/spec/capture-recording.md#capture-helper

import {
  createCaptureNode,
  type CaptureNodeHandle,
  type CaptureNodeOptions,
  type CaptureShot,
  type CaptureSingleShot,
  type CaptureStreamInit,
} from "@orchestrator/capture-node";
import type { PipeBroker } from "@orchestrator/pipe-session";
import {
  rawPipeSpec,
  type RawPipeRegistry,
  type RawPipeAcquisition,
  type RawGeometrySource,
} from "@orchestrator/raw-pipe";
import { significantBits } from "@lib/util/dtype";
import type { PixelFormat } from "core/Aravis";
import type { FramePayload, Serializable } from "@lib/orchestrator/protocol";

/** A held center pipe the capture worker one-shot reads (the session's already-
 *  connected undistort/convert pipe — 8-bit BGRA, latest-wins). null until the
 *  session's activation has connected it. */
export interface CaptureCenterPipe {
  shmName: string;
  maxBytes: number;
  channels: number;
}

/** The two raw camera leases capture stacks (L/R). Matches the lease camera
 *  object (satisfies both the raw geometry spec and the native attach handle). */
export interface CaptureLeases {
  left: RawGeometrySource;
  right: RawGeometrySource;
}

/** A short capture-burst ring depth for the per-shot advertise. Exported so a
 *  session can PRE-ACQUIRE the same raw pipes at activation: the per-shot
 *  acquire then finds the entry and only bumps its refcount, keeping the ring
 *  allocation (and its native attach) off the shot path. */
export const CAPTURE_RING_DEPTH = 8;

export interface CaptureHelperDeps {
  /** Graph node id — `capture/<session>` (compose via `nodeId.win`). */
  id: string;
  /** Broker for the on-demand per-shot raw L/R connects. */
  broker: PipeBroker;
  /** Refcounted raw-pipe registry (shared process-wide with recording). */
  rawPipes: RawPipeRegistry;
  /** Stable graph input pipe ids (wiring only — the actual raw connect is
   *  per-shot). Triple: L/R raw + the session's `center` undistort/convert pipe
   *  id. Single (degenerate): the one selected camera's raw pipe id. */
  graphInputs: { left: string; right: string; center: string } | { single: string };
  /** TRIPLE mode: the two raw camera leases (L/R), or null when the session is
   *  not active. Omit for single-stream mode. */
  cameras?(): CaptureLeases | null;
  /** TRIPLE mode: the session's already-connected center pipe (undistort/
   *  convert), or null when not connected. Omit for single-stream mode. */
  centerPipe?(): CaptureCenterPipe | null;
  /** SINGLE-STREAM mode: the ONE selected camera lease. Its
   *  PRESENCE switches the helper to single-stream composition. The capture
   *  REUSES the session's `select` lease — it NEVER acquires its own camera —
   *  and returns null when no camera is selected (→ capture refuses cleanly). */
  camera?(): RawGeometrySource | null;
  /** App-specific per-shot snapshot: the calibration-derived transforms +
   *  per-resource metadata for the whole shot (single-stream apps return a
   *  `CaptureSingleShot`). Return null when the session is not ready to capture
   *  (→ the command rejects "Capture not ready"). */
  snapshot(reset: boolean, indexed: boolean): CaptureShot | CaptureSingleShot | null;
  /** Exclusivity: true while a recording is active. Capture is
   *  refused while true — capture and recording share the raw pipe ids. */
  recordingActive(): boolean;
  /** Publish the capture telemetry patch (session `s.telemetry`). */
  telemetry(patch: { captureBusy?: boolean; capture_meta?: Record<string, Serializable> }): void;
  /** Test seam: capture node factory (default: the real one). */
  createNode?: (options: CaptureNodeOptions) => CaptureNodeHandle;
}

export interface CaptureHelper {
  /** True while a shot is in flight — the recording side reads this for the
   *  reciprocal exclusivity guard (`startRecording` refuses while capturing). */
  readonly capturing: boolean;
  /** The in-flight shot's promise (idle → resolved). Session teardown awaits
   *  this before tearing down the vision worker + pipes. */
  readonly activeCapture: Promise<void>;
  /** Build the (idle) capture node — call once on activate. */
  build(): void;
  /** Run ONE capture shot (the mixin `captureShot`). `tag` present ⇒ accumulate
   *  an indexed (raster) resource; absent/0 ⇒ fresh accumulation. Rejects when
   *  not ready or while a recording is active. */
  captureShot(tag?: number): Promise<void>;
  /** Pull one held resource downconverted to 8-bit BGRA (mixin
   *  `getCapturePreview`). */
  getPreview(resource: string, index?: number): Promise<FramePayload | null>;
  /** Persist the pending capture to disk and clear it (mixin `saveCapture`). */
  save(path: string, format: string): Promise<void>;
  /** Discard the pending capture (mixin `discardCapture`). */
  discard(): Promise<void>;
  /** Terminate the node's worker + retire its graph row (call on drain, AFTER
   *  `activeCapture` settles). */
  stop(): Promise<void>;
}

/** One connected raw stream → the worker's per-stream init. */
function streamInitFrom(conn: {
  shmName: string;
  spec: {
    pixelFormat: string;
    dtype: string;
    channels: number;
    bytesPerFrame: number;
    maxBytes?: number;
  };
}): CaptureStreamInit {
  return {
    shmName: conn.shmName,
    maxBytes: conn.spec.maxBytes ?? conn.spec.bytesPerFrame,
    channels: conn.spec.channels,
    bytesPerElement: conn.spec.dtype === "U16" ? 2 : 1,
    significantBits: significantBits(conn.spec.pixelFormat as PixelFormat),
    pixelFormat: conn.spec.pixelFormat,
  };
}

/** 3×3 identity (flat, row-major) — the degraded (no-wrap) fovea homography. */
const IDENTITY_H = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A degraded capture shot for a triple-holder that has no per-frame mirror
 *  pose to derive fovea homographies from. The L/R foveae stack the raw sensors
 *  WITHOUT a perspective wrap (identity H — `wrapPerspective` is a no-op), the
 *  center is the FULL undistorted frame (an over-sized rect the worker clamps to
 *  the frame), and `capture_meta` states the degradation explicitly. Every triple-
 *  holder can produce this uniformly without coupling capture to its control
 *  loop's volt tracking. */
export function rawTripleShot(opts: {
  reset: boolean;
  indexed: boolean;
  stackCount: number;
  /** Human note for `capture_meta` (why the wrap is absent — e.g.
   *  "no undistort (extrinsic pre-calibration)" or "raw stacks, no pose"). */
  note?: string;
}): CaptureShot {
  const note = opts.note ?? "raw stacks (no per-frame mirror pose)";
  const modeMeta: Serializable = { capture: "raw-stack", wrap: "none", note };
  return {
    reset: opts.reset,
    indexed: opts.indexed,
    stackCount: opts.stackCount,
    H_L: [...IDENTITY_H],
    H_R: [...IDENTITY_H],
    // Over-sized rect → the worker's `clampRect` clamps it to the actual center
    // frame, yielding the full frame without main knowing its dims.
    rect: { x: 0, y: 0, width: 1e9, height: 1e9 },
    meta: {
      wide: opts.reset ? modeMeta : undefined,
      fovea: modeMeta,
      left: modeMeta,
      right: modeMeta,
    },
  };
}

/** A degraded SINGLE-STREAM shot: stack the one selected camera's raw full-depth
 *  sensor into ONE held resource, UNWRAPPED (no fovea homography, no center
 *  slice, no diff). `capture_meta`
 *  states the raw-stack mode explicitly. Every single-camera session (calibrate-
 *  intrinsic) produces this uniformly. */
export function rawSingleShot(opts: {
  reset: boolean;
  indexed: boolean;
  stackCount: number;
  /** Held-resource name (default "sensor"). */
  resource?: string;
  /** Human note for `capture_meta`. */
  note?: string;
}): CaptureSingleShot {
  const note = opts.note ?? "raw sensor stack (single camera)";
  const modeMeta: Serializable = { capture: "raw-stack", wrap: "none", note };
  return {
    reset: opts.reset,
    indexed: opts.indexed,
    stackCount: opts.stackCount,
    resource: opts.resource ?? "sensor",
    meta: {
      wide: opts.reset ? modeMeta : undefined,
      single: modeMeta,
    },
  };
}

export function createCaptureHelper(deps: CaptureHelperDeps): CaptureHelper {
  let node: CaptureNodeHandle | null = null;
  let activeCapture: Promise<void> = Promise.resolve();
  let capturing = false;
  const createNode = deps.createNode ?? createCaptureNode;

  /** ON-DEMAND per-shot connect (capture-node `AcquireStreams`): advertise+attach
   *  the raw L/R producers (refcounted), connect all three streams, and return
   *  a `release` that disconnects then releases them. A throw mid-sequence
   *  unwinds what already succeeded in REVERSE order (else the orphaned
   *  refcount/connection never unadvertises — camera-exclusivity hazard). */
  function acquireCaptureStreams() {
    const cams = deps.cameras?.() ?? null;
    const center = deps.centerPipe?.() ?? null;
    if (!cams || !center) throw new Error("capture: session not active");
    const { left, right } = cams;
    let rawL: RawPipeAcquisition | null = null;
    let rawR: RawPipeAcquisition | null = null;
    let lConnected = false;
    let rConnected = false;
    try {
      const aL = deps.rawPipes.acquire({
        kind: "raw",
        camera: left,
        pipeId: `camera/${left.serial}/raw`,
        spec: rawPipeSpec(left, `camera/${left.serial}/raw`, CAPTURE_RING_DEPTH),
      });
      rawL = aL;
      const aR = deps.rawPipes.acquire({
        kind: "raw",
        camera: right,
        pipeId: `camera/${right.serial}/raw`,
        spec: rawPipeSpec(right, `camera/${right.serial}/raw`, CAPTURE_RING_DEPTH),
      });
      rawR = aR;
      const cL = deps.broker.connect(aL.pipeId);
      lConnected = true;
      const cR = deps.broker.connect(aR.pipeId);
      rConnected = true;
      return {
        streams: {
          left: streamInitFrom(cL),
          right: streamInitFrom(cR),
          center: {
            shmName: center.shmName,
            maxBytes: center.maxBytes,
            channels: center.channels,
          },
        },
        release: () => {
          deps.broker.disconnect(aL.pipeId);
          deps.broker.disconnect(aR.pipeId);
          aL.release();
          aR.release();
        },
      };
    } catch (err) {
      if (rConnected && rawR) deps.broker.disconnect(rawR.pipeId);
      if (lConnected && rawL) deps.broker.disconnect(rawL.pipeId);
      rawR?.release();
      rawL?.release();
      throw err;
    }
  }

  /** ON-DEMAND per-shot connect for the DEGENERATE single-stream mode: advertise
   *  + attach the ONE selected camera's raw producer (refcounted, reusing the
   *  session's lease — never a fresh camera acquire), connect it, and return a
   *  `release` that disconnects then releases it. Same reverse-unwind discipline
   *  as the triple acquire (a throw never orphans a refcount). Refuses cleanly
   *  when no camera is selected. */
  function acquireSingleStream() {
    const cam = deps.camera?.() ?? null;
    if (!cam) throw new Error("capture: no camera selected");
    let raw: RawPipeAcquisition | null = null;
    let connected = false;
    try {
      const pipeId = `camera/${cam.serial}/raw`;
      const a = deps.rawPipes.acquire({
        kind: "raw",
        camera: cam,
        pipeId,
        spec: rawPipeSpec(cam, pipeId, CAPTURE_RING_DEPTH),
      });
      raw = a;
      const c = deps.broker.connect(a.pipeId);
      connected = true;
      return {
        streams: { single: streamInitFrom(c) },
        release: () => {
          deps.broker.disconnect(a.pipeId);
          a.release();
        },
      };
    } catch (err) {
      if (connected && raw) deps.broker.disconnect(raw.pipeId);
      raw?.release();
      throw err;
    }
  }

  return {
    get capturing() {
      return capturing;
    },
    get activeCapture() {
      return activeCapture;
    },

    build() {
      // `camera` present ⇒ single-stream (degenerate) mode; else the triple.
      node = createNode({
        id: deps.id,
        graphInputs: deps.graphInputs,
        acquireStreams: deps.camera ? acquireSingleStream : acquireCaptureStreams,
      });
    },

    async captureShot(tag?: number): Promise<void> {
      if (!node) throw new Error("Capture not ready");
      // EXCLUSIVITY: capture and recording advertise the SAME
      // `camera/<serial>/raw` ids; capture's per-shot advertise/retire would
      // clobber an active recording's pipes. Refuse cleanly (typed error →
      // renderer). Single-threaded, so the flag read is race-free.
      if (deps.recordingActive())
        throw new Error("Cannot capture while a recording is active");
      // `tag` absent OR 0 starts a fresh accumulation; a present tag accumulates
      // an indexed resource (raster).
      const reset = tag === undefined || tag === 0;
      const indexed = tag !== undefined;
      const shot = deps.snapshot(reset, indexed);
      if (!shot) throw new Error("Capture not ready");
      capturing = true;
      deps.telemetry({ captureBusy: true });
      activeCapture = node
        .capture(shot)
        .then((manifest) => {
          deps.telemetry({ capture_meta: manifest });
        })
        .finally(() => {
          capturing = false;
          deps.telemetry({ captureBusy: false });
        });
      await activeCapture;
    },

    async getPreview(resource: string, index?: number): Promise<FramePayload | null> {
      return node ? node.getPreview(resource, index) : null;
    },

    async save(path: string, format: string): Promise<void> {
      await node?.save(path, format);
      deps.telemetry({ capture_meta: {} });
    },

    async discard(): Promise<void> {
      await node?.discard();
      deps.telemetry({ capture_meta: {} });
    },

    async stop(): Promise<void> {
      await node?.stop();
      node = null;
    },
  };
}
