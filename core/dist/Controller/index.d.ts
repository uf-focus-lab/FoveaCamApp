// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { BufferLike, CoreObject, InPort, MirrorVolts } from "../types";

declare module "core/Controller" {
  /** Path to the resolved native module injected by JS loader */
  export const __origin__: string;

  // Internally distinguishable objects that can be converted to buffer.
  const bufferAccessor: unique symbol;
  const factoryAccessor: unique symbol;
  const propNameAccessor: unique symbol;
  type PacketInstance<I, O = I> = Readonly<O> & {
    readonly [bufferAccessor]: ArrayBuffer;
  };

  type PacketFactory<I, O = I> = ((
    v: I | BufferLike,
  ) => PacketInstance<I, O>) & {
    readonly [propNameAccessor]: string;
    readonly [bufferAccessor]: null;
  };

  export type ActuateArg = {
    left: AnalogChannels;
    right: AnalogChannels;
    settle_time?: number; // in microseconds
    complete_time?: number; // in microseconds
  };

  export type CameraName = "C" | "L" | "R";

  export type MirrorStreamOp = "CREATE" | "UPDATE" | "TERMINATE";
  export type MirrorStreamArg = {
    op: MirrorStreamOp;
    id: number; // host-chosen stream id, 0..N-1 (CAPACITY = 64)
    left?: AnalogChannels; // ignored by TERMINATE
    right?: AnalogChannels;
  };
  export type MirrorStreamDecoded = {
    op: MirrorStreamOp;
    id: number;
    left: AnalogChannels;
    right: AnalogChannels;
  };

  export type FrameArg = {
    stream: number;
    // Bitmask (CameraName[] or a raw number); omitted/undefined means
    // the firmware default (CAM_L | CAM_R). "C" is REJected until the
    // center camera has a strobe cable.
    cameras?: CameraName[] | number;
    pulse?: number; // trigger pulse width, in microseconds
    // v2.0 trigger settle HOLD (µs) — held only when this request SWITCHES the
    // active stream (mirror moved). Omitted/0 = fire immediately (pre-v2.0).
    settle_time?: number;
  };
  export type FrameDecoded = {
    stream: number;
    cameras: CameraName[];
    pulse: number;
    settle_time: number;
  };
  /** CMD_FRAME ACK payload: position in the per-stream FIFO (0 = next). */
  export type FrameAccepted = { queue_position: number };
  /** CMD_FRAME FIN payload, latched at exposure start (strobe rising
   *  edge). Timestamps are MCU microseconds, as `bigint` (uint64,
   *  matching firmware's Global::time). */
  export type FrameResult = {
    stream: number;
    /** Firmware-monotonic capture id (1-based; 0 = none). Stable frame
     *  identity bound to the camera frame via t_exposure/timestamp; distinct
     *  from the request `seq`. Consumed downstream by the recorder/UI. */
    frame_id: number;
    t_trigger: bigint;
    t_exposure: bigint;
    /** Exposure-AVERAGED mirror position (per-channel round-half-up mean of the
     *  strobe-rise and strobe-fall DAC targets) — replaces the former
     *  start-only latched value. */
    left: AnalogChannels;
    right: AnalogChannels;
  };

  // ---- v2.2.0: CMD_SCHEDULE / CMD_TRAJECTORY --------------------------------
  // All times are MCU-clock MICROSECONDS (the SYS_TIMESTAMP / FrameResult
  // domain). uint64 fields are `bigint` — a `number` would be truncated to 32
  // bits by the native encoder.

