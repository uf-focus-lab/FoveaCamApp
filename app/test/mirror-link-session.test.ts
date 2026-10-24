// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// MirrorLink session over fake seams (spec docs/spec/mirror-link.md
// §scan-patterns, §lifecycle, §actuation, §exposure-windows, §triangle-flip):
//   - spec building for both patterns through the EXACT chain,
//   - start refuses without a v2.2 controller (and touches no camera),
//   - camera programming + restore around a run,
//   - live geometry → throttled, latest-wins `replace`,
//   - a period change restarts the run (cameras kept),
//   - triangle window sync mirroring,
//   - flip pipe lifecycle + anchor pushes, the ring reader re-binding,
//   - telemetry shapes + the once-per-run warnings.
// The session runs over a real Channel pair (fake-endpoint); every native /
// hardware seam is mocked (the calibrate-intrinsic-session pattern).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Channel, topic } from "@lib/orchestrator/protocol";
import type { Point2d } from "core/Geometry";
import { createEndpointPair, flush } from "./fake-endpoint";

// --- controllable seams (hoisted for the vi.mock factories) -----------------

type Spec = {
  periodUs: number;
  samples: { tOffsetUs: number; left: Point2d; right: Point2d }[];
  markers?: { tOffsetUs: number; pulseUs: number; cameras?: string[] }[];
  step?: boolean;
};

const ctl = vi.hoisted(() => ({
  controller: null as null | {
    v22Capable: boolean;
    dv: number;
    clockCalibrated?: boolean;
    clockOffsetNs?: bigint;
  },
  /** `activeController()` reads — every sample's volt clamp reads it once, so
   *  the delta counts spec builds. */
  controllerReads: 0,
  trajectories: [] as Array<FakeTrajectory>,
  openError: null as Error | null,
  replaceError: null as Error | null,
  /** When set, the matching call parks on it (an in-flight open/start/replace). */
  openGate: null as Promise<void> | null,
  startGate: null as Promise<void> | null,
  replaceGate: null as Promise<void> | null,
  nextId: 1,
  /** A replace swaps between TWO ids (the controller's real allocation: the
   *  retired id is free again after its grace) instead of a fresh one. */
  alternateIds: false,
  /** Ordered teardown-relevant events (trajectory stop/close, position close). */
  events: [] as string[],
  pacerTick: null as null | (() => void),
  positionUpdates: 0,
  triggerOn: [] as string[],
  triggerOff: [] as string[],
  reports: [] as string[],
  wirings: [] as Array<{
    nodes: Array<{ id: string; kind: string }>;
    edges: unknown[];
  }>,
  workers: [] as Array<{ init: { pipes: Array<{ role: string }> } }>,
  /** When set, every worker's `sendParams` throws it. */
  sendParamsError: null as Error | null,
  hostNs: 1_000_000_000n,
  /** The triple `acquireTriple` hands out — built per test (fake cameras). */
  triple: null as unknown,
}));

// A class can't be hoisted with vi.hoisted, so the trajectory is a plain
// factory-built object typed here.
type FakeTrajectory = {
  name: string;
  /** The CURRENT MCU table id (a replace swaps it, like the real handle). */
  id: number;
  /** The id retired by the last replace (`ctl.alternateIds`). */
  prevId?: number;
  spec: Spec;
  state: string;
  startedAt: bigint | null;
  /** `start()` calls (a cancelled start never sends one). */
  startCalls: number;
  replaceCalls: number;
  replaced: Spec[];
  stops: number;
  closes: number;
  frameCbs: Array<(f: unknown) => void>;
  stateCbs: Array<(s: string, d: { controllerAvailable: boolean }) => void>;
  start(at?: bigint): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  replace(spec: Spec): Promise<void>;
  onFrame(cb: (f: unknown) => void): () => void;
  onStateChange(
    cb: (s: string, d: { controllerAvailable: boolean }) => void,
  ): () => void;
  push(f: Partial<FrameOut>): void;
  setState(s: string): void;
};
type FrameOut = {
  trajectoryId: number;
  marker: number | null;
  cycle: number;
  status: string;
  frameId: number;
  tTrigger: bigint;
  tExposure: bigint;
  left: Point2d;
  right: Point2d;
};

vi.mock("@orchestrator/controller-node", () => {
  const makeTrajectory = (name: string, spec: Spec): FakeTrajectory => {
    const t: FakeTrajectory = {
      name,
      id: ctl.nextId++,
      spec,
      state: "ready",
      startedAt: null,
      startCalls: 0,
      replaceCalls: 0,
      replaced: [],
      stops: 0,
      closes: 0,
      frameCbs: [],
      stateCbs: [],
      async start(at) {
        t.startCalls++;
        t.startedAt = at ?? null;
        // The node holds inputs (state running) BEFORE the START await.
        t.state = "running";
        if (ctl.startGate) await ctl.startGate;
      },
      async stop() {
        t.stops++;
        ctl.events.push("traj-stop");
        if (t.state === "running") t.state = "ready";
      },
      async close() {
        t.closes++;
        ctl.events.push("traj-close");
        t.state = "closed";
      },
      async replace(next) {
        t.replaceCalls++;
        ctl.events.push("traj-replace");
        if (ctl.replaceGate) await ctl.replaceGate;
        if (ctl.replaceError) throw ctl.replaceError;
        if (t.state === "running" && next.periodUs !== t.spec.periodUs)
          throw new Error("period change while running");
        t.replaced.push(next);
        t.spec = next;
        if (ctl.alternateIds) {
          const back = t.prevId ?? ctl.nextId++;
          t.prevId = t.id;
          t.id = back;
        } else t.id = ctl.nextId++;
      },
      onFrame(cb) {
        t.frameCbs.push(cb);
        return () => void (t.frameCbs = t.frameCbs.filter((x) => x !== cb));
      },
      onStateChange(cb) {
        t.stateCbs.push(cb);
        return () => void (t.stateCbs = t.stateCbs.filter((x) => x !== cb));
      },
      push(f) {
        const full: FrameOut = {
          trajectoryId: t.id,
          marker: 0,
          cycle: 0,
          status: "OK",
          frameId: 1,
          tTrigger: 0n,
          tExposure: 0n,
          left: { x: 0, y: 0 },
          right: { x: 0, y: 0 },
          ...f,
        };
        for (const cb of t.frameCbs) cb(full);
      },
      setState(s) {
        t.state = s;
        for (const cb of t.stateCbs) cb(s, { controllerAvailable: false });
      },
    };
    return t;
  };
  const node = {
    openPosition: () => ({
      streamId: null,
      scheduleFallbacks: 0,
      update: (p: { left: Point2d; right: Point2d }) => {
        ctl.positionUpdates++;
        return p;
      },
      updateAt: (_t: bigint, p: unknown) => p,
      close: async () => void ctl.events.push("pos-close"),
    }),
    trajectorySnapshot: () => ({ lastSwap: "atomic" }),
    async openTrajectory(spec: Spec, opts: { name: string }) {
      if (ctl.openGate) await ctl.openGate;
      if (ctl.openError) throw ctl.openError;
      const t = makeTrajectory(opts.name, spec);
      ctl.trajectories.push(t);
      return t;
    },
  };
  return {
    controllerNode: () => node,
    startPacer: (_ms: number, tick: () => void) => {
      ctl.pacerTick = tick;
      return () => {
        ctl.pacerTick = null;
      };
    },
    trajectoryNodeId: () => "controller/trajectory",
    expectedTriggerNs: (
      start: bigint,
      cycle: number,
      periodUs: number,
      offsetUs: number,
    ) =>
      start +
      BigInt(cycle) * BigInt(periodUs) * 1000n +
      BigInt(offsetUs) * 1000n,
  };
});

vi.mock("@orchestrator/controller", () => ({
  TRAJECTORY_MAX_TABLES: 4,
  activeController: () => {
    ctl.controllerReads++;
    return ctl.controller;
  },
  TrajectoryCapacityError: class TrajectoryCapacityError extends Error {
    constructor() {
      super("Trajectory capacity (4 tables) exceeded");
    }
  },
  TrajectoryReplaceError: class TrajectoryReplaceError extends Error {
    constructor(
      message: string,
      readonly running: boolean,
      readonly cause?: unknown,
      readonly replacement: { id: number; maybeLive: boolean } | null = null,
      readonly retiredSiblings: readonly number[] = [],
    ) {
      super(message);
    }
  },
}));

vi.mock("@orchestrator/time-align", () => ({
  hostNowNs: () => ctl.hostNs,
}));

vi.mock("@orchestrator/camera-trigger", () => ({
  enableHardwareTrigger: async (lease: { camera: FakeCam }) => {
    ctl.triggerOn.push(lease.camera.serial);
    // arv_camera_set_trigger resets the activation (camera-trigger.ts).
    lease.camera.features.TriggerMode = "On";
    lease.camera.features.TriggerActivation = "RisingEdge";
    return { lineInverter: null };
  },
  disableHardwareTrigger: async (lease: { camera: FakeCam }) => {
    ctl.triggerOff.push(lease.camera.serial);
    lease.camera.features.TriggerMode = "Off";
  },
}));

vi.mock("@orchestrator/diagnostics", () => ({
  report: (scope: string, message: string) =>
    void ctl.reports.push(`${scope}: ${message}`),
  span: () => {},
  timeSpan: async <T>(_n: string, fn: () => Promise<T>) => fn(),
}));

vi.mock("@orchestrator/graph-topology", () => ({
  registerGraphWiring: (w: (typeof ctl.wirings)[number]) => {
    ctl.wirings.push(w);
    return () => {
      const i = ctl.wirings.indexOf(w);
      if (i >= 0) ctl.wirings.splice(i, 1);
    };
  },
}));

vi.mock("@orchestrator/vision-worker-host", () => ({
  createVisionWorker: (init: (typeof ctl.workers)[number]["init"]) => {
    const w = { init };
    ctl.workers.push(w);
    return {
      sendParams: () => {
        if (ctl.sendParamsError) throw ctl.sendParamsError;
      },
      terminate: () => {
        const i = ctl.workers.indexOf(w);
        if (i >= 0) ctl.workers.splice(i, 1);
      },
    };
  },
}));

vi.mock("@orchestrator/raw-recording", () => ({
  createRawRecording: () => ({
    active: false,
    start: async () => true,
    stop: async () => true,
  }),
}));

vi.mock("@orchestrator/capture-helper", () => ({
  CAPTURE_RING_DEPTH: 4,
  createCaptureHelper: () => ({
    capturing: false,
    activeCapture: Promise.resolve(),
    build: () => {},
    captureShot: async () => {},
    getPreview: async () => null,
    save: async () => {},
    discard: async () => {},
    stop: async () => {},
  }),
  rawTripleShot: () => ({ meta: { fovea: {}, left: {}, right: {} } }),
}));

vi.mock("@orchestrator/registry", () => ({
  cameraPipeSpec: (camera: { serial: string }) => ({
    id: `camera/${camera.serial}/convert`,
    pixelFormat: "RGBA8",
    dtype: "U8",
    width: 64,
    height: 48,
    channels: 4,
    stride: 256,
    bytesPerFrame: 64 * 48 * 4,
    ringDepth: 4,
  }),
}));

vi.mock("@orchestrator/raw-pipe", () => ({
  rawPipeSpec: (_c: unknown, id: string) => ({ id }),
}));

vi.mock("@orchestrator/calibration", () => ({
  acquireTriple: async () => ctl.triple,
}));

import mirrorLinkSession from "@modules/mirror-link/session";
import {
  scanAngles,
  patternOffset,
  patternSamples,
  patternPeriodUs,
  sweepUs,
} from "@modules/mirror-link/scan";

// --- fakes -------------------------------------------------------------------

