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
        const i = mockOps.reject.findIndex((r) => r.op === arg.op && r.id === arg.id);
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
        mockData.maxInFlight = Math.max(mockData.maxInFlight, mockData.inFlight);
        await new Promise((r) => setTimeout(r, mockData.delayMs));
        mockData.inFlight--;
        if (arg.first_index === mockData.rejectAt)
          throw new Error("DATA chunk past the end of the table");
      }
      return arg;
    });
  }
  const Protocol = {
    System: { Enable: "Enable", Info: "Info", Version: "Version", Reset: "Reset", Timestamp: "Timestamp" },
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
  chunkTrajectorySamples,
  hostNsToMcuUs,
  mcuUsToHostNs,
  validateTrajectorySpec,
  type TrajectoryFrameOutcome,
  type TrajectorySpec,
} from "@orchestrator/controller";
import { setHostClock } from "@orchestrator/time-align";

const BIAS = dac2volt(29490);
const DV = 170;
const P0 = { x: 0, y: 0 };

async function makeController(fw = { major: 2, minor: 2, patch: 0 }): Promise<Controller> {
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

const trajectoryOps = () =>
  mockCalls.filter((c) => c.prop === "Trajectory").map((c) => c.arg.op as string);

describe("v2.2.0 pure helpers", () => {
  it("converts host-steady ns to MCU µs through the clock offset (FIN inverse)", () => {
    const offset = 1_700_000_000_000_000_000n; // host ns at MCU µs 0
    expect(hostNsToMcuUs(offset + 5_000_000n, offset)).toBe(5_000n);
    expect(hostNsToMcuUs(offset + 1_499n, offset)).toBe(1n); // rounds to nearest
    expect(hostNsToMcuUs(offset + 1_500n, offset)).toBe(2n);
    expect(hostNsToMcuUs(offset - 10n, offset)).toBe(0n); // before the MCU epoch
    // Round trip with the FIN decode direction.
    expect(hostNsToMcuUs(mcuUsToHostNs(987_654_321n, offset), offset)).toBe(987_654_321n);
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
    expect(() => validateTrajectorySpec({ ...spec(2), periodUs: 0 })).toThrow(/periodUs/);
    expect(() => validateTrajectorySpec({ periodUs: 100, samples: [] })).toThrow(/at least one/);
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
      validateTrajectorySpec({ periodUs: 100, samples: [{ tOffsetUs: 100, left: P0, right: P0 }] }),
    ).toThrow(/\[0, periodUs\)/);
    expect(() =>
      validateTrajectorySpec({
        ...spec(2, 100),
        markers: Array.from({ length: 9 }, () => ({ tOffsetUs: 1, pulseUs: 1 })),
      }),
    ).toThrow(/at most 8 markers/);
    expect(() =>
      validateTrajectorySpec({ ...spec(2, 100), markers: [{ tOffsetUs: 1, pulseUs: 0 }] }),
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
    stream.scheduleAt(1_000_000_000n + 250_000_000n, pos, { interpolate: true });
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
    expect(() => stream.scheduleAt(1n, { left: P0, right: P0 })).toThrow(/2\.2\.0/);
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
    Object.assign(mockData, { inFlight: 0, maxInFlight: 0, rejectAt: -1, delayMs: 0 });
  });

  it("uploads BEGIN -> chunked DATA -> MARK -> COMMIT with converted positions", async () => {
    ctrl = await makeController();
    const s = spec(25);
    const handle = await ctrl.uploadTrajectory(s);
    expect(handle.id).toBe(0);
    expect(trajectoryOps()).toEqual(["BEGIN", "DATA", "DATA", "DATA", "MARK", "COMMIT"]);
    const calls = mockCalls.filter((c) => c.prop === "Trajectory");
    expect(calls[0].arg).toEqual({ op: "BEGIN", id: 0, sample_count: 25, period: 20_000, step: false });
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
    ctrl = await makeController();
    ctrl.setClockOffsetNs(5_000_000n);
    const handle = await ctrl.uploadTrajectory(spec(4));
    mockCalls.length = 0;
    await handle.start(5_000_000n + 2_000_000_000n, 10);
    await handle.start();
    await handle.stop();
    const ops = mockCalls.filter((c) => c.prop === "Trajectory").map((c) => c.arg);
    expect(ops[0]).toEqual({ op: "START", id: 0, t_start: 2_000_000n, cycles: 10 });
    expect(ops[1]).toEqual({ op: "START", id: 0, t_start: 0n, cycles: 0 }); // now, forever
    expect(ops[2]).toEqual({ op: "STOP", id: 0 });

    mockCalls.length = 0;
    await handle.dispose();
    await handle.dispose(); // idempotent
    expect(trajectoryOps()).toEqual(["DELETE"]);
    await expect(handle.start()).rejects.toThrow(/disposed/);
    // The id is free again.
    const again = await ctrl.uploadTrajectory(spec(4));
    expect(again.id).toBe(0);
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
      result: { stream: 0, frame_id: 17, t_trigger: 100n, t_exposure: 600n, left, right },
    });
    expect(gotB).toHaveLength(0);
    expect(gotA).toHaveLength(1);
    const f = gotA[0];
    expect(f).toMatchObject({ trajectoryId: 0, marker: 0, cycle: 3, status: "OK", frameId: 17 });
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
      result: { stream: 0, frame_id: 0, t_trigger: 0n, t_exposure: 0n, left: [0, 0, 0, 0], right: [0, 0, 0, 0] },
    });
    expect(gotA[1]).toMatchObject({ marker: null, status: "ENDED", cycle: 10 });
    offA();
    mockPush.cb!({
      id: 0,
      marker: 0,
      cycle: 11,
      status: "OK",
      result: { stream: 0, frame_id: 18, t_trigger: 1n, t_exposure: 2n, left, right },
    });
    expect(gotA).toHaveLength(2);
  });

  it("caps the table count, gates the version, and validates before the wire", async () => {
    ctrl = await makeController();
    for (let i = 0; i < TRAJECTORY_MAX_TABLES; i++) await ctrl.uploadTrajectory(spec(2));
    await expect(ctrl.uploadTrajectory(spec(2))).rejects.toThrow(/capacity/);
    mockCalls.length = 0;
    await expect(ctrl.uploadTrajectory({ periodUs: 10, samples: [] })).rejects.toThrow();
    expect(mockCalls).toHaveLength(0);
    ctrl.release();

    ctrl = await makeController({ major: 2, minor: 1, patch: 9 });
    await expect(ctrl.uploadTrajectory(spec(2))).rejects.toThrow(/2\.2\.0/);
    expect(mockCalls).toHaveLength(0);
  });

  it("DELETEs a partial table and frees the id when a chunk is REJected", async () => {
    ctrl = await makeController();
    mockData.rejectAt = 12;
    await expect(ctrl.uploadTrajectory(spec(30))).rejects.toThrow(/past the end/);
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
    Object.assign(mockData, { inFlight: 0, maxInFlight: 0, rejectAt: -1, delayMs: 0 });
    setHostClock(() => process.hrtime.bigint());
  });

  /** A different shape of the same period (MirrorLink: a steer/slider move). */
  function reshaped(n: number, periodUs = 20_000): TrajectorySpec {
    const s = spec(n, periodUs);
    return {
      ...s,
      samples: s.samples.map((x) => ({ ...x, left: { x: x.left.x + 1, y: 2 } })),
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

  /** A handle on id 0, RUNNING since MCU 2 000 000 µs, wire log cleared. */
  async function running() {
    ctrl = await makeController();
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
    expect(calls[0]).toEqual({ op: "BEGIN", id: 1, sample_count: 25, period: 20_000, step: false });
    expect(calls.slice(1, 6).every((a) => a.id === 1)).toBe(true);
    expect(calls[1].samples[0].left).toEqual(channels(next.samples[0].left, BIAS, DV));
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
    expect(calls[7]).toEqual({ op: "START", id: 1, t_start: 2_000_000n, cycles: 0 });
    expect(calls[8]).toEqual({ op: "DELETE", id: 0 });
    expect(handle.id).toBe(1);
    // A later replace carries the same anchor again and swaps back to id 0.
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
    expect(wireOps().at(-1)).toEqual({ op: "START", id: 0, t_start: 0n, cycles: 50 });
    now += 1_000_000_000n; // a second later: the anchor stays the START instant
    mockCalls.length = 0;
    await handle.replace(reshaped(4));
    const start = wireOps().find((a) => a.op === "START");
    expect(start).toEqual({ op: "START", id: 1, t_start: 3_000_000n, cycles: 50 });
  });

  it("keeps the listener set: new-id pushes reach it, the old id is unrouted", async () => {
    const handle = await running();
    const got: TrajectoryFrameOutcome[] = [];
    handle.onFrame((f) => got.push(f));
    push(0);
    await handle.replace(reshaped(4));
    push(1);
    push(0); // a straggler for the deleted table: nobody owns it
    expect(got.map((f) => f.trajectoryId)).toEqual([0, 1]);
    // The freed id is reusable — and its pushes do not leak into this handle.
    const other = await ctrl!.uploadTrajectory(spec(2));
    expect(other.id).toBe(0);
    push(0);
    expect(got).toHaveLength(2);
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
    await expect(handle.replace(reshaped(4, 40_000))).rejects.toThrow(/same period/);
    await expect(handle.replace({ periodUs: 10, samples: [] })).rejects.toThrow(/at least one/);
    expect(mockCalls).toHaveLength(0);
    expect(handle.id).toBe(0);
  });

  it("from a stopped handle: plain re-upload + DELETE(old), any period, no STOP/START", async () => {
    ctrl = await makeController();
    ctrl.setClockOffsetNs(OFFSET);
    const handle = await ctrl.uploadTrajectory(spec(4));
    await handle.start(T_START_NS);
    await handle.stop();
    mockCalls.length = 0;
    await handle.replace(reshaped(4, 40_000));
    expect(trajectoryOps()).toEqual(["BEGIN", "DATA", "MARK", "COMMIT", "DELETE"]);
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
    // Both ids are free again.
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
    expect(trajectoryOps()).toEqual(["BEGIN", "DATA", "MARK", "COMMIT", "DELETE"]);
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
    expect((await ctrl!.uploadTrajectory(spec(2))).id).toBe(0);
  });

  it("dispose during the upload: the new table never STARTs, both are DELETEd", async () => {
    const handle = await running();
    mockData.delayMs = 5;
    const first = handle.replace(reshaped(4));
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
});
