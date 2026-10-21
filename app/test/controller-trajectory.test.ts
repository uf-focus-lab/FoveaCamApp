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
  chunkTrajectorySamples,
  hostNsToMcuUs,
  mcuUsToHostNs,
  validateTrajectorySpec,
  type TrajectoryFrameOutcome,
  type TrajectorySpec,
} from "@orchestrator/controller";

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