/** A timing-capable fake camera: free-running Timed exposure by default. */
class FakeCam {
  frame_rate_enable = true;
  frame_rate = 30;
  frame_rate_range = { min: 1, max: 60 };
  exposure = 12_000;
  readonly exposure_range = { min: 20, max: 30e6 };
  exposure_auto: "Off" | "Once" | "Continuous" = "Continuous";
  gain = 3;
  gain_auto: "Off" | "Once" | "Continuous" = "Off";
  readonly gain_range = { min: 0, max: 24 };
  readonly features: Record<string, string> = {
    ExposureMode: "Timed",
    TriggerActivation: "RisingEdge",
    TriggerMode: "Off",
    TriggerOverlap: "Off",
  };
  constructor(
    readonly serial: string,
    readonly modes: string[] = ["Timed", "TriggerWidth"],
  ) {}
  getFeatureInt(name: string): number {
    if (name === "Width") return 64;
    if (name === "Height") return 48;
    throw new Error(`[${name}] not an integer node`);
  }
  setExposureMode(mode: string): boolean {
    if (!this.modes.includes(mode)) return false;
    this.features.ExposureMode = mode;
    return true;
  }
  getFeature(name: string): string {
    const v = this.features[name];
    if (v === undefined) throw new Error(`[${name}] not found`);
    return v;
  }
  setFeature(name: string, value: string): void {
    this.features[name] = value;
  }
}

/** Fake conversions: a mildly NON-linear angle→volt map per eye (so the
 *  exact-chain check is not trivially linear); A2P.C/undistort scale by 1000. */
const conv = {
  A2V: {
    L: (a: Point2d) => ({
      x: 40 * Math.tan(a.x) + 1,
      y: 38 * Math.tan(a.y) - 2,
    }),
    R: (a: Point2d) => ({
      x: 41 * Math.tan(a.x) - 1,
      y: 39 * Math.tan(a.y) + 2,
    }),
  },
  V2A: {
    L: (v: Point2d) => ({
      x: Math.atan((v.x - 1) / 40),
      y: Math.atan((v.y + 2) / 38),
    }),
    R: (v: Point2d) => ({
      x: Math.atan((v.x + 1) / 41),
      y: Math.atan((v.y - 2) / 39),
    }),
  },
  A2P: { C: (a: Point2d) => ({ x: a.x * 1000, y: a.y * 1000 }) },
  P2A: { C: (p: Point2d) => ({ x: p.x / 1000, y: p.y / 1000 }) },
  A2H: { L: () => new Float64Array(9), R: () => new Float64Array(9) },
};

function makeTriple(
  opts: { calibrated?: boolean; modes?: string[]; maxFps?: number } = {},
) {
  const lease = (serial: string) => {
    const camera = new FakeCam(serial, opts.modes);
    if (opts.maxFps !== undefined)
      camera.frame_rate_range = { min: 1, max: opts.maxFps };
    return {
      camera,
      reconfigure: async (fn: () => void) => fn(),
      release: vi.fn(),
    };
  };
  return {
    leases: { L: lease("SL"), C: lease("SC"), R: lease("SR") },
    conv,
    undistort:
      opts.calibrated === false
        ? null
        : {
            calibration: {},
            angular: (pts: Point2d[]) => pts.map((p) => conv.P2A.C(p)),
            sensor_size: { width: 64, height: 48 },
            focal: 1,
            center: { x: 32, y: 24 },
            fov: 1,
          },
    magnification: { L: null, R: null },
    zoomOverride: null,
    baselineMm: null,
    settleTimeUs: 0,
    delayCompensationMs: 0,
    configPath: [],
  };
}

type Anchor = { tStart: bigint; tEnd: bigint; flip: boolean };
type ProbeRow = {
  frames: number;
  flipped: number;
  unmatched: number;
  matchedSkewNs?: number;
};

function makeFlipSeam() {
  const pools: Record<string, Anchor[]> = {};
  const seam = {
    advertised: [] as Array<{ id: string; width?: number }>,
    attached: [] as Array<{
      src: string;
      id: string;
      toleranceNs: bigint;
      anchorFrom?: string;
    }>,
    detached: [] as string[],
    unadvertised: [] as string[],
    pools,
    probes: {} as Record<string, ProbeRow>,
    advertise: (spec: { id: string; width?: number }) => {
      seam.advertised.push({ id: spec.id, width: spec.width });
      return 1;
    },
    unadvertise: (id: string) => void seam.unadvertised.push(id),
    attach: (
      src: string,
      id: string,
      o: { toleranceNs: bigint; anchorFrom?: string },
    ) => {
      seam.attached.push({
        src,
        id,
        toleranceNs: o.toleranceNs,
        anchorFrom: o.anchorFrom,
      });
      pools[id] = [];
      // A fresh brick counts from 0.
      delete seam.probes[id];
    },
    pushAnchor: (id: string, a: Anchor) => void pools[id]!.push(a),
    probe: (id: string) => {
      const p = seam.probes[id] ?? { frames: 0, flipped: 0, unmatched: 0 };
      return {
        matchedSkewNs: 0,
        ...p,
        anchorPoolSize: pools[id]?.length ?? 0,
        anchorDrops: 0,
      };
    },
    detach: (id: string) => void seam.detached.push(id),
  };
  return seam;
}

/** A gate a fake call parks on until `open()`. */
function gate(): { p: Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

// --- harness -------------------------------------------------------------------

async function settle(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

let perfNow = 0;

async function harness(
  opts: {
    calibrated?: boolean;
    modes?: string[];
    maxFps?: number;
    state?: Record<string, unknown>;
  } = {},
) {
  ctl.controller = { v22Capable: true, dv: 170, clockCalibrated: true };
  ctl.alternateIds = false;
  ctl.hostNs = 1_000_000_000n;
  ctl.trajectories.length = 0;
  ctl.openError = null;
  ctl.replaceError = null;
  ctl.openGate = ctl.startGate = ctl.replaceGate = null;
  ctl.events.length = 0;
  ctl.triggerOn.length = 0;
  ctl.triggerOff.length = 0;
  ctl.reports.length = 0;
  ctl.wirings.length = 0;
  ctl.workers.length = 0;
  ctl.sendParamsError = null;
  ctl.positionUpdates = 0;
  const triple = makeTriple(opts);
  ctl.triple = triple;
  const flipSeam = makeFlipSeam();
  const broker = {
    advertise: () => 1,
    connect: vi.fn((id: string) => ({
      shmName: `/fv.${id}`,
      // The broker's record (width 80) differs from cameraPipeSpec's (64): the flip
      // pipe must be advertised with the BROKER's.
      spec: {
        id,
        width: 80,
        height: 48,
        channels: 4,
        bytesPerFrame: 80 * 48 * 4,
      },
    })),
    disconnect: vi.fn(() => 0),
    drop: () => {},
  };
  const undistortSeam = {
    advertise: () => 1,
    unadvertise: () => {},
    attach: () => {},
    detach: () => {},
  };
  const rawPipes = { acquire: () => ({ release: () => {} }) };
  const session = mirrorLinkSession(
    broker as never,
    undistortSeam as never,
    rawPipes as never,
    {} as never,
    {} as never,
    undefined,
    flipSeam,
  );
  const [serverEp, clientEp] = createEndpointPair();
  const server = new Channel(serverEp);
  const client = new Channel(clientEp);
  session.attach(server);
  const tele: Record<string, any> = {};
  const state: Record<string, any> = {};
  client.on(topic.telemetry("mirror-link"), (patch: Record<string, unknown>) =>
    Object.assign(tele, patch),
  );
  client.on(
    topic.state("mirror-link"),
    ({ key, value }: { key: string; value: unknown }) => {
      state[key] = value;
    },
  );
  // Seed state BEFORE activation (a carried-over drawer).
  for (const [k, v] of Object.entries(opts.state ?? {}))
    (session.state as Record<string, unknown>)[k] = v;
  session.subscribe(server);
  await settle(30);
  const call = <T = unknown>(cmd: string, arg?: unknown) =>
    client.request<T>(topic.command("mirror-link", cmd), arg);
  const setState = async (key: string, value: unknown) => {
    client.emit(topic.setState("mirror-link"), { key, value });
    await settle();
  };
  /** Run the pacer up to the next telemetry emit. */
  const tick = async (ms = 40) => {
    perfNow += ms;
    ctl.pacerTick?.();
    await settle();
  };
  const traj = () => ctl.trajectories.at(-1)!;
  return {
    session,
    server,
    client,
    tele,
    state,
    call,
    setState,
    tick,
    traj,
    triple,
    flipSeam,
    broker,
  };
}

beforeEach(() => {
  perfNow = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => perfNow);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const BASELINE = 200;
/** The session's chain at the default drawer (verge 0 → ∞, no shift, no pan). */
function chainVolts(center: Point2d, offset: Point2d) {
  const a = scanAngles(center, offset, BASELINE, Infinity, 0);
  const clamp = (v: Point2d) => ({
    x: Math.min(Math.max(v.x, -170), 170),
    y: Math.min(Math.max(v.y, -170), 170),
  });
  return { left: clamp(conv.A2V.L(a.l)), right: clamp(conv.A2V.R(a.r)) };
}

// --- tests -------------------------------------------------------------------

describe("spec building", () => {
  it("ellipse: 128 exact-chain samples over T, one L+R marker from the window", async () => {
    const h = await harness();
    await h.call("steer", { x: 20, y: -10 });
    await h.setState("scan_axis_deg", 30);
    await h.setState("scan_ratio", 0.5);
    await h.setState("scan_window", [0.1, 0.6]);
    expect(await h.call("startScan")).toBe(true);
    const spec = h.traj().spec;
    expect(h.traj().name).toBe("mirror-link");
    expect(spec.periodUs).toBe(100_000);
    expect(spec.step).toBe(false);
    expect(spec.samples).toHaveLength(128);
    expect(spec.markers).toEqual([
      { tOffsetUs: 10_000, pulseUs: 50_000, cameras: ["L", "R"] },
    ]);
    // Every sample IS voltsFor(anglesAt(offset)) — no linearization.
    const center = { x: 0.02, y: -0.01 };
    const ref = patternSamples("ellipse", 10, 30, 0.5, 0.5);
    for (const k of [0, 17, 64, 127]) {
      const want = chainVolts(center, ref[k]!.offset);
      expect(spec.samples[k]!.tOffsetUs).toBe(ref[k]!.tOffsetUs);
      expect(spec.samples[k]!.left.x).toBeCloseTo(want.left.x, 9);
      expect(spec.samples[k]!.left.y).toBeCloseTo(want.left.y, 9);
      expect(spec.samples[k]!.right.x).toBeCloseTo(want.right.x, 9);
      expect(spec.samples[k]!.right.y).toBeCloseTo(want.right.y, 9);
    }
  });

  it("triangle: 2T period, the two endpoint samples, rising + falling markers", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.2, 0.5]);
    expect(await h.call("startScan")).toBe(true);
    const spec = h.traj().spec;
    expect(spec.periodUs).toBe(patternPeriodUs("triangle", 10));
    expect(spec.samples.map((s) => s.tOffsetUs)).toEqual([0, sweepUs(10)]);
    const want0 = chainVolts(
      { x: 0, y: 0 },
      { x: (-0.5 * Math.PI) / 180, y: 0 },
    );
    expect(spec.samples[0]!.left.x).toBeCloseTo(want0.left.x, 9);
    expect(spec.markers).toEqual([
      { tOffsetUs: 10_000, pulseUs: 80_000, cameras: ["L", "R"] },
      { tOffsetUs: 120_000, pulseUs: 30_000, cameras: ["L", "R"] },
    ]);
  });

  it("starts at an EXPLICIT host instant (now + the lead)", async () => {
    const h = await harness();
    await h.call("startScan");
    expect(h.traj().startedAt).toBe(ctl.hostNs + 20_000_000n);
  });
});

