// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side MEMS mirror controller. A non-Vue port of the device logic
// in the renderer `Controller.vue` (state is plain fields; the session reads and
// broadcasts it). Owns the serial `Device`; reuses the shared DAC math.

import { createMirrorSink, Protocol, Device, type LogLevel } from "core/Controller";
import type { CameraName, FirmwareVersion, FrameArg, MirrorSink } from "core/Controller";
import type { TrajectoryFrame, TrajectoryStatus } from "core/Controller"; // v2.2.0
import { SerialPort } from "serialport";
import {
  channels,
  dac2volt,
  origin,
  volt2dac,
  type Pos,
} from "@lib/controller-codec";
import { registerWorkload, type WorkloadHandle } from "./metering.js";
import { hostNowNs } from "./time-align.js";
import { trajectoryGraceUs } from "./trajectory-grace.js";

type PortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];

// Streams::CAPACITY, firmware/include/Streams.h — fixed-size table on the MCU.
export const STREAM_CAPACITY = 64;
/** Default host-side floor between two CMD_STREAM UPDATEs on one stream (ms)
 *  — the JS `StreamUpdateGate` and, via `createNativeMirrorSink`, the native
 *  MirrorSink's `minIntervalUs`. Tunable per controller
 *  (`Controller.streamMinIntervalMs`); this is only the default.
 *
 *  Derivation (docs/spec/serial-protocol.md#rate-limits): the old 1 ms was
 *  sized for the 2 MHz shared DAC bus (~150 µs per committed position). The
 *  V0.1 board's two concurrent 10–20 MHz buses commit one in ~10 µs; with
 *  ~3–5 µs of firmware COBS decode + handler per 24-byte UPDATE the MCU
 *  sustains ~65 kHz of DAC-committed updates. 0.2 ms (5 kHz) keeps the MCU
 *  loop ≤ ~8 % busy with updates — half of the old 1 kHz × 150 µs — and the
 *  firmware coalesces anything faster (latest wins per loop iteration), so
 *  the device loop stays protected; the serial governor still backs off on
 *  USB/tty pressure. */
export const STREAM_MIN_UPDATE_INTERVAL_MS = 0.2;

// Minimum firmware/protocol version exposing the targeted MEMS-recovery reset
// (System::Reset MEMS type). Older firmware REJects the unknown enum, so
// `recoverMems()`/`v21Capable` gate on this — the v2Capable major-only version
// gate taken one level finer (major.minor.patch).
export const RECOVER_MEMS_MIN_VERSION = { major: 2, minor: 1, patch: 0 } as const;

// Minimum firmware/protocol version for the v2.2.0 surfaces: CMD_SCHEDULE
// (`StreamHandle.scheduleAt`) and CMD_TRAJECTORY (`uploadTrajectory`). Older
// firmware REJects both properties ("Unknown packet type").
export const SCHEDULE_MIN_VERSION = { major: 2, minor: 2, patch: 0 } as const;

// Minimum firmware/protocol version for the ATOMIC trajectory swap (protocol
// 2.2.1): `START {id = b, t_start, cycles}` while table `a` runs is accepted
// iff `b` is committed, has `a`'s period and `t_start` equals `a`'s recorded
// start (exact µs) — the firmware switches tables in place (no HOLD, no missed
// marker). Older firmware REJs it "already running".
export const ATOMIC_SWAP_MIN_VERSION = { major: 2, minor: 2, patch: 1 } as const;

// Firmware limits (lib/Protocol/Packet.h Trajectory::CHUNK_SAMPLES,
// firmware/include/Trajectory.h, Streams::SCHEDULE_DEPTH). Checked host-side so
// a bad spec fails before anything goes on the wire; the firmware REJects past
// them anyway.
export const TRAJECTORY_CHUNK_SAMPLES = 12;
export const TRAJECTORY_MAX_TABLES = 4;
export const TRAJECTORY_MAX_SAMPLES = 4096;
export const TRAJECTORY_MAX_MARKERS = 8;
export const SCHEDULE_DEPTH = 32;
// DATA chunks kept in flight during an upload (ACK-backed, pipelined).
const TRAJECTORY_UPLOAD_WINDOW = 8;
// The retired-table grace rule (pure, shared with the controller node).
export {
  TRAJECTORY_GRACE_SLACK_US,
  TRAJECTORY_STROBE_MARGIN_US,
  trajectoryGraceUs,
} from "./trajectory-grace.js";

/** Host-steady NANOSECONDS → MCU-clock MICROSECONDS — the inverse of the
 *  FIN decode (`hostNs = mcuUs * 1000 + clockOffsetNs`). Rounds to the nearest
 *  µs; a time before the MCU epoch clamps to 0n (which every v2.2.0 surface
 *  reads as "now"). */
export function hostNsToMcuUs(hostNs: bigint, clockOffsetNs: bigint): bigint {
  const ns = hostNs - clockOffsetNs;
  return ns <= 0n ? 0n : (ns + 500n) / 1000n;
}

/** MCU-clock µs → trusted host-steady ns (the FIN / push decode boundary). */
export function mcuUsToHostNs(mcuUs: bigint, clockOffsetNs: bigint): bigint {
  return mcuUs * 1000n + clockOffsetNs;
}

/** Splits `samples` into CMD_TRAJECTORY DATA chunks of at most `size`. */
export function chunkTrajectorySamples<T>(
  samples: readonly T[],
  size = TRAJECTORY_CHUNK_SAMPLES,
): Array<{ firstIndex: number; samples: T[] }> {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be >= 1");
  const out: Array<{ firstIndex: number; samples: T[] }> = [];
  for (let i = 0; i < samples.length; i += size)
    out.push({ firstIndex: i, samples: samples.slice(i, i + size) });
  return out;
}

/** `a >= b` over (major, minor, patch) firmware versions. */
function versionAtLeast(
  a: FirmwareVersion,
  b: { major: number; minor: number; patch: number },
): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

function clonePos(pos: Pos): Pos {
  return { x: pos.x, y: pos.y };
}

/** Decode a 4-channel DAC vector — either an `actuate()` ACK readback or a
 *  locally-computed `channels()` array — into an {x,y} volt pair (the
 *  differential pairs 0-1 / 2-3 via `dac2volt`). Shared by `actuate()`'s
 *  readback decode and `predictVolts()` so the streamed local prediction is
 *  byte-for-byte the same math as the awaited readback. */
function decodeChannels(chan: readonly number[]): Pos {
  return { x: dac2volt(chan[0] - chan[1]), y: dac2volt(chan[2] - chan[3]) };
}

export class StreamIdPool {
  private readonly inUse = new Set<number>();

  constructor(readonly capacity = STREAM_CAPACITY) {}

  allocate(): number {
    for (let candidate = 0; candidate < this.capacity; candidate++) {
      if (!this.inUse.has(candidate)) {
        this.inUse.add(candidate);
        return candidate;
      }
    }
    throw new Error(`Stream capacity (${this.capacity}) exceeded`);
  }

  release(id: number): void {
    this.inUse.delete(id);
  }
}

export class StreamUpdateGate {
  private lastLeft: Pos;
  private lastRight: Pos;
  private lastSentAt: number;

  /** `minIntervalMs` is a number or a live getter (a controller's tunable
   *  `streamMinIntervalMs`, read on every `accept`). */
  constructor(
    initial: { left: Pos; right: Pos },
    private readonly minIntervalMs: number | (() => number) = STREAM_MIN_UPDATE_INTERVAL_MS,
    now = performance.now(),
  ) {
    this.lastLeft = clonePos(initial.left);
    this.lastRight = clonePos(initial.right);
    this.lastSentAt = now;
  }

  accept(next: { left: Pos; right: Pos }, now = performance.now()): boolean {
    if (samePos(next.left, this.lastLeft) && samePos(next.right, this.lastRight))
      return false;
    const minIntervalMs =
      typeof this.minIntervalMs === "function" ? this.minIntervalMs() : this.minIntervalMs;
    if (now - this.lastSentAt < minIntervalMs) return false;
    this.lastLeft = clonePos(next.left);
    this.lastRight = clonePos(next.right);
    this.lastSentAt = now;
    return true;
  }

  /** Record `next` as sent WITHOUT the dedupe / min-interval checks — the
   *  forced-UPDATE path (`StreamHandle.update(pos, { force: true })`). */
  force(next: { left: Pos; right: Pos }, now = performance.now()): void {
    this.lastLeft = clonePos(next.left);
    this.lastRight = clonePos(next.right);
    this.lastSentAt = now;
  }

