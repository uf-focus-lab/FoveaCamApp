// Controller node routing of the protocol v2.2.0 surfaces
// (docs/spec/controller.md#scheduled-inputs, #trajectory-ownership):
//   (1) openTrajectory requires a bound v2.2 controller; ONE open at a time.
//   (2) enable lifecycle — enable on open, disable on the last close iff the
//       node enabled it (trajectory + position inputs counted together).
//   (3) position pushes are HELD while a trajectory runs (nothing sent or
//       recorded) and re-asserted (forced UPDATE) when the run ends.
//   (4) FIN routing — OK pushes reach the FIN sinks (tagged) + mirror history;
//       non-OK pushes only the handle's onFrame (+ a rate-limited log).
//   (5) unbind → detached (onFrame stops), rebind reported, reupload manual.
//   (6) updateAt — CMD_SCHEDULE on v2.2 recorded at the SCHEDULED time;
//       superseded by an immediate update; v2.1 / no-stream fallback counted.
//   (7) graph wiring + stats snapshot (lateness from t_trigger vs phase).
//
// No serial hardware / addon: fake controllers + fake trajectory handles; the
// host clock is pinned through `setHostClock`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControllerNode,
  RateLimitedLog,
  expectedTriggerNs,
  resetControllerNodeForTest,
  trajectoryNodeId,
} from "@orchestrator/controller-node";
import { buildTopology, resetTopologyStateForTest } from "@orchestrator/graph-topology";
import { mirrorHistory } from "@orchestrator/mirror-history";
import { AnchorNode } from "@orchestrator/anchor-node";
import { setHostClock } from "@orchestrator/time-align";
import type {
  FrameOutcome,
  TrajectoryFrameOutcome,
  TrajectorySpec,
} from "@orchestrator/controller";

type Pos = { x: number; y: number };
type Pair = { left: Pos; right: Pos };
const P = (x: number, y: number): Pos => ({ x, y });
const PAIR = (l: Pos, r: Pos): Pair => ({ left: l, right: r });
const ORIGIN = PAIR(P(0, 0), P(0, 0));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Pinned host clock (ns) — advanced explicitly.
let nowNs = 1_000_000_000n;
const advance = (ns: bigint) => {
  nowNs += ns;
};

const SPEC: TrajectorySpec = {
  periodUs: 10_000,
  samples: [
    { tOffsetUs: 0, left: P(0, 0), right: P(0, 0) },
    { tOffsetUs: 5_000, left: P(1, 1), right: P(-1, -1) },
  ],
  markers: [
    { tOffsetUs: 2_000, pulseUs: 500 },
    { tOffsetUs: 7_000, pulseUs: 500 },
  ],
};

// --- fakes -------------------------------------------------------------------