describe("start / stop", () => {
  it("refuses without a v2.2 controller and touches no camera", async () => {
    const h = await harness();
    ctl.controller = { v22Capable: false, dv: 170 };
    expect(await h.call("startScan")).toBe(false);
    await settle();
    expect(h.tele.scan_blocked).toBe("controller firmware >= 2.2.0 required");
    expect(ctl.trajectories).toHaveLength(0);
    expect(ctl.triggerOn).toEqual([]);
    ctl.controller = null;
    expect(await h.call("startScan")).toBe(false);
    await settle();
    expect(h.tele.scan_blocked).toBe("no controller connected");
  });

  it("programs both cameras (trigger + TriggerWidth/LevelHigh) and restores them verbatim", async () => {
    const h = await harness();
    const L = h.triple.leases.L.camera;
    const before = {
      ...L.features,
      exposure: L.exposure,
      auto: L.exposure_auto,
      fre: L.frame_rate_enable,
    };
    expect(await h.call("startScan")).toBe(true);
    await settle();
    expect(ctl.triggerOn).toEqual(["SL", "SR"]);
    expect(L.features.ExposureMode).toBe("TriggerWidth");
    expect(L.features.TriggerActivation).toBe("LevelHigh");
    expect(L.exposure_auto).toBe("Off");
    expect(L.frame_rate_enable).toBe(false);
    expect(h.tele.scan).toMatchObject({
      mode: "ellipse",
      hz: 10,
      period_us: 100_000,
      windows: [{ t_offset_us: 0, pulse_us: 95_000 }],
      exposure_mode: "TriggerWidth",
      exposure_us: { L: 0, R: 0 },
      mismatch: false,
    });
    expect(h.tele.scan_blocked).toBeNull();
    await h.call("stopScan");
    await settle();
    expect(h.traj().stops).toBeGreaterThan(0);
    expect(h.traj().closes).toBe(1);
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
    expect({
      ...L.features,
      exposure: L.exposure,
      auto: L.exposure_auto,
      fre: L.frame_rate_enable,
    }).toEqual({
      ...before,
      TriggerMode: "Off",
    });
    expect(h.tele.scan).toBeNull();
  });

  it("refuses and restores when the trajectory cannot open", async () => {
    const h = await harness();
    ctl.openError = new Error("firmware REJ");
    expect(await h.call("startScan")).toBe(false);
    await settle();
    expect(h.tele.scan_blocked).toMatch(
      /trajectory start failed: firmware REJ/,
    );
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
    expect(h.triple.leases.R.camera.features.ExposureMode).toBe("Timed");
  });

  it("the pacer slews the idle pose but never pushes while the trajectory runs", async () => {
    const h = await harness();
    await h.tick(1);
    const idle = ctl.positionUpdates;
    expect(idle).toBeGreaterThan(0);
    await h.call("startScan");
    for (let i = 0; i < 5; i++) await h.tick(1);
    expect(ctl.positionUpdates).toBe(idle);
    await h.call("stopScan");
    await h.tick(1);
    expect(ctl.positionUpdates).toBe(idle + 1);
  });

  it("stops (and says why) when the controller detaches the run", async () => {
    const h = await harness();
    await h.call("startScan");
    h.traj().setState("detached");
    await settle(30);
    expect(h.tele.scan).toBeNull();
    expect(h.tele.scan_blocked).toMatch(/controller disconnected/);
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
  });

  it("tells a Start refusal from a stop: kind refused / stopped, a start clears both", async () => {
    const h = await harness();
    expect(h.tele.scan_blocked_kind).toBeNull();
    const c = ctl.controller;
    ctl.controller = null;
    expect(await h.call("startScan")).toBe(false);
    await settle();
    expect(h.tele.scan_blocked).toBe("no controller connected");
    expect(h.tele.scan_blocked_kind).toBe("refused");
    ctl.controller = c;
    expect(await h.call("startScan")).toBe(true);
    await settle();
    expect(h.tele.scan_blocked).toBeNull();
    expect(h.tele.scan_blocked_kind).toBeNull();
    h.traj().setState("ready"); // the MCU ended the run
    await settle(30);
    expect(h.tele.scan).toBeNull();
    expect(h.tele.scan_blocked).toBe(
      "the controller ended the trajectory run — scan stopped",
    );
    expect(h.tele.scan_blocked_kind).toBe("stopped");
    await h.call("stopScan");
    await settle();
    expect(h.tele.scan_blocked).toBeNull();
    expect(h.tele.scan_blocked_kind).toBeNull();
  });

  it("falls back to Timed on both eyes when one model lacks TriggerWidth", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.modes.splice(1); // R: Timed only
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.2, 0.5]);
    await h.call("startScan");
    await settle();
    expect(h.triple.leases.L.camera.features.ExposureMode).toBe("Timed");
    expect(h.tele.scan.exposure_mode).toBe("Timed");
    expect(h.tele.scan.exposure_us).toEqual({ L: 80_000, R: 80_000 });
    // Unequal triangle windows cannot share one Timed exposure.
    expect(h.tele.scan.mismatch).toBe(true);
    expect(h.tele.scan.mismatch_reason).toBe(
      "unequal windows: Timed exposure gives both the rising window's length",
    );
    expect(
      ctl.reports.some((r) => r.includes("cannot take the exposure windows")),
    ).toBe(true);
    // EVERY marker carries marker 0's applied exposure, so the firmware's
    // per-marker strobe timeout matches the camera's single exposure — and
    // the falling one is kept inside ITS slope: 0.2 T + 0.8 T would run past
    // 0.95 T, so it starts at 0.95 T − 0.8 T = 0.15 T into the fall.
    expect(h.traj().spec.markers!.map((m) => m.pulseUs)).toEqual([
      80_000, 80_000,
    ]);
    expect(h.tele.scan.windows).toEqual([
      { t_offset_us: 10_000, pulse_us: 80_000 },
      { t_offset_us: 115_000, pulse_us: 80_000 },
    ]);
    // The drawn windows are the APPLIED ones (wide px = angle × 1000 here).
    const fall = h.tele.scan_window_px[1] as Point2d[];
    const P = patternPeriodUs("triangle", 10);
    const first = patternOffset("triangle", 115_000 / P, 0, 0.5, 1);
    const last = patternOffset("triangle", 195_000 / P, 0, 0.5, 1);
    expect(fall[0]!.x).toBeCloseTo(first.x * 1000, 9);
    expect(fall.at(-1)!.x).toBeCloseTo(last.x * 1000, 9);
    // ...and a window move (shrinking the exposure) re-writes the exposure
    // first, then swaps in the equal pulses.
    await h.setState("tri_window_rise", [0.1, 0.6]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.triple.leases.L.camera.exposure).toBe(50_000);
    expect(
      h
        .traj()
        .replaced.at(-1)!
        .markers!.map((m) => m.pulseUs),
    ).toEqual([50_000, 50_000]);
    expect(
      h
        .traj()
        .replaced.at(-1)!
        .markers!.map((m) => m.tOffsetUs),
    ).toEqual([10_000, 120_000]);
  });

  it("Timed: a falling END edit that leaves the spec identical still re-judges the windows", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.modes.splice(1); // R: Timed only
    await h.setState("tri_window_rise", [0.1, 0.5]);
    await h.setState("tri_window_fall", [0.1, 0.5]);
    await h.call("startScan");
    await settle();
    expect(h.tele.scan.exposure_mode).toBe("Timed");
    expect(h.tele.scan.mismatch).toBe(false);
    // Every marker carries marker 0's pulse and the falling START is unmoved,
    // so the MCU spec does not change — no replace goes out — but the
    // REQUESTED windows now differ: the Timed mismatch must say so.
    await h.setState("tri_window_fall", [0.1, 0.8]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaced).toHaveLength(0);
    expect(h.tele.scan.mismatch).toBe(true);
    expect(h.tele.scan.mismatch_reason).toBe(
      "unequal windows: Timed exposure gives both the rising window's length",
    );
    // ...and back to equal clears it, again without a replace.
    perfNow += 200; // past the replace throttle
    await h.setState("tri_window_fall", [0.1, 0.5]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaced).toHaveLength(0);
    expect(h.tele.scan.mismatch).toBe(false);
    expect(h.tele.scan.mismatch_reason).toBeNull();
  });

  it("Timed: an exposure clamped past the slope runs into the next trigger → clamped + named", async () => {
    const h = await harness({
      modes: ["Timed"],
      state: { scan_mode: "triangle" },
    });
    for (const side of ["L", "R"] as const)
      Object.defineProperty(h.triple.leases[side].camera, "exposure_range", {
        value: { min: 120_000, max: 30e6 },
      });
    await h.setState("tri_window_rise", [0.1, 0.2]);
    expect(await h.call("startScan")).toBe(true);
    await settle();
    const T = sweepUs(10);
    // 120 ms > T: each marker starts at its slope and is clamped at the next.
    expect(h.tele.scan.windows).toEqual([
      { t_offset_us: 0, pulse_us: T },
      { t_offset_us: T, pulse_us: T },
    ]);
    expect(h.tele.scan.mismatch_reason).toBe(
      "Timed exposure clamped to the camera's exposure range; " +
        "Timed exposure would run into the next trigger; " +
        // the touching edges leave no flip gap at all
        "exposure windows too close for reliable flipping at this frequency",
    );
  });

  it("reads the maximum frame rate AFTER the triggered timing (the pre-scan exposure caps it)", async () => {
    const h = await harness({ modes: ["Timed"] });
    for (const side of ["L", "R"] as const) {
      const cam = h.triple.leases[side].camera;
      cam.exposure = 200_000; // pre-scan: 200 ms → 5 fps
      Object.defineProperty(cam, "frame_rate_range", {
        get: () => ({ min: 1, max: Math.min(500, 1e6 / cam.exposure) }),
      });
    }
    await h.setState("scan_window", [0, 0.5]); // 50 ms → 20 fps ≥ 10 Hz
    expect(await h.call("startScan")).toBe(true);
    await settle();
    expect(h.tele.scan.exposure_us).toEqual({ L: 50_000, R: 50_000 });
    expect(h.tele.scan.mismatch).toBe(false);
  });

  it("the readout check uses SensorReadoutTime when readable", async () => {
    // 500 fps → 2 ms by the frame rate; the node says 30 ms. Ends at 0.95 T
    // and T + 0.2 T → 25 ms apart.
    const h = await harness({
      maxFps: 500,
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.features.SensorReadoutTime = "30000";
    await h.setState("tri_window_rise", [0.05, 0.95]);
    await h.setState("tri_window_fall", [0.05, 0.2]);
    await h.call("startScan");
    await settle();
    expect(h.tele.scan.mismatch_reason).toBe(
      "exposures closer than the sensor readout",
    );
    // Without the node the 2 ms of 1 / 500 fps passes.
    const u = await harness({
      maxFps: 500,
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    await u.setState("tri_window_rise", [0.05, 0.95]);
    await u.setState("tri_window_fall", [0.05, 0.2]);
    await u.call("startScan");
    await settle();
    expect(u.tele.scan.mismatch).toBe(false);
  });

  it("TriggerWidth keeps each marker's own pulse (no mismatch)", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.2, 0.5]);
    await h.call("startScan");
    await settle();
    expect(h.traj().spec.markers!.map((m) => m.pulseUs)).toEqual([
      80_000, 30_000,
    ]);
    expect(h.tele.scan.mismatch).toBe(false);
    expect(h.tele.scan.mismatch_reason).toBeNull();
  });

  it("sets TriggerOverlap = ReadOut while scanning and restores it", async () => {
    const h = await harness();
    await h.call("startScan");
    expect(h.triple.leases.L.camera.features.TriggerOverlap).toBe("ReadOut");
    expect(h.triple.leases.R.camera.features.TriggerOverlap).toBe("ReadOut");
    await h.call("stopScan");
    await settle();
    expect(h.triple.leases.L.camera.features.TriggerOverlap).toBe("Off");
  });

  it("mismatch: trigger rate above either fovea's maximum frame rate (scan still runs)", async () => {
    const h = await harness({ maxFps: 8 });
    expect(await h.call("startScan")).toBe(true); // 10 Hz > 8 fps
    await settle();
    expect(h.tele.scan.mismatch).toBe(true);
    expect(h.tele.scan.mismatch_reason).toBe(
      "trigger rate above the camera's maximum frame rate",
    );
    expect(ctl.reports.some((r) => r.includes("maximum frame rate"))).toBe(
      true,
    );
  });

  it("mismatch: triangle exposures closer end-to-end than the sensor readout", async () => {
    // 30 fps max → 33.3 ms readout; ends at 0.95 T and T + 0.2 T → 25 ms apart.
    const h = await harness({
      maxFps: 30,
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    await h.setState("tri_window_rise", [0.05, 0.95]);
    await h.setState("tri_window_fall", [0.05, 0.2]);
    await h.call("startScan");
    await settle();
    expect(h.tele.scan.mismatch_reason).toBe(
      "exposures closer than the sensor readout",
    );
    // Spread them and the replace clears it.
    await h.setState("tri_window_fall", [0.05, 0.6]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.tele.scan.mismatch).toBe(false);
    expect(h.tele.scan.mismatch_reason).toBeNull();
  });

  it("refuses until the controller clock is calibrated, touching no camera", async () => {
    const h = await harness();
    ctl.controller!.clockCalibrated = false;
    expect(await h.call("startScan")).toBe(false);
    await settle();
    expect(h.tele.scan_blocked).toBe("controller clock not calibrated yet");
    expect(ctl.trajectories).toHaveLength(0);
    expect(ctl.triggerOn).toEqual([]);
    ctl.controller!.clockCalibrated = true;
    expect(await h.call("startScan")).toBe(true);
  });

  it("a throwing flip retire still restores the cameras", async () => {
    const h = await harness({ state: { scan_mode: "triangle" } });
    await h.call("startScan");
    h.flipSeam.detach = () => {
      throw new Error("native detach failed");
    };
    await h.call("stopScan");
    await settle();
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
    expect(h.triple.leases.L.camera.features.ExposureMode).toBe("Timed");
    expect(h.tele.scan).toBeNull();
    expect(h.state.flipPipes).toEqual({ L: null, R: null });
    expect(
      ctl.reports.some((r) => r.includes("flip pipe retire incomplete")),
    ).toBe(true);
  });

  it("a refused restore write is reported; the rest still lands", async () => {
    const h = await harness();
    await h.call("startScan");
    const L = h.triple.leases.L.camera;
    const orig = L.setFeature.bind(L);
    L.setFeature = (n: string, v: string) => {
      if (n === "TriggerActivation") throw new Error("locked");
      orig(n, v);
    };
    await h.call("stopScan");
    await settle();
    expect(L.features.ExposureMode).toBe("Timed");
    expect(L.features.TriggerOverlap).toBe("Off");
    expect(L.exposure_auto).toBe("Continuous");
    expect(
      ctl.reports.some(
        (r) =>
          r.includes("restore incomplete") && r.includes("L TriggerActivation"),
      ),
    ).toBe(true);
  });
});

describe("live geometry → replace", () => {
  it("throttles to ≤ 10 Hz with the LATEST spec winning", async () => {
    const h = await harness();
    await h.call("startScan");
    await h.setState("scan_amp", 0.6);
    await h.setState("scan_amp", 0.7);
    await h.setState("scan_amp", 0.8);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaced).toHaveLength(1); // the first fires immediately
    perfNow += 30;
    await h.setState("scan_ratio", 0.3);
    await h.setState("scan_axis_deg", 45);
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(h.traj().replaced).toHaveLength(1); // still inside the 100 ms window
    perfNow += 100;
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(h.traj().replaced).toHaveLength(2);
    const last = h.traj().replaced.at(-1)!;
    const ref = patternSamples("ellipse", 10, 45, 0.8, 0.3);
    const want = chainVolts({ x: 0, y: 0 }, ref[5]!.offset);
    expect(last.samples[5]!.left.x).toBeCloseTo(want.left.x, 9);
    expect(last.periodUs).toBe(100_000);
    expect(ctl.trajectories).toHaveLength(1); // no restart
    expect(h.tele.scan.amp_deg).toBe(0.8);
    await h.tick();
    expect(h.tele.perf.trajectory.reuploads).toBe(2);
    expect(h.tele.perf.trajectory.last_swap).toBe("atomic");
  });

  it("skips an identical spec (a no-op write re-uploads nothing)", async () => {
    const h = await harness();
    await h.call("startScan");
    await h.setState("verge", 0);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaced).toHaveLength(0);
  });

  it("windows ride the replace too (marker offsets/pulses)", async () => {
    const h = await harness();
    await h.call("startScan");
    await h.setState("scan_window", [0.2, 0.4]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaced.at(-1)!.markers).toEqual([
      { tOffsetUs: 20_000, pulseUs: 20_000, cameras: ["L", "R"] },
    ]);
  });

  it("a failed replace keeps the run (warned once); one that ended it stops the scan", async () => {
    const h = await harness();
    await h.call("startScan");
    ctl.replaceError = new Error("upload REJ");
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.tele.scan).not.toBeNull();
    expect(
      ctl.reports.filter((r) => r.includes("re-upload failed")),
    ).toHaveLength(1);
    const { TrajectoryReplaceError } = await import("@orchestrator/controller");
    ctl.replaceError = new (TrajectoryReplaceError as unknown as new (
      m: string,
      r: boolean,
    ) => Error)("STOP lost", false);
    perfNow += 200;
    await h.setState("scan_amp", 1.0);
    await vi.advanceTimersByTimeAsync(200);
    await settle(30);
    expect(h.tele.scan).toBeNull();
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
  });
});