  /** The accepted pose never reached the wire (a latest-wins drop under
   *  back-pressure): forget it for DEDUPE so the next push — even the same
   *  pose — is sent, while the min-interval still paces the retry. */
  forgetLast(): void {
    this.lastLeft = { x: NaN, y: NaN };
    this.lastRight = { x: NaN, y: NaN };
  }
}

/** A CMD_STREAM handle: a named,
 *  continuously-updatable mirror-position target. `update()` is fire-and-
 *  forget (seq=0, multi-kHz-safe — see STREAM_MIN_UPDATE_INTERVAL_MS) — it
 *  never resolves/rejects, matching the protocol's design (the firmware
 *  sends no response for it at all), and is written immediately: it never
 *  waits behind an awaited request. */
export interface StreamHandle {
  readonly id: number;
  /** Returns true when the UPDATE was written to the wire, false when the
   *  gate deduped/paced it or a latest-wins drop discarded it — the
   *  controller node uses this to know whether a pending CMD_SCHEDULE ring
   *  was actually cleared (an UPDATE that never left the host clears
   *  nothing). Callers that don't care ignore it. `force` bypasses the
   *  gate's dedupe + min-interval (one-off re-assertions — the controller
   *  node uses it to take the DAC back after an uploaded trajectory STOPs,
   *  when the pose may equal the last one sent); never use it per tick. */
  update(pos: { left: Pos; right: Pos }, opts?: { force?: boolean }): boolean;
  /** v2.2.0 CMD_SCHEDULE: apply `pos` at host-steady time `hostNs` (converted
   *  to the MCU clock through the calibrated offset) instead of on arrival;
   *  with `interpolate` the firmware ramps linearly from the previous
   *  keyframe. Fire-and-forget like `update()` (no gate/dedupe — every
   *  keyframe counts; the MCU ring holds SCHEDULE_DEPTH pending). A later
   *  `update()` clears pending keyframes. Requires firmware >= 2.2.0. */
  scheduleAt(
    hostNs: bigint,
    pos: { left: Pos; right: Pos },
    opts?: { interpolate?: boolean },
  ): void;
  close(): Promise<void>;
}

/** One sample of an uploaded trajectory: the mirror target `tOffsetUs` into
 *  the period (volts, like every Pos surface). */
export interface TrajectorySample {
  tOffsetUs: number;
  left: Pos;
  right: Pos;
}

/** A trigger placed inside the period: fires `cameras` once per cycle when
 *  the phase crosses `tOffsetUs`, through the firmware capture engine. */
export interface TrajectoryMarker {
  tOffsetUs: number;
  /** Default L+R. */
  cameras?: CameraName[] | number;
  pulseUs: number;
}

export interface TrajectorySpec {
  /** Strictly increasing `tOffsetUs`, each in [0, periodUs). */
  samples: TrajectorySample[];
  periodUs: number;
  /** Up to TRAJECTORY_MAX_MARKERS. */
  markers?: TrajectoryMarker[];
  /** Hold each sample until the next instead of linear interpolation. */
  step?: boolean;
}

/** A decoded SYN CMD_TRAJECTORY push — `FrameOutcome` conventions (volts,
 *  OWNER-APPLIED trusted host-steady ns). `marker` is null for the run-level
 *  ENDED / CANCELLED pushes; positions/timestamps are only meaningful when
 *  `status === "OK"` (BUSY carries the missed marker's due time in tTrigger). */
export interface TrajectoryFrameOutcome {
  trajectoryId: number;
  marker: number | null;
  cycle: number;
  status: TrajectoryStatus;
  frameId: number;
  tTrigger: bigint;
  tExposure: bigint;
  left: Pos;
  right: Pos;
}

/** How the last running `replace` swapped tables: `atomic` = the firmware
 *  2.2.1 in-place START (no HOLD; a marker is never doubled, and one moved
 *  before the swap phase first fires next cycle), `stop-start` = the
 *  STOP(old) + START(new) pair (older firmware, or the atomic START REJected
 *  "already running"). */
export type TrajectorySwapKind = "atomic" | "stop-start";

/** A swap landed (`TrajectoryReplaceOptions.onSwap`): `to` is the handle's
 *  table now; each `retired` id stays routed to the handle for `graceUs`
 *  from this instant (0 = unrouted at once) — the controller's own grace. */
export interface TrajectorySwapEvent {
  to: number;
  retired: Array<{ id: number; graceUs: number }>;
}

export interface TrajectoryReplaceOptions {
  /** Called synchronously when the swap lands — BEFORE `replace` resolves
   *  (the old table's DELETE is still to go out) — so a caller scoring pushes
   *  per table id can switch specs at the exact swap. A throw is logged. */
  onSwap?: (swap: TrajectorySwapEvent) => void;
}

/** An uploaded (committed) MCU trajectory table. */
export interface TrajectoryHandle {
  /** The CURRENT MCU table id — a getter: `replace` swaps it to the new
   *  table (listeners and run state carry over). */
  readonly id: number;
  /** START at host-steady `atHostNs` (default: now) for `cycles` (default 0 =
   *  forever). The mirror pre-positions at phase 0 until then. */
  start(atHostNs?: bigint, cycles?: number): Promise<void>;
  /** STOP: the mirror holds its last position; the next stream write takes
   *  the DAC back. Idempotent. */
  stop(): Promise<void>;
  /** DELETE (stops first) and release the table id. Idempotent. */
  dispose(): Promise<void>;
  /** Subscribe to this table's pushes; returns the unsubscribe function. */
  onFrame(cb: (frame: TrajectoryFrameOutcome) => void): () => void;
  /** PHASE-CONTINUOUS swap to a new spec of the SAME period while running:
   *  upload `spec` to a second table id, STOP this one, START the new one at
   *  this run's original `t_start` (so the MCU joins the new table at the
   *  phase the old one was at), DELETE the old table, and carry this handle's
   *  identity (listeners, `id` updates) over. A live steer or slider move in
   *  MirrorLink rides this. Resolves once the new table runs; throws (and
   *  leaves the old table running) if the upload fails. Not running → a plain
   *  re-upload that leaves the handle `ready`.
   *
   *  Wire order while running: BEGIN/DATA/MARK/COMMIT(new), then
   *  - ATOMIC first (firmware >= 2.2.1 and an exact `t_start`): a single
   *    START(new, t_start, cycles) — the firmware swaps in place; a REJ
   *    "already running" (the firmware did not take it) falls back to
   *  - STOP(old) + START(new, t_start, cycles) written back to back (both
   *    awaited after) — the only path below 2.2.1;
   *  → DELETE(old) best-effort. `lastSwap` records which path landed. A
   *  failure of the atomic START WITHOUT a REJ (timeout, lost ACK, device
   *  error) is ambiguous — the firmware may have swapped — and is resolved by
   *  re-STARTing the old table at the same `t_start` (decision table:
   *  docs/spec/controller.md#trajectory-ownership).
   *  `t_start`/`cycles` are the run's original: the exact MCU value sent by
   *  `start(atHostNs)`, or — after a "now" start — the host clock at send
   *  time converted to MCU µs, so the carried phase is then approximate to
   *  the serial latency (and relies on the calibrated clock offset); such an
   *  inexact anchor can never equal the firmware's, so the atomic START is
   *  not attempted for it — until a STOP/START pair (which sends that anchor
   *  explicitly) has been ACKed, after which the anchor is exact.
   *
   *  GRACE: the old id stays routed to this handle's listeners for
   *  `trajectoryGraceUs(old spec)` after the swap (a marker capture in flight
   *  at the swap still pushes with the old id) and is not handed out for a
   *  new table meanwhile. `opts.onSwap` reports the swap and each retired
   *  id's grace synchronously, before this resolves.
   *
   *  SERIALIZATION: `start`/`stop`/`replace` run one at a time in call order
   *  (a replace right after a `start()` waits for its ACK and swaps the
   *  running table). One replace at a time per handle (a second call while
   *  one is queued or running throws; `NodeTrajectory.replace` coalesces);
   *  `dispose` waits for the queue. A START failure after the upload throws
   *  `TrajectoryReplaceError` (`running` says whether the old table is still
   *  running). */
  replace(spec: TrajectorySpec, opts?: TrajectoryReplaceOptions): Promise<void>;
  /** The kind of the last successful RUNNING swap (null before one; a plain
   *  re-upload from a stopped handle leaves it unchanged). */
  readonly lastSwap: TrajectorySwapKind | null;
}