  /** CMD_SCHEDULE SET: one timestamped keyframe on an EXISTING stream. The
   *  stream target becomes left/right once the MCU clock reaches `t_apply`;
   *  with `interpolate` it ramps linearly from the previous keyframe. Late
   *  keyframes apply at once; ones older than the last applied are dropped.
   *  CMD_STREAM UPDATE clears the schedule. Single-phase (ACK echoes). */
  export type ScheduleArg = {
    stream: number;
    t_apply: bigint;
    interpolate?: boolean;
    /** Raw flag bits (OR-ed with `interpolate`); 1 = INTERPOLATE. */
    flags?: number;
    left: AnalogChannels;
    right: AnalogChannels;
  };
  export type ScheduleDecoded = {
    stream: number;
    flags: number;
    interpolate: boolean;
    t_apply: bigint;
    left: AnalogChannels;
    right: AnalogChannels;
  };

  export type TrajectoryOp =
    | "BEGIN"
    | "DATA"
    | "MARK"
    | "COMMIT"
    | "START"
    | "STOP"
    | "DELETE";
  /** One table sample: the target `t_offset` µs into the period. */
  export type TrajectorySampleArg = {
    t_offset: number;
    left: AnalogChannels;
    right: AnalogChannels;
  };
  /** CMD_TRAJECTORY SET (op-tagged, variable size). Every op is single-phase
   *  (ACK/REJ); the ACK echoes the op's fixed header (DATA: no samples). */
  export type TrajectoryArg =
    | {
        op: "BEGIN";
        id: number; // 0..3
        sample_count: number; // >= 1, <= 4096 across all tables
        period: number; // µs, > 0
        /** Step/hold between samples instead of linear interpolation. */
        step?: boolean;
        flags?: number;
      }
    | {
        op: "DATA";
        id: number;
        first_index: number;
        /** 1..12 samples (one COBS frame) — chunk larger tables. */
        samples: TrajectorySampleArg[];
      }
    | {
        op: "MARK";
        id: number;
        marker: number; // 0..7
        t_offset?: number; // µs into the period, < period
        /** Omitted/empty = CLEAR this marker (unlike Frame's default). */
        cameras?: CameraName[] | number;
        pulse?: number; // trigger pulse width µs, > 0
      }
    | {
        op: "START";
        id: number;
        /** MCU µs of phase 0, cycle 0. Omitted/0n = now. */
        t_start?: bigint;
        /** Cycles to run; omitted/0 = forever. */
        cycles?: number;
      }
    | { op: "COMMIT" | "STOP" | "DELETE"; id: number };
  export type TrajectoryDecoded = {
    op: TrajectoryOp;
    id: number;
    sample_count?: number;
    period?: number;
    flags?: number;
    step?: boolean;
    first_index?: number;
    count?: number;
    samples?: TrajectorySampleArg[];
    marker?: number;
    t_offset?: number;
    cameras?: CameraName[];
    pulse?: number;
    t_start?: bigint;
    cycles?: number;
  };
  export type TrajectoryStatus =
    | "OK"
    | "STROBE_TIMEOUT"
    | "BUSY"
    | "CANCELLED"
    | "ENDED"
    | "UNKNOWN";
  /** SYN CMD_TRAJECTORY push (`Device.onPush(Protocol.Command.
   *  TrajectoryFrame, cb)`): one per marker firing, plus a run-level push
   *  (`marker: null`) with status ENDED (finite run done; cycle = cycles) or
   *  CANCELLED (system disabled). `result` is only meaningful for status OK
   *  (`result.stream` = trajectory id, `frame_id` shared with CMD_FRAME);
   *  BUSY carries the missed marker's scheduled time in `result.t_trigger`. */
  export type TrajectoryFrame = {
    id: number;
    marker: number | null;
    cycle: number;
    status: TrajectoryStatus;
    result: FrameResult;
  };

