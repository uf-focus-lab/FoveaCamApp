// Protocol v2.2.0 host surfaces: CMD_SCHEDULE (`StreamHandle.scheduleAt`) and
// CMD_TRAJECTORY (`Controller.uploadTrajectory`). Covers the pure parts (host
// ns <-> MCU µs conversion, DATA chunking, spec validation) and the handle
// lifecycle against a fake `Device` (no serial hardware): the exact op
// sequence on the wire, the pipelined DATA window, version gating, push decode
// into trusted host-ns + volts, unsubscribe, dispose/id reuse and the failed-
// upload cleanup. Wire-level firmware behavior lives in test/fw-sim-check.cpp
// (stages C1-C4) and core/test/51-schedule-trajectory.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

// Mutated per test BEFORE constructing the Controller (vitest allowlists the
// `mock` prefix inside the hoisted factory).
const mockFirmware = { major: 2, minor: 2, patch: 0 };
const mockCalls: Array<{ kind: "set" | "ff"; prop: string; arg: any }> = [];
const mockPush: { cb: ((f: unknown) => void) | null; binds: number } = {
  cb: null,
  binds: 0,
};
// DATA ACK gating: when set, DATA sets wait on this before resolving.
const mockData = { inFlight: 0, maxInFlight: 0, rejectAt: -1, delayMs: 0 };
// Trajectory op timeline (`send:OP:id` when written, `ack:OP:id` when it
// resolves) + per-op REJ / ACK-delay injection, for the replace tests.
const mockTimeline: string[] = [];
const mockOps: {
  reject: Array<{ op: string; id: number; message: string }>;
  delayMs: Record<string, number>;
} = { reject: [], delayMs: {} };

vi.mock("core/Controller", () => {
  class FakeDevice {
    connected = true;
    v2Capable = true;
    stats = {};
    constructor(_path: string) {
      void _path;
    }
    verifyVersion = vi.fn(async () => ({ ...mockFirmware, compatible: true }));
    release = vi.fn();
    get = vi.fn(async () => undefined);
    fireAndForget = vi.fn((prop: string, arg: unknown) => {
      mockCalls.push({ kind: "ff", prop, arg });
    });
    onPush = vi.fn((prop: string, cb: (f: unknown) => void) => {
      expect(prop).toBe("TrajectoryFrame");
      mockPush.cb = cb;
      mockPush.binds++;
    });
    set = vi.fn(async (prop: string, arg: any) => {
      mockCalls.push({ kind: "set", prop, arg });
      if (prop === "Bias") return 29490; // volt2dac(90)
      if (prop === "Trajectory" && arg.op !== "DATA") {
        mockTimeline.push(`send:${arg.op}:${arg.id}`);
        const delay = mockOps.delayMs[arg.op];
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const i = mockOps.reject.findIndex(
          (r) => r.op === arg.op && r.id === arg.id,
        );
        if (i >= 0) {
          const [r] = mockOps.reject.splice(i, 1);
          mockTimeline.push(`rej:${arg.op}:${arg.id}`);
          throw new Error(r.message);
        }
        mockTimeline.push(`ack:${arg.op}:${arg.id}`);
        return arg;
      }
      if (prop === "Trajectory" && arg.op === "DATA") {
        mockData.inFlight++;
        mockData.maxInFlight = Math.max(
          mockData.maxInFlight,
          mockData.inFlight,
        );
        await new Promise((r) => setTimeout(r, mockData.delayMs));
        mockData.inFlight--;
        if (arg.first_index === mockData.rejectAt)
          throw new Error("DATA chunk past the end of the table");
      }
      return arg;
    });
  }
  const Protocol = {
    System: {
      Enable: "Enable",
      Info: "Info",
      Version: "Version",
      Reset: "Reset",
      Timestamp: "Timestamp",
    },
    Config: { Log: "Log", LPF: "LPF", Bias: "Bias" },
    Command: {
      Actuate: "Actuate",
      Trigger: "Trigger",
      MirrorStream: "MirrorStream",
      Schedule: "Schedule",
      Trajectory: "Trajectory",
      TrajectoryFrame: "TrajectoryFrame",
    },
  };
  return { Device: FakeDevice, Protocol, createMirrorSink: vi.fn() };
});
vi.mock("serialport", () => ({ SerialPort: { list: vi.fn(async () => []) } }));

import { channels, dac2volt } from "@lib/controller-codec";
import {
  Controller,
  TRAJECTORY_CHUNK_SAMPLES,
  TRAJECTORY_MAX_TABLES,
  TrajectoryReplaceError,
  classifyTrajectoryStartError,
  chunkTrajectorySamples,
  trajectoryGraceUs,
  hostNsToMcuUs,
  mcuUsToHostNs,
  validateTrajectorySpec,
  type TrajectoryFrameOutcome,
  type TrajectorySpec,
} from "@orchestrator/controller";
import { hostNowNs, setHostClock } from "@orchestrator/time-align";

const BIAS = dac2volt(29490);
const DV = 170;
const P0 = { x: 0, y: 0 };

async function makeController(
  fw = { major: 2, minor: 2, patch: 0 },
): Promise<Controller> {
  Object.assign(mockFirmware, fw);
  const ctrl = new Controller({ path: "/dev/fake-controller" } as never);
  await ctrl.ready;
  mockCalls.length = 0; // drop the init config writes
  return ctrl;
}

function spec(n: number, periodUs = 20_000): TrajectorySpec {
  return {
    periodUs,
    samples: Array.from({ length: n }, (_, i) => ({
      tOffsetUs: i * Math.floor(periodUs / n),
      left: { x: i, y: -i },
      right: { x: 0.5 * i, y: 1 },
    })),
    markers: [{ tOffsetUs: periodUs / 2, pulseUs: 2000 }],
  };
}

/** Pin the host clock (grace deadlines run on it); returns `elapse(µs)`. */
function pinHostClock(startNs = 10_000_000_000n): (us: number) => void {
  let now = startNs;
  setHostClock(() => now);
  return (us) => {
    now += BigInt(us) * 1000n;
  };
}

const trajectoryOps = () =>
  mockCalls
    .filter((c) => c.prop === "Trajectory")
    .map((c) => c.arg.op as string);

