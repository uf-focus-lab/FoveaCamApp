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
  controller: null as null | { v22Capable: boolean; dv: number },
  trajectories: [] as Array<FakeTrajectory>,
  openError: null as Error | null,
  replaceError: null as Error | null,
  pacerTick: null as null | (() => void),
  positionUpdates: 0,
  triggerOn: [] as string[],
  triggerOff: [] as string[],
  reports: [] as string[],
  wirings: [] as Array<{ nodes: Array<{ id: string; kind: string }>; edges: unknown[] }>,
  workers: [] as Array<{ init: { pipes: Array<{ role: string }> } }>,
  hostNs: 1_000_000_000n,
  /** The triple `acquireTriple` hands out — built per test (fake cameras). */
  triple: null as unknown,
}));

// A class can't be hoisted with vi.hoisted, so the trajectory is a plain
// factory-built object typed here.
type FakeTrajectory = {
  name: string;
  spec: Spec;
  state: string;
  startedAt: bigint | null;
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
  onStateChange(cb: (s: string, d: { controllerAvailable: boolean }) => void): () => void;
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
      spec,
      state: "ready",
      startedAt: null,
      replaced: [],
      stops: 0,
      closes: 0,
      frameCbs: [],
      stateCbs: [],
      async start(at) {
        t.startedAt = at ?? null;
        t.state = "running";
      },
      async stop() {
        t.stops++;
        if (t.state === "running") t.state = "ready";
      },
      async close() {
        t.closes++;
        t.state = "closed";
      },
      async replace(next) {
        if (ctl.replaceError) throw ctl.replaceError;
        if (t.state === "running" && next.periodUs !== t.spec.periodUs)
          throw new Error("period change while running");
        t.replaced.push(next);
        t.spec = next;
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
          trajectoryId: 1,
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
      close: async () => {},
    }),
    async openTrajectory(spec: Spec, opts: { name: string }) {
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
    expectedTriggerNs: (start: bigint, cycle: number, periodUs: number, offsetUs: number) =>
      start + BigInt(cycle) * BigInt(periodUs) * 1000n + BigInt(offsetUs) * 1000n,
  };
});

vi.mock("@orchestrator/controller", () => ({
  activeController: () => ctl.controller,
  TrajectoryReplaceError: class TrajectoryReplaceError extends Error {
    constructor(
      message: string,
      readonly running: boolean,
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
  report: (scope: string, message: string) => void ctl.reports.push(`${scope}: ${message}`),
  span: () => {},
  timeSpan: async <T,>(_n: string, fn: () => Promise<T>) => fn(),
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
      sendParams: () => {},
      terminate: () => {
        const i = ctl.workers.indexOf(w);
        if (i >= 0) ctl.workers.splice(i, 1);
      },
    };
  },
}));

