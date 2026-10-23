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
//   (8) replace — running stays running (inputs held), spec + stats carry,
//       concurrent calls coalesce (latest wins), stop/close wait for it and
//       refuse replaces issued after them.
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
import {
  buildTopology,
  resetTopologyStateForTest,
} from "@orchestrator/graph-topology";
import { mirrorHistory } from "@orchestrator/mirror-history";
import { AnchorNode } from "@orchestrator/anchor-node";
import { setHostClock } from "@orchestrator/time-align";
import type {
  FrameOutcome,
  TrajectoryFrameOutcome,
  TrajectoryReplaceOptions,
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

interface FakeSwapState {
  swapKind: "atomic" | "stop-start";
  lastSwap: unknown;
  callsOnSwap: boolean;
  graceUs: number;
  gate: Promise<void> | null;
}

function makeTrajectoryHandle(id = 0) {
  const listeners = new Set<(f: TrajectoryFrameOutcome) => void>();
  // The CURRENT table id — a successful replace() swaps it (+1 here).
  let current = id;
  return {
    get id() {
      return current;
    },
    /** What the next successful replace() reports as its swap kind. */
    swapKind: "atomic" as "atomic" | "stop-start",
    lastSwap: null as "atomic" | "stop-start" | null,
    /** Like the controller: report the swap through `opts.onSwap` (with
     *  `graceUs` for the retired id) at the swap; false = an older handle
     *  without the hook (the node then sees the swap only on resolve). */
    callsOnSwap: true,
    graceUs: 55_000,
    /** When set, a replace() swaps first and then waits on it before
     *  resolving (the controller's DELETE(old) still out). */
    gate: null as Promise<void> | null,
    replace: vi.fn(async function (
      this: FakeSwapState,
      _spec: TrajectorySpec,
      opts?: TrajectoryReplaceOptions,
    ) {
      const from = current;
      current += 1;
      this.lastSwap = this.swapKind;
      if (this.callsOnSwap)
        opts?.onSwap?.({
          to: current,
          retired: [{ id: from, graceUs: this.graceUs }],
        });
      if (this.gate) await this.gate;
    }),
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
        trajectoryId: current,
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

function makeController(
  opts: { v22?: boolean; enabled?: boolean; port?: string } = {},
) {
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
    clockOffsetNs: 0n,
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
    await expect(node.openTrajectory(SPEC, { name: "ml" })).rejects.toThrow(
      /2\.2\.0/,
    );
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
    await expect(node.openTrajectory(SPEC, { name: "b" })).rejects.toThrow(
      /already open/,
    );
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
    await expect(node.openTrajectory(SPEC, { name: "ml" })).rejects.toThrow(
      /pool full/,
    );
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
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(7, 7), P(8, 8)), {
      force: true,
    });
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
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(1, 1), P(1, 1)), {
      force: true,
    });
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
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(2, 2), P(2, 2)), {
      force: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    await t.close();
  });

  it("a failed START un-holds the inputs", async () => {
    const { c, input, n } = await withStream();
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    c.trajectories[0]!.start.mockRejectedValueOnce(
      new Error("system is not enabled"),
    );
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
    c.trajectories[0]!.push({
      tExposure: 7_000_000n,
      left: P(1, 2),
      right: P(3, 4),
    });
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
    const out = input.updateAt(at, PAIR(P(2, 3), P(4, 5)), {
      interpolate: true,
    });
    expect(out).toEqual(PAIR(P(2, 3), P(4, 5)));
    expect(stream.scheduleAt).toHaveBeenCalledWith(at, PAIR(P(2, 3), P(4, 5)), {
      interpolate: true,
    });
    expect(input.scheduleFallbacks).toBe(0);
    // Interpolated keyframe: the ramp starts at the arrival instant from the
    // last position and lands on the target AT `at`.
    expect(mirrorHistory.mirrorAt(at)).toMatchObject({
      left: P(2, 3),
      right: P(4, 5),
    });
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
    input.updateAt(nowNs + 8_000_000n, PAIR(P(2, 2), P(2, 2)), {
      interpolate: true,
    });
    const record = vi.spyOn(mirrorHistory, "record");
    input.updateAt(nowNs + 4_000_000n, PAIR(P(3, 3), P(3, 3)), {
      interpolate: true,
    });
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
    expect(c.streams[0]!.update).toHaveBeenLastCalledWith(
      PAIR(P(9, 9), P(9, 9)),
    );
    // The firmware cleared the schedule: the keyframe at `at` never happens.
    expect(mirrorHistory.newest()).toMatchObject({
      hostNs: nowNs,
      left: P(9, 9),
    });
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
    input.updateAt(nowNs + 1_000_000n, PAIR(P(2, 2), P(2, 2)), {
      interpolate: true,
    });
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
    let topo = buildTopology({
      listPipes: () => [],
      workloads: () => ({}),
      now: () => 0,
    });
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
    topo = buildTopology({
      listPipes: () => [],
      workloads: () => ({}),
      now: () => 0,
    });
    expect(topo.nodes.find((x) => x.id === trajectoryNodeId())).toBeUndefined();
    expect(topo.edges.find((e) => e.port === "mirrorlink")).toBeUndefined();
  });
});