describe("v2.2.0 pure helpers", () => {
  it("converts host-steady ns to MCU µs through the clock offset (FIN inverse)", () => {
    const offset = 1_700_000_000_000_000_000n; // host ns at MCU µs 0
    expect(hostNsToMcuUs(offset + 5_000_000n, offset)).toBe(5_000n);
    expect(hostNsToMcuUs(offset + 1_499n, offset)).toBe(1n); // rounds to nearest
    expect(hostNsToMcuUs(offset + 1_500n, offset)).toBe(2n);
    expect(hostNsToMcuUs(offset - 10n, offset)).toBe(0n); // before the MCU epoch
    // Round trip with the FIN decode direction.
    expect(hostNsToMcuUs(mcuUsToHostNs(987_654_321n, offset), offset)).toBe(
      987_654_321n,
    );
    expect(hostNsToMcuUs(42_000n, 0n)).toBe(42n); // uncalibrated: raw µs ×1000
  });

  it("chunks DATA at the firmware's one-COBS-frame limit", () => {
    const s = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunkTrajectorySamples(s);
    expect(TRAJECTORY_CHUNK_SAMPLES).toBe(12);
    expect(chunks.map((c) => [c.firstIndex, c.samples.length])).toEqual([
      [0, 12],
      [12, 12],
      [24, 1],
    ]);
    expect(chunks.flatMap((c) => c.samples)).toEqual(s);
    expect(chunkTrajectorySamples(s.slice(0, 24)).length).toBe(2);
    expect(chunkTrajectorySamples([])).toEqual([]);
  });

  it("validates a spec against the firmware limits", () => {
    expect(() => validateTrajectorySpec(spec(25))).not.toThrow();
    expect(() => validateTrajectorySpec({ ...spec(2), periodUs: 0 })).toThrow(
      /periodUs/,
    );
    expect(() =>
      validateTrajectorySpec({ periodUs: 100, samples: [] }),
    ).toThrow(/at least one/);
    expect(() =>
      validateTrajectorySpec({
        periodUs: 100,
        samples: [
          { tOffsetUs: 10, left: P0, right: P0 },
          { tOffsetUs: 10, left: P0, right: P0 },
        ],
      }),
    ).toThrow(/strictly increasing/);
    expect(() =>
      validateTrajectorySpec({
        periodUs: 100,
        samples: [{ tOffsetUs: 100, left: P0, right: P0 }],
      }),
    ).toThrow(/\[0, periodUs\)/);
    expect(() =>
      validateTrajectorySpec({
        ...spec(2, 100),
        markers: Array.from({ length: 9 }, () => ({
          tOffsetUs: 1,
          pulseUs: 1,
        })),
      }),
    ).toThrow(/at most 8 markers/);
    expect(() =>
      validateTrajectorySpec({
        ...spec(2, 100),
        markers: [{ tOffsetUs: 1, pulseUs: 0 }],
      }),
    ).toThrow(/pulseUs/);
  });
});

describe("StreamHandle.scheduleAt (CMD_SCHEDULE)", () => {
  let ctrl: Controller | undefined;
  afterEach(() => {
    ctrl?.release();
    ctrl = undefined;
    mockCalls.length = 0;
  });

  it("fires a keyframe with t_apply on the MCU clock and DAC channels", async () => {
    ctrl = await makeController();
    ctrl.setClockOffsetNs(1_000_000_000n);
    const stream = await ctrl.createStream({ left: P0, right: P0 });
    mockCalls.length = 0;
    const pos = { left: { x: 3, y: -2 }, right: { x: 1, y: 1 } };
    stream.scheduleAt(1_000_000_000n + 250_000_000n, pos, {
      interpolate: true,
    });
    stream.scheduleAt(1_000_000_000n + 260_000_000n, pos); // no gate/dedupe
    expect(mockCalls).toHaveLength(2);
    const [k] = mockCalls;
    expect(k.kind).toBe("ff"); // fire-and-forget (seq 0)
    expect(k.prop).toBe("Schedule");
    expect(k.arg).toEqual({
      stream: stream.id,
      t_apply: 250_000n,
      interpolate: true,
      left: channels(pos.left, BIAS, DV),
      right: channels(pos.right, BIAS, DV),
    });
    expect(mockCalls[1].arg.interpolate).toBe(false);
    await stream.close();
    expect(() => stream.scheduleAt(0n, pos)).toThrow(/closed/);
  });

  it("is gated below 2.2.0 and sends nothing", async () => {
    ctrl = await makeController({ major: 2, minor: 1, patch: 0 });
    expect(ctrl.v22Capable).toBe(false);
    const stream = await ctrl.createStream({ left: P0, right: P0 });
    mockCalls.length = 0;
    expect(() => stream.scheduleAt(1n, { left: P0, right: P0 })).toThrow(
      /2\.2\.0/,
    );
    expect(mockCalls).toHaveLength(0);
  });

  it("update() reports whether it reached the wire; force bypasses the gate", async () => {
    ctrl = await makeController();
    const stream = await ctrl.createStream({ left: P0, right: P0 });
    mockCalls.length = 0;
    const pos = { left: { x: 1, y: 1 }, right: P0 };
    // The gate's min-interval is anchored at CREATE: pace past it.
    await new Promise((r) => setTimeout(r, 2));
    expect(stream.update(pos)).toBe(true);
    expect(stream.update(pos)).toBe(false); // deduped
    expect(stream.update(pos, { force: true })).toBe(true); // re-asserted anyway
    expect(mockCalls.filter((c) => c.prop === "MirrorStream")).toHaveLength(2);
  });
});