vi.mock("@orchestrator/raw-recording", () => ({
  createRawRecording: () => ({ active: false, start: async () => true, stop: async () => true }),
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
import { scanAngles, patternSamples, patternPeriodUs, sweepUs } from "@modules/mirror-link/scan";

// --- fakes -------------------------------------------------------------------

/** A timing-capable fake camera: free-running Timed exposure by default. */
class FakeCam {
  frame_rate_enable = true;
  frame_rate = 30;
  readonly frame_rate_range = { min: 1, max: 60 };
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
  };
  constructor(
    readonly serial: string,
    readonly modes: string[] = ["Timed", "TriggerWidth"],
  ) {}
  getFeatureInt(name: string): number {
    return name === "Width" ? 64 : 48;
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
    L: (a: Point2d) => ({ x: 40 * Math.tan(a.x) + 1, y: 38 * Math.tan(a.y) - 2 }),
    R: (a: Point2d) => ({ x: 41 * Math.tan(a.x) - 1, y: 39 * Math.tan(a.y) + 2 }),
  },
  V2A: {
    L: (v: Point2d) => ({ x: Math.atan((v.x - 1) / 40), y: Math.atan((v.y + 2) / 38) }),
    R: (v: Point2d) => ({ x: Math.atan((v.x + 1) / 41), y: Math.atan((v.y - 2) / 39) }),
  },
  A2P: { C: (a: Point2d) => ({ x: a.x * 1000, y: a.y * 1000 }) },
  P2A: { C: (p: Point2d) => ({ x: p.x / 1000, y: p.y / 1000 }) },
  A2H: { L: () => new Float64Array(9), R: () => new Float64Array(9) },
};

function makeTriple(opts: { calibrated?: boolean; modes?: string[] } = {}) {
  const lease = (serial: string) => ({
    camera: new FakeCam(serial, opts.modes),
    reconfigure: async (fn: () => void) => fn(),
    release: vi.fn(),
  });
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

function makeFlipSeam() {
  const pools: Record<string, Array<{ tExposure: bigint; flip: boolean }>> = {};
  const seam = {
    advertised: [] as string[],
    attached: [] as Array<{ src: string; id: string; toleranceNs: bigint }>,
    detached: [] as string[],
    unadvertised: [] as string[],
    pools,
    probes: {} as Record<string, { frames: number; flipped: number; unmatched: number }>,
    advertise: (spec: { id: string }) => {
      seam.advertised.push(spec.id);
      return 1;
    },
    unadvertise: (id: string) => void seam.unadvertised.push(id),
    attach: (src: string, id: string, o: { toleranceNs: bigint }) => {
      seam.attached.push({ src, id, toleranceNs: o.toleranceNs });
      pools[id] = [];
    },
    pushAnchor: (id: string, a: { tExposure: bigint; flip: boolean }) => void pools[id]!.push(a),
    probe: (id: string) => {
      const p = seam.probes[id] ?? { frames: 0, flipped: 0, unmatched: 0 };
      return { ...p, anchorPoolSize: pools[id]?.length ?? 0 };
    },
    detach: (id: string) => void seam.detached.push(id),
  };
  return seam;
}

// --- harness -------------------------------------------------------------------

async function settle(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

let perfNow = 0;

async function harness(
  opts: { calibrated?: boolean; modes?: string[]; state?: Record<string, unknown> } = {},
) {
  ctl.controller = { v22Capable: true, dv: 170 };
  ctl.trajectories.length = 0;
  ctl.openError = null;
  ctl.replaceError = null;
  ctl.triggerOn.length = 0;
  ctl.triggerOff.length = 0;
  ctl.reports.length = 0;
  ctl.wirings.length = 0;
  ctl.workers.length = 0;
  ctl.positionUpdates = 0;
  const triple = makeTriple(opts);
  ctl.triple = triple;
  const flipSeam = makeFlipSeam();
  const broker = {
    advertise: () => 1,
    connect: vi.fn((id: string) => ({
      shmName: `/fv.${id}`,
      spec: { width: 64, height: 48, channels: 4, bytesPerFrame: 64 * 48 * 4 },
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
  client.on(topic.state("mirror-link"), ({ key, value }: { key: string; value: unknown }) => {
    state[key] = value;
  });
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
  return { session, client, tele, state, call, setState, tick, traj, triple, flipSeam, broker };
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
    expect(spec.markers).toEqual([{ tOffsetUs: 10_000, pulseUs: 50_000, cameras: ["L", "R"] }]);
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
    const h = await harness({ state: { scan_mode: "triangle", tri_window_sync: false } });
    await h.setState("tri_window_rise", [0.1, 0.9]);
    await h.setState("tri_window_fall", [0.2, 0.5]);
    expect(await h.call("startScan")).toBe(true);
    const spec = h.traj().spec;
    expect(spec.periodUs).toBe(patternPeriodUs("triangle", 10));
    expect(spec.samples.map((s) => s.tOffsetUs)).toEqual([0, sweepUs(10)]);
    const want0 = chainVolts({ x: 0, y: 0 }, { x: (-0.5 * Math.PI) / 180, y: 0 });
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
    const before = { ...L.features, exposure: L.exposure, auto: L.exposure_auto, fre: L.frame_rate_enable };
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
    expect({ ...L.features, exposure: L.exposure, auto: L.exposure_auto, fre: L.frame_rate_enable }).toEqual({
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
    expect(h.tele.scan_blocked).toMatch(/trajectory start failed: firmware REJ/);
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

  it("falls back to Timed on both eyes when one model lacks TriggerWidth", async () => {
    const h = await harness({ state: { scan_mode: "triangle", tri_window_sync: false } });
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
    expect(ctl.reports.some((r) => r.includes("cannot take the exposure windows"))).toBe(true);
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
    expect(ctl.reports.filter((r) => r.includes("re-upload failed"))).toHaveLength(1);
    const { TrajectoryReplaceError } = await import("@orchestrator/controller");
    ctl.replaceError = new (TrajectoryReplaceError as unknown as new (m: string, r: boolean) => Error)(
      "STOP lost",
      false,
    );
    perfNow += 200;
    await h.setState("scan_amp", 1.0);
    await vi.advanceTimersByTimeAsync(200);
    await settle(30);
    expect(h.tele.scan).toBeNull();
    expect(ctl.triggerOff).toEqual(["SL", "SR"]);
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
    expect(h.flipSeam.detached).toEqual(["camera/SL/convert/flip", "camera/SR/convert/flip"]);
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
    const h = await harness({ state: { scan_mode: "triangle", ring_reader: true } });
    expect(h.broker.connect).toHaveBeenCalledWith("camera/SL/convert");
    await h.call("startScan");
    await settle();
    const T = sweepUs(10);
    expect(h.flipSeam.attached).toEqual([
      { src: "camera/SL/convert", id: "camera/SL/convert/flip", toleranceNs: BigInt(0.4 * T * 1000) },
      { src: "camera/SR/convert", id: "camera/SR/convert/flip", toleranceNs: BigInt(0.4 * T * 1000) },
    ]);
    expect(h.state.flipPipes).toEqual({ L: "camera/SL/convert/flip", R: "camera/SR/convert/flip" });
    // The ring reader re-bound to the flip pipes.
    expect(h.broker.connect).toHaveBeenCalledWith("camera/SL/convert/flip");
    expect(ctl.workers.at(-1)!.init.pipes).toHaveLength(2);
    // Graph rows: kind "flip", fed by the convert pipe and the trajectory.
    const flipRows = ctl.wirings.flatMap((w) => w.nodes).filter((n) => n.kind === "flip");
    expect(flipRows.map((n) => n.id)).toEqual(["camera/SL/convert/flip", "camera/SR/convert/flip"]);
    // OK pushes → anchors (falling = marker 1 = flip); failed ones → none.
    h.traj().push({ marker: 0, status: "OK", tExposure: 5n });
    h.traj().push({ marker: 1, status: "OK", tExposure: 9n });
    h.traj().push({ marker: 1, status: "STROBE_TIMEOUT", tExposure: 11n });
    expect(h.flipSeam.pools["camera/SL/convert/flip"]).toEqual([
      { tExposure: 5n, flip: false },
      { tExposure: 9n, flip: true },
    ]);
    expect(h.flipSeam.pools["camera/SR/convert/flip"]).toHaveLength(2);
    await h.call("stopScan");
    await settle();
    expect(h.flipSeam.detached).toEqual(["camera/SL/convert/flip", "camera/SR/convert/flip"]);
    expect(h.flipSeam.unadvertised).toEqual(["camera/SL/convert/flip", "camera/SR/convert/flip"]);
    expect(h.state.flipPipes).toEqual({ L: null, R: null });
    expect(ctl.wirings.flatMap((w) => w.nodes).some((n) => n.kind === "flip")).toBe(false);
    // ...and the reader is back on the raw pipes.
    expect(h.broker.connect.mock.calls.at(-1)![0]).toMatch(/^camera\/S[LR]\/convert$/);
  });

  it("builds nothing in ellipse mode", async () => {
    const h = await harness({ state: { ring_reader: true } });
    await h.call("startScan");
    h.traj().push({ marker: 0, status: "OK", tExposure: 5n });
    expect(h.flipSeam.attached).toHaveLength(0);
    expect(h.state.flipPipes ?? { L: null, R: null }).toEqual({ L: null, R: null });
  });

  it("tightens the tolerance when the windows bring the markers close", async () => {
    const h = await harness({ state: { scan_mode: "triangle", tri_window_sync: false } });
    await h.setState("tri_window_rise", [0.9, 0.95]);
    await h.setState("tri_window_fall", [0, 0.5]);
    await h.call("startScan");
    await settle();
    // Rising at 0.9T, falling at T: 0.1T apart → 0.04T tolerance.
    expect(h.flipSeam.attached[0]!.toleranceNs).toBe(BigInt(Math.round(0.4 * 0.1 * sweepUs(10) * 1000)));
  });

  it("warns once when falling frames beat their marker push (unmatched)", async () => {
    const h = await harness({ state: { scan_mode: "triangle" } });
    await h.call("startScan");
    await h.tick();
    h.flipSeam.probes["camera/SL/convert/flip"] = { frames: 40, flipped: 10, unmatched: 5 };
    perfNow += 600;
    await h.tick();
    expect(h.tele.perf.trajectory.unmatched).toEqual({ L: 5, R: 0 });
    expect(h.tele.perf.trajectory.flipped).toEqual({ L: 10, R: 0 });
    expect(ctl.reports.filter((r) => r.includes("before their marker push"))).toHaveLength(1);
    h.flipSeam.probes["camera/SL/convert/flip"] = { frames: 80, flipped: 20, unmatched: 15 };
    perfNow += 600;
    await h.tick();
    expect(ctl.reports.filter((r) => r.includes("before their marker push"))).toHaveLength(1);
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
  });

  it("counts pushes by status and reports exact lateness", async () => {
    const h = await harness();
    await h.call("startScan");
    const start = h.traj().startedAt!;
    // Marker 0 of cycle 2 is due at start + 2·P; 37 µs late.
    h.traj().push({ status: "OK", marker: 0, cycle: 2, tTrigger: start + 200_000_000n + 37_000n });
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
    });
  });

  it("warns once per run when no OK push arrives for two periods", async () => {
    const h = await harness();
    await h.call("startScan");
    perfNow += 150; // < 2 periods past the start (lead included)
    await h.tick(0);
    expect(ctl.reports.filter((r) => r.includes("no fovea exposure"))).toHaveLength(0);
    perfNow += 200;
    await h.tick(0);
    perfNow += 400;
    await h.tick(0);
    expect(ctl.reports.filter((r) => r.includes("no fovea exposure"))).toHaveLength(1);
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
    const u = await harness({ calibrated: false });
    await u.call("setAxis", { x: 5, y: 5 });
    await settle();
    expect(u.session.state.scan_axis_deg).toBe(0);
  });
});