function makeTrajectoryHandle(id = 0) {
  const listeners = new Set<(f: TrajectoryFrameOutcome) => void>();
  return {
    id,
    start: vi.fn(async (_at?: bigint, _cycles?: number) => {}),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    onFrame: vi.fn((cb: (f: TrajectoryFrameOutcome) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    push(f: Partial<TrajectoryFrameOutcome>) {
      const full: TrajectoryFrameOutcome = {
        trajectoryId: id,
        marker: 0,
        cycle: 0,
        status: "OK",
        frameId: 1,
        tTrigger: 0n,
        tExposure: 0n,
        left: P(0, 0),
        right: P(0, 0),
        ...f,
      };
      for (const cb of [...listeners]) cb(full);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function makeController(opts: { v22?: boolean; enabled?: boolean; port?: string } = {}) {
  const streams: Array<{
    id: number;
    update: ReturnType<typeof vi.fn>;
    scheduleAt: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const trajectories: Array<ReturnType<typeof makeTrajectoryHandle>> = [];
  const c = {
    port: opts.port ?? "/dev/v22",
    v2Capable: true,
    v22Capable: opts.v22 ?? true,
    connected: true,
    enabled: opts.enabled ?? false,
    enable: vi.fn(async () => {
      c.enabled = true;
    }),
    disable: vi.fn(async () => {
      c.enabled = false;
    }),
    predictVolts: vi.fn((p: Pair) => PAIR({ ...p.left }, { ...p.right })),
    applyStreamedPos: vi.fn(),
    createStream: vi.fn(async (_initial: Pair) => {
      const h = {
        id: streams.length,
        update: vi.fn((_p: Pair, _o?: { force?: boolean }) => true),
        scheduleAt: vi.fn(),
        close: vi.fn(async () => {}),
      };
      streams.push(h);
      return h;
    }),
    uploadTrajectory: vi.fn(async (_spec: TrajectorySpec) => {
      const h = makeTrajectoryHandle(trajectories.length);
      trajectories.push(h);
      return h;
    }),
    streams,
    trajectories,
  };
  return c;
}

let node: ControllerNode | null = null;

beforeEach(() => {
  nowNs = 1_000_000_000n;
  setHostClock(() => nowNs);
  mirrorHistory.clear();
});

afterEach(() => {
  node?.dispose();
  node = null;
  resetControllerNodeForTest();
  resetTopologyStateForTest();
  mirrorHistory.clear();
  setHostClock(() => process.hrtime.bigint());
  vi.restoreAllMocks();
});

/** A node with a bound controller and an input whose MCU stream exists. */
async function withStream(c = makeController()) {
  node = new ControllerNode();
  node.bindController(c as never);
  const input = node.openPosition("servo", { initial: ORIGIN });
  input.update(PAIR(P(1, 1), P(1, 1)));
  await tick(); // lazy CREATE lands
  expect(c.streams.length).toBe(1);
  return { c, input, n: node };
}

// --- (1) gating + exclusivity -------------------------------------------------

describe("openTrajectory — gating and exclusivity", () => {
  it("requires a bound controller", async () => {
    node = new ControllerNode();
    await expect(node.openTrajectory(SPEC, { name: "ml" })).rejects.toThrow(
      /bound controller/,
    );
  });

  it("requires firmware >= 2.2.0 (v2.1 rejected before anything is uploaded)", async () => {
    node = new ControllerNode();
    const c = makeController({ v22: false });
    node.bindController(c as never);
    await expect(node.openTrajectory(SPEC, { name: "ml" })).rejects.toThrow(/2\.2\.0/);
    expect(c.uploadTrajectory).not.toHaveBeenCalled();
    expect(c.enable).not.toHaveBeenCalled();
    expect(node.trajectorySnapshot()).toBeNull();
  });

  it("refuses a second open — also while the first is still uploading", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const first = node.openTrajectory(SPEC, { name: "a" });
    await expect(node.openTrajectory(SPEC, { name: "b" })).rejects.toThrow(
      /already open.*close it first/,
    );
    const t = await first;
    await expect(node.openTrajectory(SPEC, { name: "b" })).rejects.toThrow(/already open/);
    expect(c.uploadTrajectory).toHaveBeenCalledTimes(1);
    await t.close();
    // The slot frees on close.
    const again = await node.openTrajectory(SPEC, { name: "b" });
    expect(again.state).toBe("ready");
    await again.close();
  });

  it("a failed upload frees the slot (and disables iff the node enabled)", async () => {
    node = new ControllerNode();
    const c = makeController();
    c.uploadTrajectory.mockRejectedValueOnce(new Error("Trajectory pool full"));
    node.bindController(c as never);
    await expect(node.openTrajectory(SPEC, { name: "ml" })).rejects.toThrow(/pool full/);
    expect(c.enable).toHaveBeenCalledTimes(1);
    expect(c.disable).toHaveBeenCalledTimes(1);
    expect(node.trajectorySnapshot()).toBeNull();
  });
});

// --- (2) enable lifecycle -----------------------------------------------------

describe("openTrajectory — enable lifecycle", () => {
  it("enables on open and disables on close when the node enabled it", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    expect(c.enable).toHaveBeenCalledTimes(1);
    expect(t.state).toBe("ready");
    expect(t.id).toBe(0);
    await t.close();
    expect(c.disable).toHaveBeenCalledTimes(1);
    expect(t.state).toBe("closed");
  });

  it("never disables a controller the user enabled", async () => {
    node = new ControllerNode();
    const c = makeController({ enabled: true });
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    expect(c.enable).not.toHaveBeenCalled();
    await t.close();
    expect(c.disable).not.toHaveBeenCalled();
  });

  it("counts with the position inputs: disable only when the last of them closes", async () => {
    const { c, input, n } = await withStream();
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    await t.close();
    expect(c.disable).not.toHaveBeenCalled(); // the input is still open
    const t2 = await n.openTrajectory(SPEC, { name: "ml" });
    await input.close();
    expect(c.disable).not.toHaveBeenCalled(); // the trajectory is still open
    await t2.close();
    expect(c.disable).toHaveBeenCalledTimes(1);
  });

  it("close() stops a running trajectory and DELETEs the table", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    await t.close();
    const h = c.trajectories[0]!;
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.listenerCount).toBe(0);
  });

  it("close() is best-effort on a REJecting / gone device", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const h = c.trajectories[0]!;
    h.stop.mockRejectedValueOnce(new Error("gone"));
    h.dispose.mockRejectedValueOnce(new Error("gone"));
    await expect(t.close()).resolves.toBeUndefined();
    expect(node.trajectorySnapshot()).toBeNull();
  });
});

// --- (3) input holding --------------------------------------------------------

describe("position inputs while a trajectory runs", () => {
  it("holds pushes (nothing sent or recorded) and re-asserts the latest on stop", async () => {
    const { c, input, n } = await withStream();
    const stream = c.streams[0]!;
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    await t.start(undefined, 0);
    expect(c.trajectories[0]!.start).toHaveBeenCalledWith(undefined, 0);
    expect(t.state).toBe("running");

    const record = vi.spyOn(mirrorHistory, "record");
    stream.update.mockClear();
    const out = input.update(PAIR(P(5, 5), P(6, 6)));
    input.updateAt(nowNs + 1_000_000n, PAIR(P(7, 7), P(8, 8)));
    expect(out).toEqual(PAIR(P(1, 1), P(1, 1))); // last predicted — mirror not ours
    expect(stream.update).not.toHaveBeenCalled();
    expect(stream.scheduleAt).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(input.scheduleFallbacks).toBe(0); // a hold is not a fallback
    expect(n.trajectorySnapshot()!.heldPushes).toBe(2);

    advance(1_000n);
    await t.stop();
    expect(t.state).toBe("ready");
    // The latest held pose, FORCED past the gate (the firmware HOLDs the
    // trajectory's last position until the next stream write).
    expect(stream.update).toHaveBeenCalledTimes(1);
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(7, 7), P(8, 8)), { force: true });
    expect(record).toHaveBeenCalledWith(nowNs, P(7, 7), P(8, 8));

    // Normal streaming afterwards.
    input.update(PAIR(P(9, 9), P(9, 9)));
    expect(stream.update).toHaveBeenLastCalledWith(PAIR(P(9, 9), P(9, 9)));
    await t.close();
    await input.close();
  });

  it("re-takes the DAC even with no push during the run (pre-run target)", async () => {
    const { c, n } = await withStream();
    const stream = c.streams[0]!;
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    stream.update.mockClear();
    await t.stop();
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(1, 1), P(1, 1)), { force: true });
    await t.close();
  });

  it("an ENDED run-level push ends the run and resumes the inputs", async () => {
    const { c, input, n } = await withStream();
    const stream = c.streams[0]!;
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    await t.start(undefined, 3);
    input.update(PAIR(P(2, 2), P(2, 2))); // held
    stream.update.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    c.trajectories[0]!.push({ marker: null, cycle: 3, status: "ENDED" });
    expect(t.state).toBe("ready");
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(2, 2), P(2, 2)), { force: true });
    expect(warn).toHaveBeenCalledTimes(1);
    await t.close();
  });

  it("a failed START un-holds the inputs", async () => {
    const { c, input, n } = await withStream();
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    c.trajectories[0]!.start.mockRejectedValueOnce(new Error("system is not enabled"));
    await expect(t.start()).rejects.toThrow(/not enabled/);
    expect(t.state).toBe("ready");
    c.streams[0]!.update.mockClear();
    input.update(PAIR(P(3, 3), P(3, 3)));
    expect(c.streams[0]!.update).toHaveBeenCalledWith(PAIR(P(3, 3), P(3, 3)));
    await t.close();
  });

  it("start() refuses while already running", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    await expect(t.start()).rejects.toThrow(/already running/);
    await t.close();
  });
});