describe("Controller.uploadTrajectory (CMD_TRAJECTORY)", () => {
  let ctrl: Controller | undefined;
  afterEach(() => {
    ctrl?.release();
    ctrl = undefined;
    mockCalls.length = 0;
    mockPush.cb = null;
    mockPush.binds = 0;
    Object.assign(mockData, {
      inFlight: 0,
      maxInFlight: 0,
      rejectAt: -1,
      delayMs: 0,
    });
    setHostClock(() => process.hrtime.bigint());
  });

  it("uploads BEGIN -> chunked DATA -> MARK -> COMMIT with converted positions", async () => {
    ctrl = await makeController();
    const s = spec(25);
    const handle = await ctrl.uploadTrajectory(s);
    expect(handle.id).toBe(0);
    expect(trajectoryOps()).toEqual([
      "BEGIN",
      "DATA",
      "DATA",
      "DATA",
      "MARK",
      "COMMIT",
    ]);
    const calls = mockCalls.filter((c) => c.prop === "Trajectory");
    expect(calls[0].arg).toEqual({
      op: "BEGIN",
      id: 0,
      sample_count: 25,
      period: 20_000,
      step: false,
    });
    const data = calls.filter((c) => c.arg.op === "DATA").map((c) => c.arg);
    expect(data.map((d) => [d.first_index, d.samples.length])).toEqual([
      [0, 12],
      [12, 12],
      [24, 1],
    ]);
    expect(data[1].samples[0]).toEqual({
      t_offset: s.samples[12].tOffsetUs,
      left: channels(s.samples[12].left, BIAS, DV),
      right: channels(s.samples[12].right, BIAS, DV),
    });
    expect(calls[4].arg).toEqual({
      op: "MARK",
      id: 0,
      marker: 0,
      t_offset: 10_000,
      cameras: ["L", "R"],
      pulse: 2000,
    });
    expect(mockPush.binds).toBe(1);
  });

  it("pipelines DATA chunks within the upload window", async () => {
    ctrl = await makeController();
    mockData.delayMs = 5;
    await ctrl.uploadTrajectory(spec(240)); // 20 chunks
    expect(mockData.maxInFlight).toBeGreaterThan(1);
    expect(mockData.maxInFlight).toBeLessThanOrEqual(8);
    // Issue order is preserved on the wire.
    const firsts = mockCalls
      .filter((c) => c.prop === "Trajectory" && c.arg.op === "DATA")
      .map((c) => c.arg.first_index);
    expect(firsts).toEqual(Array.from({ length: 20 }, (_, i) => i * 12));
  });

  it("starts at a host-ns instant on the MCU clock, stops, and disposes", async () => {
    const elapse = pinHostClock();
    ctrl = await makeController();
    ctrl.setClockOffsetNs(5_000_000n);
    const handle = await ctrl.uploadTrajectory(spec(4));
    mockCalls.length = 0;
    await handle.start(5_000_000n + 2_000_000_000n, 10);
    await handle.start();
    await handle.stop();
    const ops = mockCalls
      .filter((c) => c.prop === "Trajectory")
      .map((c) => c.arg);
    expect(ops[0]).toEqual({
      op: "START",
      id: 0,
      t_start: 2_000_000n,
      cycles: 10,
    });
    expect(ops[1]).toEqual({ op: "START", id: 0, t_start: 0n, cycles: 0 }); // now, forever
    expect(ops[2]).toEqual({ op: "STOP", id: 0 });

    mockCalls.length = 0;
    await handle.dispose();
    await handle.dispose(); // idempotent
    expect(trajectoryOps()).toEqual(["DELETE"]);
    await expect(handle.start()).rejects.toThrow(/disposed/);
    // The table was played: its id sits out the grace (a capture in flight
    // at the DELETE still pushes with it), then is free again.
    expect((await ctrl.uploadTrajectory(spec(4))).id).toBe(1);
    elapse(trajectoryGraceUs(spec(4)) + 1);
    expect((await ctrl.uploadTrajectory(spec(4))).id).toBe(0);
  });

  it("a never-started table's id is reusable at once after dispose", async () => {
    pinHostClock();
    ctrl = await makeController();
    const handle = await ctrl.uploadTrajectory(spec(4));
    await handle.dispose();
    expect((await ctrl.uploadTrajectory(spec(4))).id).toBe(0);
  });

  it("tracks clock calibration: set by an offset, lost after two missed pings in a row", async () => {
    ctrl = await makeController();
    expect(ctrl.clockCalibrated).toBe(false);
    ctrl.setClockOffsetNs(123n);
    expect(ctrl.clockCalibrated).toBe(true);
    ctrl.noteClockPingMissed();
    expect(ctrl.clockCalibrated).toBe(true); // one miss is tolerated
    ctrl.setClockOffsetNs(124n); // a landed ping resets the streak
    ctrl.noteClockPingMissed();
    expect(ctrl.clockCalibrated).toBe(true);
    ctrl.noteClockPingMissed();
    expect(ctrl.clockCalibrated).toBe(false);
    ctrl.setClockOffsetNs(125n);
    expect(ctrl.clockCalibrated).toBe(true);
  });

  it("feeds onFrame from the SYN pushes, decoded like FrameOutcome", async () => {
    ctrl = await makeController();
    ctrl.setClockOffsetNs(7_000n);
    const a = await ctrl.uploadTrajectory(spec(4));
    const b = await ctrl.uploadTrajectory(spec(4));
    expect([a.id, b.id]).toEqual([0, 1]);
    expect(mockPush.binds).toBe(1); // one device subscription, demuxed by id
    const gotA: TrajectoryFrameOutcome[] = [];
    const gotB: TrajectoryFrameOutcome[] = [];
    const offA = a.onFrame((f) => gotA.push(f));
    b.onFrame((f) => gotB.push(f));
    const left = channels({ x: 2, y: -1 }, BIAS, DV);
    const right = channels({ x: -3, y: 0.5 }, BIAS, DV);
    mockPush.cb!({
      id: 0,
      marker: 0,
      cycle: 3,
      status: "OK",
      result: {
        stream: 0,
        frame_id: 17,
        t_trigger: 100n,
        t_exposure: 600n,
        left,
        right,
      },
    });
    expect(gotB).toHaveLength(0);
    expect(gotA).toHaveLength(1);
    const f = gotA[0];
    expect(f).toMatchObject({
      trajectoryId: 0,
      marker: 0,
      cycle: 3,
      status: "OK",
      frameId: 17,
    });
    expect(f.tTrigger).toBe(100n * 1000n + 7_000n); // trusted host-steady ns
    expect(f.tExposure).toBe(600n * 1000n + 7_000n);
    expect(f.left.x).toBeCloseTo(2, 2);
    expect(f.left.y).toBeCloseTo(-1, 2);
    expect(f.right.x).toBeCloseTo(-3, 2);

    // Run-level push (no marker), then unsubscribe.
    mockPush.cb!({
      id: 0,
      marker: null,
      cycle: 10,
      status: "ENDED",
      result: {
        stream: 0,
        frame_id: 0,
        t_trigger: 0n,
        t_exposure: 0n,
        left: [0, 0, 0, 0],
        right: [0, 0, 0, 0],
      },
    });
    expect(gotA[1]).toMatchObject({ marker: null, status: "ENDED", cycle: 10 });
    offA();
    mockPush.cb!({
      id: 0,
      marker: 0,
      cycle: 11,
      status: "OK",
      result: {
        stream: 0,
        frame_id: 18,
        t_trigger: 1n,
        t_exposure: 2n,
        left,
        right,
      },
    });
    expect(gotA).toHaveLength(2);
  });

  it("caps the table count, gates the version, and validates before the wire", async () => {
    ctrl = await makeController();
    for (let i = 0; i < TRAJECTORY_MAX_TABLES; i++)
      await ctrl.uploadTrajectory(spec(2));
    await expect(ctrl.uploadTrajectory(spec(2))).rejects.toThrow(/capacity/);
    mockCalls.length = 0;
    await expect(
      ctrl.uploadTrajectory({ periodUs: 10, samples: [] }),
    ).rejects.toThrow();
    expect(mockCalls).toHaveLength(0);
    ctrl.release();

    ctrl = await makeController({ major: 2, minor: 1, patch: 9 });
    await expect(ctrl.uploadTrajectory(spec(2))).rejects.toThrow(/2\.2\.0/);
    expect(mockCalls).toHaveLength(0);
  });

  it("DELETEs a partial table and frees the id when a chunk is REJected", async () => {
    ctrl = await makeController();
    mockData.rejectAt = 12;
    await expect(ctrl.uploadTrajectory(spec(30))).rejects.toThrow(
      /past the end/,
    );
    const ops = trajectoryOps();
    expect(ops[0]).toBe("BEGIN");
    expect(ops.at(-1)).toBe("DELETE");
    expect(ops).not.toContain("COMMIT");
    mockData.rejectAt = -1;
    expect((await ctrl.uploadTrajectory(spec(2))).id).toBe(0);
  });
});