  /**
   * Protocol v2 two-phase request:
   * `accepted` resolves on ACK (queued/applied; rejects on REJ) independently
   * of the returned promise itself, which only resolves on FIN (or rejects on
   * a REJ at either phase).
   *
   * `accepted` is only attached once the connection has confirmed v2
   * firmware (`Device.v2Capable`, set by `verifyVersion()`) — against
   * unconfirmed or v1 firmware, `get`/`set` fall back to resolving on ACK
   * alone (no `accepted` property at all), matching v1's blocking behavior.
   * Feature-detect with `"accepted" in result` if you must support both.
   */
  export type TwoPhase<Completed, Accepted = Completed> = Promise<
    PacketInstance<Completed>
  > & {
    accepted: Promise<PacketInstance<Accepted>>;
  };

  export const Protocol: {
    readonly Log: PacketFactory<String>;
    readonly System: {
      readonly Info: PacketFactory<String>;
      readonly Version: PacketFactory<FirmwareVersion> &
        Readonly<FirmwareVersion>;
      readonly Reset: PacketFactory<ResetType>;
      readonly Enable: PacketFactory<Boolean>;
      /** Clock calibration. GET → the
       *  MCU's uint64 MICROSECOND clock as `bigint`, stamped firmware-side
       *  at packet parse time (same Global::time clock/units as
       *  `FrameResult.t_trigger`/`t_exposure`). SET (arg = new counter
       *  value, normally `0n`) resets the counter; the ACK echoes the fresh
       *  clock. Single-phase (ACK/REJ, no FIN). Requires firmware >= v1.1. */
      readonly Timestamp: PacketFactory<BigInt>;
    };
    readonly Config: {
      readonly Log: PacketFactory<LogLevel>;
      readonly LPF: PacketFactory<Number>;
      readonly Bias: PacketFactory<Number>;
    };
    readonly Command: {
      readonly Actuate: PacketFactory<ActuateArg>;
      readonly Trigger: PacketFactory<Number>;
      readonly MirrorStream: PacketFactory<
        MirrorStreamArg,
        MirrorStreamDecoded
      >;
      readonly Frame: PacketFactory<FrameArg, FrameDecoded>;
      readonly FrameAccepted: PacketFactory<FrameAccepted>;
      readonly FrameResult: PacketFactory<FrameResult>;
      /** v2.2.0 timestamped keyframe (CMD_SCHEDULE). */
      readonly Schedule: PacketFactory<ScheduleArg, ScheduleDecoded>;
      /** v2.2.0 uploaded trajectory ops (CMD_TRAJECTORY SET). */
      readonly Trajectory: PacketFactory<TrajectoryArg, TrajectoryDecoded>;
      /** v2.2.0 SYN CMD_TRAJECTORY push decoder (buffer only) — pass to
       *  `Device.onPush`. */
      readonly TrajectoryFrame: PacketFactory<never, TrajectoryFrame>;
    };
  };

  export class Device {
    // Properties
    readonly connected: boolean;
    /** See verifyVersion() and TwoPhase above. Starts false. */
    readonly v2Capable: boolean;
    /** Cumulative serial counters for the lifetime of this Device. */
    readonly stats: {
      txBytes: number;
      rxBytes: number;
      txPackets: number;
      rxPackets: number;
      // ---- Serial pressure (poll-on-read at the caller's stats cadence) ----
      /** Kernel tty output-queue depth (TIOCOUTQ) — where CDC-ACM NAK
       *  backpressure materializes. 0 when `outqSupported` is false. */
      outqBytes: number;
      outqHighWater: number;
      /** False when the platform/ioctl doesn't support the gauge (degraded,
       *  never failing). */
      outqSupported: boolean;
      /** EAGAIN / short-write events on the O_NONBLOCK fd — each a discrete
       *  overflow event. Short writes are framing-safe (the remainder is
       *  tailed and completes before any new frame starts). */
      txSoftFail: number;
      /** ACK round-trip rolling stats over the trailing window, from the
       *  existing two-phase request timing (+ the ~2 Hz probe ping).
       *  `baselineP50` = the connect-time baseline the governor's inflation
       *  gate compares against. */
      ackRttMs: { p50: number; p95: number; max: number; count: number; baselineP50: number };
      /** The active MirrorSink governor's mirror (state "off" = no governed
       *  sink attached / governor disabled). */
      governor: { effectiveRateHz: number; ceilingHz: number; state: "off" | "steady" | "seeking" | "backoff" };
    };