// --- (4) FIN routing ----------------------------------------------------------

describe("trajectory FIN routing", () => {
  it("OK pushes reach the FIN sinks (tagged) and mirror history; non-OK only onFrame", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const fins: FrameOutcome[] = [];
    node.onFin((o) => fins.push(o));
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    const frames: TrajectoryFrameOutcome[] = [];
    t.onFrame((f) => frames.push(f));
    await t.start();
    const h = c.trajectories[0]!;

    h.push({
      marker: 1,
      cycle: 4,
      status: "OK",
      frameId: 42,
      tTrigger: 5_000_000n,
      tExposure: 5_250_000n,
      left: P(0.5, -0.5),
      right: P(0.25, 0.75),
    });
    expect(fins).toEqual([
      {
        frameId: 42,
        stream: 0,
        tTrigger: 5_000_000n,
        tExposure: 5_250_000n,
        left: P(0.5, -0.5),
        right: P(0.25, 0.75),
        trajectory: { id: 0, marker: 1, cycle: 4 },
      },
    ]);
    // History: the exposure-averaged position at the exposure host time.
    expect(mirrorHistory.mirrorAt(5_250_000n)).toMatchObject({
      left: P(0.5, -0.5),
      right: P(0.25, 0.75),
      interpolated: true,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = vi.spyOn(mirrorHistory, "record");
    for (const status of ["STROBE_TIMEOUT", "BUSY", "CANCELLED"] as const)
      h.push({ marker: 0, cycle: 5, status, tTrigger: 6_000_000n });
    h.push({ marker: 0, cycle: 6, status: "STROBE_TIMEOUT" }); // rate-limited
    expect(fins).toHaveLength(1); // none of the failures reached the sinks
    expect(record).not.toHaveBeenCalled();
    expect(frames.map((f) => f.status)).toEqual([
      "OK",
      "STROBE_TIMEOUT",
      "BUSY",
      "CANCELLED",
      "STROBE_TIMEOUT",
    ]);
    expect(warn).toHaveBeenCalledTimes(3); // one per status within the window
    expect(t.state).toBe("running"); // a marker-level CANCELLED does not end the run
    expect(node.trajectorySnapshot()!.statusCounts).toEqual({
      OK: 1,
      STROBE_TIMEOUT: 2,
      BUSY: 1,
      CANCELLED: 1,
    });
    await t.close();
  });

  it("the anchor node ingests a forwarded push unchanged (pairing path)", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const anchors = new AnchorNode();
    const pushAnchor = vi.fn(() => 1);
    anchors.register({ pushAnchor });
    node.onFin((o) => anchors.ingest(o));
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    c.trajectories[0]!.push({ tExposure: 7_000_000n, left: P(1, 2), right: P(3, 4) });
    expect(pushAnchor).toHaveBeenCalledWith({
      tExposure: 7_000_000n,
      stream: 0,
      payload: new Float64Array([1, 2, 3, 4]),
    });
    anchors.dispose();
    await t.close();
  });

  it("stats: cycles seen + lateness vs the expected phase", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    const startNs = 2_000_000_000n;
    await t.start(startNs);
    expect(c.trajectories[0]!.start).toHaveBeenCalledWith(startNs, 0);
    // cycle 3, marker 1 (7 000 µs): expected = start + 3·10 ms + 7 ms; 12 µs late.
    const expected = expectedTriggerNs(startNs, 3, 10_000, 7_000);
    expect(expected).toBe(startNs + 37_000_000n);
    c.trajectories[0]!.push({
      marker: 1,
      cycle: 3,
      tTrigger: expected + 12_000n,
      tExposure: expected + 100_000n,
    });
    expect(node.trajectorySnapshot()).toMatchObject({
      name: "ml",
      id: 0,
      state: "running",
      running: true,
      periodUs: 10_000,
      markers: 2,
      cyclesSeen: 4,
      lastMarker: 1,
      lastCycle: 3,
      lastLatenessUs: 12,
      latenessExact: true,
    });
    await t.close();
  });
});

