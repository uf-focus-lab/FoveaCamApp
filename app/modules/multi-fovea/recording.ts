// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea session RECORDING controller — raw12p streams + optional /zlib +
// wide-camera singleton + per-target descriptor channels, over the shared
// `@orchestrator/recording-service`. Injection-seamed (no native imports) so
// vitest drives it with fakes. Container shape, descriptor emission, and
// per-frame extras: docs/spec/multi-fovea.md §recording.

import type { Rect } from "core/Geometry";
import {
  type RecorderConnect,
  type RecorderNodeHandle,
  type RecorderNodeOptions,
  type RecorderStreamStats,
  type FoveaDescriptor,
} from "@orchestrator/recorder-node";
import { createRecordingService } from "@orchestrator/recording-service";
import {
  raw12pPipeSpec,
  type RawPipeRegistry,
  type RawPipeAcquisition,
  type RawGeometrySource,
} from "@orchestrator/raw-pipe";
import {
  createCompressPipe,
  type CompressPipeSeam,
  type CompressHandle,
} from "@orchestrator/compress-pipe";
import {
  readRecordCompression,
  type RecordCompression,
} from "@orchestrator/record-compression";
import { ANCHOR_PAYLOAD } from "@orchestrator/anchor-node";
import type { PairRecord } from "@orchestrator/pair-pipe";
import type { MirrorAt } from "@orchestrator/mirror-history";
import type { CoordinateConversions } from "@lib/coordinate-conversions";
import type { MultiTrackBatch } from "./runtime";

/** The recorded stream names — also the descriptor `frames` keys. */
export type RecordedStream = "left" | "center" | "right";

/** Per-stream compression switches (default all off) — ENABLES of the app-level
 *  `record_compression` method (spec §recording). */
export type CompressConfig = Record<RecordedStream, boolean>;

/** One leased camera the recording taps: the geometry source (serial /
 *  pixel_format / dims) + the opaque native handle the raw12p attach needs. */
export interface RecordingCamera {
  source: RawGeometrySource;
  camera: unknown;
}

/** The per-target slice of the session's telemetry this controller consumes
 *  (channel churn + controller-stream mapping). */
export interface RecordingTarget {
  index: number;
  enabled: boolean;
  streamId: number | null;
}

export interface MultiFoveaRecordingDeps {
  /** The leased L/C/R cameras, or null when the session isn't active. */
  cameras(): Record<"L" | "C" | "R", RecordingCamera> | null;
  /** Wide camera singleton metadata — intrinsics/distortion from the
   *  calibration triple; null on an uncalibrated rig (record omitted). */
  wideCamera(): Record<string, unknown> | null;
  /** Refcounted raw-pipe registry. Injected from index.ts. */
  rawPipes: RawPipeRegistry;
  /** Plain broker connect (refcount++ → gate). Wrapped to inject each advert's
   *  JS-side `significantBits` the native PipeSpec drops. */
  connect: RecorderConnect;
  /** Compression brick seam; absent → the compress switches are ignored. */
  compress?: CompressPipeSeam;
  /** Live per-stream compression switches, read at `start` (spec §recording). */
  compressStreams(): CompressConfig;
  /** Test seam: read the app-level compression method at recording START
   *  (default `readRecordCompression()`). `"none"` gates every stream off. */
  readMethod?: () => Promise<RecordCompression>;
  /** Free-run extras: the mirror position at a frame's exposure host-ns, from
   *  the `mirror-history` ring (spec §recording). Absent → no free-run extras. */
  mirrorAt?: (hostNs: bigint) => MirrorAt | null;
  /** Free-run extras: the triple's per-eye V2A + A2H, or null uncalibrated. */
  conversions?: () => FreeRunConversions | null;
  /** Notify main a recording finished (auto-open viewer). */
  finished(foveaPath: string): void;
  telemetry(patch: {
    recording_active?: boolean;
    recordingStreams?: Record<string, RecorderStreamStats>;
  }): void;
  /** Test seam: the recorder node factory (default: the real one). */
  createNode?: (options: RecorderNodeOptions) => RecorderNodeHandle;
}