describe("RateLimitedLog", () => {
  it("logs once per key per window and reports the suppressed count", () => {
    let t = 0;
    const lines: string[] = [];
    const log = new RateLimitedLog(
      1000,
      (m) => lines.push(m),
      () => t,
    );
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

// --- (8) replace ------------------------------------------------------------------

describe("NodeTrajectory.replace", () => {
  /** Same period, different shape + marker layout (a steer / slider move). */
  const RESHAPED: TrajectorySpec = {
    periodUs: 10_000,
    samples: [
      { tOffsetUs: 0, left: P(2, 2), right: P(-2, -2) },
      { tOffsetUs: 5_000, left: P(3, 3), right: P(-3, -3) },
    ],
    markers: [{ tOffsetUs: 4_000, pulseUs: 800 }],
  };
  const withPeriod = (periodUs: number, base = RESHAPED): TrajectorySpec => ({
    ...base,
    periodUs,
  });

  /** A deferred the fake handle's replace() waits on. */
  function gate() {
    let release!: () => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      release = res;
      fail = rej;
    });
    return { promise, release, fail };
  }

  it("while running: swaps through the handle, stays running, inputs stay held", async () => {
    const { c, input, n } = await withStream();
    const stream = c.streams[0]!;
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    const frames: TrajectoryFrameOutcome[] = [];
    t.onFrame((f) => frames.push(f));
    const startNs = 2_000_000_000n;
    await t.start(startNs);
    const h = c.trajectories[0]!;
    input.update(PAIR(P(5, 5), P(5, 5))); // held
    stream.update.mockClear();

    await t.replace(RESHAPED);
    expect(h.replace).toHaveBeenCalledWith(RESHAPED, {
      onSwap: expect.any(Function),
    });
    expect(h.start).toHaveBeenCalledTimes(1); // the handle re-STARTs, not the node
    expect(h.stop).not.toHaveBeenCalled();
    expect(t.state).toBe("running");
    expect(states).toEqual(["running"]); // no ready/running flap
    expect(t.id).toBe(1); // the swapped table
    // No resume: nothing re-took the DAC, and pushes keep being held.
    expect(stream.update).not.toHaveBeenCalled();
    input.update(PAIR(P(6, 6), P(6, 6)));
    expect(stream.update).not.toHaveBeenCalled();
    expect(n.trajectorySnapshot()).toMatchObject({
      id: 1,
      state: "running",
      running: true,
      markers: 1,
      heldPushes: 2,
      reuploads: 1,
    });

    // Pushes from the new table keep flowing on the same handle, scored
    // against the NEW spec's marker (4 000 µs) on the ORIGINAL t_start.
    const expected = expectedTriggerNs(startNs, 7, 10_000, 4_000);
    h.push({ marker: 0, cycle: 7, tTrigger: expected + 30_000n });
    expect(frames.map((f) => f.trajectoryId)).toEqual([1]);
    expect(n.trajectorySnapshot()).toMatchObject({
      lastLatenessUs: 30,
      cyclesSeen: 8,
    });

    // stop() hands the DAC back with the latest held pose.
    await t.stop();
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(6, 6), P(6, 6)), {
      force: true,
    });
    await t.close();
    await input.close();
  });

  it("from ready: a plain re-upload — any period, stays ready, reupload() sends the new spec", async () => {
    node = new ControllerNode();
    const c1 = makeController();
    node.bindController(c1 as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    const spec = withPeriod(20_000);
    await t.replace(spec);
    expect(t.state).toBe("ready");
    expect(node.trajectorySnapshot()).toMatchObject({
      periodUs: 20_000,
      reuploads: 1,
    });

    // Lateness uses the new period after a start.
    const startNs = 3_000_000_000n;
    await t.start(startNs);
    c1.trajectories[0]!.push({
      marker: 0,
      cycle: 2,
      tTrigger: expectedTriggerNs(startNs, 2, 20_000, 4_000) + 5_000n,
    });
    expect(node.trajectorySnapshot()!.lastLatenessUs).toBe(5);

    // A detach + reupload carries the replaced spec, not the opening one.
    await node.unbindController();
    const c2 = makeController({ port: "/dev/v22b" });
    node.bindController(c2 as never);
    await t.reupload();
    expect(c2.uploadTrajectory).toHaveBeenCalledWith(spec);
    await t.close();
  });

  it("coalesces: while one swap is in flight, the LATEST spec wins and is sent once", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const h = c.trajectories[0]!;
    const g = gate();
    h.replace.mockImplementationOnce(async () => g.promise);
    const A = { ...RESHAPED, markers: [{ tOffsetUs: 1_000, pulseUs: 100 }] };
    const B = { ...RESHAPED, markers: [{ tOffsetUs: 2_000, pulseUs: 100 }] };
    const C = { ...RESHAPED, markers: [{ tOffsetUs: 3_000, pulseUs: 100 }] };
    const order: string[] = [];
    const pa = t.replace(A).then(() => order.push("A"));
    const pb = t.replace(B).then(() => order.push("B"));
    const pc = t.replace(C).then(() => order.push("C"));
    await tick();
    expect(h.replace).toHaveBeenCalledTimes(1);
    g.release();
    await Promise.all([pa, pb, pc]);
    // A, then C (B was superseded before it was ever sent).
    expect(h.replace.mock.calls.map(([s]) => s)).toEqual([A, C]);
    expect(order).toEqual(["A", "B", "C"]);
    expect(node.trajectorySnapshot()).toMatchObject({
      reuploads: 2,
      state: "running",
    });
    await t.close();
  });

  it("a coalesced batch that fails rejects every caller in it; the in-flight one is unaffected", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const h = c.trajectories[0]!;
    const g = gate();
    h.replace.mockImplementationOnce(async () => g.promise);
    h.replace.mockRejectedValueOnce(new Error("Trajectory pool full"));
    const settled = Promise.allSettled([
      t.replace(RESHAPED),
      t.replace(RESHAPED),
      t.replace(RESHAPED),
    ]);
    g.release();
    const [ra, rb, rc] = await settled;
    expect(ra.status).toBe("fulfilled");
    expect(rb).toMatchObject({
      status: "rejected",
      reason: { message: "Trajectory pool full" },
    });
    expect(rc).toMatchObject({
      status: "rejected",
      reason: { message: "Trajectory pool full" },
    });
    expect(t.state).toBe("running"); // the old table kept running
    expect(node.trajectorySnapshot()!.reuploads).toBe(1);
    await t.close();
  });

  it("stop() during a replace waits for it (and the pending batch) before STOP", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const h = c.trajectories[0]!;
    const g = gate();
    const log: string[] = [];
    h.replace.mockImplementation(async (s: TrajectorySpec) => {
      log.push(`replace:${s.markers?.length}`);
      if (log.length === 1) await g.promise;
    });
    h.stop.mockImplementation(async () => {
      log.push("stop");
    });
    const p1 = t.replace(RESHAPED);
    const p2 = t.replace(SPEC); // coalesced
    const stopped = t.stop();
    await tick();
    expect(log).toEqual(["replace:1"]);
    g.release();
    await Promise.all([p1, p2, stopped]);
    expect(log).toEqual(["replace:1", "replace:2", "stop"]);
    expect(t.state).toBe("ready");
    await t.close();
  });

  it("close() during a replace drops the pending batch and waits for the in-flight one", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const h = c.trajectories[0]!;
    const g = gate();
    h.replace.mockImplementationOnce(async () => g.promise);
    const p1 = t.replace(RESHAPED);
    const p2 = t.replace(SPEC).catch((e: unknown) => e);
    const closed = t.close();
    await tick();
    expect(h.dispose).not.toHaveBeenCalled();
    g.release();
    await expect(p1).resolves.toBeUndefined();
    expect(await p2).toMatchObject({
      message: expect.stringMatching(/closed before the replace was sent/),
    });
    await closed;
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(t.state).toBe("closed");
  });

  it("close() refuses a replace issued while it waits; STOP/DELETE proceed after the one in-flight swap", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const h = c.trajectories[0]!;
    const g = gate();
    h.replace.mockImplementationOnce(async () => g.promise);
    const p1 = t.replace(RESHAPED);
    const closed = t.close();
    await expect(t.replace(SPEC)).rejects.toThrow(/closing — replace refused/);
    await tick();
    expect(h.dispose).not.toHaveBeenCalled();
    g.release();
    await expect(p1).resolves.toBeUndefined();
    await closed;
    expect(h.replace).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(t.state).toBe("closed");
    await expect(t.replace(SPEC)).rejects.toThrow(/is closed/);
  });

  it("stop() is not starved: replaces issued after it are refused; it STOPs after the in-flight swap", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    const h = c.trajectories[0]!;
    const g = gate();
    const log: string[] = [];
    h.replace.mockImplementation(async () => {
      log.push("replace");
      if (log.length === 1) await g.promise;
    });
    h.stop.mockImplementation(async () => {
      log.push("stop");
    });
    const p1 = t.replace(RESHAPED);
    const stopped = t.stop();
    const late = [t.replace(SPEC), t.replace(RESHAPED)].map((p) =>
      p.catch((e: unknown) => e),
    );
    for (const r of await Promise.all(late))
      expect(r).toMatchObject({
        message: expect.stringMatching(/stopping — replace refused/),
      });
    await tick();
    expect(log).toEqual(["replace"]);
    g.release();
    await Promise.all([p1, stopped]);
    expect(log).toEqual(["replace", "stop"]);
    expect(t.state).toBe("ready");
    // Once stop() resolved, a replace is a plain re-upload from ready.
    await t.replace(SPEC);
    expect(h.replace).toHaveBeenCalledTimes(2);
    expect(t.state).toBe("ready");
    await t.close();
  });

  it("throws when detached / closed / uploading, and on a period change while running", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });

    // period change while running → refused before the handle sees it
    await t.start();
    await expect(t.replace(withPeriod(20_000))).rejects.toThrow(/same period/);
    expect(c.trajectories[0]!.replace).not.toHaveBeenCalled();
    await t.stop();

    // detached
    await node.unbindController();
    await expect(t.replace(RESHAPED)).rejects.toThrow(/detached/);

    // uploading (a reupload in flight)
    const c2 = makeController({ port: "/dev/v22b" });
    let release2!: () => void;
    c2.uploadTrajectory.mockImplementationOnce(async (_s: TrajectorySpec) => {
      await new Promise<void>((r) => (release2 = r));
      const h = makeTrajectoryHandle(0);
      c2.trajectories.push(h);
      return h;
    });
    node.bindController(c2 as never);
    const re = t.reupload();
    await tick();
    expect(t.state).toBe("uploading");
    await expect(t.replace(RESHAPED)).rejects.toThrow(/still uploading/);
    release2();
    await re;

    // closed
    await t.close();
    await expect(t.replace(RESHAPED)).rejects.toThrow(/closed/);
    expect(node.trajectorySnapshot()).toBeNull();
  });

  it("a swap that lost the run (TrajectoryReplaceError running:false) ends it and resumes inputs", async () => {
    const { c, input, n } = await withStream();
    const stream = c.streams[0]!;
    const t = await n.openTrajectory(SPEC, { name: "ml" });
    await t.start();
    input.update(PAIR(P(4, 4), P(4, 4))); // held
    stream.update.mockClear();
    const h = c.trajectories[0]!;
    h.replace.mockRejectedValueOnce(
      Object.assign(new Error("START of the replacement table failed"), {
        running: false,
      }),
    );
    await expect(t.replace(RESHAPED)).rejects.toThrow(
      /replacement table failed/,
    );
    expect(t.state).toBe("ready");
    expect(stream.update).toHaveBeenCalledWith(PAIR(P(4, 4), P(4, 4)), {
      force: true,
    });
    expect(n.trajectorySnapshot()!.reuploads).toBe(0);

    // A plain upload failure (old table still running) leaves the run alone.
    await t.start();
    h.replace.mockRejectedValueOnce(
      new Error("DATA chunk past the end of the table"),
    );
    await expect(t.replace(RESHAPED)).rejects.toThrow(/past the end/);
    expect(t.state).toBe("running");
    await t.close();
    await input.close();
  });

  it("reports the last swap kind and scores a retired table's straggler against ITS spec", async () => {
    node = new ControllerNode();
    const c = makeController();
    node.bindController(c as never);
    const t = await node.openTrajectory(SPEC, { name: "ml" });
    expect(node.trajectorySnapshot()!.lastSwap).toBeNull();
    const startNs = 2_000_000_000n;
    await t.start(startNs);
    const h = c.trajectories[0]!;
    await t.replace(RESHAPED); // 0 -> 1, atomic
    expect(node.trajectorySnapshot()).toMatchObject({
      id: 1,
      lastSwap: "atomic",
    });

    // An in-flight capture of the OLD table (id 0, marker 1 at 7 000 µs in
    // SPEC — RESHAPED has no marker 1) lands after the swap, inside the
    // grace: scored against SPEC.
    const late = expectedTriggerNs(startNs, 3, 10_000, 7_000) + 20_000n;
    h.push({ trajectoryId: 0, marker: 1, cycle: 3, tTrigger: late });
    expect(node.trajectorySnapshot()!.lastLatenessUs).toBe(20);
    // The new table's pushes score against RESHAPED (marker 0 at 4 000 µs).
    h.push({
      marker: 0,
      cycle: 4,
      tTrigger: expectedTriggerNs(startNs, 4, 10_000, 4_000) + 5_000n,
    });
    expect(node.trajectorySnapshot()!.lastLatenessUs).toBe(5);

    h.swapKind = "stop-start";
    await t.replace(SPEC);
    expect(node.trajectorySnapshot()!.lastSwap).toBe("stop-start");
    await t.stop();
    await t.close();
  });

  describe("per-id straggler scoring", () => {
    /** A third shape: one marker at 6 000 µs. */
    const THIRD: TrajectorySpec = {
      ...RESHAPED,
      markers: [{ tOffsetUs: 6_000, pulseUs: 800 }],
    };
    const START_NS = 2_000_000_000n;
    /** Push `marker` of table `id` at cycle 3, `lateUs` after the phase of
     *  `offsetUs`; returns the node's lateness reading. */
    const lateness = (
      h: ReturnType<typeof makeTrajectoryHandle>,
      id: number,
      marker: number,
      offsetUs: number,
      lateUs: number,
    ) => {
      h.push({
        trajectoryId: id,
        marker,
        cycle: 3,
        tTrigger:
          expectedTriggerNs(START_NS, 3, 10_000, offsetUs) +
          BigInt(lateUs) * 1000n,
      });
      return node!.trajectorySnapshot()!.lastLatenessUs;
    };
    async function runningOn(): Promise<{
      t: Awaited<ReturnType<ControllerNode["openTrajectory"]>>;
      h: ReturnType<typeof makeTrajectoryHandle>;
    }> {
      node = new ControllerNode();
      const c = makeController();
      node.bindController(c as never);
      const t = await node.openTrajectory(SPEC, { name: "ml" });
      await t.start(START_NS);
      return { t, h: c.trajectories[0]! };
    }

    it("switches specs AT the swap (onSwap), before the handle's replace resolves", async () => {
      const { t, h } = await runningOn();
      const hold = gate();
      h.gate = hold.promise;
      const swapping = t.replace(RESHAPED);
      await tick();
      expect(h.id).toBe(1); // swapped on the controller; DELETE(old) still out
      // The OLD table's straggler (SPEC marker 1 at 7 000 µs — RESHAPED has
      // no marker 1) is scored against SPEC already now…
      expect(lateness(h, 0, 1, 7_000, 11)).toBe(11);
      // …and the NEW table against RESHAPED (marker 0 at 4 000 µs, SPEC's is
      // at 2 000 µs).
      expect(lateness(h, 1, 0, 4_000, 7)).toBe(7);
      hold.release();
      await swapping;
      expect(lateness(h, 0, 1, 7_000, 12)).toBe(12);
      await t.close();
    });

    it("a re-ping that moves the clock offset does not step the lateness", async () => {
      const { t, h } = await runningOn();
      expect(lateness(h, 0, 0, 2_000, 9)).toBe(9);
      // The offset moves by +40 µs: pushes decoded after it carry the new
      // offset, so the same MCU instant reads 40 µs later in host ns…
      const c = node!.liveController as unknown as { clockOffsetNs: bigint };
      c.clockOffsetNs += 40_000n;
      h.push({
        trajectoryId: 0,
        marker: 0,
        cycle: 4,
        tTrigger:
          expectedTriggerNs(START_NS, 4, 10_000, 2_000) + 9_000n + 40_000n,
      });
      // …and the start is re-based by the same difference: still 9 µs late.
      expect(node!.trajectorySnapshot()!.lastLatenessUs).toBe(9);
      await t.close();
    });

    it("a second swap inside the first's grace keeps one entry per retired id", async () => {
      const { t, h } = await runningOn();
      await t.replace(RESHAPED); // 0 -> 1
      advance(10_000_000n); // 10 ms: id 0 still in its 55 ms grace
      await t.replace(THIRD); // 1 -> 2
      expect(lateness(h, 0, 1, 7_000, 21)).toBe(21); // SPEC
      expect(lateness(h, 1, 0, 4_000, 22)).toBe(22); // RESHAPED
      expect(lateness(h, 2, 0, 6_000, 23)).toBe(23); // THIRD (current)
      // Past id 0's grace (55 ms from ITS swap) but inside id 1's: id 0 is
      // no longer SPEC's; id 1 still RESHAPED's.
      advance(50_000_000n);
      expect(lateness(h, 0, 0, 6_000, 24)).toBe(24); // scored as the current table
      expect(lateness(h, 1, 0, 4_000, 25)).toBe(25);
      await t.close();
    });

    it("a failed pair swap's retiredSiblings move an open-ended entry to the grace", async () => {
      const { t, h } = await runningOn();
      h.replace.mockRejectedValueOnce(
        Object.assign(new Error("ambiguous: table 0 (or 7) is live"), {
          running: true,
          replacement: { id: 7, maybeLive: true },
        }),
      );
      await expect(t.replace(RESHAPED)).rejects.toThrow(/ambiguous/);
      advance(1_000_000_000n);
      expect(lateness(h, 7, 0, 4_000, 61)).toBe(61); // RESHAPED, open-ended
      h.replace.mockRejectedValueOnce(
        Object.assign(new Error("pair START REJ"), {
          running: true,
          replacement: null,
          retiredSiblings: [7],
        }),
      );
      await expect(t.replace(THIRD)).rejects.toThrow(/pair START REJ/);
      // Still RESHAPED's inside the grace…
      expect(lateness(h, 7, 0, 4_000, 62)).toBe(62);
      // …and the live table's past it (RESHAPED's grace: 55 ms).
      advance(60_000_000n);
      expect(lateness(h, 7, 0, 2_000, 63)).toBe(63); // SPEC's marker 0
      await t.close();
    });

    it("a detach forgets the retired ids: a new device's reuse of one is scored as the live table", async () => {
      const { t, h } = await runningOn();
      h.replace.mockRejectedValueOnce(
        Object.assign(new Error("ambiguous: table 0 (or 1) is live"), {
          running: true,
          replacement: { id: 1, maybeLive: true },
        }),
      );
      await expect(t.replace(RESHAPED)).rejects.toThrow(/ambiguous/);
      expect(lateness(h, 1, 0, 4_000, 51)).toBe(51); // RESHAPED, possibly live
      // The device goes away with its tables; a new one hands id 1 out again.
      await node!.unbindController();
      const c2 = makeController({ port: "/dev/v22b" });
      node!.bindController(c2 as never);
      await t.reupload();
      await t.start(START_NS);
      const h2 = c2.trajectories[0]!;
      expect(h2.id).toBe(0);
      // A push from id 1 (NOT current here) is scored as the live table —
      // SPEC's marker 1 at 7 000 µs — not against the old device's stale
      // RESHAPED entry (which has no marker 1: the reading would be null).
      expect(lateness(h2, 1, 1, 7_000, 50)).toBe(50);
      await t.replace(RESHAPED); // 0 -> 1 on the NEW device
      expect(lateness(h2, 1, 0, 4_000, 52)).toBe(52);
      await t.close();
    });

    it("a handle without the onSwap hook: the retired id is scored from the resolve on", async () => {
      const { t, h } = await runningOn();
      h.callsOnSwap = false;
      await t.replace(RESHAPED);
      expect(lateness(h, 0, 1, 7_000, 31)).toBe(31);
      expect(lateness(h, 1, 0, 4_000, 32)).toBe(32);
      await t.close();
    });

    it("an ambiguous failed swap keeps scoring the possibly-live replacement id against ITS spec until the run ends", async () => {
      const { t, h } = await runningOn();
      h.replace.mockRejectedValueOnce(
        Object.assign(new Error("ambiguous: table 0 (or 7) is live"), {
          running: true,
          replacement: { id: 7, maybeLive: true },
        }),
      );
      await expect(t.replace(RESHAPED)).rejects.toThrow(/ambiguous/);
      expect(t.state).toBe("running");
      advance(1_000_000_000n); // no time limit while it may be live
      expect(lateness(h, 7, 0, 4_000, 41)).toBe(41); // RESHAPED
      expect(lateness(h, 0, 0, 2_000, 42)).toBe(42); // SPEC (current)
      await t.stop(); // the run's end graces it
      advance(100_000_000n); // past grace(RESHAPED) = 55.8 ms
      await t.start(START_NS);
      expect(lateness(h, 7, 0, 2_000, 43)).toBe(43); // expired: no longer RESHAPED's
      await t.close();
    });
  });
});
