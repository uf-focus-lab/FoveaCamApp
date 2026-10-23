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

/** An uploaded (committed) MCU trajectory table. */
export interface TrajectoryHandle {
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
   *  re-upload that leaves the handle `ready`. */
  replace(spec: TrajectorySpec): Promise<void>;
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
  // on connect); atomically swapped on mid-task re-calibration — outcomes
  // decoded after the swap carry the new offset.
  private clockOffsetNs = 0n;
  /** Install the calibrated MCU→host offset (from `pingControllerOffset`).
   *  Every FIN timestamp surfaced after this call is trusted host-ns. */
  setClockOffsetNs(offsetNs: bigint): void {
    this.clockOffsetNs = offsetNs;
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
          t_apply: hostNsToMcuUs(hostNs, this.clockOffsetNs),
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
        tTrigger: result.t_trigger * 1000n + this.clockOffsetNs,
        tExposure: result.t_exposure * 1000n + this.clockOffsetNs,
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
      tTrigger: mcuUsToHostNs(f.result.t_trigger, this.clockOffsetNs),
      tExposure: mcuUsToHostNs(f.result.t_exposure, this.clockOffsetNs),
      left: decodeChannels(f.result.left),
      right: decodeChannels(f.result.right),
    };
  }

  private bindTrajectoryPush(): void {
    if (this.trajectoryPushBound) return;
    this.trajectoryPushBound = true;
    this.device.onPush(Protocol.Command.TrajectoryFrame, (f) => {
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
    let id = -1;
    for (let candidate = 0; candidate < TRAJECTORY_MAX_TABLES; candidate++)
      if (!this.trajectoryIds.has(candidate)) {
        id = candidate;
        break;
      }
    if (id < 0)
      throw new Error(`Trajectory capacity (${TRAJECTORY_MAX_TABLES} tables) exceeded`);
    this.trajectoryIds.add(id);
    this.bindTrajectoryPush();
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
        await this.set(Trajectory, { op: "DELETE", id });
      } catch {
        // best-effort cleanup on a dead/REJecting device
      }
      this.trajectoryIds.delete(id);
      throw error;
    }

    const listeners = new Set<(frame: TrajectoryFrameOutcome) => void>();
    this.trajectoryListeners.set(id, listeners);
    let disposed = false;
    const live = (what: string) => {
      if (disposed) throw new Error(`Trajectory ${id} is disposed (${what})`);
    };
    return {
      id,
      start: async (atHostNs?: bigint, cycles = 0) => {
        live("start");
        await this.set(Trajectory, {
          op: "START",
          id,
          t_start: atHostNs === undefined ? 0n : hostNsToMcuUs(atHostNs, this.clockOffsetNs),
          cycles,
        });
      },
      stop: async () => {
        live("stop");
        await this.set(Trajectory, { op: "STOP", id });
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        listeners.clear();
        this.trajectoryListeners.delete(id);
        try {
          if (this.device.connected) await this.set(Trajectory, { op: "DELETE", id });
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
      replace: async () => {
        live("replace");
        // Implemented by the trajectory-replace workstream (see
        // docs/spec/mirror-link-scan-patterns.md §replace).
        throw new Error("TrajectoryHandle.replace is not implemented yet");
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