export interface MultiFoveaRecordingController {
  /** True while recording (drain-refusal probe, manual-control pattern). */
  readonly active: boolean;
  start(path: string): Promise<boolean>;
  stop(): Promise<boolean>;
  /** Session wiring: one completed ROOT pair record (trigger mode). Builds the
   *  dts→anchor maps for extras + the per-stream pair freshness the descriptor
   *  L/R pointers key on. Cheap; safe to call while idle. */
  onPairRecord(rec: PairRecord): void;
  /** Session wiring: one native tracker batch → descriptor emission for every
   *  armed target with a bbox. No-op while idle. */
  onTrackBatch(batch: MultiTrackBatch): void;
  /** Session wiring: the live target set (from the runtime's publish flow) —
   *  descriptor channels churn with target arm/disarm (add/removeDataStream)
   *  and the controller-stream map updates. Safe while idle (snapshotted for
   *  the next start). */
  onTargets(targets: RecordingTarget[]): void;
}

/** Bounded-map cap: ~2× the recorder ring depth (48) — a descriptor arriving
 *  after its frames evicted records null pointers rather than stalling. */
const MAP_CAP = 96;

/** A pair record older than this (ms) no longer binds L/R pointers to new
 *  descriptors — the round-robin schedule revisits each target far faster than
 *  this in live trigger capture; stale pairs degrade to free-run shape. */
const PAIR_FRESH_MS = 1000;

/** Insert with evict-oldest (Map preserves insertion order). */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAP_CAP) map.delete(map.keys().next().value as K);
}

/** The descriptor doc this controller writes: the shape with EXPLICIT nulls
 *  for absent pointers (free-run L/R; an evicted/unmatched key). */
export interface MultiFoveaDescriptor {
  tNs: number;
  bbox: Rect;
  frames: { left: number | null; center: number | null; right: number | null };
}

/** Unpack the anchor payload's per-side extras (the enrichment node's opaque
 *  doubles, ANCHOR_PAYLOAD layout) into the extras shape — `volt.source:
 *  fin-averaged`. Volts-only (uncalibrated) payloads omit angle/affine. */
export function anchorExtras(
  payload: Float64Array,
  side: "L" | "R",
): Record<string, unknown> | null {
  if (payload.length < ANCHOR_PAYLOAD.LEN_VOLTS_ONLY) return null;
  const o = side === "L" ? 0 : 2;
  const extras: Record<string, unknown> = {
    volt: { x: payload[ANCHOR_PAYLOAD.VOLTS + o], y: payload[ANCHOR_PAYLOAD.VOLTS + o + 1] },
    "volt.unit": "volt",
    "volt.source": "fin-averaged",
  };
  if (payload.length >= ANCHOR_PAYLOAD.LEN_FULL) {
    extras.angle = {
      x: payload[ANCHOR_PAYLOAD.ANGLES + o],
      y: payload[ANCHOR_PAYLOAD.ANGLES + o + 1],
    };
    extras["angle.unit"] = "radian";
    const h = side === "L" ? ANCHOR_PAYLOAD.H_LEFT : ANCHOR_PAYLOAD.H_RIGHT;
    extras.affine = Array.from(payload.subarray(h, h + 9));
  }
  return extras;
}

/** The minimal calibrated-triple conversions the free-run extras stamp needs:
 *  per-eye voltage→angle (V2A) and angle→homography (A2H). A structural subset
 *  of {@link CoordinateConversions} so this file (and its tests) never build a
 *  full triple. */
export type FreeRunConversions = Pick<CoordinateConversions, "V2A" | "A2H">;

/** Free-run analogue of {@link anchorExtras} (spec §recording): per-frame extras
 *  for a CALIBRATED triple from the interpolated actuation history —
 *  `volt` (`volt.source: history-interpolated`), `angle` = V2A(volt), `affine` =
 *  A2H(angle) (the same volt→angle→H chain the display path uses). Null (no
 *  extras, never a guess) when history is empty/too-old OR uncalibrated. */
export function historyExtras(
  mirror: MirrorAt | null,
  conv: FreeRunConversions | null,
  side: "L" | "R",
): Record<string, unknown> | null {
  if (!mirror || !conv) return null;
  const volt = side === "L" ? mirror.left : mirror.right;
  const angle = side === "L" ? conv.V2A.L(volt) : conv.V2A.R(volt);
  const H = side === "L" ? conv.A2H.L(angle) : conv.A2H.R(angle);
  return {
    volt: { x: volt.x, y: volt.y },
    "volt.unit": "volt",
    "volt.source": "history-interpolated",
    angle: { x: angle.x, y: angle.y },
    "angle.unit": "radian",
    // `Mat<Float64Array>` IS a Float64Array (shape props tacked on); row-major 9.
    affine: Array.from(H as unknown as ArrayLike<number>),
  };
}