describe("TrajectoryHandle.replace (phase-continuous swap)", () => {
  let ctrl: Controller | undefined;
  const OFFSET = 5_000_000n;
  const T_START_NS = OFFSET + 2_000_000_000n; // MCU 2 000 000 µs
  afterEach(() => {
    ctrl?.release();
    ctrl = undefined;
    mockCalls.length = 0;
    mockTimeline.length = 0;
    mockPush.cb = null;
    mockPush.binds = 0;
    mockOps.reject.length = 0;
    mockOps.delayMs = {};
    Object.assign(mockData, {
      inFlight: 0,
      maxInFlight: 0,
      rejectAt: -1,
      delayMs: 0,
    });
    setHostClock(() => process.hrtime.bigint());
  });

  /** A different shape of the same period (MirrorLink: a steer/slider move). */
  function reshaped(n: number, periodUs = 20_000): TrajectorySpec {
    const s = spec(n, periodUs);
    return {
      ...s,
      samples: s.samples.map((x) => ({
        ...x,
        left: { x: x.left.x + 1, y: 2 },
      })),
      markers: [{ tOffsetUs: 1_000, pulseUs: 3_000 }],
    };
  }

  const push = (id: number, extra: Record<string, unknown> = {}) =>
    mockPush.cb!({
      id,
      marker: 0,
      cycle: 1,
      status: "OK",
      result: {
        stream: id,
        frame_id: 1,
        t_trigger: 1n,
        t_exposure: 2n,
        left: [0, 0, 0, 0],
        right: [0, 0, 0, 0],
      },
      ...extra,
    });

  const wireOps = () =>
    mockCalls.filter((c) => c.prop === "Trajectory").map((c) => c.arg);

  /** Poll (real time) until `cond` holds. */
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 500 && !cond(); i++)
      await new Promise((r) => setTimeout(r, 1));
    expect(cond()).toBe(true);
  };

  // Advances the pinned host clock (grace deadlines), set by running().
  let elapse: (us: number) => void = () => {};

  /** A handle on id 0, RUNNING since MCU 2 000 000 µs, wire log cleared. */
  async function running(fw = { major: 2, minor: 2, patch: 0 }) {
    elapse = pinHostClock();
    ctrl = await makeController(fw);
    ctrl.setClockOffsetNs(OFFSET);
    const handle = await ctrl.uploadTrajectory(spec(4));
    await handle.start(T_START_NS, 0);
    mockCalls.length = 0;
    mockTimeline.length = 0;
    return handle;
  }

  it("uploads to a FREE id, then STOP(old) + START(new, original t_start), then DELETE(old)", async () => {
    const handle = await running();
    const next = reshaped(25);
    await handle.replace(next);
    expect(trajectoryOps()).toEqual([
      "BEGIN",
      "DATA",
      "DATA",
      "DATA",
      "MARK",
      "COMMIT",
      "STOP",
      "START",
      "DELETE",
    ]);
    const calls = wireOps();
    expect(calls[0]).toEqual({
      op: "BEGIN",
      id: 1,
      sample_count: 25,
      period: 20_000,
      step: false,
    });
    expect(calls.slice(1, 6).every((a) => a.id === 1)).toBe(true);
    expect(calls[1].samples[0].left).toEqual(
      channels(next.samples[0].left, BIAS, DV),
    );
    expect(calls[4]).toEqual({
      op: "MARK",
      id: 1,
      marker: 0,
      t_offset: 1_000,
      cameras: ["L", "R"],
      pulse: 3_000,
    });
    expect(calls[6]).toEqual({ op: "STOP", id: 0 });
    // The exact MCU t_start the run was started with — the firmware joins it
    // in progress, so the phase carries over.
    expect(calls[7]).toEqual({
      op: "START",
      id: 1,
      t_start: 2_000_000n,
      cycles: 0,
    });
    expect(calls[8]).toEqual({ op: "DELETE", id: 0 });
    expect(handle.id).toBe(1);
    expect(handle.lastSwap).toBe("stop-start"); // 2.2.0: no atomic START
    // Past the old table's grace, a later replace carries the same anchor
    // again and swaps back to id 0.
    elapse(trajectoryGraceUs(spec(4)) + 1);
    mockCalls.length = 0;
    await handle.replace(spec(4));
    const again = wireOps();
    expect(again.find((a) => a.op === "START")).toEqual({
      op: "START",
      id: 0,
      t_start: 2_000_000n,
      cycles: 0,
    });
    expect(again.at(-1)).toEqual({ op: "DELETE", id: 1 });
    expect(handle.id).toBe(0);
  });

  it("writes STOP and START back to back (START goes out before STOP's ACK)", async () => {
    const handle = await running();
    mockOps.delayMs = { STOP: 5 };
    await handle.replace(reshaped(4));
    const sendStart = mockTimeline.indexOf("send:START:1");
    expect(mockTimeline.indexOf("send:STOP:0")).toBe(sendStart - 1);
    expect(sendStart).toBeLessThan(mockTimeline.indexOf("ack:STOP:0"));
    // DELETE(old) only after both settled.
    expect(mockTimeline.indexOf("send:DELETE:0")).toBeGreaterThan(
      mockTimeline.indexOf("ack:STOP:0"),
    );
  });

  it("carries the cycle budget, and a 'now' start's send-time MCU estimate", async () => {
    ctrl = await makeController();
    ctrl.setClockOffsetNs(OFFSET);
    let now = OFFSET + 3_000_000_000n;
    setHostClock(() => now);
    const handle = await ctrl.uploadTrajectory(spec(4));
    await handle.start(undefined, 50);
    expect(wireOps().at(-1)).toEqual({
      op: "START",
      id: 0,
      t_start: 0n,
      cycles: 50,
    });
    now += 1_000_000_000n; // a second later: the anchor stays the START instant
    mockCalls.length = 0;
    await handle.replace(reshaped(4));
    const start = wireOps().find((a) => a.op === "START");
    expect(start).toEqual({
      op: "START",
      id: 1,
      t_start: 3_000_000n,
      cycles: 50,
    });
  });

  it("keeps the listener set: new-id pushes reach it, the old id stays routed for its grace", async () => {
    const handle = await running();
    const got: TrajectoryFrameOutcome[] = [];
    handle.onFrame((f) => got.push(f));
    push(0);
    await handle.replace(reshaped(4));
    push(1);
    // A capture of the OLD table in flight at the swap pushes with the old
    // id after it: inside the grace it still reaches the same listeners.
    const graceUs = trajectoryGraceUs(spec(4)); // the OLD spec's
    expect(graceUs).toBe(2_000 + 5_000 + 50_000);
    elapse(graceUs - 1);
    push(0);
    expect(got.map((f) => f.trajectoryId)).toEqual([0, 1, 0]);
    // Inside the grace the old id is not handed out again.
    const other = await ctrl!.uploadTrajectory(spec(2));
    expect(other.id).toBe(2);
    // Past it, a straggler is nobody's, and the id is free.
    elapse(2);
    push(0);
    expect(got).toHaveLength(3);
    const reused = await ctrl!.uploadTrajectory(spec(2));
    expect(reused.id).toBe(0);
    const gotReused: TrajectoryFrameOutcome[] = [];
    reused.onFrame((f) => gotReused.push(f));
    push(0); // the new owner's — no leak into the old handle
    expect(got).toHaveLength(3);
    expect(gotReused).toHaveLength(1);
  });

  it("the grace is the OLD spec's max pulse + 5 ms margin + 50 ms slack, measured from the swap", async () => {
    const handle = await running();
    const got: TrajectoryFrameOutcome[] = [];
    handle.onFrame((f) => got.push(f));
    await handle.replace(reshaped(4)); // 0 -> 1, old pulse 2 000 µs
    elapse(1_000);
    await handle.replace(spec(4)); // 1 -> 2 (0 still in grace), old pulse 3 000 µs
    expect(handle.id).toBe(2);
    // id 0 expires 57 ms after the first swap; id 1 58 ms after the second.
    elapse(57_000 - 1_000 - 1); // 1 µs before id 0's deadline
    push(0);
    push(1);
    expect(got.map((f) => f.trajectoryId)).toEqual([0, 1]);
    elapse(2);
    push(0); // expired
    push(1);
    expect(got.map((f) => f.trajectoryId)).toEqual([0, 1, 1]);
    elapse(58_000);
    push(1); // expired
    expect(got).toHaveLength(3);
  });

  it("a retired id's run-level push does not end the current run", async () => {
    const handle = await running();
    await handle.replace(reshaped(4));
    push(0, { marker: null, status: "CANCELLED", cycle: 0 });
    // Still running: a period change is refused.
    await expect(handle.replace(reshaped(4, 40_000))).rejects.toThrow(
      /same period/,
    );
  });

  it("dispose honors the grace: the id is not reused and its stragglers reach nobody", async () => {
    const handle = await running();
    const got: TrajectoryFrameOutcome[] = [];
    handle.onFrame((f) => got.push(f));
    await handle.dispose();
    const next = await ctrl!.uploadTrajectory(spec(4));
    expect(next.id).toBe(1);
    const gotNext: TrajectoryFrameOutcome[] = [];
    next.onFrame((f) => gotNext.push(f));
    push(0);
    expect(got).toHaveLength(0);
    expect(gotNext).toHaveLength(0);
    elapse(trajectoryGraceUs(spec(4)) + 1);
    expect((await ctrl!.uploadTrajectory(spec(4))).id).toBe(0);
  });

  it("waits for a grace to run out instead of failing when every other id is taken", async () => {
    const handle = await running(); // id 0
    await ctrl!.uploadTrajectory(spec(2)); // 1
    await ctrl!.uploadTrajectory(spec(2)); // 2
    await handle.replace(reshaped(4)); // -> 3, 0 in grace
    expect(handle.id).toBe(3);
    // No free id: the next replace waits out id 0's grace (real time — the
    // pinned clock stands still) rather than throwing at capacity.
    const t0 = performance.now();
    await handle.replace(spec(4));
    expect(handle.id).toBe(0);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it("an upload failure leaves the old table running and frees the new id", async () => {
    const handle = await running();
    const got: TrajectoryFrameOutcome[] = [];
    handle.onFrame((f) => got.push(f));
    mockData.rejectAt = 12;
    await expect(handle.replace(reshaped(30))).rejects.toThrow(/past the end/);
    const ops = wireOps();
    expect(ops[0]).toMatchObject({ op: "BEGIN", id: 1 });
    expect(ops.at(-1)).toEqual({ op: "DELETE", id: 1 });
    expect(ops.map((a) => a.op)).not.toContain("STOP");
    expect(ops.map((a) => a.op)).not.toContain("START");
    expect(handle.id).toBe(0);
    push(0);
    expect(got).toHaveLength(1);
    // Still running: the next replace is phase-continuous on a free id (1).
    mockData.rejectAt = -1;
    mockCalls.length = 0;
    await handle.replace(reshaped(4));
    expect(trajectoryOps().slice(-3)).toEqual(["STOP", "START", "DELETE"]);
    expect(handle.id).toBe(1);
  });

  it("refuses a period change while running before anything is sent", async () => {
    const handle = await running();
    await expect(handle.replace(reshaped(4, 40_000))).rejects.toThrow(
      /same period/,
    );
    await expect(handle.replace({ periodUs: 10, samples: [] })).rejects.toThrow(
      /at least one/,
    );
    expect(mockCalls).toHaveLength(0);
    expect(handle.id).toBe(0);
  });

  it("from a stopped handle: plain re-upload + DELETE(old), any period, no STOP/START", async () => {
    elapse = pinHostClock();
    ctrl = await makeController();
    ctrl.setClockOffsetNs(OFFSET);
    const handle = await ctrl.uploadTrajectory(spec(4));
    await handle.start(T_START_NS);
    await handle.stop();
    mockCalls.length = 0;
    await handle.replace(reshaped(4, 40_000));
    expect(trajectoryOps()).toEqual([
      "BEGIN",
      "DATA",
      "MARK",
      "COMMIT",
      "DELETE",
    ]);
    expect(wireOps().at(-1)).toEqual({ op: "DELETE", id: 0 });
    expect(handle.id).toBe(1);
    // The swapped handle starts / disposes the NEW table.
    mockCalls.length = 0;
    await handle.start();
    await handle.dispose();
    expect(wireOps().map((a) => [a.op, a.id])).toEqual([
      ["START", 1],
      ["DELETE", 1],
    ]);
    // Both ids are free again once their graces ran out (0 was played
    // before the re-upload, 1 after it).
    elapse(trajectoryGraceUs(reshaped(4)) + 1);
    expect((await ctrl.uploadTrajectory(spec(2))).id).toBe(0);
    expect((await ctrl.uploadTrajectory(spec(2))).id).toBe(1);
  });

  it("a finished run (ENDED push) replaces as a stopped one", async () => {
    const handle = await running();
    push(0, { marker: null, status: "ENDED", cycle: 10 });
    await handle.replace(reshaped(4, 40_000)); // a period change is fine now
    expect(trajectoryOps()).not.toContain("START");
    expect(trajectoryOps()).not.toContain("STOP");
    expect(handle.id).toBe(1);
  });

  it("a REJected START(new) re-STARTs the old table at the same t_start", async () => {
    const handle = await running();
    mockOps.reject.push({
      op: "START",
      id: 1,
      message: "Cannot perform action: system is not enabled",
    });
    const error = await handle.replace(reshaped(4)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrajectoryReplaceError);
    expect((error as TrajectoryReplaceError).running).toBe(true);
    expect(wireOps().slice(-4)).toEqual([
      { op: "STOP", id: 0 },
      { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
      { op: "DELETE", id: 1 },
      { op: "START", id: 0, t_start: 2_000_000n, cycles: 0 },
    ]);
    expect(handle.id).toBe(0);
    // Both REJected: the run is over (running: false); the next replace is plain.
    mockOps.reject.push(
      { op: "START", id: 1, message: "nope" },
      { op: "START", id: 0, message: "nope" },
    );
    const second = await handle.replace(reshaped(4)).catch((e: unknown) => e);
    expect((second as TrajectoryReplaceError).running).toBe(false);
    mockCalls.length = 0;
    await handle.replace(reshaped(4, 40_000));
    expect(trajectoryOps()).toEqual([
      "BEGIN",
      "DATA",
      "MARK",
      "COMMIT",
      "DELETE",
    ]);
  });

  it("one replace at a time; dispose waits for it and deletes the swapped table", async () => {
    const handle = await running();
    mockData.delayMs = 5;
    const first = handle.replace(reshaped(4));
    await expect(handle.replace(reshaped(4))).rejects.toThrow(/in flight/);
    await first; // landed: the handle now owns id 1
    expect(handle.id).toBe(1);
    await handle.dispose();
    expect(wireOps().at(-1)).toEqual({ op: "DELETE", id: 1 });
    await expect(handle.replace(spec(4))).rejects.toThrow(/disposed/);
    elapse(trajectoryGraceUs(reshaped(4)) + 1);
    expect((await ctrl!.uploadTrajectory(spec(2))).id).toBe(0);
  });

  it("dispose during the upload: the new table never STARTs, both are DELETEd", async () => {
    const handle = await running();
    mockData.delayMs = 5;
    const first = handle.replace(reshaped(4));
    await until(() => mockTimeline.includes("send:BEGIN:1"));
    const disposed = handle.dispose();
    await expect(first).rejects.toThrow(/disposed/);
    await disposed;
    const ops = wireOps().map((a) => [a.op, a.id]);
    expect(ops.map(([op]) => op)).not.toContain("START");
    expect(ops.slice(-2)).toEqual([
      ["DELETE", 1],
      ["DELETE", 0],
    ]);
  });

  it("a replace queued behind a dispose never uploads", async () => {
    const handle = await running();
    mockOps.delayMs = { STOP: 5 };
    const stopping = handle.stop();
    await until(() => mockTimeline.includes("send:STOP:0"));
    const queued = handle.replace(reshaped(4));
    const disposed = handle.dispose();
    await stopping;
    await expect(queued).rejects.toThrow(/disposed/);
    await disposed;
    expect(trajectoryOps()).toEqual(["STOP", "DELETE"]);
  });

  describe("start / stop / replace serialization", () => {
    it("a replace issued while START awaits its ACK waits for it and swaps the RUNNING table", async () => {
      elapse = pinHostClock();
      ctrl = await makeController();
      ctrl.setClockOffsetNs(OFFSET);
      const handle = await ctrl.uploadTrajectory(spec(4));
      mockCalls.length = 0;
      mockTimeline.length = 0;
      mockOps.delayMs = { START: 5 };
      const started = handle.start(T_START_NS, 0);
      const replaced = handle.replace(reshaped(4));
      await Promise.all([started, replaced]);
      const sent = mockTimeline.filter((e) => !e.startsWith("send:DATA"));
      // The upload of the new table only begins after START(0)'s ACK, and
      // the swap is a running one: STOP(0) + START(1) — never a plain
      // re-upload that DELETEs the starting table.
      expect(sent.indexOf("ack:START:0")).toBeLessThan(
        sent.indexOf("send:BEGIN:1"),
      );
      expect(wireOps().slice(-3)).toEqual([
        { op: "STOP", id: 0 },
        { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
        { op: "DELETE", id: 0 },
      ]);
      expect(handle.id).toBe(1);
      expect(handle.lastSwap).toBe("stop-start");
    });

    it("a stop() issued while START awaits its ACK goes out after it; a replace after both is plain", async () => {
      const handle = await running();
      await handle.stop();
      mockCalls.length = 0;
      mockTimeline.length = 0;
      mockOps.delayMs = { START: 5 };
      const started = handle.start(T_START_NS, 0);
      const stopped = handle.stop();
      const replaced = handle.replace(reshaped(4, 40_000)); // stopped by then: any period
      await Promise.all([started, stopped, replaced]);
      const sent = mockTimeline.filter((e) =>
        /^(send|ack):(START|STOP|BEGIN)/.test(e),
      );
      expect(sent).toEqual([
        "send:START:0",
        "ack:START:0",
        "send:STOP:0",
        "ack:STOP:0",
        "send:BEGIN:1",
        "ack:BEGIN:1",
      ]);
      expect(trajectoryOps().filter((op) => op === "START")).toHaveLength(1);
      expect(handle.id).toBe(1);
    });

    it("a second replace while one is QUEUED (behind a start) throws", async () => {
      const handle = await running();
      await handle.stop();
      mockOps.delayMs = { START: 5 };
      const started = handle.start(T_START_NS, 0);
      const first = handle.replace(reshaped(4));
      await expect(handle.replace(reshaped(4))).rejects.toThrow(/in flight/);
      await Promise.all([started, first]);
      expect(handle.id).toBe(1);
    });
  });

  describe("atomic swap (firmware 2.2.1)", () => {
    const FW_221 = { major: 2, minor: 2, patch: 1 };

    it("is gated on 2.2.1", async () => {
      ctrl = await makeController(FW_221);
      expect(ctrl.v221Capable).toBe(true);
      expect(ctrl.v22Capable).toBe(true);
      ctrl.release();
      ctrl = await makeController({ major: 2, minor: 2, patch: 0 });
      expect(ctrl.v221Capable).toBe(false);
    });

    it("swaps with ONE START(new, original t_start) — no STOP — then DELETE(old)", async () => {
      const handle = await running(FW_221);
      const got: TrajectoryFrameOutcome[] = [];
      handle.onFrame((f) => got.push(f));
      expect(handle.lastSwap).toBeNull();
      await handle.replace(reshaped(4));
      expect(trajectoryOps()).toEqual([
        "BEGIN",
        "DATA",
        "MARK",
        "COMMIT",
        "START",
        "DELETE",
      ]);
      expect(wireOps().slice(-2)).toEqual([
        { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
        { op: "DELETE", id: 0 },
      ]);
      expect(handle.id).toBe(1);
      expect(handle.lastSwap).toBe("atomic");
      // The old table's in-flight capture still lands inside the grace.
      push(0);
      push(1);
      expect(got.map((f) => f.trajectoryId)).toEqual([0, 1]);
    });

    it("falls back to STOP(old) + START(new) on a REJ 'already running'", async () => {
      const handle = await running(FW_221);
      mockOps.reject.push({
        op: "START",
        id: 1,
        message: "A trajectory is already running (STOP it first)",
      });
      await handle.replace(reshaped(4));
      expect(
        mockTimeline.filter(
          (e) => e.startsWith("send:") || e.startsWith("rej:"),
        ),
      ).toEqual([
        "send:BEGIN:1",
        "send:MARK:1",
        "send:COMMIT:1",
        "send:START:1",
        "rej:START:1",
        "send:STOP:0",
        "send:START:1",
        "send:DELETE:0",
      ]);
      expect(wireOps().slice(-3)).toEqual([
        { op: "STOP", id: 0 },
        { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
        { op: "DELETE", id: 0 },
      ]);
      expect(handle.id).toBe(1);
      expect(handle.lastSwap).toBe("stop-start");
    });

    it("any other REJ of the atomic START stops nothing: TrajectoryReplaceError, still running", async () => {
      const handle = await running(FW_221);
      mockOps.reject.push({
        op: "START",
        id: 1,
        message: "Trajectory not committed (COMMIT first)",
      });
      const error = await handle.replace(reshaped(4)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TrajectoryReplaceError);
      expect((error as TrajectoryReplaceError).running).toBe(true);
      expect(wireOps().slice(-2)).toEqual([
        { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
        { op: "DELETE", id: 1 },
      ]);
      expect(trajectoryOps()).not.toContain("STOP");
      expect(handle.id).toBe(0);
      expect(handle.lastSwap).toBeNull();
      // The never-started new id is free at once; still running → same period.
      await expect(handle.replace(reshaped(4, 40_000))).rejects.toThrow(
        /same period/,
      );
      mockCalls.length = 0;
      await handle.replace(reshaped(4));
      expect(wireOps().find((a) => a.op === "BEGIN")).toMatchObject({ id: 1 });
      expect(handle.lastSwap).toBe("atomic");
    });

    it("a 'now' start (inexact anchor) skips the atomic attempt", async () => {
      ctrl = await makeController(FW_221);
      ctrl.setClockOffsetNs(OFFSET);
      setHostClock(() => OFFSET + 3_000_000_000n);
      const handle = await ctrl.uploadTrajectory(spec(4));
      await handle.start();
      mockCalls.length = 0;
      await handle.replace(reshaped(4));
      expect(trajectoryOps().slice(-3)).toEqual(["STOP", "START", "DELETE"]);
      expect(handle.lastSwap).toBe("stop-start");
    });

    it("after a 'now' start's first STOP/START (explicit t_start ACKed) the next replace is atomic", async () => {
      ctrl = await makeController(FW_221);
      ctrl.setClockOffsetNs(OFFSET);
      setHostClock(() => OFFSET + 3_000_000_000n);
      const handle = await ctrl.uploadTrajectory(spec(4));
      await handle.start();
      mockCalls.length = 0;
      await handle.replace(reshaped(4));
      expect(handle.lastSwap).toBe("stop-start");
      const anchor = wireOps().find((a) => a.op === "START")!.t_start;
      expect(anchor).toBe(3_000_000n); // the send-time estimate, now on the wire
      mockCalls.length = 0;
      await handle.replace(spec(4));
      expect(trajectoryOps()).toEqual([
        "BEGIN",
        "DATA",
        "MARK",
        "COMMIT",
        "START",
        "DELETE",
      ]);
      // id 0 is still in its grace, so the third table is id 2.
      expect(wireOps().find((a) => a.op === "START")).toEqual({
        op: "START",
        id: 2,
        t_start: anchor,
        cycles: 0,
      });
      expect(handle.lastSwap).toBe("atomic");
    });

    describe("atomic START failing WITHOUT a REJ (outcome unknown)", () => {
      const TIMEOUT = "Request timeout";

      it("re-STARTs the old table at the same t_start; an ACK means it runs — grace + DELETE the new one", async () => {
        const handle = await running(FW_221);
        const got: number[] = [];
        handle.onFrame((f) => got.push(f.trajectoryId));
        mockOps.reject.push({ op: "START", id: 1, message: TIMEOUT });
        const error = (await handle
          .replace(reshaped(4))
          .catch((e: unknown) => e)) as TrajectoryReplaceError;
        expect(error).toBeInstanceOf(TrajectoryReplaceError);
        expect(error.running).toBe(true);
        expect(error.message).toMatch(/without a REJ.*re-STARTed table 0/);
        expect(error.replacement).toEqual({ id: 1, maybeLive: false });
        expect(wireOps().slice(-3)).toEqual([
          { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
          { op: "START", id: 0, t_start: 2_000_000n, cycles: 0 },
          { op: "DELETE", id: 1 },
        ]);
        expect(trajectoryOps()).not.toContain("STOP");
        expect(handle.id).toBe(0);
        expect(handle.lastSwap).toBeNull();
        // The new table may have played for a moment: its id stays routed
        // (and unallocatable) for its grace.
        push(1);
        push(0);
        expect(got).toEqual([1, 0]);
        mockCalls.length = 0;
        await handle.replace(reshaped(4));
        expect(wireOps().find((a) => a.op === "BEGIN")).toMatchObject({
          id: 2,
        });
        expect(handle.lastSwap).toBe("atomic"); // still running, still exact
        elapse(trajectoryGraceUs(reshaped(4)) + 1);
        push(1);
        expect(got).toEqual([1, 0]); // past the grace: unrouted
      });

      it("a REJ 'already running' of the re-START is ambiguous: both ids stay routed, nothing is DELETEd", async () => {
        const handle = await running(FW_221);
        const got: number[] = [];
        handle.onFrame((f) => got.push(f.trajectoryId));
        mockOps.reject.push(
          { op: "START", id: 1, message: TIMEOUT },
          {
            op: "START",
            id: 0,
            message: "A trajectory is already running (STOP it first)",
          },
        );
        const error = (await handle
          .replace(reshaped(4))
          .catch((e: unknown) => e)) as TrajectoryReplaceError;
        expect(error).toBeInstanceOf(TrajectoryReplaceError);
        expect(error.running).toBe(true);
        expect(error.message).toMatch(/ambiguous/);
        expect(error.replacement).toEqual({ id: 1, maybeLive: true });
        expect(wireOps().slice(-2)).toEqual([
          { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
          { op: "START", id: 0, t_start: 2_000_000n, cycles: 0 },
        ]);
        expect(trajectoryOps()).not.toContain("STOP");
        expect(trajectoryOps()).not.toContain("DELETE");
        expect(handle.id).toBe(0);
        // Both route to the listeners — with no time limit while ambiguous.
        elapse(10 * trajectoryGraceUs(reshaped(4)));
        push(1);
        push(0);
        expect(got).toEqual([1, 0]);
        // The next swap (atomic: valid whichever of 0 / 1 plays) retires both.
        mockCalls.length = 0;
        await handle.replace(spec(4));
        expect(wireOps().find((a) => a.op === "BEGIN")).toMatchObject({
          id: 2,
        });
        expect(wireOps().slice(-3)).toEqual([
          { op: "START", id: 2, t_start: 2_000_000n, cycles: 0 },
          { op: "DELETE", id: 0 },
          { op: "DELETE", id: 1 },
        ]);
        expect(handle.id).toBe(2);
        push(1); // in its grace now
        expect(got).toEqual([1, 0, 1]);
        elapse(trajectoryGraceUs(reshaped(4)) + 1);
        push(1);
        expect(got).toEqual([1, 0, 1]);
      });

      it("after an ambiguous outcome, the STOP/START pair STOPs the sibling too — before START(new)", async () => {
        const handle = await running(FW_221);
        mockOps.reject.push(
          { op: "START", id: 1, message: TIMEOUT },
          {
            op: "START",
            id: 0,
            message: "A trajectory is already running (STOP it first)",
          },
        );
        await handle.replace(reshaped(4)).catch(() => {});
        mockOps.reject.push({
          op: "START",
          id: 2,
          message: "A trajectory is already running (STOP it first)",
        });
        mockCalls.length = 0;
        await handle.replace(spec(4));
        expect(wireOps().slice(-6)).toEqual([
          { op: "START", id: 2, t_start: 2_000_000n, cycles: 0 },
          { op: "STOP", id: 0 },
          { op: "STOP", id: 1 },
          { op: "START", id: 2, t_start: 2_000_000n, cycles: 0 },
          { op: "DELETE", id: 0 },
          { op: "DELETE", id: 1 },
        ]);
        expect(handle.id).toBe(2);
        expect(handle.lastSwap).toBe("stop-start");
      });

      it("after an ambiguous outcome, stop() STOPs both tables and retires the sibling", async () => {
        const handle = await running(FW_221);
        mockOps.reject.push(
          { op: "START", id: 1, message: TIMEOUT },
          {
            op: "START",
            id: 0,
            message: "A trajectory is already running (STOP it first)",
          },
        );
        await handle.replace(reshaped(4)).catch(() => {});
        mockCalls.length = 0;
        await handle.stop();
        expect(wireOps()).toEqual([
          { op: "STOP", id: 0 },
          { op: "STOP", id: 1 },
          { op: "DELETE", id: 1 },
        ]);
        // Not running any more: a plain re-upload, the sibling is gone.
        mockCalls.length = 0;
        await handle.replace(reshaped(4, 40_000));
        expect(trajectoryOps()).toEqual([
          "BEGIN",
          "DATA",
          "MARK",
          "COMMIT",
          "DELETE",
        ]);
        expect(wireOps().at(-1)).toEqual({ op: "DELETE", id: 0 });
      });

      it("after an ambiguous outcome, dispose() graces and DELETEs the sibling", async () => {
        const handle = await running(FW_221);
        const got: number[] = [];
        handle.onFrame((f) => got.push(f.trajectoryId));
        mockOps.reject.push(
          { op: "START", id: 1, message: TIMEOUT },
          {
            op: "START",
            id: 0,
            message: "A trajectory is already running (STOP it first)",
          },
        );
        await handle.replace(reshaped(4)).catch(() => {});
        mockCalls.length = 0;
        await handle.dispose();
        expect(wireOps()).toEqual([
          { op: "DELETE", id: 1 },
          { op: "DELETE", id: 0 },
        ]);
        // Both ids are in grace: their stragglers reach nobody and neither
        // is allocated to the next table.
        push(1);
        push(0);
        expect(got).toEqual([]);
        const next = await ctrl!.uploadTrajectory(spec(4));
        expect(next.id).toBe(2);
        const gotNext: number[] = [];
        next.onFrame((f) => gotNext.push(f.trajectoryId));
        push(1);
        expect(gotNext).toEqual([]);
        elapse(trajectoryGraceUs(reshaped(4)) + 1);
        expect((await ctrl!.uploadTrajectory(spec(2))).id).toBe(0);
        expect((await ctrl!.uploadTrajectory(spec(2))).id).toBe(1);
      });

      it("after an ambiguous outcome, a run that ENDED replaces as a plain re-upload and retires the sibling", async () => {
        const handle = await running(FW_221);
        const got: number[] = [];
        handle.onFrame((f) => got.push(f.trajectoryId));
        mockOps.reject.push(
          { op: "START", id: 1, message: TIMEOUT },
          {
            op: "START",
            id: 0,
            message: "A trajectory is already running (STOP it first)",
          },
        );
        await handle.replace(reshaped(4)).catch(() => {});
        push(0, { marker: null, status: "ENDED", cycle: 10 });
        got.length = 0;
        mockCalls.length = 0;
        await handle.replace(reshaped(4, 40_000)); // not running: any period
        expect(trajectoryOps()).toEqual([
          "BEGIN",
          "DATA",
          "MARK",
          "COMMIT",
          "DELETE",
          "DELETE",
        ]);
        expect(wireOps().find((a) => a.op === "BEGIN")).toMatchObject({
          id: 2,
        });
        expect(wireOps().slice(-2)).toEqual([
          { op: "DELETE", id: 0 },
          { op: "DELETE", id: 1 },
        ]);
        expect(handle.id).toBe(2);
        // The sibling is graced, then unrouted — not a sibling any more.
        push(1);
        expect(got).toEqual([1]);
        elapse(trajectoryGraceUs(reshaped(4)) + 1);
        push(1);
        expect(got).toEqual([1]);
        mockCalls.length = 0;
        await handle.start(T_START_NS);
        await handle.stop();
        expect(wireOps()).toEqual([
          { op: "START", id: 2, t_start: 2_000_000n, cycles: 0 },
          { op: "STOP", id: 2 },
        ]);
      });

      it("a re-START failing otherwise ends the run (running: false): STOP(old), DELETE(new)", async () => {
        const handle = await running(FW_221);
        mockOps.reject.push(
          { op: "START", id: 1, message: TIMEOUT },
          {
            op: "START",
            id: 0,
            message: "Request timeout (no device response)",
          },
        );
        const error = (await handle
          .replace(reshaped(4))
          .catch((e: unknown) => e)) as TrajectoryReplaceError;
        expect(error).toBeInstanceOf(TrajectoryReplaceError);
        expect(error.running).toBe(false);
        expect(error.message).toMatch(/could not be restarted/);
        expect(wireOps().slice(-4)).toEqual([
          { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
          { op: "START", id: 0, t_start: 2_000_000n, cycles: 0 },
          { op: "STOP", id: 0 },
          { op: "DELETE", id: 1 },
        ]);
        expect(handle.id).toBe(0);
        mockCalls.length = 0;
        await handle.replace(reshaped(4, 40_000)); // the run is over: plain re-upload
        expect(trajectoryOps()).not.toContain("START");
      });

      it("a definitive REJ is NOT retried (no re-START), whatever its reason", async () => {
        const handle = await running(FW_221);
        mockOps.reject.push({
          op: "START",
          id: 1,
          message: "Cannot perform action: system is not enabled",
        });
        const error = (await handle
          .replace(reshaped(4))
          .catch((e: unknown) => e)) as TrajectoryReplaceError;
        expect(error.running).toBe(true);
        expect(error.replacement).toBeNull();
        expect(wireOps().slice(-2)).toEqual([
          { op: "START", id: 1, t_start: 2_000_000n, cycles: 0 },
          { op: "DELETE", id: 1 },
        ]);
      });
    });
  });
});

describe("classifyTrajectoryStartError / Controller.clockOffsetNs", () => {
  it("tells the firmware's START REJ texts from host-side transport failures", () => {
    const k = (m: string) => classifyTrajectoryStartError(new Error(m));
    expect(k("A trajectory is already running (STOP it first)")).toBe(
      "already-running",
    );
    for (const m of [
      "Unknown trajectory id (BEGIN first)",
      "Trajectory not committed (COMMIT first)",
      "Cannot perform action: system is not enabled",
      "Bad START length",
      "A trigger is pending (legacy Trigger) — wait for its FIN",
      "Unknown trajectory operation",
      "Trajectory packet too short for its operation",
      "Unknown packet type",
    ])
      expect(k(m)).toBe("rejected");
    for (const m of [
      "Request timeout",
      "Request timeout (no device response)",
      "Unexpected response FIN:Trajectory",
      "Unknown response error",
      "Controller not connected",
      "nope",
    ])
      expect(k(m)).toBe("transport");
    expect(classifyTrajectoryStartError("Request timeout")).toBe("transport");
  });

  it("exposes the installed clock offset read-only", async () => {
    const ctrl = await makeController();
    expect(ctrl.clockOffsetNs).toBe(0n);
    ctrl.setClockOffsetNs(123_456_789n);
    expect(ctrl.clockOffsetNs).toBe(123_456_789n);
    ctrl.noteClockPingMissed();
    ctrl.noteClockPingMissed();
    expect(ctrl.clockOffsetNs).toBe(123_456_789n); // kept, just not vouched for
    ctrl.release();
  });
});