/** A `TrajectoryHandle.replace` whose START of the new table failed (see the
 *  decision table in docs/spec/controller.md#trajectory-ownership). The
 *  handle's `id` and spec stay the OLD table's. `running` is false when the
 *  run is over (the mirror holds its last position); true when the old table
 *  (phase-continuously) still runs. `replacement` is set when the new table
 *  id stays routed to the handle's listeners after the failure: in its grace
 *  (`maybeLive: false` — it may have played for a moment), or reserved as a
 *  possibly-LIVE sibling (`maybeLive: true`, the ambiguous outcome) until the
 *  handle's next stop / swap / dispose retires it. */
export class TrajectoryReplaceError extends Error {
  constructor(
    message: string,
    readonly running: boolean,
    readonly cause?: unknown,
    readonly replacement: { id: number; maybeLive: boolean } | null = null,
  ) {
    super(message);
    this.name = "TrajectoryReplaceError";
  }
}

/** How a CMD_TRAJECTORY START failed. A REJ comes back as an `Error` whose
 *  message is the firmware's reason text (core/src/Controller.cpp REJ
 *  branch); the host-side failures (request timeout, sweep of an unanswered
 *  request, unexpected response, decode error, disconnect) carry other
 *  messages. So a START failure is a REJ only when its message is one of the
 *  firmware's START REJ texts (firmware/src/Protocol.cpp `Trajectory::SET`,
 *  firmware/src/Trajectory.cpp `start`; plus older firmware's unknown-packet
 *  REJ) — anything else is treated as a transport failure, whose outcome on
 *  the device is UNKNOWN (it may have been applied).
 *  - `already-running`: REJ "A trajectory is already running (STOP it first)"
 *  - `rejected`: any other firmware START REJ
 *  - `transport`: no REJ (or an unrecognised message) */
export type TrajectoryStartFailure = "already-running" | "rejected" | "transport";

const TRAJECTORY_START_REJ_TEXTS: readonly RegExp[] = [
  /Unknown trajectory id/i,
  /Trajectory not committed/i,
  /system is not enabled/i,
  /Bad START length/i,
  /Unknown trajectory operation/i,
  /Trajectory packet too short/i,
  /Unknown packet type/i,
];