export function createMultiFoveaRecording(
  deps: MultiFoveaRecordingDeps,
): MultiFoveaRecordingController {
  // --- dts→seq + dts→anchor state (see header) ------------------------------
  const seqByDts: Record<"left" | "right", Map<bigint, number>> = {
    left: new Map(),
    right: new Map(),
  };
  const anchorByDts: Record<"left" | "right", Map<bigint, Float64Array>> = {
    left: new Map(),
    right: new Map(),
  };
  /** Recent recorded CENTER frames (insertion = time order) for the nearest-
   *  by-timestamp pointer (explicitly unsynchronized — C free-runs: it is not in
   *  this session's trigger mask, though the V0.1 board cables CAM0). */
  const centerFrames: Array<{ tNs: bigint; seq: number }> = [];
  /** Latest pair per controller stream id → the descriptor L/R binding. */
  const pairByStream = new Map<number, { leftDts: bigint; rightDts: bigint; at: number }>();
  /** Slot index → controller stream id (from the session's target telemetry). */
  const streamBySlot = new Map<number, number>();
  /** Live descriptor channels (`fovea/<slot>`), churned with targets. */
  const liveChannels = new Set<string>();
  /** Last target snapshot — applied at start (channels for already-armed
   *  targets) and diffed on churn. */
  let targetSnapshot: RecordingTarget[] = [];

  function clearMaps(): void {
    seqByDts.left.clear();
    seqByDts.right.clear();
    anchorByDts.left.clear();
    anchorByDts.right.clear();
    centerFrames.length = 0;
    pairByStream.clear();
    liveChannels.clear();
  }

  function nearestCenterSeq(tNs: bigint): number | null {
    let best: number | null = null;
    let bestDelta: bigint | null = null;
    for (const f of centerFrames) {
      const d = f.tNs > tNs ? f.tNs - tNs : tNs - f.tNs;
      if (bestDelta === null || d < bestDelta) {
        bestDelta = d;
        best = f.seq;
      }
    }
    return best;
  }

  /** Per-frame callback (spec §recording): L/R answer with the matched anchor's
   *  extras (exact dts binding) or free-run history extras; center records its
   *  dts→seq sample and posts none. */
  function onFrame(stream: string, seq: number, tNs: bigint): Record<string, unknown> | null {
    if (stream === "center") {
      centerFrames.push({ tNs, seq });
      if (centerFrames.length > MAP_CAP) centerFrames.shift();
      return null;
    }
    if (stream !== "left" && stream !== "right") return null;
    boundedSet(seqByDts[stream], tNs, seq);
    const side = stream === "left" ? "L" : "R";
    // Trigger mode (preferred): the FIN-averaged anchor bound to this exposure.
    const payload = anchorByDts[stream].get(tNs);
    if (payload) return anchorExtras(payload, side);
    // Free-run: interpolate the actuation history at the trusted exposure host-ns.
    const mirror = deps.mirrorAt?.(tNs) ?? null;
    return historyExtras(mirror, deps.conversions?.() ?? null, side);
  }

  /** Diff the live channel set against the enabled targets (churn).
   *  Only meaningful with a live node; the snapshot persists for `start`. */
  function syncChannels(): void {
    const node = service.node;
    if (!node) return;
    const want = new Set(
      targetSnapshot.filter((t) => t.enabled).map((t) => `fovea/${t.index}`),
    );
    for (const name of liveChannels)
      if (!want.has(name)) {
        liveChannels.delete(name);
        node.removeDataStream(name);
      }
    for (const name of want)
      if (!liveChannels.has(name)) {
        liveChannels.add(name);
        node.addDataStream(name);
      }
  }

  const readMethod = deps.readMethod ?? readRecordCompression;
  /** App-level compression method, read at recording START (spec §recording). */
  let method: RecordCompression = "none";

  // Thin config over the shared facility (spec §recording): raw12p streams +
  // /zlib routing + the descriptor `onFrame`. The facility owns
  // start/stop/poll/telemetry + the acquire-then-build error unwind.
  const service = createRecordingService({
    id: "recorder/multi-fovea",
    createNode: deps.createNode,
    ready: () => deps.cameras() !== null,
    telemetry: deps.telemetry,
    finished: deps.finished,
    async prepare() {
      method = await readMethod();
    },
    // Channels for targets already armed at start.
    onStarted: () => syncChannels(),
    onStopped: () => clearMaps(),
    acquire() {
      const cams = deps.cameras()!; // `ready()` guaranteed non-null

      // Refcounted raw12p acquire (spec §recording): the packed verbatim payload
      // per camera, ONE advertise per id ever — shared with any concurrent acquirer.
      const acquire = (cam: RecordingCamera): RawPipeAcquisition =>
        deps.rawPipes.acquire({
          kind: "raw12p",
          camera: cam.camera,
          pipeId: `camera/${cam.source.serial}/raw12p`,
          spec: raw12pPipeSpec(cam.source),
        });
      const order: Array<[RecordedStream, RecordingCamera]> = [
        ["left", cams.L],
        ["center", cams.C],
        ["right", cams.R],
      ];
      const acquisitions = order.map(([, cam]) => acquire(cam));

      // Optional per-stream compression (spec §recording): route flagged streams
      // through the CompressStream brick, record the `/zlib` sibling instead.
      const compressCfg = deps.compressStreams();
      const methodOn = method === "zlib";
      const streams: Record<string, { pipeId: string }> = {};
      const significantBitsOf = new Map<string, number>();
      const compressed: CompressHandle[] = [];
      order.forEach(([name], i) => {
        const acq = acquisitions[i]!;
        significantBitsOf.set(acq.pipeId, acq.spec.significantBits);
        if (methodOn && compressCfg[name] && deps.compress) {
          const handle = createCompressPipe(deps.compress, acq.spec);
          compressed.push(handle);
          significantBitsOf.set(handle.pipeId, handle.spec.significantBits);
          streams[name] = { pipeId: handle.pipeId };
        } else {
          streams[name] = { pipeId: acq.pipeId };
        }
      });

      // Inject the JS-side significantBits the native spec drops (raw + compressed).
      const connect: RecorderConnect = (pipeId) => {
        const conn = deps.connect(pipeId);
        const sb = significantBitsOf.get(pipeId);
        return sb === undefined
          ? conn
          : { ...conn, spec: { ...conn.spec, significantBits: sb } };
      };

      return {
        nodeOptions: {
          streams,
          connect,
          // Wide camera singleton metadata (omitted uncalibrated; spec §recording).
          cameraMatrix: deps.wideCamera() ?? undefined,
          // Every stream posts notices (L/R for extras + dts→seq, center for the
          // nearest-pointer map); center's `onFrame` returns null → no extras.
          onFrame,
        },
        // Retire compress bricks first (they consume the raw pipes), then release
        // acquisitions in reverse (last release unadvertises).
        release: () => {
          for (const c of compressed) c.retire();
          for (const a of [...acquisitions].reverse()) a.release();
        },
      };
    },
  });

  return {
    get active() {
      return service.active;
    },

    start: (path) => service.start(path),
    stop: () => service.stop(),

    onPairRecord(rec: PairRecord): void {
      boundedSet(anchorByDts.left, rec.left.deviceTimestamp, rec.payload);
      boundedSet(anchorByDts.right, rec.right.deviceTimestamp, rec.payload);
      pairByStream.set(rec.stream, {
        leftDts: rec.left.deviceTimestamp,
        rightDts: rec.right.deviceTimestamp,
        at: performance.now(),
      });
    },

    onTrackBatch(batch: MultiTrackBatch): void {
      const node = service.node;
      if (!node || !service.active) return;
      // The batch IS a center-camera observation; without a device timestamp the
      // latest recorded center frame is the nearest sample by construction.
      const tNs =
        batch.deviceTimestamp ?? centerFrames[centerFrames.length - 1]?.tNs ?? 0n;
      const now = performance.now();
      for (const t of batch.targets) {
        if (!t.ok || !t.bbox) continue;
        const slot = Number(t.id);
        const channel = `fovea/${slot}`;
        if (!liveChannels.has(channel)) continue;
        // A FRESH pair re-keys to recorded L/R seqs; free-run/stale → nulls (spec §recording).
        const streamId = streamBySlot.get(slot);
        const pair = streamId !== undefined ? pairByStream.get(streamId) : undefined;
        const fresh = pair !== undefined && now - pair.at < PAIR_FRESH_MS;
        const descriptor: FoveaDescriptor = {
          tNs: Number(tNs),
          bbox: t.bbox,
          frames: {
            left: fresh ? seqByDts.left.get(pair.leftDts) ?? null : null,
            center: nearestCenterSeq(tNs),
            right: fresh ? seqByDts.right.get(pair.rightDts) ?? null : null,
          },
        };
        node.postData(channel, descriptor);
      }
    },

    onTargets(targets: RecordingTarget[]): void {
      targetSnapshot = targets;
      streamBySlot.clear();
      for (const t of targets)
        if (t.streamId !== null) streamBySlot.set(t.index, t.streamId);
      syncChannels();
    },
  };
}