    // Two-phase overloads — see TwoPhase above. Must precede the
    // generic fallback overloads below (TS resolves overloads in
    // declaration order).
    set(
      fn: typeof Protocol.Command.Actuate,
      arg: ActuateArg | BufferLike,
    ): TwoPhase<ActuateArg>;
    set(
      fn: typeof Protocol.Command.Trigger,
      arg: number | BufferLike,
    ): TwoPhase<number>;
    get(
      fn: typeof Protocol.Command.Frame,
      arg: FrameArg | BufferLike,
    ): TwoPhase<FrameResult, FrameAccepted>;

    // v2.2.0 single-phase SETs whose decoded shape differs from the argument.
    set(
      fn: typeof Protocol.Command.Schedule,
      arg: ScheduleArg | BufferLike,
    ): Promise<PacketInstance<ScheduleDecoded>>;
    set(
      fn: typeof Protocol.Command.Trajectory,
      arg: TrajectoryArg | BufferLike,
    ): Promise<PacketInstance<TrajectoryDecoded>>;

    // Single-phase (default): resolves on ACK alone, no `.accepted` —
    // exactly today's (pre-v2) behavior.
    get<T>(fn: PacketFactory<T>): Promise<PacketInstance<T>>;
    set<T>(
      fn: PacketFactory<T>,
      arg: T | BufferLike,
    ): Promise<PacketInstance<T>>;

    /**
     * Sequence == 0 fire-and-forget: the firmware performs the SET but sends
     * no ACK/FIN/REJ at
     * all — no promise, no pending-map entry. Intended for high-rate
     * stream position updates (CMD_STREAM UPDATE, ~1kHz); throws
     * synchronously on a transport/encode failure.
     */
    fireAndForget(
      fn: typeof Protocol.Command.Schedule,
      arg: ScheduleArg | BufferLike,
    ): void;
    fireAndForget<T>(fn: PacketFactory<T>, arg: T | BufferLike): void;

    /**
     * v2.2.0: subscribe to the MCU's unsolicited SYN pushes for `fn`'s
     * property — each push payload is decoded with `fn` and handed to `cb`
     * on the JS thread. One callback per property (a later call replaces
     * it); `null` unsubscribes. LOG pushes stay native (not subscribable).
     */
    onPush(
      fn: typeof Protocol.Command.TrajectoryFrame,
      cb: ((frame: PacketInstance<never, TrajectoryFrame>) => void) | null,
    ): void;

    /** TEST-ONLY (core/test/46): deterministic pressure scripting — force
     *  the outq gauge (`outq`, <0 restores the real ioctl), inject synthetic
     *  ACK-RTT samples, bump the soft-fail counter. */
    __testPressure(p: { outq?: number; rttMs?: number; rttCount?: number; softFail?: number }): void;

    /**
     * Fetches System.Version and sets v2Capable = (firmware.major >=
     * this build's Protocol.System.Version.major). Never rejects on a
     * version *mismatch* — only on a transport/REJ failure — so old
     * firmware simply keeps v2Capable false (v1-compat: every property
     * resolves on ACK, matching pre-v2 behavior) rather than refusing
     * to operate.
     */
    verifyVersion(): Promise<FirmwareVersion & { compatible: boolean }>;
    release(): void;
    // Construction
    constructor(
      port: string,
      baudrate?: number, // default 115200
    );
  }

  export type FirmwareVersion = {
    major: number;
    minor: number;
    patch: number;
  };
  export type ResetType = "SOFT" | "HARD" | "MEMS";
  export type LogLevel = "OFF" | "ERR" | "WARN" | "INFO" | "VERB";
  export type AnalogChannels = [number, number, number, number];
  // ---- Native mirror position sink ----------