describe("failed replace: the routed new id is scored against ITS spec", () => {
  /** A `TrajectoryReplaceError(running: true)` that left table `id` routed. */
  async function replaceErrorWith(id: number, maybeLive: boolean) {
    const { TrajectoryReplaceError } = await import("@orchestrator/controller");
    return new (TrajectoryReplaceError as unknown as new (
      m: string,
      r: boolean,
      c?: unknown,
      rep?: { id: number; maybeLive: boolean } | null,
    ) => Error)("atomic START timed out", true, undefined, { id, maybeLive });
  }

  it("graced (never live): pushes from the new id score against the new spec for its grace", async () => {
    const h = await harness();
    await h.call("startScan");
    const start = h.traj().startedAt!;
    ctl.replaceError = await replaceErrorWith(7, false);
    await h.setState("scan_window", [0.3, 0.95]); // marker 0 moves 0 → 30 ms
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    // A push from id 7 exactly on the NEW table's phase: 0 µs late, not the
    // old marker's 30 ms.
    h.traj().push({
      trajectoryId: 7,
      status: "OK",
      marker: 0,
      cycle: 2,
      tTrigger: start + 200_000_000n + 30_000_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(0);
    // The running table (id 0) still scores against ITS spec (marker at 0).
    h.traj().push({
      status: "OK",
      marker: 0,
      cycle: 3,
      tTrigger: start + 300_000_000n + 5_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(5);
    // Past the grace the id may be reallocated: back to the running spec.
    ctl.hostNs += 1_000_000_000n;
    h.traj().push({
      trajectoryId: 7,
      status: "OK",
      marker: 0,
      cycle: 12,
      tTrigger: start + 1_200_000_000n + 30_000_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(30_000);
  });

  it("possibly live: the entry never expires on its own; the next landed swap retires it", async () => {
    const h = await harness();
    await h.call("startScan");
    const start = h.traj().startedAt!;
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("scan_window", [0.3, 0.95]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    ctl.hostNs += 5_000_000_000n; // far past any grace
    h.traj().push({
      trajectoryId: 7,
      status: "OK",
      marker: 0,
      cycle: 52,
      tTrigger: start + 5_200_000_000n + 30_000_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(0);
    // A swap that lands (the controller STOPped the sibling first) retires
    // the entry: past ITS grace the id scores as the live table again.
    ctl.replaceError = null;
    perfNow += 200;
    await h.setState("scan_window", [0.4, 0.95]); // marker 0 at 40 ms
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    ctl.hostNs += 1_000_000_000n;
    h.traj().push({
      trajectoryId: 7,
      status: "OK",
      marker: 0,
      cycle: 62,
      tTrigger: start + 6_200_000_000n + 40_000_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(0);
  });

  it("Timed, possibly live: the shorter exposure of a pre-swap shrink is NOT written back", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.modes.splice(1); // R: Timed only
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.1, 0.9]);
    await h.call("startScan");
    await settle();
    expect(h.triple.leases.L.camera.exposure).toBe(80_000);
    // A shrinking window re-times the camera FIRST (50 ms), then swaps…
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("tri_window_rise", [0.1, 0.6]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    // …and the swap's outcome is unknown: the 50 ms exposure stays (safe under
    // either table), the 80 ms one is NOT restored.
    expect(h.triple.leases.L.camera.exposure).toBe(50_000);
  });

  it("a failed pair swap that STOPped the sibling (retiredSiblings) clears the unconfirmed state", async () => {
    const h = await harness();
    await h.call("startScan");
    const start = h.traj().startedAt!;
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("scan_window", [0.3, 0.95]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.tele.scan.mismatch_reason).toBe(
      "replacement swap unconfirmed — the mirror may run the previous edit",
    );
    // The next swap falls to the pair, STOPs sibling 7, and its START fails:
    // the sibling is retired (graced) — no longer unconfirmed.
    const { TrajectoryReplaceError } = await import("@orchestrator/controller");
    ctl.replaceError = new (TrajectoryReplaceError as unknown as new (
      m: string,
      r: boolean,
      c?: unknown,
      rep?: { id: number; maybeLive: boolean } | null,
      sibs?: readonly number[],
    ) => Error)("pair START REJ", true, undefined, null, [7]);
    perfNow += 200;
    await h.setState("scan_window", [0.4, 0.95]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    expect(h.tele.scan.mismatch).toBe(false);
    // Inside the grace a push from 7 still scores against ITS spec (30 ms)…
    h.traj().push({
      trajectoryId: 7,
      status: "OK",
      marker: 0,
      cycle: 3,
      tTrigger: start + 300_000_000n + 30_000_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(0);
    // …past it, as the running table (marker at 0).
    ctl.hostNs += 1_000_000_000n;
    h.traj().push({
      trajectoryId: 7,
      status: "OK",
      marker: 0,
      cycle: 13,
      tTrigger: start + 1_300_000_000n + 30_000_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(30_000);
  });

  it("possibly live: mismatch names the unconfirmed swap; an edit back to the running geometry still swaps and settles it", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.modes.splice(1); // R: Timed only
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.1, 0.9]);
    await h.call("startScan");
    await settle();
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("tri_window_rise", [0.1, 0.6]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    expect(h.triple.leases.L.camera.exposure).toBe(50_000);
    // The camera deliberately differs from the running table: not a clamp.
    expect(h.tele.scan.mismatch).toBe(true);
    expect(h.tele.scan.mismatch_reason).toBe(
      "replacement swap unconfirmed — the mirror may run the previous edit",
    );
    expect(ctl.reports.some((r) => r.includes("clamped to the camera"))).toBe(
      false,
    );
    // Back to the running geometry: identical to runSpec, but a sibling may be
    // live — the swap goes out anyway, the exposure grows back AFTER it, and
    // the sibling is retired.
    ctl.replaceError = null;
    perfNow += 200;
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    expect(h.triple.leases.L.camera.exposure).toBe(80_000);
    expect(h.tele.scan.mismatch).toBe(false);
    expect(h.tele.scan.mismatch_reason).toBeNull();
  });

  it("Timed, never live: the pre-swap shrink IS written back", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.modes.splice(1); // R: Timed only
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.1, 0.9]);
    await h.call("startScan");
    await settle();
    ctl.replaceError = await replaceErrorWith(7, false);
    await h.setState("tri_window_rise", [0.1, 0.6]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.triple.leases.L.camera.exposure).toBe(80_000);
  });

  it("a failed pair swap that STOPped the sibling grows the Timed camera back to the running table's exposure", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.modes.splice(1); // R: Timed only
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.1, 0.9]);
    await h.call("startScan");
    await settle();
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("tri_window_rise", [0.1, 0.6]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.triple.leases.L.camera.exposure).toBe(50_000);
    // Back to the running geometry, but the swap falls to the pair: sibling 7
    // is STOPped (retired) and the START fails — the old table plays alone,
    // its MCU pulses carry 80 ms, so the camera grows back to it.
    const { TrajectoryReplaceError } = await import("@orchestrator/controller");
    ctl.replaceError = new (TrajectoryReplaceError as unknown as new (
      m: string,
      r: boolean,
      c?: unknown,
      rep?: { id: number; maybeLive: boolean } | null,
      sibs?: readonly number[],
    ) => Error)("pair START REJ", true, undefined, null, [7]);
    perfNow += 200;
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    expect(h.triple.leases.L.camera.exposure).toBe(80_000);
    expect(h.tele.scan.exposure_us.L).toBe(80_000);
    expect(h.tele.scan.mismatch).toBe(false);
    expect(ctl.reports.some((r) => r.includes("clamped"))).toBe(false);
    // A Timed falling-END edit afterwards behaves as ever: identical MCU
    // spec, no swap, the unequal-windows reason alone.
    ctl.replaceError = null;
    perfNow += 200;
    await h.setState("tri_window_fall", [0.1, 0.6]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    expect(h.tele.scan.mismatch_reason).toBe(
      "unequal windows: Timed exposure gives both the rising window's length",
    );
  });

  it("reason order: the unconfirmed swap comes LAST, after a Timed reason", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    h.triple.leases.R.camera.modes.splice(1); // R: Timed only
    await h.setState("tri_window_rise", [0.1, 0.5]);
    await h.setState("tri_window_fall", [0.1, 0.8]);
    await h.call("startScan");
    await settle();
    expect(h.tele.scan.mismatch_reason).toBe(
      "unequal windows: Timed exposure gives both the rising window's length",
    );
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    expect(h.tele.scan.mismatch_reason).toBe(
      "unequal windows: Timed exposure gives both the rising window's length; " +
        "replacement swap unconfirmed — the mirror may run the previous edit",
    );
  });

  it("the failure warning says which table may run", async () => {
    const h = await harness();
    await h.call("startScan");
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(
      ctl.reports.filter((r) =>
        r.includes("may run either the previous or the new edit"),
      ),
    ).toHaveLength(1);
    expect(ctl.reports.some((r) => r.includes("keeps its previous"))).toBe(
      false,
    );

    const g = await harness();
    await g.call("startScan");
    ctl.replaceError = new Error("upload REJ");
    await g.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(
      ctl.reports.filter((r) =>
        r.includes(
          "live trajectory re-upload failed: upload REJ — the scan keeps its previous geometry",
        ),
      ),
    ).toHaveLength(1);
    expect(ctl.reports.some((r) => r.includes("may run either"))).toBe(false);
  });

  it("capacity: three possibly-live failures fill the tables → the current spec restarts", async () => {
    const h = await harness();
    await h.call("startScan");
    const first = h.traj();
    for (const [i, amp] of [0.6, 0.7, 0.8].entries()) {
      ctl.replaceError = await replaceErrorWith(7 + i, true);
      perfNow += 200;
      await h.setState("scan_amp", amp);
      await vi.advanceTimersByTimeAsync(200);
      await settle(30);
    }
    // 1 running + 3 possibly-live siblings = TRAJECTORY_MAX_TABLES: no swap
    // can be uploaded — stop → start of the CURRENT spec.
    // The edits + the first streak's one settling retry (inside the first
    // edit's 200 ms, failing on id 7 again).
    expect(first.replaceCalls).toBe(4);
    expect(first.stops).toBeGreaterThanOrEqual(1);
    expect(first.closes).toBe(1);
    expect(ctl.trajectories).toHaveLength(2);
    expect(h.traj().state).toBe("running");
    expect(h.traj().startCalls).toBe(1);
    const ref = patternSamples("ellipse", 10, 0, 0.8, 0.5);
    const want = chainVolts({ x: 0, y: 0 }, ref[5]!.offset);
    expect(h.traj().spec.samples[5]!.left.x).toBeCloseTo(want.left.x, 9);
    expect(
      ctl.reports.filter((r) =>
        r.includes(
          "live edits exhausted the controller's tables — the scan restarts",
        ),
      ),
    ).toHaveLength(1);
    expect(h.tele.scan.mismatch).toBe(false);
    expect(h.tele.scan.amp_deg).toBe(0.8);
    // A fourth edit swaps on the fresh run as usual.
    ctl.replaceError = null;
    perfNow += 200;
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaced).toHaveLength(1);
    expect(h.tele.scan.amp_deg).toBe(0.9);
    expect(h.tele.scan.mismatch).toBe(false);
  });

  it("capacity: the controller's own capacity refusal restarts the scan too", async () => {
    const h = await harness();
    await h.call("startScan");
    const { TrajectoryCapacityError } =
      await import("@orchestrator/controller");
    ctl.replaceError =
      new (TrajectoryCapacityError as unknown as new () => Error)();
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle(30);
    expect(ctl.trajectories).toHaveLength(2);
    expect(ctl.trajectories[0]!.closes).toBe(1);
    expect(h.traj().state).toBe("running");
    expect(
      ctl.reports.some((r) => r.includes("exhausted the controller's tables")),
    ).toBe(true);
    expect(ctl.reports.some((r) => r.includes("re-upload failed"))).toBe(false);
  });

  it("settling: one automatic replace per unconfirmed streak (re-armed by a user edit)", async () => {
    const h = await harness();
    await h.call("startScan");
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    // No user edit: inside the throttle nothing yet…
    perfNow += 50;
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    // …past it ONE settling replace of the current geometry.
    perfNow += 100;
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    // It fails unclear again (same sibling): no further automatic retry.
    perfNow += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    expect(h.tele.scan.mismatch_reason).toBe(
      "replacement swap unconfirmed — the mirror may run the previous edit",
    );
    // A user edit re-arms one retry after ITS failure.
    await h.setState("scan_amp", 1.0);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(3);
    perfNow += 200;
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(4);
    perfNow += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.traj().replaceCalls).toBe(4);
    // The settling retry that lands clears the state.
    ctl.replaceError = null;
    await h.setState("scan_amp", 0.8);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaced).toHaveLength(1);
    expect(h.tele.scan.mismatch).toBe(false);
  });

  it("settling: never when the retry could leave no table free", async () => {
    const h = await harness();
    await h.call("startScan");
    ctl.replaceError = await replaceErrorWith(7, true);
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    // The settling retry also fails unclear, on a NEW id: two siblings now
    // (1 + 2 ≥ TRAJECTORY_MAX_TABLES − 1) — and a user edit's failure there
    // schedules none either.
    ctl.replaceError = await replaceErrorWith(8, true);
    perfNow += 200;
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(2);
    ctl.replaceError = await replaceErrorWith(8, true);
    perfNow += 200;
    await h.setState("scan_amp", 1.0);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.traj().replaceCalls).toBe(3);
    perfNow += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(h.traj().replaceCalls).toBe(3);
    expect(ctl.trajectories).toHaveLength(1);
  });
});

describe("scan.amp_deg", () => {
  it("is the RUNNING amplitude: a failed replace leaves it at the old one", async () => {
    const h = await harness({ state: { scan_amp: 0.5 } });
    await h.call("startScan");
    expect(h.tele.scan.amp_deg).toBe(0.5);
    ctl.replaceError = new Error("upload REJ");
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    expect(h.tele.scan.amp_deg).toBe(0.5);
    await h.tick();
    expect(h.tele.scan.amp_deg).toBe(0.5);
    // ...and a replace that lands publishes the new one.
    ctl.replaceError = null;
    perfNow += 200;
    await h.setState("scan_amp", 0.8);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.tele.scan.amp_deg).toBe(0.8);
  });
});

describe("period change", () => {
  it("scan_hz while active: stop → rebuild → start, keeping the camera config", async () => {
    const h = await harness();
    await h.call("startScan");
    const first = h.traj();
    await h.setState("scan_hz", 20);
    await settle(30);
    expect(first.closes).toBe(1);
    expect(ctl.trajectories).toHaveLength(2);
    expect(h.traj().spec.periodUs).toBe(50_000);
    expect(h.traj().state).toBe("running");
    expect(ctl.triggerOn).toEqual(["SL", "SR"]); // not re-armed
    expect(ctl.triggerOff).toEqual([]);
    expect(h.tele.scan.hz).toBe(20);
  });

  it("scan_mode while active: restarts into the triangle and builds the flip pipes", async () => {
    const h = await harness();
    await h.call("startScan");
    expect(h.flipSeam.attached).toHaveLength(0);
    await h.setState("scan_mode", "triangle");
    await settle(30);
    expect(ctl.trajectories).toHaveLength(2);
    expect(h.traj().spec.periodUs).toBe(200_000);
    expect(h.flipSeam.attached.map((a) => a.id)).toEqual([
      "camera/SL/convert/flip",
      "camera/SR/convert/flip",
    ]);
    await h.setState("scan_mode", "ellipse");
    await settle(30);
    expect(h.flipSeam.detached).toEqual([
      "camera/SL/convert/flip",
      "camera/SR/convert/flip",
    ]);
    expect(h.state.flipPipes).toEqual({ L: null, R: null });
  });
});

describe("triangle window sync", () => {
  it("mirrors every rising write into the falling window; sync-on copies once", async () => {
    const h = await harness({ state: { scan_mode: "triangle" } });
    await h.setState("tri_window_rise", [0.2, 0.7]);
    expect(h.state.tri_window_fall).toEqual([0.2, 0.7]);
    await h.setState("tri_window_fall", [0.1, 0.3]); // snapped back while synced
    expect(h.state.tri_window_fall).toEqual([0.2, 0.7]);
    await h.setState("tri_window_sync", false);
    await h.setState("tri_window_fall", [0.1, 0.3]);
    expect(h.session.state.tri_window_fall).toEqual([0.1, 0.3]);
    await h.setState("tri_window_rise", [0.3, 0.6]);
    expect(h.session.state.tri_window_fall).toEqual([0.1, 0.3]);
    await h.setState("tri_window_sync", true);
    expect(h.state.tri_window_fall).toEqual([0.3, 0.6]);
  });

  it("clamps a window past WINDOW_MAX and writes it back", async () => {
    const h = await harness();
    await h.setState("scan_window", [0.5, 1]);
    expect(h.state.scan_window).toEqual([0.5, 0.95]);
  });
});

describe("triangle flip", () => {
  it("builds one flip pipe per eye, pushes OK anchors, retires on stop", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", ring_reader: true },
    });
    expect(h.broker.connect).toHaveBeenCalledWith("camera/SL/convert");
    await h.call("startScan");
    await settle();
    const T = sweepUs(10);
    // Default windows [0.05, 0.95]: the EDGE gap between the two markers is
    // 0.1 T (rising end 0.95 T → falling start 1.05 T) → 0.04 T.
    const tol = BigInt(0.04 * T * 1000);
    expect(h.flipSeam.attached).toEqual([
      {
        src: "camera/SL/convert",
        id: "camera/SL/convert/flip",
        toleranceNs: tol,
        anchorFrom: "controller/trajectory",
      },
      {
        src: "camera/SR/convert",
        id: "camera/SR/convert/flip",
        toleranceNs: tol,
        anchorFrom: "controller/trajectory",
      },
    ]);
    // Advertised with the BROKER's record of the source pipe.
    expect(h.flipSeam.advertised).toEqual([
      { id: "camera/SL/convert/flip", width: 80 },
      { id: "camera/SR/convert/flip", width: 80 },
    ]);
    expect(h.state.flipPipes).toEqual({
      L: "camera/SL/convert/flip",
      R: "camera/SR/convert/flip",
    });
    // The ring reader re-bound to the flip pipes.
    expect(h.broker.connect).toHaveBeenCalledWith("camera/SL/convert/flip");
    expect(ctl.workers.at(-1)!.init.pipes).toHaveLength(2);
    // Graph rows are the brick's NATIVE ones (anchorFrom names the trajectory
    // input) — the session registers none.
    expect(
      ctl.wirings.flatMap((w) => w.nodes).some((n) => n.kind === "flip"),
    ).toBe(false);
    expect(
      ctl.wirings.some((w) =>
        (w.edges as Array<{ to: string }>).some((e) => e.to.endsWith("/flip")),
      ),
    ).toBe(false);
    await h.tick();
    expect(h.tele.perf.trajectory.flip_tolerance_us).toBe(0.04 * T);
    // OK pushes → anchors carrying BOTH exposure edges (falling = marker 1 =
    // flip; the pulse is that marker's: 0.9 T); failed ones → none.
    h.traj().push({ marker: 0, status: "OK", tExposure: 5n });
    h.traj().push({ marker: 1, status: "OK", tExposure: 9n });
    h.traj().push({ marker: 1, status: "STROBE_TIMEOUT", tExposure: 11n });
    expect(h.flipSeam.pools["camera/SL/convert/flip"]).toEqual([
      { tStart: 5n, tEnd: 5n + 90_000_000n, flip: false },
      { tStart: 9n, tEnd: 9n + 90_000_000n, flip: true },
    ]);
    expect(h.flipSeam.pools["camera/SR/convert/flip"]).toHaveLength(2);
    await h.call("stopScan");
    await settle();
    expect(h.flipSeam.detached).toEqual([
      "camera/SL/convert/flip",
      "camera/SR/convert/flip",
    ]);
    expect(h.flipSeam.unadvertised).toEqual([
      "camera/SL/convert/flip",
      "camera/SR/convert/flip",
    ]);
    expect(h.state.flipPipes).toEqual({ L: null, R: null });
    expect(
      ctl.wirings.flatMap((w) => w.nodes).some((n) => n.kind === "flip"),
    ).toBe(false);
    // ...and the reader is back on the raw pipes.
    expect(h.broker.connect.mock.calls.at(-1)![0]).toMatch(
      /^camera\/S[LR]\/convert$/,
    );
  });

  it("builds nothing in ellipse mode", async () => {
    const h = await harness({ state: { ring_reader: true } });
    await h.call("startScan");
    h.traj().push({ marker: 0, status: "OK", tExposure: 5n });
    expect(h.flipSeam.attached).toHaveLength(0);
    expect(h.state.flipPipes ?? { L: null, R: null }).toEqual({
      L: null,
      R: null,
    });
  });

  it("tightens the tolerance when the windows bring the markers close", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    await h.setState("tri_window_rise", [0.9, 0.95]);
    await h.setState("tri_window_fall", [0, 0.5]);
    await h.call("startScan");
    await settle();
    // Rising ends at 0.95 T, falling starts at T: a 0.05 T EDGE gap → 0.02 T.
    expect(h.flipSeam.attached[0]!.toleranceNs).toBe(
      BigInt(Math.round(0.4 * 0.05 * sweepUs(10) * 1000)),
    );
  });

  it("warns once when falling frames beat their marker push (unmatched)", async () => {
    const h = await harness({ state: { scan_mode: "triangle" } });
    await h.call("startScan");
    await h.tick();
    h.flipSeam.probes["camera/SL/convert/flip"] = {
      frames: 40,
      flipped: 10,
      unmatched: 5,
    };
    perfNow += 600;
    await h.tick();
    expect(h.tele.perf.trajectory.unmatched).toEqual({ L: 5, R: 0 });
    expect(h.tele.perf.trajectory.flipped).toEqual({ L: 10, R: 0 });
    expect(
      ctl.reports.filter((r) => r.includes("before their marker push")),
    ).toHaveLength(1);
    h.flipSeam.probes["camera/SL/convert/flip"] = {
      frames: 80,
      flipped: 20,
      unmatched: 15,
    };
    perfNow += 600;
    await h.tick();
    expect(
      ctl.reports.filter((r) => r.includes("before their marker push")),
    ).toHaveLength(1);
  });

  it("tolerance floor 1 ms; floor above the 0.45 × edge-gap cap → mismatch, scan runs", async () => {
    // 50 Hz: T = 20 ms. Rising [0.8, 0.88] ends at 17.6 ms, falling starts at
    // T: a 2.4 ms EDGE gap → 0.96 ms, floored to 1 ms (the cap is 1.08 ms).
    const h = await harness({
      maxFps: 500,
      state: { scan_mode: "triangle", tri_window_sync: false, scan_hz: 50 },
    });
    await h.setState("tri_window_rise", [0.8, 0.88]);
    await h.setState("tri_window_fall", [0, 0.5]);
    expect(await h.call("startScan")).toBe(true);
    await settle();
    expect(h.flipSeam.attached[0]!.toleranceNs).toBe(1_000_000n);
    expect(h.tele.scan.mismatch).toBe(false);
    // The round-1 review's "OK" case: rising [0.88, 0.95] STARTS 2.4 ms before
    // the fall but ENDS 1 ms before it — cap 0.45 ms < the floor → too close;
    // the tolerance is the cap (rebuilt tighter on the replace) and mismatch
    // names it.
    await h.setState("tri_window_rise", [0.88, 0.95]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.flipSeam.attached.at(-1)!.toleranceNs).toBe(450_000n);
    expect(h.tele.scan.mismatch).toBe(true);
    expect(h.tele.scan.mismatch_reason).toBe(
      "exposure windows too close for reliable flipping at this frequency",
    );
    expect(h.tele.scan).not.toBeNull();
  });

  it("default windows at 100 Hz: a 1 ms edge gap is too close to flip reliably", async () => {
    const h = await harness({
      maxFps: 500,
      state: { scan_mode: "triangle", scan_hz: 100 },
    });
    expect(await h.call("startScan")).toBe(true);
    await settle();
    expect(h.flipSeam.attached[0]!.toleranceNs).toBe(450_000n);
    expect(h.tele.scan.mismatch_reason).toBe(
      "exposure windows too close for reliable flipping at this frequency",
    );
    // ...and at 10 Hz the same windows are fine (4 ms of a 10 ms gap).
    const ok = await harness({ maxFps: 500, state: { scan_mode: "triangle" } });
    await ok.call("startScan");
    await settle();
    expect(ok.flipSeam.attached[0]!.toleranceNs).toBe(4_000_000n);
    expect(ok.tele.scan.mismatch).toBe(false);
  });

  it("a tightened tolerance widens back once the windows move apart (round-3 hysteresis)", async () => {
    // 50 Hz, T = 20 ms: rising [0.8, 0.88] → a 2.4 ms edge gap → the 1 ms floor.
    const h = await harness({
      maxFps: 500,
      state: { scan_mode: "triangle", tri_window_sync: false, scan_hz: 50 },
    });
    await h.setState("tri_window_rise", [0.8, 0.88]);
    await h.setState("tri_window_fall", [0, 0.5]);
    await h.call("startScan");
    await settle();
    expect(h.flipSeam.attached.map((a) => a.toleranceNs)).toEqual([
      1_000_000n,
      1_000_000n,
    ]);
    // Dragged close: a 1 ms edge gap → the 0.45 ms cap, too close.
    await h.setState("tri_window_rise", [0.88, 0.95]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.flipSeam.attached).toHaveLength(4);
    expect(h.flipSeam.attached.at(-1)!.toleranceNs).toBe(450_000n);
    expect(h.tele.scan.mismatch_reason).toBe(
      "exposure windows too close for reliable flipping at this frequency",
    );
    // ...and apart again: 450 µs is below the floor that fits again → wider.
    perfNow += 200;
    await h.setState("tri_window_rise", [0.8, 0.88]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.flipSeam.attached).toHaveLength(6);
    expect(h.flipSeam.attached.at(-1)!.toleranceNs).toBe(1_000_000n);
    expect(h.tele.scan.mismatch).toBe(false);
    expect(h.tele.scan.mismatch_reason).toBeNull();
    await h.tick();
    expect(h.tele.perf.trajectory.flip_tolerance_us).toBe(1000);
  });

  it("sync on: small rising-window widenings keep the bricks while the tolerance fits the cap", async () => {
    // 10 Hz defaults: a 10 ms edge gap → 4 ms (cap 4.5 ms).
    const h = await harness({
      state: { scan_mode: "triangle", ring_reader: true },
    });
    await h.call("startScan");
    await settle();
    expect(h.flipSeam.attached).toHaveLength(2);
    const workers = ctl.workers.length;
    const flipPipes = h.state.flipPipes;
    // Each widening (mirrored into the falling window) shrinks the gap by
    // 0.2 ms: caps 4.41 → 4.14 ms, all above the 4 ms in force.
    for (const start of [0.048, 0.046, 0.044, 0.042]) {
      perfNow += 200;
      await h.setState("tri_window_rise", [start, 0.95]);
      await vi.advanceTimersByTimeAsync(200);
      await settle();
    }
    expect(h.traj().replaced).toHaveLength(4);
    expect(h.traj().replaced.at(-1)!.markers![1]!.tOffsetUs).toBe(104_200);
    expect(h.flipSeam.attached).toHaveLength(2); // no rebuild
    expect(h.flipSeam.detached).toEqual([]);
    expect(h.state.flipPipes).toBe(flipPipes);
    expect(ctl.workers.length).toBe(workers);
    expect(h.tele.scan.mismatch).toBe(false);
    await h.tick();
    expect(h.tele.perf.trajectory.flip_tolerance_us).toBe(4000);
  });

  it("buildFlips is all or nothing: the second eye's attach fails → the first retires, start refused", async () => {
    const h = await harness({ state: { scan_mode: "triangle" } });
    const attach = h.flipSeam.attach;
    h.flipSeam.attach = (src, id, o) => {
      if (id === "camera/SR/convert/flip")
        throw new Error("native attach failed");
      attach(src, id, o);
    };
    expect(await h.call("startScan")).toBe(false);
    await settle();
    expect(h.flipSeam.attached.map((a) => a.id)).toEqual([
      "camera/SL/convert/flip",
    ]);
    // The first eye's brick retired; the second never left an advertised pipe.
    expect(h.flipSeam.detached).toEqual(["camera/SL/convert/flip"]);
    expect(h.flipSeam.unadvertised).toEqual([
      "camera/SR/convert/flip",
      "camera/SL/convert/flip",
    ]);
    expect(h.state.flipPipes ?? { L: null, R: null }).toEqual({
      L: null,
      R: null,
    });
    expect(h.tele.scan_blocked).toBe(
      "trajectory start failed: native attach failed",
    );
    expect(h.tele.scan).toBeFalsy();
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
    expect(h.traj().startCalls).toBe(0);
    expect(h.traj().closes).toBe(1);
  });

  it("accumulates flip counters across brick rebuilds within a run; skew from the probe", async () => {
    const h = await harness({
      state: { scan_mode: "triangle", tri_window_sync: false },
    });
    await h.call("startScan");
    h.flipSeam.probes["camera/SL/convert/flip"] = {
      frames: 30,
      flipped: 10,
      unmatched: 2,
      matchedSkewNs: 41_500,
    };
    await h.tick();
    expect(h.tele.perf.trajectory.skew_us).toEqual({ L: 41.5, R: 0 });
    // A probe that matched nothing new keeps the last skew (0 is no reading).
    h.flipSeam.probes["camera/SL/convert/flip"] = {
      frames: 32,
      flipped: 10,
      unmatched: 4,
      matchedSkewNs: 0,
    };
    await h.tick();
    expect(h.tele.perf.trajectory.skew_us.L).toBe(41.5);
    // Markers closer → tighter tolerance → the bricks are rebuilt (count from 0).
    await h.setState("tri_window_rise", [0.9, 0.95]);
    await h.setState("tri_window_fall", [0, 0.5]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.flipSeam.attached).toHaveLength(4);
    h.flipSeam.probes["camera/SL/convert/flip"] = {
      frames: 5,
      flipped: 3,
      unmatched: 1,
    };
    await h.tick();
    expect(h.tele.perf.trajectory.flipped).toEqual({ L: 13, R: 0 });
    expect(h.tele.perf.trajectory.unmatched).toEqual({ L: 5, R: 0 });
    // A new run starts over.
    await h.call("stopScan");
    await h.call("startScan");
    await h.tick();
    expect(h.tele.perf.trajectory.flipped).toEqual({ L: 0, R: 0 });
    expect(h.tele.perf.trajectory.skew_us).toEqual({ L: 0, R: 0 });
  });
});