export function classifyTrajectoryStartError(error: unknown): TrajectoryStartFailure {
  const message = errorMessage(error);
  if (/already running/i.test(message)) return "already-running";
  return TRAJECTORY_START_REJ_TEXTS.some((re) => re.test(message)) ? "rejected" : "transport";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Host-side validation of a trajectory spec against the firmware limits —
 *  throws a descriptive Error, so a bad spec never reaches the wire. */
export function validateTrajectorySpec(spec: TrajectorySpec): void {
  const { samples, periodUs, markers = [] } = spec;
  if (!Number.isInteger(periodUs) || periodUs <= 0 || periodUs > 0xffffffff)
    throw new Error("periodUs must be a positive integer (µs)");
  if (samples.length === 0) throw new Error("a trajectory needs at least one sample");
  if (samples.length > TRAJECTORY_MAX_SAMPLES)
    throw new Error(`a trajectory holds at most ${TRAJECTORY_MAX_SAMPLES} samples`);
  samples.forEach((s, i) => {
    if (!Number.isInteger(s.tOffsetUs) || s.tOffsetUs < 0 || s.tOffsetUs >= periodUs)
      throw new Error(`sample ${i}: tOffsetUs must be an integer in [0, periodUs)`);
    if (i > 0 && s.tOffsetUs <= samples[i - 1].tOffsetUs)
      throw new Error(`sample ${i}: tOffsetUs must be strictly increasing`);
  });
  if (markers.length > TRAJECTORY_MAX_MARKERS)
    throw new Error(`a trajectory holds at most ${TRAJECTORY_MAX_MARKERS} markers`);
  markers.forEach((m, i) => {
    if (!Number.isInteger(m.tOffsetUs) || m.tOffsetUs < 0 || m.tOffsetUs >= periodUs)
      throw new Error(`marker ${i}: tOffsetUs must be an integer in [0, periodUs)`);
    if (!Number.isInteger(m.pulseUs) || m.pulseUs <= 0)
      throw new Error(`marker ${i}: pulseUs must be a positive integer`);
  });
}

/** A native mirror sink bound to a live MCU stream (native-compose-
 *  controller.md): `sink` exposes `pos_in` + the native history queries;
 *  `close()` releases the sink then TERMINATEs the stream (idempotent). */
export interface NativeMirrorSinkHandle {
  readonly sink: MirrorSink;
  /** The bound MCU stream's id — the CMD_FRAME target for trigger-sync capture
   *  on this sink's stream (spec disparity-scope §trigger-sync). */
  readonly streamId: number;
  close(): Promise<void>;
}

/** `Controller.frame()`'s decoded result — DAC channels converted to volts,
 *  matching `actuate()`'s existing convention. Distinct from core's raw
 *  `FrameResult` (`core/Controller`), which is in wire units. */
export interface FrameOutcome {
  /** Stable per-capture frame identity (FIN `frame_id`) — binds this
   *  outcome to the exact camera frame it produced, for downstream recorder
   *  metadata. */
  frameId: number;
  stream: number;
  /** OWNER-APPLIED TRUSTED TIME (unified-time): host-steady-domain
   *  NANOSECONDS — the raw MCU µs ×1000 plus the controller's calibrated dt
   *  (0 until `setClockOffsetNs`, i.e. raw µs-resolution ns). Downstream
   *  nodes NEVER re-correct these. */
  tTrigger: bigint;
  tExposure: bigint;
  /** Exposure-AVERAGED mirror voltage for this frame (MEMS voltage
   *  sampled at exposure start AND finish, then averaged), converted DAC→volts
   *  like `actuate()`. */
  left: Pos;
  right: Pos;
  /** Present ONLY on an outcome the controller node forwards from a running
   *  uploaded trajectory (an OK `SYN CMD_TRAJECTORY` push, v2.2.0) rather
   *  than a `CMD_FRAME` FIN. `stream` then carries the trajectory id (the
   *  firmware's `result.stream`), so a consumer that keys on stream ids can
   *  tell the two apart here; FIN consumers that only need the exposure time
   *  + volts (the anchor node) ignore it. */
  trajectory?: { id: number; marker: number; cycle: number };
}

export class Controller {
  /** First serial port whose fields all match `match` (e.g. vendor/product id). */
  static async match(match: Partial<PortInfo>): Promise<PortInfo | undefined> {
    search: for (const info of await SerialPort.list()) {
      for (const [k, v] of Object.entries(match))
        if (info[k as keyof PortInfo] !== v) continue search;
      return info;
    }
  }

  private readonly device: Device;
  readonly ready: Promise<void>;
  /** Serial port path (e.g. `/dev/tty…`) — the identity behind this device's
   *  `controller:<port>` serial meter. The controller NODE folds that meter
   *  into its stats by this key on bind. */
  readonly port: string;
  private bias = 0;
  // Owner-applied dt (unified-time): host-steady-ns offset mapping
  // the MCU µs clock into the trusted domain. 0 until calibration (the ping
  // on connect); atomically swapped on mid-task re-calibration (the
  // controller session re-pings every 30 s) — outcomes decoded after the
  // swap carry the new offset.
  private _clockOffsetNs = 0n;
  private _clockCalibrated = false;
  private clockPingMisses = 0;
  /** The installed MCU→host offset (host-steady ns at MCU µs 0; 0n before
   *  calibration), read-only — `hostNs = mcuUs * 1000 + clockOffsetNs`. A
   *  re-ping replaces it (`setClockOffsetNs`); a consumer that anchored an
   *  instant on the old offset (MirrorLink's trajectory start, carried in MCU
   *  µs) re-bases its host-ns view by the difference. */
  get clockOffsetNs(): bigint {
    return this._clockOffsetNs;
  }
  /** Install the calibrated MCU→host offset (from `pingControllerOffset`).
   *  Every FIN timestamp surfaced after this call is trusted host-ns. Marks
   *  the clock calibrated and clears the consecutive-miss count. */
  setClockOffsetNs(offsetNs: bigint): void {
    this._clockOffsetNs = offsetNs;
    this._clockCalibrated = true;
    this.clockPingMisses = 0;
  }
  /** A calibration ping round produced no offset (timed out or failed). Two
   *  misses IN A ROW mark the clock uncalibrated again (`clockCalibrated`
   *  false) — the last offset stays installed, but is no longer vouched for;
   *  the next landed ping restores it. */
  noteClockPingMissed(): void {
    this.clockPingMisses++;
    if (this.clockPingMisses >= 2) this._clockCalibrated = false;
  }
  /** True once a calibration ping landed (`setClockOffsetNs`); false again
   *  after two consecutive missed pings (`noteClockPingMissed`). MirrorLink
   *  refuses to scan while false: its trajectory start instant and every
   *  marker timestamp ride this offset. */
  get clockCalibrated(): boolean {
    return this._clockCalibrated;
  }
  private _enabled = false;
  /** Host-side floor between two UPDATEs on one stream (ms): the JS
   *  `StreamUpdateGate` reads it live on every update; native sinks take it
   *  as `minIntervalUs` at creation. Default STREAM_MIN_UPDATE_INTERVAL_MS. */
  streamMinIntervalMs = STREAM_MIN_UPDATE_INTERVAL_MS;
  // Firmware version resolved by verifyVersion() during `ready` — retained so
  // version-gated surfaces finer than v2Capable (e.g. recoverMems, >= 2.1.0)
  // can compare minor/patch. null until `ready` resolves, or if verifyVersion
  // yields nothing (a v1 device / a test fake).
  private firmwareVersion: FirmwareVersion | null = null;
  private _pos: { left: Pos; right: Pos } = origin;
  private readonly streamIds = new StreamIdPool();
  // Live-stream telemetry: `count` accumulates between `streamSnapshot()`
  // calls, which reset it — the caller's sampling interval turns the raw
  // count into a rolling Hz. `left`/`right` are the last-sent target, for the
  // profiler's per-stream XY position pad.
  private readonly streamStats = new Map<
    number,
    { count: number; left: Pos; right: Pos }
  >();
  /** Observe-only serial WRITE meter. One `packets` output is emitted on
   *  every packet pushed to the wire — the awaited `set`/`actuate`/stream
   *  create+terminate + `frame` paths AND the fire-and-forget stream `update`
   *  hot path — so the serial send rate becomes a first-class
   *  `perfSnapshot.workloads` row (`controller:<port>`) the profiler sorts
   *  and flags. The `actuate()` round-trip is also timed as busy. NEVER gates:
   *  `emit`/`measure` are safe no-ops post-dispose and always run the wrapped
   *  send unchanged (the metering "observe, never gate" contract). */
  private readonly serialMeter: WorkloadHandle;

  constructor(
    info: PortInfo,
    readonly dv: number = 170.0,
    bias: number = 90.0,
    lpf: number = 120,
    log_level: LogLevel = "INFO",
  ) {
    this.port = info.path;
    this.serialMeter = registerWorkload(`controller:${info.path}`, {
      inputs: [],
      outputs: ["packets"],
    });
    this.device = new Device(info.path);
    const device = this.device;
    this.ready = (async () => {
      // Must run before anything two-phase-sensitive (createStream/frame,
      // and actuate/trigger's `.accepted`). Never throws on a version
      // *mismatch* (only on a transport failure): old firmware just keeps
      // device.v2Capable false (v1-compat).
      // Retain the resolved version for the finer-grained recover gate
      // (v21Capable). `?? null` tolerates a device/fake that resolves nothing.
      this.firmwareVersion = (await device.verifyVersion()) ?? null;
      // Pipelined: requests are matched by seq and the firmware handles them
      // in wire order, so the disable → bias → LPF → log-level sequence is
      // written back-to-back (one round trip, not four). Each call writes
      // synchronously, so the wire order is the call order (Bias is REJected
      // while enabled — Enable(false) still lands first).
      await Promise.all([
        this.disable(),
        this.setBias(bias),
        this.setLPF(lpf),
        this.setLogLevel(log_level),
      ]);
    })();
  }

  get connected() {
    return this.device.connected;
  }
  get enabled() {
    return this._enabled;
  }
  get pos() {
    return this._pos;
  }
  /** See `ready` — set once `verifyVersion()` resolves. CMD_STREAM/CMD_FRAME
   *  (createStream/frame below) don't exist at all on v1 firmware, unlike
   *  actuate/trigger's v1-compat fallback — so they hard-require this. */
  get v2Capable() {
    return this.device.v2Capable;
  }
  /** True once `ready` has confirmed firmware >= 2.1.0 — the version that adds
   *  the System::Reset MEMS recovery type. Finer-grained
   *  sibling of `v2Capable` (which gates on the major number only); gates
   *  `recoverMems()` and the renderer's "Recover mirror" affordance. */
  get v21Capable() {
    return (
      this.firmwareVersion != null &&
      versionAtLeast(this.firmwareVersion, RECOVER_MEMS_MIN_VERSION)
    );
  }
  /** True once `ready` has confirmed firmware >= 2.2.0 — CMD_SCHEDULE
   *  (`StreamHandle.scheduleAt`) and CMD_TRAJECTORY (`uploadTrajectory`). */
  get v22Capable() {
    return (
      this.firmwareVersion != null &&
      versionAtLeast(this.firmwareVersion, SCHEDULE_MIN_VERSION)
    );
  }
  /** True once `ready` has confirmed firmware >= 2.2.1 — the ATOMIC
   *  trajectory swap (`TrajectoryHandle.replace` tries a single in-place
   *  START before the STOP/START pair). */
  get v221Capable() {
    return (
      this.firmwareVersion != null &&
      versionAtLeast(this.firmwareVersion, ATOMIC_SWAP_MIN_VERSION)
    );
  }
  /** Cumulative serial byte/packet counters — the caller derives rates by
   *  diffing successive samples, same pattern as `streamSnapshot()`'s Hz. */
  get stats() {
    return this.device.stats;
  }

  /** Live per-stream `{id, hz, left, right}` snapshot, resetting each
   *  stream's call counter — call at a fixed interval (`intervalSec`) so
   *  `hz` is meaningful. */
  streamSnapshot(
    intervalSec: number,
  ): Array<{ id: number; hz: number; left: Pos; right: Pos }> {
    const out: Array<{ id: number; hz: number; left: Pos; right: Pos }> = [];
    for (const [id, s] of this.streamStats) {
      out.push({ id, hz: s.count / intervalSec, left: s.left, right: s.right });
      s.count = 0;
    }
    return out;
  }

  release() {
    this.serialMeter.dispose();
    this.device.release();
  }

  // `prop: any` like set() below: the d.ts `PacketFactory` type is not
  // exported, and `Parameters<Device["get"]>[0]` collapses the generic to
  // PacketFactory<unknown>, which no concrete factory is assignable to
  // (contravariant input). Callers pin the decode type via <T>.
  private get<T>(prop: any) {
    if (!this.device.connected) throw new Error("Controller not connected");
    // A GET is one serial write too — same observe-only accounting as set()
    // below (covers readTimestamp's calibration pings).
    this.serialMeter.emit("packets");
    return this.device.get(prop) as Promise<T>;
  }
  private set<T>(prop: any, arg: T) {
    if (!this.device.connected) throw new Error("Controller not connected");
    // Covers enable/disable/setBias/setLPF/setLogLevel/trigger — every config
    // + command write routed through here is one serial packet.
    this.serialMeter.emit("packets");
    return this.device.set(prop, arg as any);
  }

  get info() {
    return this.device.get(Protocol.System.Info);
  }
  get version() {
    return this.device.get(Protocol.System.Version);
  }

  async enable() {
    await this.set(Protocol.System.Enable, true);
    this._enabled = true;
  }
  async disable() {
    this._pos = origin;
    await this.set(Protocol.System.Enable, false);
    this._enabled = false;
  }

  /** Re-initialize the MEMS DACs WITHOUT dropping the session.
   *  Sends System::Reset(MEMS = 2), which runs the MEMS::enable() re-init
   *  (AD5664R software reset + reference/DAC power-on + neutral bias) WITHOUT
   *  cycling the driver rail or clearing the stream table — the app-side
   *  "recover mirror" action. Single-phase:
   *  resolves on ACK, propagates the firmware REJ as a rejection (the firmware
   *  REJs when the system is disabled). Requires firmware >= 2.1.0 (older
   *  firmware REJects the unknown enum), guarded locally like createStream()'s
   *  v2 gate. `"MEMS"` is the EnumPacket name the firmware maps to wire value
   *  2 (Reset::Type::MEMS). Deliberately does NOT touch `_pos`/`_enabled`: the
   *  session stays enabled and its target unchanged across the recovery. */
  async recoverMems(): Promise<void> {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.v21Capable)
      throw new Error(
        "recoverMems requires firmware >= 2.1.0 (System::Reset MEMS type unavailable)",
      );
    await this.set(Protocol.System.Reset, "MEMS");
  }

  /** Clock-calibration ping (unified-time): the MCU's
   *  current clock in MICROSECONDS as a uint64 `bigint`, stamped
   *  firmware-side at packet parse time so the reading's jitter stays at the
   *  serial-latency floor. RAW BY CONTRACT — this is the calibration
   *  primitive itself; owner-applied dt (setClockOffsetNs) deliberately does
   *  NOT apply here, unlike every other surfaced timestamp. Requires
   *  firmware >= v1.1 (older firmware REJects the unknown property). */
  async readTimestamp(): Promise<bigint> {
    const ts = await this.get<BigInt>(Protocol.System.Timestamp);
    return ts.valueOf();
  }
  /** Resets the MCU clock counter to 0 (SET System.Timestamp) — the ONLY
   *  clock reset (enable() does not reset time). Invalidates
   *  any prior offset calibration: re-ping after using this. */
  async resetTimestamp(): Promise<void> {
    await this.set(Protocol.System.Timestamp, 0n);
  }

  setLogLevel(level: LogLevel) {
    return this.set(Protocol.Config.Log, level);
  }
  setLPF(value: number) {
    return this.set(Protocol.Config.LPF, value);
  }
  async setBias(value: number) {
    const bias = await this.set(Protocol.Config.Bias, volt2dac(value));
    this.bias = dac2volt(Number(bias));
    return this.bias;
  }

  async actuate(pos: { left?: Pos; right?: Pos }, settleTime = 0) {
    // `settle_time`/`complete_time` are the NATIVE core `Device.set` protocol
    // field names — they stay snake_case at this boundary; only the
    // wire-facing param/return are camelCased.
    this.serialMeter.emit("packets");
    // `measure` times the actuate round-trip as busy while running the send
    // unchanged (span stays open until the awaited set settles).
    const { left, right, complete_time } = await this.serialMeter.measure(() =>
      this.device.set(Protocol.Command.Actuate, {
        left: channels(pos.left ?? this._pos.left, this.bias, this.dv),
        right: channels(pos.right ?? this._pos.right, this.bias, this.dv),
        settle_time: settleTime,
      }),
    );
    const new_pos = { left: decodeChannels(left), right: decodeChannels(right) };
    this._pos = new_pos;
    return { ...new_pos, completeTime: complete_time ?? 0 };
  }

  /**
   * Locally predict the actuated volts for `pos` WITHOUT a serial round-trip:
   * the exact `channels()`→`dac2volt` math `actuate()` applies to the ACK
   * readback, assuming the firmware echoes the commanded channels (verify the
   * prediction against a sampled real readback on hardware). This lets the fire-
   * and-forget streaming actuation path (the controller thread node,
   * `controller-node.ts`) publish telemetry /
   * fovea-wrap volts without paying the awaited readback the streaming protocol
   * has no response for anyway. Pure: reads only `pos`, `_pos` (fallback for an
   * unspecified axis), `bias`, and `dv` — no serial I/O, no mutation.
   */
  predictVolts(pos: { left?: Pos; right?: Pos }): { left: Pos; right: Pos } {
    return {
      left: decodeChannels(channels(pos.left ?? this._pos.left, this.bias, this.dv)),
      right: decodeChannels(channels(pos.right ?? this._pos.right, this.bias, this.dv)),
    };
  }

  /** Mirror a STREAMED target into the local `pos` (v2 fire-and-forget has no
   *  readback). The controller node feeds the predicted volts it just applied so
   *  `pos` stays live for readers that expect the awaited-actuate invariant —
   *  calibrate voltage capture, drift derivation. LOCAL only: sends nothing to
   *  the wire (the CMD_STREAM update already carries the command). */
  applyStreamedPos(pos: { left: Pos; right: Pos }): void {
    this._pos = { left: clonePos(pos.left), right: clonePos(pos.right) };
  }

  trigger(duration_ns: number) {
    return this.set(Protocol.Command.Trigger, duration_ns);
  }

  // --- Protocol v2: streams + synced-frame requests -----------------------
  // Deliberately independent of `this._pos`/`actuate()` — mixing Actuate
  // writes with an active stream leaves `Streams::snapshot()` reporting the
  // stream's target rather than the DAC's actual (Actuate-set) state; callers
  // should pick one.

  /** Creates a CMD_STREAM (id auto-allocated, 0..63 — Streams::CAPACITY).
   *  ACK-backed (protocol-level single-phase: ACK/REJ, no FIN). */
  async createStream(pos: { left: Pos; right: Pos }): Promise<StreamHandle> {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.device.v2Capable)
      throw new Error(
        "createStream requires v2-capable firmware (verifyVersion() has not confirmed compatibility)",
      );
    const id = this.streamIds.allocate();
    try {
      this.serialMeter.emit("packets");
      await this.device.set(Protocol.Command.MirrorStream, {
        op: "CREATE",
        id,
        left: channels(pos.left, this.bias, this.dv),
        right: channels(pos.right, this.bias, this.dv),
      });
    } catch (error) {
      this.streamIds.release(id);
      throw error;
    }
    this.streamStats.set(id, { count: 0, left: pos.left, right: pos.right });
    const gate = new StreamUpdateGate(pos, () => this.streamMinIntervalMs);
    let closed = false;
    return {
      id,
      update: (next, opts) => {
        if (closed) throw new Error(`Stream ${id} is closed`);
        if (opts?.force) gate.force(next);
        else if (!gate.accept(next)) return false;
        try {
          this.device.fireAndForget(Protocol.Command.MirrorStream, {
            op: "UPDATE",
            id,
            left: channels(next.left, this.bias, this.dv),
            right: channels(next.right, this.bias, this.dv),
          });
        } catch {
          // Latest-wins drop (full kernel queue / requests queued ahead —
          // counted natively in txSoftFail, the governor's signal). Never
          // throw into the caller's hot path (native-sink parity); re-arm the
          // dedupe so a resting target is re-sent on the next push.
          gate.forgetLast();
          return false;
        }
        // The ~kHz-capable stream hot path — `emit` is an O(1) counter bump,
        // never a gate on the fire-and-forget write.
        this.serialMeter.emit("packets");
        const stats = this.streamStats.get(id);
        if (stats) {
          stats.count++;
          stats.left = next.left;
          stats.right = next.right;
        }
        return true;
      },
      scheduleAt: (hostNs, next, opts) => {
        if (closed) throw new Error(`Stream ${id} is closed`);
        if (!this.v22Capable)
          throw new Error(
            "scheduleAt requires firmware >= 2.2.0 (CMD_SCHEDULE unavailable)",
          );
        this.device.fireAndForget(Protocol.Command.Schedule, {
          stream: id,
          t_apply: hostNsToMcuUs(hostNs, this._clockOffsetNs),
          interpolate: opts?.interpolate ?? false,
          left: channels(next.left, this.bias, this.dv),
          right: channels(next.right, this.bias, this.dv),
        });
        this.serialMeter.emit("packets");
        const stats = this.streamStats.get(id);
        if (stats) stats.count++;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          this.serialMeter.emit("packets");
          await this.device.set(Protocol.Command.MirrorStream, {
            op: "TERMINATE",
            id,
          });
        } finally {
          this.streamIds.release(id);
          this.streamStats.delete(id);
        }
      },
    };
  }

  /**
   * native-compose-controller.md: create the MCU stream (ACK-backed, same
   * guards as {@link createStream}) and attach a NATIVE pos_in sink to the
   * device's write seam — the UPDATE path (gate + channels() + fire-and-
   * forget + history) then runs entirely native off a port link's delivery
   * thread. JS KEEPS stream lifecycle ownership: `close()` releases the sink
   * (writes stop) and TERMINATEs the stream (quiesce unchanged).
   */
  async createNativeMirrorSink(
    pos: { left: Pos; right: Pos },
    nodeId = "controller",
  ): Promise<NativeMirrorSinkHandle> {
    const stream = await this.createStream(pos);
    const sink = createMirrorSink(this.device, {
      streamId: stream.id,
      bias: this.bias,
      dv: this.dv,
      nodeId,
    });
    // One tunable for both update paths: the native gate's emission floor.
    sink.setGovernor?.({ minIntervalUs: Math.round(this.streamMinIntervalMs * 1000) });
    let closed = false;
    return {
      sink,
      streamId: stream.id,
      close: async () => {
        if (closed) return;
        closed = true;
        sink.release(); // stop native writes FIRST
        await stream.close(); // then TERMINATE (best-effort on a dead device)
      },
    };
  }

  /** Issues a CMD_FRAME triggered-capture request on `stream`.
   *  Two-phase: `.accepted` resolves on ACK (queue position; rejects on
   *  REJ) independently of the returned promise, which resolves on FIN with
   *  the exposure-AVERAGED mirror voltage (converted to volts like
   *  `actuate()`) plus the FIN `frameId` and the MCU trigger/exposure
   *  timestamps — feed these to `sync.ts`'s `calibrate`/`matchPair` for L/R
   *  pairing, and `frameId` binds the voltage to the recorded frame. */
  frame(opts: {
    stream: number;
    cameras?: CameraName[] | number;
    pulse?: number;
    /** v2.0 trigger settle HOLD (µs) — the firmware holds the trigger this
     *  long after a stream SWITCH (mirror moved to this stream's target), then
     *  runs the normal exposure. Independent of `pulse` (NOT subtracted from
     *  exposure). Omitted/0 = fire immediately (pre-v2.0 behavior). */
    settle_time?: number;
  }): Promise<FrameOutcome> & { accepted: Promise<unknown> } {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.device.v2Capable)
      throw new Error(
        "frame requires v2-capable firmware (verifyVersion() has not confirmed compatibility)",
      );
    this.serialMeter.emit("packets");
    const req = this.device.get(Protocol.Command.Frame, opts as FrameArg);
    const accepted = req.accepted;
    const completed = (async (): Promise<FrameOutcome> => {
      const result = await req;
      return {
        frameId: result.frame_id,
        stream: result.stream,
        // Owner-applied trusted time (unified-time): raw MCU µs →
        // host-steady ns at THE decode boundary. No downstream correction.
        tTrigger: result.t_trigger * 1000n + this._clockOffsetNs,
        tExposure: result.t_exposure * 1000n + this._clockOffsetNs,
        left: {
          x: dac2volt(result.left[0] - result.left[1]),
          y: dac2volt(result.left[2] - result.left[3]),
        },
        right: {
          x: dac2volt(result.right[0] - result.right[1]),
          y: dac2volt(result.right[2] - result.right[3]),
        },
      };
    })();
    return Object.assign(completed, { accepted });
  }

  // --- Protocol v2.2.0: uploaded trajectories (MirrorLink) -----------------
  // spec: docs/spec/serial-protocol.md#trajectory

  private readonly trajectoryIds = new Set<number>();
  private readonly trajectoryListeners = new Map<
    number,
    Set<(frame: TrajectoryFrameOutcome) => void>
  >();
  /** Per-id run tracking of the owning handle (a run-level ENDED/CANCELLED
   *  clears its running view) — routed with the listener set on a replace. */
  private readonly trajectoryRunHooks = new Map<number, (f: TrajectoryFrame) => void>();
  /** Retired table ids in their GRACE period (`trajectoryGraceUs`): id →
   *  host-steady ns deadline. Until then the id's pushes still reach the
   *  retiring handle's listener set (a marker capture in flight at the swap
   *  finishes later with the OLD id) and the id is not allocated again. */
  private readonly trajectoryGrace = new Map<number, bigint>();
  private trajectoryPushBound = false;

  /** Decode one SYN CMD_TRAJECTORY push like `frame()`'s FIN: volts, and MCU
   *  µs → trusted host-steady ns through the current clock offset. */
  decodeTrajectoryFrame(f: TrajectoryFrame): TrajectoryFrameOutcome {
    return {
      trajectoryId: f.id,
      marker: f.marker,
      cycle: f.cycle,
      status: f.status,
      frameId: f.result.frame_id,
      tTrigger: mcuUsToHostNs(f.result.t_trigger, this._clockOffsetNs),
      tExposure: mcuUsToHostNs(f.result.t_exposure, this._clockOffsetNs),
      left: decodeChannels(f.result.left),
      right: decodeChannels(f.result.right),
    };
  }

  private bindTrajectoryPush(): void {
    if (this.trajectoryPushBound) return;
    this.trajectoryPushBound = true;
    this.device.onPush(Protocol.Command.TrajectoryFrame, (f) => {
      // A push for an id in grace: expire it first if the deadline passed
      // (the routing goes with it — a straggler that late is nobody's).
      if (this.trajectoryGrace.has(f.id)) this.sweepTrajectoryGrace();
      this.trajectoryRunHooks.get(f.id)?.(f);
      const listeners = this.trajectoryListeners.get(f.id);
      if (!listeners || listeners.size === 0) return;
      const outcome = this.decodeTrajectoryFrame(f);
      for (const cb of listeners) {
        try {
          cb(outcome);
        } catch (error) {
          console.error("trajectory onFrame listener threw:", error);
        }
      }
    });
  }

  /** Put the retired table `id` in grace for `graceUs`: its pushes keep
   *  reaching `listeners` (the retiring handle's set, possibly empty after a
   *  dispose — then they are swallowed) and it is not allocated until the
   *  deadline. The run hook is NOT kept: a retired table's pushes never end
   *  the handle's current run. `graceUs <= 0` unroutes at once. */
  private graceTrajectoryId(
    id: number,
    listeners: Set<(frame: TrajectoryFrameOutcome) => void>,
    graceUs: number,
  ): void {
    this.trajectoryRunHooks.delete(id);
    if (graceUs <= 0) {
      if (this.trajectoryListeners.get(id) === listeners) this.trajectoryListeners.delete(id);
      return;
    }
    this.trajectoryListeners.set(id, listeners);
    this.trajectoryGrace.set(id, hostNowNs() + BigInt(Math.ceil(graceUs)) * 1000n);
  }

  /** Expire every grace entry whose deadline has passed (or every entry
   *  with a deadline at or before `upToNs`), unrouting its id. */
  private sweepTrajectoryGrace(upToNs: bigint = hostNowNs()): void {
    for (const [id, until] of this.trajectoryGrace) {
      if (until > upToNs) continue;
      this.trajectoryGrace.delete(id);
      // Only a not-yet-reallocated id can be in grace, so its routing is
      // still the retiring handle's.
      this.trajectoryListeners.delete(id);
      this.trajectoryRunHooks.delete(id);
    }
  }

  /** Reserve the lowest FREE table id — neither held by a handle nor in
   *  grace. When every id is taken but some are only in grace, wait for the
   *  earliest grace to run out (real time, so a frozen test clock cannot
   *  wedge it); throws at capacity otherwise. */
  private async allocTrajectoryId(): Promise<number> {
    for (;;) {
      this.sweepTrajectoryGrace();
      for (let candidate = 0; candidate < TRAJECTORY_MAX_TABLES; candidate++)
        if (!this.trajectoryIds.has(candidate) && !this.trajectoryGrace.has(candidate)) {
          this.trajectoryIds.add(candidate);
          return candidate;
        }
      if (this.trajectoryGrace.size === 0)
        throw new Error(`Trajectory capacity (${TRAJECTORY_MAX_TABLES} tables) exceeded`);
      let earliest: bigint | null = null;
      for (const until of this.trajectoryGrace.values())
        if (earliest === null || until < earliest) earliest = until;
      const waitMs = Math.max(1, Math.ceil(Number(earliest! - hostNowNs()) / 1e6));
      await new Promise((r) => setTimeout(r, waitMs));
      this.sweepTrajectoryGrace(earliest!);
    }
  }

  /** `set` with a synchronous throw (disconnected) turned into a rejection,
   *  so two writes can be issued back to back and settled together. */
  private sendTrajectory(arg: Record<string, unknown>): Promise<unknown> {
    try {
      return this.set(Protocol.Command.Trajectory, arg);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** BEGIN → DATA chunks (pipelined) → MARK → COMMIT of `spec` into the
   *  reserved table `id` — the one upload path (`uploadTrajectory` and
   *  `TrajectoryHandle.replace`). A failure DELETEs the partial table
   *  (best-effort) and rethrows; releasing the id is the caller's. */
  private async uploadTable(id: number, spec: TrajectorySpec): Promise<void> {
    const Trajectory = Protocol.Command.Trajectory;
    try {
      await this.set(Trajectory, {
        op: "BEGIN",
        id,
        sample_count: spec.samples.length,
        period: spec.periodUs,
        step: spec.step ?? false,
      });
      const chunks = chunkTrajectorySamples(spec.samples);
      await pipelined(
        chunks.map((chunk) => () =>
          this.set(Trajectory, {
            op: "DATA",
            id,
            first_index: chunk.firstIndex,
            samples: chunk.samples.map((s) => ({
              t_offset: s.tOffsetUs,
              left: channels(s.left, this.bias, this.dv),
              right: channels(s.right, this.bias, this.dv),
            })),
          }),
        ),
        TRAJECTORY_UPLOAD_WINDOW,
      );
      for (const [marker, m] of (spec.markers ?? []).entries())
        await this.set(Trajectory, {
          op: "MARK",
          id,
          marker,
          t_offset: m.tOffsetUs,
          cameras: m.cameras ?? ["L", "R"],
          pulse: m.pulseUs,
        });
      await this.set(Trajectory, { op: "COMMIT", id });
    } catch (error) {
      try {
        await this.sendTrajectory({ op: "DELETE", id });
      } catch {
        // best-effort cleanup on a dead/REJecting device
      }
      throw error;
    }
  }

  /**
   * Upload a periodic trajectory to the MCU (CMD_TRAJECTORY BEGIN → DATA
   * chunks → MARK → COMMIT, all ACK-backed; DATA pipelined
   * TRAJECTORY_UPLOAD_WINDOW deep). Positions are volts, converted with the
   * same `channels()` math as streams. The returned handle STARTs/STOPs the
   * MCU-side playback; its `onFrame` is fed by the per-marker SYN pushes.
   * Steady state: zero host→MCU bytes, one push per marker firing. Requires
   * firmware >= 2.2.0. A failed upload DELETEs the partial table.
   */
  async uploadTrajectory(spec: TrajectorySpec): Promise<TrajectoryHandle> {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.v22Capable)
      throw new Error(
        "uploadTrajectory requires firmware >= 2.2.0 (CMD_TRAJECTORY unavailable)",
      );
    validateTrajectorySpec(spec);
    const firstId = await this.allocTrajectoryId();
    this.bindTrajectoryPush();
    try {
      await this.uploadTable(firstId, spec);
    } catch (error) {
      this.trajectoryIds.delete(firstId);
      throw error;
    }

    // The handle's CURRENT table — `replace` swaps it (and moves the
    // listener set + run hook to the new id); `id` reads it live.
    let id = firstId;
    let current = spec;
    // The current table has been STARTed at least once — only then can a
    // marker capture of it still be in flight when it retires (grace).
    let played = false;
    let lastSwap: TrajectorySwapKind | null = null;
    const listeners = new Set<(frame: TrajectoryFrameOutcome) => void>();
    // The host's view of the run: set on a START ack, cleared on a STOP ack,
    // dispose, or a run-level ENDED / CANCELLED push. `tStartMcuUs` is the
    // MCU instant the run is anchored at — the exact value sent for an
    // explicit start (`exact`), the converted send-time host clock for a
    // "now" start (t_start = 0 on the wire; the carried phase is then
    // approximate to the serial latency). `replace` re-STARTs the new table
    // at it.
    let run: { tStartMcuUs: bigint; cycles: number; exact: boolean } | null = null;
    const runHook = (f: TrajectoryFrame) => {
      if (f.marker === null && (f.status === "ENDED" || f.status === "CANCELLED")) run = null;
    };
    /** Route `to`'s pushes to this handle (listeners + run hook). */
    const route = (to: number) => {
      this.trajectoryListeners.set(to, listeners);
      this.trajectoryRunHooks.set(to, runHook);
    };
    /** Forget `from`'s routing iff it is still this handle's. */
    const unroute = (from: number) => {
      if (this.trajectoryListeners.get(from) === listeners) this.trajectoryListeners.delete(from);
      if (this.trajectoryRunHooks.get(from) === runHook) this.trajectoryRunHooks.delete(from);
    };
    /** Retire `table` (spec `of`, STARTed iff `wasPlayed`): grace its id when
     *  a capture of it may still be in flight, else unroute it at once. */
    const retire = (table: number, of: TrajectorySpec, wasPlayed: boolean) =>
      this.graceTrajectoryId(table, listeners, wasPlayed ? trajectoryGraceUs(of) : 0);
    route(id);
    let disposed = false;
    // SERIALIZATION: start / stop / replace run one at a time, in call order,
    // on one chain (`serialize`) — a replace issued while a START is still
    // awaiting its ACK runs after it (and sees `run`), a stop() issued during
    // a replace runs after the swap. One replace may be queued or running at
    // a time (`replacing`; a second concurrent call throws). dispose() marks
    // the handle disposed and waits for the chain (queued ops then refuse).
    let tail: Promise<unknown> = Promise.resolve();
    let replacing = false;
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = tail.then(() => fn());
      tail = p.catch(() => {});
      return p;
    };
    const settle = async () => {
      for (let t = tail; ; t = tail) {
        await t;
        if (t === tail) return;
      }
    };
    const live = (what: string) => {
      if (disposed) throw new Error(`Trajectory ${id} is disposed (${what})`);
    };
    // SIBLINGS: replacement tables left reserved and routed to this handle
    // because they MAY be live on the MCU (an atomic START that failed without
    // a REJ, whose old-table re-START was then REJected "already running" —
    // see `doReplace`). id → spec. The next stop() / swap STOPs and retires
    // them (grace, then DELETE); dispose() DELETEs them.
    const siblings = new Map<number, TrajectorySpec>();
    /** DELETE `table` best-effort and release its id. The DELETE may go out
     *  at once even inside the grace: the firmware's push for an in-flight
     *  marker capture carries the id copied into the capture request
     *  (Capture.cpp `finishActive` → `Trajectory::push`) and never looks the
     *  table up. */
    const drop = async (table: number) => {
      try {
        if (this.device.connected) await this.sendTrajectory({ op: "DELETE", id: table });
      } catch {
        // best-effort — a dead/REJecting device
      } finally {
        this.trajectoryIds.delete(table);
      }
    };
    /** Grace + DELETE every sibling in `ids` (default: all). */
    const dropSiblings = async (ids: Iterable<number> = [...siblings.keys()]) => {
      const gone: number[] = [];
      for (const sid of ids) {
        const sspec = siblings.get(sid);
        if (!sspec) continue;
        siblings.delete(sid);
        retire(sid, sspec, true);
        gone.push(sid);
      }
      for (const sid of gone) await drop(sid);
    };
    /** The swap landed: `newId` (spec `next`) is the handle's table now. The
     *  old table and every sibling retire into their grace; `onSwap` hears
     *  each retired id with the grace the controller applied, synchronously
     *  (before any of their DELETEs goes out). Returns the ids to DELETE. */
    const swapTo = (
      newId: number,
      next: TrajectorySpec,
      nowPlaying: boolean,
      onSwap?: TrajectoryReplaceOptions["onSwap"],
    ): number[] => {
      const oldId = id;
      const old = current;
      const oldPlayed = played;
      route(newId);
      id = newId;
      current = next;
      played = nowPlaying;
      const retired = [{ id: oldId, graceUs: oldPlayed ? trajectoryGraceUs(old) : 0 }];
      retire(oldId, old, oldPlayed);
      for (const [sid, sspec] of siblings) {
        retire(sid, sspec, true);
        retired.push({ id: sid, graceUs: trajectoryGraceUs(sspec) });
      }
      siblings.clear();
      try {
        onSwap?.({ to: newId, retired });
      } catch (error) {
        console.error("trajectory onSwap hook threw:", error);
      }
      return retired.map((r) => r.id);
    };

    const doReplace = async (
      next: TrajectorySpec,
      onSwap?: TrajectoryReplaceOptions["onSwap"],
    ): Promise<void> => {
      live("replace");
      validateTrajectorySpec(next);
      if (run && next.periodUs !== current.periodUs)
        throw new Error(
          `Trajectory ${id}: replace while running needs the same period (${current.periodUs} µs, got ${next.periodUs} µs) — stop, replace, then start`,
        );
      if (!this.device.connected) throw new Error("Controller not connected");
      const oldId = id;
      const newId = await this.allocTrajectoryId();
      try {
        await this.uploadTable(newId, next);
      } catch (error) {
        this.trajectoryIds.delete(newId); // uploadTable DELETEd the partial table
        throw error;
      }
      if (disposed) {
        // dispose() came in during the upload (it waits for us): never START
        // the new table — retire it; dispose then DELETEs the old one.
        await drop(newId);
        throw new Error(`Trajectory ${oldId} is disposed (replace)`);
      }
      const carried = run;
      if (!carried) {
        // Not running: a plain re-upload — swap, then retire the old table
        // (in grace if it was played: a stop() just before may have left a
        // capture in flight) and any sibling.
        for (const gone of swapTo(newId, next, false, onSwap)) await drop(gone);
        return;
      }
      /** A START(…, carried.tStartMcuUs) was ACKed: the firmware recorded
       *  exactly that t_start, so the run's anchor is EXACT from now on and
       *  later replaces may try the atomic START (even after a "now" start). */
      const anchorExact = () => {
        if (run === carried && !carried.exact) run = { ...carried, exact: true };
      };
      const startTable = (table: number) =>
        this.sendTrajectory({
          op: "START",
          id: table,
          t_start: carried.tStartMcuUs,
          cycles: carried.cycles,
        });
      // The new id's pushes reach the same listeners from START on.
      route(newId);
      if (this.v221Capable && carried.exact) {
        // ATOMIC (2.2.1): one START while the old table runs — the firmware
        // swaps tables in place (same period, same exact t_start). Decision
        // table: docs/spec/controller.md#trajectory-ownership.
        //  ACK                   → swapped ("atomic").
        //  REJ "already running" → not taken: the STOP/START pair below.
        //  any other REJ         → not taken, nothing stopped: still running.
        //  no REJ (timeout, lost ACK, device error) → UNKNOWN whether the
        //                          firmware swapped: re-START the old table.
        try {
          await startTable(newId);
          lastSwap = "atomic";
          for (const gone of swapTo(newId, next, true, onSwap)) await drop(gone);
          return;
        } catch (error) {
          const kind = classifyTrajectoryStartError(error);
          if (kind === "rejected") {
            // A REJ is the firmware's answer: it did not take START(new), and
            // nothing was stopped — the old table keeps running.
            unroute(newId);
            await drop(newId);
            throw new TrajectoryReplaceError(
              `Trajectory ${oldId}: atomic START of the replacement table failed (${errorMessage(error)}) — still running the previous spec`,
              true,
              error,
            );
          }
          if (kind === "transport") {
            // The START may or may not have swapped. Re-START the OLD table at
            // the same t_start: if the new one plays, that is itself an atomic
            // swap back (same period, same anchor); if neither plays it joins
            // the run in progress; if the old one still plays it is REJected
            // "already running".
            let again: unknown = null;
            try {
              await startTable(oldId);
            } catch (e) {
              again = e ?? new Error("re-START failed");
            }
            if (again === null) {
              // ACK: the old table runs (phase-continuously); the new one does
              // not — serial order puts the lost START(new) before it. The new
              // one may have played for a moment: grace it, then DELETE.
              anchorExact();
              retire(newId, next, true);
              await drop(newId);
              throw new TrajectoryReplaceError(
                `Trajectory ${oldId}: atomic START of the replacement table ${newId} failed without a REJ (${errorMessage(error)}) — re-STARTed table ${oldId} at the same t_start; still running the previous spec`,
                true,
                error,
                { id: newId, maybeLive: false },
              );
            }
            if (classifyTrajectoryStartError(again) === "already-running") {
              // A table is live — the old one, or (if the START(new) is still
              // pending on the device) soon the new one. Query nothing: keep
              // BOTH routed; the new one stays reserved as a sibling until the
              // next stop / swap / dispose retires it.
              siblings.set(newId, next);
              throw new TrajectoryReplaceError(
                `Trajectory ${oldId}: atomic START of the replacement table ${newId} failed without a REJ (${errorMessage(error)}) and the re-START of table ${oldId} was REJected "already running" — ambiguous: table ${oldId} (or ${newId}) is live; both stay routed, still running`,
                true,
                error,
                { id: newId, maybeLive: true },
              );
            }
            // The re-START failed otherwise: the run is over. Make it so —
            // STOP(old) and DELETE(new) (a DELETE halts a playing table).
            if (run === carried) run = null;
            try {
              if (this.device.connected) await this.sendTrajectory({ op: "STOP", id: oldId });
            } catch {
              // best-effort
            }
            retire(newId, next, true);
            await drop(newId);
            throw new TrajectoryReplaceError(
              `Trajectory ${oldId}: atomic START of the replacement table failed without a REJ (${errorMessage(error)}) and the old table could not be restarted (${errorMessage(again)})`,
              false,
              error,
              { id: newId, maybeLive: false },
            );
          }
          // "already running": fall through to the STOP/START pair.
        }
      }
      // STOP(old) [+ STOP(each sibling)] + START(new, original t_start) back
      // to back — the firmware joins a past t_start in progress, so the
      // phase carries over. Every STOP precedes the START on the wire (a
      // still-playing sibling would REJ it "already running").
      const sibIds = [...siblings.keys()];
      const settled = await Promise.allSettled([
        this.sendTrajectory({ op: "STOP", id: oldId }),
        ...sibIds.map((sid) => this.sendTrajectory({ op: "STOP", id: sid })),
        startTable(newId),
      ]);
      const stopped = settled[0]!;
      const sibStops = settled.slice(1, -1);
      const started = settled.at(-1)!;
      if (started.status === "fulfilled") {
        lastSwap = "stop-start";
        anchorExact();
        for (const gone of swapTo(newId, next, true, onSwap)) await drop(gone);
        return;
      }
      // Siblings that took their STOP are done with.
      await dropSiblings(sibIds.filter((_, i) => sibStops[i]?.status === "fulfilled"));
      // START(new) failed: retire it (in grace when it failed without a REJ —
      // it may have started); if STOP(old) went through, re-START the old
      // table at the same t_start (phase-continuous again) so the scan keeps
      // running on the old spec.
      const startUnknown = classifyTrajectoryStartError(started.reason) === "transport";
      if (startUnknown) retire(newId, next, true);
      else unroute(newId);
      await drop(newId);
      let running = true;
      if (stopped.status === "fulfilled") {
        try {
          await startTable(oldId);
          anchorExact();
        } catch {
          running = false;
          if (run === carried) run = null;
        }
      }
      throw new TrajectoryReplaceError(
        `Trajectory ${oldId}: START of the replacement table failed (${errorMessage(started.reason)})` +
          (running ? " — still running the previous spec" : " and the old table could not be restarted"),
        running,
        started.reason,
        startUnknown ? { id: newId, maybeLive: false } : null,
      );
    };

    return {
      get id() {
        return id;
      },
      get lastSwap() {
        return lastSwap;
      },
      start: async (atHostNs?: bigint, cycles = 0) => {
        live("start");
        return serialize(async () => {
          live("start");
          const tStart =
            atHostNs === undefined ? 0n : hostNsToMcuUs(atHostNs, this._clockOffsetNs);
          // A "now" start has no exact MCU instant: estimate it from the host
          // clock at send time (off by the serial latency). An explicit
          // instant that clamped to 0n (before the MCU epoch) is a "now"
          // start too.
          const exact = tStart !== 0n;
          const anchor = exact ? tStart : hostNsToMcuUs(hostNowNs(), this._clockOffsetNs);
          // Conservatively "played" from the write on (a lost ACK may still
          // have started it).
          played = true;
          await this.set(Protocol.Command.Trajectory, {
            op: "START",
            id,
            t_start: tStart,
            cycles,
          });
          run = { tStartMcuUs: anchor, cycles, exact };
        });
      },
      stop: async () => {
        live("stop");
        return serialize(async () => {
          live("stop");
          const sibIds = [...siblings.keys()];
          const [own, ...sibStops] = await Promise.allSettled([
            this.sendTrajectory({ op: "STOP", id }),
            ...sibIds.map((sid) => this.sendTrajectory({ op: "STOP", id: sid })),
          ]);
          await dropSiblings(sibIds.filter((_, i) => sibStops[i]?.status === "fulfilled"));
          if (own.status === "rejected") throw own.reason;
          run = null;
        });
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await settle();
        run = null;
        listeners.clear();
        // Grace the id like a swap does: a capture in flight at the DELETE
        // still pushes with it, and must not reach the id's next owner.
        retire(id, current, played);
        await dropSiblings();
        try {
          if (this.device.connected)
            await this.set(Protocol.Command.Trajectory, { op: "DELETE", id });
        } finally {
          this.trajectoryIds.delete(id);
        }
      },
      onFrame: (cb) => {
        live("onFrame");
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      replace: async (next: TrajectorySpec, opts?: TrajectoryReplaceOptions) => {
        live("replace");
        if (replacing) throw new Error(`Trajectory ${id}: a replace is already in flight`);
        replacing = true;
        try {
          await serialize(() => doReplace(next, opts?.onSwap));
        } finally {
          replacing = false;
        }
      },
    };
  }
}

/** Runs `tasks` with at most `window` in flight (issue order preserved — each
 *  task's serial write happens when it starts); rejects with the first error
 *  once the in-flight tasks settle, starting no new ones after it. */
async function pipelined(
  tasks: ReadonlyArray<() => Promise<unknown>>,
  window: number,
): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && next < tasks.length) {
      const task = tasks[next++];
      try {
        await task();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(window, tasks.length) }, worker),
  );
  if (failed) throw firstError;
}

// --- Shared device handle ------------------------------------------------
// The controller session connects/owns the serial device, but orchestrator
// control loops (e.g. the tracking session) must actuate the *same* device.
// This module-level holder is that single point of truth; the session sets it
// on connect and clears it on disconnect.
let active: Controller | null = null;
export const activeController = (): Controller | null => active;
export const setActiveController = (c: Controller | null): void => {
  active = c;
};