  /** One native-history sample: the PREDICTED volts (DAC round-trip —
   *  predictVolts parity) at a host-steady-ns stamp. */
  export interface MirrorHistorySample {
    tNs: bigint;
    left: { x: number; y: number };
    right: { x: number; y: number };
  }

  /** `historyAt` result — the JS `mirrorAt` shape (mirror-history.ts), so the
   *  homography feeder's injectable `history` seam is a passthrough. */
  export interface MirrorHistoryAt {
    left: { x: number; y: number };
    right: { x: number; y: number };
    ageNs: bigint;
    interpolated: boolean;
  }

  /**
   * The controller's NATIVE position in-port: accepts FINAL volts off a port
   * link's delivery
   * thread and natively replicates the JS StreamHandle.update path — the
   * stream-update GATE (1 ms min interval + dedupe), the channels() volt→DAC
   * conversion, and the CMD_STREAM UPDATE fire-and-forget write through the
   * device's shared write seam (one mutex — never interleaves with NAPI
   * writes; the seam closes BEFORE the fd on device release, so post-
   * disconnect writes are counted no-ops). Each accepted write records into
   * a fixed 4096-sample native history ring (the mirror-history authority
   * for NATIVELY-driven inputs). Stream lifecycle stays JS: create/TERMINATE
   * ride `Controller.createStream` (quiesce ownership unchanged).
   */
  export interface MirrorSink extends CoreObject<MirrorSink> {
    /** Typed volts IN port — runtime tag `"volts"`. */
    readonly pos_in: InPort<MirrorVolts>;
    probe(): {
      received: number;
      written: number;
      deduped: number;
      throttled: number;
      errors: number;
      /** Fairness-reserve deferrals (coalesced UPDATEs behind a pending
       *  two-phase request). */
      deferred: number;
      /** Governor multiplicative decreases. */
      backoffs: number;
      /** False once the device's write seam closed (release/disconnect). */
      open: boolean;
      /** The governed emission rate (0 when the governor is off). */
      effectiveRateHz: number;
      ceilingHz: number;
      governorState: "off" | "steady" | "seeking" | "backoff";
      /** ACK-RTT view — the session's serial-latency estimate reads
       *  p50 here at its stats throttle. */
      ackRttP50: number;
      ackRttP95: number;
      ackRttCount: number;
    };
    /** Live-retune the AIMD governor (partial update; named errors on bad
     *  ranges). `enabled: false` pins the fixed 1 ms gate exactly.
     *  The session sets `ceilingHz` = the global prediction_rate_hz. */
    setGovernor(params: {
      enabled?: boolean;
      ceilingHz?: number;
      floorHz?: number;
      stepHz?: number;
      evalMs?: number;
      outqLow?: number;
      outqHigh?: number;
      rttInflation?: number;
      fairnessMs?: number;
      maxDeferMs?: number;
    }): void;
    historyLatest(): MirrorHistorySample | null;
    historyAt(tNs: bigint): MirrorHistoryAt | null;
    historyQuery(fromNs: bigint, toNs: bigint): MirrorHistorySample[];
  }

  /** Attach a native pos_in sink to a live Device's write seam. The MCU
   *  stream (`streamId`) must already exist (JS `createStream`, ACK-backed)
   *  and is TERMINATED by JS on close — the sink only fires UPDATEs. */
  export function createMirrorSink(
    device: Device,
    options: {
      streamId: number;
      bias?: number;
      dv?: number;
      /** Graph node id for the link edge (default "controller"). */
      nodeId?: string;
    },
  ): MirrorSink;

  /** TEST-ONLY (core/test/45): a raw pty pair — a Device opens the slave
   *  `path`; the test reads the master `fd` (fs.readSync) to assert frames. */
  export function __serialTestPty(): { fd: number; path: string };


}