describe("telemetry", () => {
  it("publishes the path, windows and axis handle in px — {0,0}/empty uncalibrated", async () => {
    const h = await harness();
    await h.setState("scan_amp", 1);
    expect(h.tele.scan_path.L).toHaveLength(48);
    expect(h.tele.scan_path_px).toHaveLength(48);
    expect(h.tele.scan_window_px).toHaveLength(1);
    // Axis 0, 1° → the handle at A2P.C(A0 + (1°, 0)).
    expect(h.tele.axis_handle_px.x).toBeCloseTo((Math.PI / 180) * 1000, 9);
    expect(h.tele.axis_handle_px.y).toBeCloseTo(0, 9);
    await h.setState("scan_mode", "triangle");
    expect(h.tele.scan_window_px).toHaveLength(2);
    const u = await harness({ calibrated: false });
    expect(u.tele.scan_path.L.length).toBe(48);
    expect(u.tele.scan_path_px).toEqual([]);
    expect(u.tele.scan_window_px).toEqual([]);
    expect(u.tele.axis_handle_px).toEqual({ x: 0, y: 0 });
    expect(u.tele.scan_center_px).toEqual({ x: 0, y: 0 });
  });

  it("publishes scan_path_closed WITH the path: ellipse ratio > 0 only", async () => {
    const h = await harness();
    expect(h.tele.scan_path_closed).toBe(true); // the default circle
    await h.setState("scan_ratio", 0.4);
    expect(h.tele.scan_path_closed).toBe(true);
    await h.setState("scan_ratio", 0);
    expect(h.tele.scan_path_closed).toBe(false); // a line
    await h.setState("scan_ratio", 1);
    expect(h.tele.scan_path_closed).toBe(true);
    await h.setState("scan_mode", "triangle");
    expect(h.tele.scan_path_closed).toBe(false);
  });

  it("publishes scan_center_px; the handle encodes the axis even at amplitude 0", async () => {
    const h = await harness();
    await h.call("steer", { x: 20, y: -10 });
    await settle();
    expect(h.tele.scan_center_px.x).toBeCloseTo(20, 9);
    expect(h.tele.scan_center_px.y).toBeCloseTo(-10, 9);
    await h.setState("scan_axis_deg", 90);
    await h.setState("scan_amp", 0);
    const c = h.tele.scan_center_px as Point2d;
    const a = h.tele.axis_handle_px as Point2d;
    expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThan(0);
    // Straight +y from the center (axis 90°), ε = 0.01° away.
    expect(a.x - c.x).toBeCloseTo(0, 9);
    expect(a.y - c.y).toBeCloseTo(0.01 * (Math.PI / 180) * 1000, 9);
  });

  it("counts pushes by status and reports exact lateness", async () => {
    const h = await harness();
    await h.call("startScan");
    const start = h.traj().startedAt!;
    // Marker 0 of cycle 2 is due at start + 2·P; 37 µs late.
    h.traj().push({
      status: "OK",
      marker: 0,
      cycle: 2,
      tTrigger: start + 200_000_000n + 37_000n,
    });
    h.traj().push({ status: "STROBE_TIMEOUT", marker: 0, cycle: 3 });
    h.traj().push({ status: "BUSY", marker: 0, cycle: 4 });
    h.traj().push({ status: "CANCELLED", marker: null });
    await h.tick();
    expect(h.tele.perf.trajectory).toEqual({
      running: true,
      pushes: { ok: 1, timeout: 1, busy: 1, other: 1 },
      lateness_us: 37,
      reuploads: 0,
      flipped: { L: 0, R: 0 },
      unmatched: { L: 0, R: 0 },
      skew_us: { L: 0, R: 0 },
      flip_tolerance_us: 0,
      last_swap: null,
      stalled: false,
    });
  });

  it("re-bases the start when a re-ping moves the controller clock offset", async () => {
    const h = await harness();
    ctl.controller!.clockOffsetNs = 0n;
    await h.call("startScan");
    const start = h.traj().startedAt!;
    h.traj().push({
      status: "OK",
      marker: 0,
      cycle: 2,
      tTrigger: start + 200_000_000n + 9_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(9);
    // The offset moves +40 µs: later pushes read 40 µs later in host ns for
    // the same MCU instant; the scored start follows, so lateness holds.
    ctl.controller!.clockOffsetNs = 40_000n;
    h.traj().push({
      status: "OK",
      marker: 0,
      cycle: 3,
      tTrigger: start + 300_000_000n + 9_000n + 40_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(9);
  });

  it("warns once per run when no OK push arrives for two periods", async () => {
    const h = await harness();
    await h.call("startScan");
    perfNow += 150; // < 2 periods past the start (lead included)
    await h.tick(0);
    expect(
      ctl.reports.filter((r) => r.includes("no fovea exposure")),
    ).toHaveLength(0);
    perfNow += 200;
    await h.tick(0);
    perfNow += 400;
    await h.tick(0);
    expect(
      ctl.reports.filter((r) => r.includes("no fovea exposure")),
    ).toHaveLength(1);
    // ...naming the BUSY-after-a-missed-strobe case.
    expect(
      ctl.reports.some((r) =>
        r.includes(
          "a missed strobe keeps the capture engine busy past the next trigger when the gap after the window is under 5 ms",
        ),
      ),
    ).toBe(true);
  });

  it("stalled: no OK push for two periods after good ones → true at the throttle, an OK push clears it", async () => {
    const h = await harness();
    await h.call("startScan");
    const start = h.traj().startedAt!;
    const ok = (cycle: number, lateUs = 0) =>
      h.traj().push({
        status: "OK",
        marker: 0,
        cycle,
        tTrigger: start + BigInt(cycle) * 100_000_000n + BigInt(lateUs) * 1000n,
      });
    perfNow += 100;
    ok(1);
    perfNow += 100;
    ok(2);
    await h.tick(0);
    expect(h.tele.perf.trajectory.stalled).toBe(false);
    expect(h.tele.perf.trajectory.pushes.ok).toBe(2);
    // The cable comes loose: timeouts only. 2 periods (200 ms) is not yet.
    h.traj().push({ status: "STROBE_TIMEOUT", marker: 0, cycle: 3 });
    perfNow += 200;
    await h.tick(0);
    expect(h.tele.perf.trajectory.stalled).toBe(false);
    perfNow += 50;
    await h.tick(0);
    expect(h.tele.perf.trajectory.stalled).toBe(true); // republished
    perfNow += 400;
    await h.tick(0);
    expect(h.tele.perf.trajectory.stalled).toBe(true);
    // The watchdog's warning still fires exactly once.
    expect(
      ctl.reports.filter((r) => r.includes("no fovea exposure")),
    ).toHaveLength(1);
    // An OK push clears it at once (no throttle tick needed), and the
    // republish carries THAT push's lateness, not the previous one's.
    ok(9, 13);
    await settle();
    expect(h.tele.perf.trajectory.stalled).toBe(false);
    expect(h.tele.perf.trajectory.lateness_us).toBe(13);
    // ...and a stop publishes it false.
    perfNow += 1000;
    await h.tick(0);
    expect(h.tele.perf.trajectory.stalled).toBe(true);
    await h.call("stopScan");
    await settle();
    expect(h.tele.perf.trajectory.stalled).toBe(false);
  });

  it("a clock lapse mid-scan is a mismatch_reason (no stop), re-evaluated at the throttle", async () => {
    const h = await harness();
    await h.call("startScan");
    await settle();
    expect(h.tele.scan.mismatch).toBe(false);
    ctl.controller!.clockCalibrated = false;
    await h.tick();
    expect(h.tele.scan).not.toBeNull();
    expect(h.tele.scan.mismatch_reason).toBe(
      "controller clock calibration lapsed",
    );
    expect(h.traj().stops).toBe(0);
    ctl.controller!.clockCalibrated = true;
    await h.tick();
    expect(h.tele.scan.mismatch).toBe(false);
    expect(h.tele.scan.mismatch_reason).toBeNull();
  });

  it("setAxis turns the axis toward the pointer; on the center it keeps it", async () => {
    const h = await harness();
    await h.call("steer", { x: 10, y: 10 });
    await h.call("setAxis", { x: 10, y: 30 }); // straight +y from the center
    await settle();
    expect(h.state.scan_axis_deg).toBeCloseTo(90, 9);
    expect(h.tele.axis_handle_px.x).toBeCloseTo(10, 6);
    await h.call("setAxis", { x: 10, y: 10 });
    await settle();
    expect(h.state.scan_axis_deg).toBeCloseTo(90, 9);
    // Just past the seam (-179.8°): folded onto the slider's left end.
    const r = 100;
    const a = 0.2 * (Math.PI / 180);
    await h.call("setAxis", {
      x: 10 - r * Math.cos(a),
      y: 10 - r * Math.sin(a),
    });
    await settle();
    expect(h.state.scan_axis_deg).toBe(-179.5);
    // +179.8° is on the slider: kept exactly.
    await h.call("setAxis", {
      x: 10 - r * Math.cos(a),
      y: 10 + r * Math.sin(a),
    });
    await settle();
    expect(h.state.scan_axis_deg).toBeCloseTo(179.8, 9);
    const u = await harness({ calibrated: false });
    await u.call("setAxis", { x: 5, y: 5 });
    await settle();
    expect(u.session.state.scan_axis_deg).toBe(0);
  });
});

// --- lifecycle interleavings (review round 1, spec §lifecycle) ---------------

describe("lifecycle: a run ending during an await", () => {
  it("detach mid-replace + a plain Error from the dead device → the scan aborts", async () => {
    const h = await harness();
    await h.call("startScan");
    const g = gate();
    ctl.replaceGate = g.p;
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1);
    h.traj().setState("detached");
    ctl.replaceError = new Error("Controller not connected");
    g.open();
    await settle(40);
    expect(h.tele.scan).toBeNull();
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
    expect(h.tele.scan_blocked).toMatch(
      /re-upload ended the run: Controller not connected/,
    );
  });

  it("a run that went `ready` mid-replace aborts once the swap settles (failure or success)", async () => {
    for (const fails of [true, false]) {
      const h = await harness();
      await h.call("startScan");
      const g = gate();
      ctl.replaceGate = g.p;
      await h.setState("scan_amp", 0.9);
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      h.traj().setState("ready"); // e.g. a run-level CANCELLED push mid-swap
      if (fails) ctl.replaceError = new Error("upload REJ");
      g.open();
      await settle(40);
      expect(h.tele.scan).toBeNull();
      expect(ctl.triggerOff).toEqual(["SL", "SR"]);
      expect(h.tele.scan_blocked).toMatch(
        fails
          ? /re-upload ended the run: upload REJ/
          : /the controller ended the trajectory run/,
      );
    }
  });

  it("a CANCELLED push during START refuses the start and restores", async () => {
    const h = await harness();
    const g = gate();
    ctl.startGate = g.p;
    const started = h.call<boolean>("startScan");
    await settle();
    expect(h.traj().startCalls).toBe(1);
    h.traj().setState("ready");
    g.open();
    expect(await started).toBe(false);
    await settle();
    expect(h.tele.scan_blocked).toBe(
      "the controller ended the trajectory run before the scan started",
    );
    expect(h.tele.scan ?? null).toBeNull();
    expect(h.traj().closes).toBe(1);
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
  });
});

describe("lifecycle: edits during a start are reconciled at the commit", () => {
  it("a geometry change while starting is swapped in right after the commit", async () => {
    const h = await harness();
    const g = gate();
    ctl.openGate = g.p;
    const started = h.call<boolean>("startScan");
    await settle();
    await h.setState("scan_amp", 0.9);
    g.open();
    expect(await started).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaced).toHaveLength(1);
    const ref = patternSamples("ellipse", 10, 0, 0.9, 1);
    const want = chainVolts({ x: 0, y: 0 }, ref[3]!.offset);
    expect(h.traj().replaced[0]!.samples[3]!.left.x).toBeCloseTo(
      want.left.x,
      9,
    );
  });

  it("a scan_hz change while starting restarts into the new period", async () => {
    const h = await harness();
    const g = gate();
    ctl.openGate = g.p;
    const started = h.call<boolean>("startScan");
    await settle();
    await h.setState("scan_hz", 20);
    g.open();
    expect(await started).toBe(true);
    await settle(40);
    expect(ctl.trajectories).toHaveLength(2);
    expect(h.traj().spec.periodUs).toBe(50_000);
    expect(h.traj().state).toBe("running");
    expect(h.tele.scan.hz).toBe(20);
  });
});

describe("lifecycle: round-2 interleavings", () => {
  it("a Timed end-edit during the start is re-timed at the commit (identical spec)", async () => {
    const h = await harness({ modes: ["Timed"] });
    const g = gate();
    ctl.openGate = g.p;
    const started = h.call<boolean>("startScan");
    await settle();
    expect(h.triple.leases.L.camera.exposure).toBe(95_000); // armed for [0, 0.95]
    await h.setState("scan_window", [0, 0.5]); // only the pulse moves
    g.open();
    expect(await started).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.triple.leases.L.camera.exposure).toBe(50_000);
    expect(h.triple.leases.R.camera.exposure).toBe(50_000);
    expect(h.traj().replaced.at(-1)!.markers).toEqual([
      { tOffsetUs: 0, pulseUs: 50_000, cameras: ["L", "R"] },
    ]);
  });

  it("Timed: a growing exposure swaps first, a shrinking one re-times first", async () => {
    const h = await harness({ modes: ["Timed"] });
    const cam = h.triple.leases.L.camera;
    let v = cam.exposure;
    Object.defineProperty(cam, "exposure", {
      get: () => v,
      set: (x: number) => {
        v = x;
        ctl.events.push(`exposure=${x}`);
      },
    });
    await h.setState("scan_window", [0, 0.5]);
    await h.call("startScan");
    await settle();
    // Grow 50 → 80 ms: the MCU pulse must be the longer one first.
    ctl.events.length = 0;
    await h.setState("scan_window", [0, 0.8]);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(ctl.events).toEqual(["traj-replace", "exposure=80000"]);
    expect(h.traj().replaced.at(-1)!.markers![0]!.pulseUs).toBe(80_000);
    // Shrink 80 → 30 ms: the camera first.
    ctl.events.length = 0;
    perfNow += 200;
    await h.setState("scan_window", [0, 0.3]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(ctl.events).toEqual(["exposure=30000", "traj-replace"]);
    expect(h.traj().replaced.at(-1)!.markers![0]!.pulseUs).toBe(30_000);
  });

  it("a failed replace after a pre-swap re-time writes the previous exposure back", async () => {
    const h = await harness({ modes: ["Timed"] });
    await h.setState("scan_window", [0, 0.8]);
    await h.call("startScan");
    await settle();
    ctl.replaceError = new Error("upload REJ");
    await h.setState("scan_window", [0, 0.3]);
    await vi.advanceTimersByTimeAsync(0);
    await settle(30);
    expect(h.tele.scan).not.toBeNull();
    expect(h.traj().spec.markers![0]!.pulseUs).toBe(80_000); // the old table runs
    expect(h.triple.leases.L.camera.exposure).toBe(80_000); // ...and the camera matches it
    expect(h.triple.leases.R.camera.exposure).toBe(80_000);
    expect(h.tele.scan.exposure_us).toEqual({ L: 80_000, R: 80_000 });
    // The next replace that lands re-times again.
    ctl.replaceError = null;
    perfNow += 200;
    await h.setState("scan_window", [0, 0.31]);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(h.triple.leases.L.camera.exposure).toBe(31_000);
    expect(h.traj().spec.markers![0]!.pulseUs).toBe(31_000);
  });

  it("reused (alternating) table ids: an expired entry resolves to the pending spec", async () => {
    const h = await harness();
    ctl.alternateIds = true;
    await h.call("startScan");
    const t0 = h.traj().startedAt!;
    const idA = h.traj().id;
    await h.setState("scan_window", [0.2, 0.4]); // marker 0 at 20 ms, table B
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    const idB = h.traj().id;
    expect(idB).not.toBe(idA);
    // Past A's grace (95 ms pulse + 5 ms + 50 ms) the controller may hand A
    // out again — and does, for the next swap.
    ctl.hostNs += 1_000_000_000n;
    const g = gate();
    ctl.replaceGate = g.p;
    perfNow += 200;
    await h.setState("scan_window", [0.4, 0.6]); // marker 0 at 40 ms
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    // Mid-swap, a push from the REALLOCATED id A belongs to the new table.
    h.traj().push({
      trajectoryId: idA,
      marker: 0,
      cycle: 1,
      tTrigger: t0 + 140_000_000n + 7_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(7);
    g.open();
    await settle(30);
    expect(h.traj().id).toBe(idA);
    // B is in ITS grace now: its own spec (20 ms).
    h.traj().push({
      trajectoryId: idB,
      marker: 0,
      cycle: 2,
      tTrigger: t0 + 220_000_000n + 3_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(3);
    // A again, the live table (40 ms).
    h.traj().push({
      trajectoryId: idA,
      marker: 0,
      cycle: 3,
      tTrigger: t0 + 340_000_000n + 5_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(5);
  });

  it("a gain write queued during teardown is ignored (it would land after the restore)", async () => {
    const h = await harness();
    await h.call("startScan");
    const g = gate();
    ctl.replaceGate = g.p;
    await h.setState("scan_amp", 0.9); // a replace parks the op chain
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    h.session.unsubscribe(h.server); // teardown queues its stop + gain restore
    await settle();
    await h.setState("gain", 12); // queued AFTER the teardown op
    g.open();
    await settle(60);
    expect(h.triple.leases.L.camera.gain).toBe(3);
    expect(h.triple.leases.R.camera.gain).toBe(3);
  });

  it("a replace queued before a stop does not run", async () => {
    const h = await harness();
    await h.call("startScan");
    const g = gate();
    ctl.replaceGate = g.p;
    await h.setState("scan_amp", 0.6);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1); // in flight, parked
    perfNow += 150;
    await h.setState("scan_amp", 0.9);
    await vi.advanceTimersByTimeAsync(150);
    await settle(); // a second replace op is queued behind it
    const stopped = h.call("stopScan");
    await settle();
    g.open();
    await stopped;
    await settle(30);
    expect(h.traj().replaceCalls).toBe(1);
    expect(h.tele.scan).toBeNull();
  });

  it("a restart after the run detached aborts with the run-end reason (no re-open)", async () => {
    const h = await harness();
    await h.call("startScan");
    h.traj().state = "detached"; // the notice not delivered yet
    await h.setState("scan_hz", 20);
    await settle(30);
    expect(ctl.trajectories).toHaveLength(1);
    expect(h.tele.scan).toBeNull();
    expect(h.tele.scan_blocked).toBe("controller disconnected — scan stopped");
    expect(h.tele.scan_blocked_kind).toBe("stopped");
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
  });

  it("a restart on a lapsed controller clock aborts", async () => {
    const h = await harness();
    await h.call("startScan");
    ctl.controller!.clockCalibrated = false;
    await h.setState("scan_hz", 20);
    await settle(30);
    expect(ctl.trajectories).toHaveLength(1);
    expect(h.tele.scan).toBeNull();
    expect(h.tele.scan_blocked).toBe(
      "controller clock calibration lapsed — press Start once it recovers",
    );
    expect(h.tele.scan_blocked_kind).toBe("stopped");
  });

  it("a start cancelled while queued never arms the cameras", async () => {
    const h = await harness();
    const g = gate();
    ctl.openGate = g.p;
    const first = h.call<boolean>("startScan"); // parks on the open
    await settle();
    const second = h.call<boolean>("startScan"); // queued behind it
    await settle();
    const stopped = h.call("stopScan");
    await settle();
    g.open();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await stopped;
    await settle();
    expect(ctl.triggerOn).toEqual(["SL", "SR"]); // the first start's only
    expect(ctl.trajectories).toHaveLength(1);
  });
});

describe("lifecycle: the replace throttle under a slow replace", () => {
  it("keeps ONE queued replace however many steer events arrive", async () => {
    const h = await harness();
    await h.call("startScan");
    const g = gate();
    ctl.replaceGate = g.p;
    await h.setState("scan_amp", 0.6);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(h.traj().replaceCalls).toBe(1); // in flight, parked
    for (const amp of [0.7, 0.8, 0.9, 1.0]) {
      perfNow += 150; // each past the 100 ms throttle
      await h.setState("scan_amp", amp);
      await vi.advanceTimersByTimeAsync(150);
      await settle();
    }
    const reads = ctl.controllerReads;
    g.open();
    await settle(40);
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    // ONE more op ran: one spec build (128 samples × 2 eyes of clamp reads)
    // and one replace, with the LATEST geometry.
    expect(ctl.controllerReads - reads).toBe(2 * 128);
    expect(h.traj().replaceCalls).toBe(2);
    expect(h.tele.scan.amp_deg).toBe(1.0);
  });
});

describe("lifecycle: no START after a stop or teardown was requested", () => {
  it("stopScan mid-start: the START never goes out; a later start works", async () => {
    const h = await harness();
    const g = gate();
    ctl.openGate = g.p;
    const started = h.call<boolean>("startScan");
    await settle();
    const stopped = h.call("stopScan");
    await settle();
    g.open();
    expect(await started).toBe(false);
    await stopped;
    await settle();
    expect(h.traj().startCalls).toBe(0);
    expect(h.traj().closes).toBe(1);
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
    expect(h.tele.scan_blocked).toBeNull();
    ctl.openGate = null;
    expect(await h.call("startScan")).toBe(true);
    expect(h.traj().startCalls).toBe(1);
  });

  it("teardown mid-start: no START, cameras restored", async () => {
    const h = await harness();
    const g = gate();
    ctl.openGate = g.p;
    const started = h.call<boolean>("startScan");
    await settle();
    h.session.unsubscribe(h.server);
    await settle();
    g.open();
    expect(await started).toBe(false);
    await settle(40);
    expect(h.traj().startCalls).toBe(0);
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
  });

  it("teardown during a restart takes the stop path instead of a START", async () => {
    const h = await harness();
    await h.call("startScan");
    const g = gate();
    ctl.openGate = g.p;
    await h.setState("scan_hz", 20); // restart: close, then open (parked)
    h.session.unsubscribe(h.server);
    await settle();
    g.open();
    await settle(40);
    expect(ctl.trajectories).toHaveLength(2);
    expect(h.traj().startCalls).toBe(0);
    expect(h.traj().closes).toBe(1);
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
  });

  it("teardown with a throwing scan-stop step still disarms the cameras and restores the gain", async () => {
    const h = await harness({ state: { ring_reader: true } });
    await h.call("startScan");
    await h.setState("gain", 12);
    expect(h.triple.leases.L.camera.gain).toBe(12);
    // The reader's enable-off (`sendParams`) throws inside the scan stop.
    ctl.sendParamsError = new Error("worker gone");
    h.session.unsubscribe(h.server);
    await settle(60);
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
    expect(h.triple.leases.L.camera.features.TriggerMode).toBe("Off");
    expect(h.triple.leases.L.camera.gain).toBe(3);
    expect(h.triple.leases.R.camera.gain).toBe(3);
    expect(h.traj().closes).toBe(1);
    expect(
      ctl.reports.some(
        (r) => r.includes("ring enable failed") && r.includes("worker gone"),
      ),
    ).toBe(true);
  });

  it("teardown stops the scan BEFORE closing the idle position input", async () => {
    const h = await harness();
    await h.call("startScan");
    h.session.unsubscribe(h.server);
    await settle(40);
    const close = ctl.events.indexOf("traj-close");
    expect(close).toBeGreaterThanOrEqual(0);
    expect(close).toBeLessThan(ctl.events.indexOf("pos-close"));
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
  });
});

describe("nits", () => {
  it("clamps scan_amp and writes it back", async () => {
    const h = await harness();
    await h.setState("scan_amp", 5);
    expect(h.state.scan_amp).toBe(2);
    await h.setState("scan_amp", -1);
    expect(h.state.scan_amp).toBe(0);
  });

  it("scores pushes by trajectoryId: the pending spec mid-swap, the old one in the grace", async () => {
    const h = await harness();
    await h.call("startScan");
    const t0 = h.traj().startedAt!;
    const oldId = h.traj().id;
    const g = gate();
    ctl.replaceGate = g.p;
    await h.setState("scan_window", [0.2, 0.4]); // marker 0 moves 0 → 20 ms
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    // Mid-swap, a push from the NEW table (an id this run has not seen yet).
    h.traj().push({
      trajectoryId: 999,
      marker: 0,
      cycle: 1,
      tTrigger: t0 + 120_000_000n + 7_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(7);
    g.open();
    await settle(30);
    expect(h.traj().id).not.toBe(oldId);
    // A late push of the OLD table (the retired-id grace): its own spec.
    h.traj().push({
      trajectoryId: oldId,
      marker: 0,
      cycle: 2,
      tTrigger: t0 + 200_000_000n + 3_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(3);
    // ...and the new table's, against the new spec.
    h.traj().push({
      marker: 0,
      cycle: 3,
      tTrigger: t0 + 320_000_000n + 4_000n,
    });
    await h.tick();
    expect(h.tele.perf.trajectory.lateness_us).toBe(4);
  });
});