// --- (5) unbind / rebind --------------------------------------------------------

describe("trajectory across controller unbind / rebind", () => {
  it("unbind → detached, onFrame stops, rebind reported, reupload is manual", async () => {
    node = new ControllerNode();
    const c1 = makeController();
    node.bindController(c1 as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    const states: Array<[string, boolean]> = [];
    t.onStateChange((s, d) => states.push([s, d.controllerAvailable]));
    const frames: TrajectoryFrameOutcome[] = [];
    t.onFrame((f) => frames.push(f));
    await t.start();
    const h1 = c1.trajectories[0]!;

    await node.unbindController();
    expect(t.state).toBe("detached");
    expect(t.id).toBeNull();
    expect(h1.listenerCount).toBe(0);
    h1.push({ status: "OK" }); // a straggler from the old device
    expect(frames).toHaveLength(0);
    await expect(t.start()).rejects.toThrow(/detached/);

    const c2 = makeController({ port: "/dev/v22b" });
    node.bindController(c2 as never);
    expect(c2.uploadTrajectory).not.toHaveBeenCalled(); // never automatic
    expect(states).toEqual([
      ["running", false],
      ["detached", false],
      ["detached", true],
    ]);

    await t.reupload();
    expect(c2.uploadTrajectory).toHaveBeenCalledWith(SPEC);
    expect(t.state).toBe("ready");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    c2.trajectories[0]!.push({ status: "BUSY" });
    expect(frames.map((f) => f.status)).toEqual(["BUSY"]);
    await t.close();
    expect(c2.trajectories[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h1.dispose).not.toHaveBeenCalled(); // the old table went with the old device
  });

  it("a controller SWAP without unbind detaches too; inputs are no longer held", async () => {
    const { input, n } = await withStream();
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const c2 = makeController({ port: "/dev/other" });
    n.bindController(c2 as never);
    expect(t.state).toBe("detached");
    input.update(PAIR(P(4, 4), P(4, 4)));
    await tick();
    expect(c2.createStream).toHaveBeenCalledTimes(1); // streaming on the new device
    await t.close();
    await input.close();
  });

  it("closing a detached trajectory frees the slot without wire traffic", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await node.unbindController();
    await t.close();
    expect(c.trajectories[0]!.dispose).not.toHaveBeenCalled();
    expect(node.trajectorySnapshot()).toBeNull();
  });
});

// --- (6) updateAt -----------------------------------------------------------------

describe("position input updateAt (CMD_SCHEDULE)", () => {
  it("schedules on v2.2 and records at the SCHEDULED host time", async () => {
    const { c, input } = await withStream();
    const stream = c.streams[0]!;
    const at = nowNs + 5_000_000n;
    const out = input.updateAt(at, PAIR(P(2, 3), P(4, 5)), { interpolate: true });
    expect(out).toEqual(PAIR(P(2, 3), P(4, 5)));
    expect(stream.scheduleAt).toHaveBeenCalledWith(at, PAIR(P(2, 3), P(4, 5)), {
      interpolate: true,
    });
    expect(input.scheduleFallbacks).toBe(0);
    // Interpolated keyframe: the ramp starts at the arrival instant from the
    // last position and lands on the target AT `at`.
    expect(mirrorHistory.mirrorAt(at)).toMatchObject({ left: P(2, 3), right: P(4, 5) });
    expect(mirrorHistory.mirrorAt(nowNs)).toMatchObject({ left: P(1, 1) });
    const mid = mirrorHistory.mirrorAt(nowNs + 2_500_000n)!;
    expect(mid.left.x).toBeCloseTo(1.5);
    await input.close();
  });

  it("a STEP keyframe holds the previous position until its instant", async () => {
    const { input } = await withStream();
    const at = nowNs + 4_000_000n;
    input.updateAt(at, PAIR(P(3, 3), P(3, 3)));
    expect(mirrorHistory.mirrorAt(at - 1n)).toMatchObject({ left: P(1, 1) });
    expect(mirrorHistory.mirrorAt(at)).toMatchObject({ left: P(3, 3) });
    await input.close();
  });

  it("a late keyframe records at send time (it applies on arrival)", async () => {
    const { input } = await withStream();
    advance(10_000_000n);
    const record = vi.spyOn(mirrorHistory, "record");
    input.updateAt(nowNs - 5_000_000n, PAIR(P(6, 6), P(6, 6)));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(nowNs, P(6, 6), P(6, 6));
    await input.close();
  });

  it("an out-of-order keyframe is sent but not recorded (history stays monotonic)", async () => {
    const { c, input } = await withStream();
    input.updateAt(nowNs + 8_000_000n, PAIR(P(2, 2), P(2, 2)), { interpolate: true });
    const record = vi.spyOn(mirrorHistory, "record");
    input.updateAt(nowNs + 4_000_000n, PAIR(P(3, 3), P(3, 3)), { interpolate: true });
    expect(c.streams[0]!.scheduleAt).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
    expect(node!.statsSnapshot().inputs[0]).toMatchObject({
      scheduled: 2,
      historyOutOfOrder: 1,
    });
    await input.close();
  });

  it("an immediate update() supersedes pending keyframes in mirror history", async () => {
    const { c, input } = await withStream();
    const at = nowNs + 6_000_000n;
    input.updateAt(at, PAIR(P(2, 2), P(2, 2)), { interpolate: true });
    advance(1_000_000n);
    input.update(PAIR(P(9, 9), P(9, 9)));
    expect(c.streams[0]!.update).toHaveBeenLastCalledWith(PAIR(P(9, 9), P(9, 9)));
    // The firmware cleared the schedule: the keyframe at `at` never happens.
    expect(mirrorHistory.newest()).toMatchObject({ hostNs: nowNs, left: P(9, 9) });
    expect(mirrorHistory.mirrorAt(at)).toMatchObject({ left: P(9, 9) });
  });

  it("a GATED update() leaves the schedule (and its history) standing", async () => {
    const { c, input } = await withStream();
    const at = nowNs + 6_000_000n;
    input.updateAt(at, PAIR(P(2, 2), P(2, 2)), { interpolate: true });
    c.streams[0]!.update.mockReturnValueOnce(false); // deduped / paced: not sent
    input.update(PAIR(P(1, 1), P(1, 1)));
    expect(mirrorHistory.newest()).toMatchObject({ hostNs: at, left: P(2, 2) });
  });

  it("update() after every keyframe came due is the unchanged legacy path", async () => {
    const { input } = await withStream();
    input.updateAt(nowNs + 1_000_000n, PAIR(P(2, 2), P(2, 2)), { interpolate: true });
    advance(2_000_000n);
    const truncate = vi.spyOn(mirrorHistory, "truncateAfter");
    const record = vi.spyOn(mirrorHistory, "record");
    input.update(PAIR(P(3, 3), P(3, 3)));
    expect(truncate).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(nowNs, P(3, 3), P(3, 3));
  });

  it("falls back to an immediate update on v2.1 firmware and counts it", async () => {
    const c = makeController({ v22: false });
    const { input } = await withStream(c);
    const stream = c.streams[0]!;
    const record = vi.spyOn(mirrorHistory, "record");
    input.updateAt(nowNs + 5_000_000n, PAIR(P(2, 2), P(2, 2)));
    expect(stream.scheduleAt).not.toHaveBeenCalled();
    expect(stream.update).toHaveBeenLastCalledWith(PAIR(P(2, 2), P(2, 2)));
    expect(record).toHaveBeenCalledWith(nowNs, P(2, 2), P(2, 2)); // send time
    expect(input.scheduleFallbacks).toBe(1);
    await input.close();
  });

  it("falls back before the MCU stream exists (the first push creates it)", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const input = node.openPosition("servo", { initial: ORIGIN });
    input.updateAt(nowNs + 5_000_000n, PAIR(P(2, 2), P(2, 2)));
    await tick();
    expect(c.createStream).toHaveBeenCalledWith(PAIR(P(2, 2), P(2, 2)));
    expect(input.scheduleFallbacks).toBe(1);
    input.updateAt(nowNs + 6_000_000n, PAIR(P(3, 3), P(3, 3)));
    expect(c.streams[0]!.scheduleAt).toHaveBeenCalledTimes(1);
    await input.close();
  });

  it("a back-pressure drop is counted and not recorded", async () => {
    const { c, input } = await withStream();
    c.streams[0]!.scheduleAt.mockImplementationOnce(() => {
      throw new Error("queue full");
    });
    const record = vi.spyOn(mirrorHistory, "record");
    input.updateAt(nowNs + 5_000_000n, PAIR(P(2, 2), P(2, 2)));
    expect(record).not.toHaveBeenCalled();
    expect(node!.statsSnapshot().inputs[0]!.scheduleDrops).toBe(1);
  });
});

// --- (7) graph + helpers --------------------------------------------------------

describe("trajectory graph wiring", () => {
  it("shows the trajectory as a named controller input while open", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "mirrorlink" });
    let topo = buildTopology({ listPipes: () => [], workloads: () => ({}), now: () => 0 });
    expect(topo.nodes.find((x) => x.id === trajectoryNodeId())).toMatchObject({
      kind: "trajectory",
      transport: "native",
    });
    expect(topo.edges).toContainEqual(
      expect.objectContaining({
        from: trajectoryNodeId(),
        to: "controller",
        port: "mirrorlink",
      }),
    );
    await t.close();
    topo = buildTopology({ listPipes: () => [], workloads: () => ({}), now: () => 0 });
    expect(topo.nodes.find((x) => x.id === trajectoryNodeId())).toBeUndefined();
    expect(topo.edges.find((e) => e.port === "mirrorlink")).toBeUndefined();
  });
});

describe("RateLimitedLog", () => {
  it("logs once per key per window and reports the suppressed count", () => {
    let t = 0;
    const lines: string[] = [];
    const log = new RateLimitedLog(1000, (m) => lines.push(m), () => t);
    log.note("A", "a1");
    log.note("A", "a2");
    log.note("B", "b1");
    t = 999;
    log.note("A", "a3");
    t = 1000;
    log.note("A", "a4");
    expect(lines).toEqual(["a1", "b1", "a4 (+2 suppressed)"]);
  });
});
