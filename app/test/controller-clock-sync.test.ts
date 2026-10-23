// MCU↔host clock re-calibration (docs/spec/controller.md#clock-sync):
//   (1) `startControllerClockSync` — one ping round at once, then every 30 s;
//       a landed round installs the offset (and the calibration row), a
//       timed-out round (3 s race — pre-v1.1 firmware never answers) counts a
//       miss; two misses in a row flip `clockCalibrated` false, the next
//       landed round flips it back; one report per streak; stop() ends it.
//   (2) the controller session publishes `clockCalibrated` in its telemetry
//       and stops re-pinging on disconnect.
//
// Fake timers + a pinned host clock; the fake MCU clock is the host clock
// minus a known offset, so a ping's estimate is exact (zero RTT).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Channel, topic } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

const mockReports: string[] = [];
vi.mock("@orchestrator/diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@orchestrator/diagnostics")>()),
  report: (_scope: string, message: string) => {
    mockReports.push(message);
  },
}));

// The session's device: a fake whose clock behaviour each test sets.
let activeController: any = null;
const mockFakes: FakeClockController[] = [];
vi.mock("@orchestrator/controller", () => ({
  activeController: () => activeController,
  setActiveController: (c: any) => {
    activeController = c;
  },
  Controller: class {
    static match = vi.fn(async () => ({ path: "fake" }));
    constructor() {
      // The session constructs it; hand it the shared fake's behaviour.
      return mockFakes.shift()!;
    }
  },
}));

import { calibration, clearCalibrations, setHostClock } from "@orchestrator/time-align";
import {
  CLOCK_PING_TIMEOUT_MS,
  CLOCK_REPING_INTERVAL_MS,
  startControllerClockSync,
} from "@orchestrator/sessions/controller";

let hostNs = 50_000_000_000n;

/** A controller-shaped fake: `mode` answers pings (MCU = host − offset) or
 *  leaves them hanging; calibration state follows the real Controller's
 *  rule (set by an offset, lost after two consecutive misses). */
class FakeClockController {
  mode: "answer" | "hang" | "fail" = "answer";
  mcuOffsetNs = 7_000_000n; // host − MCU
  reads = 0;
  offsets: bigint[] = [];
  misses = 0;
  calibrated = false;
  // Session-facing surface (perf-substrate's fake shape).
  ready = Promise.resolve();
  connected = true;
  enabled = false;
  dv = 170;
  pos = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  stats = { txBytes: 0, rxBytes: 0, txPackets: 0, rxPackets: 0 };
  streamSnapshot = () => [];
  release = vi.fn();

  readTimestamp(): Promise<bigint> {
    this.reads++;
    if (this.mode === "hang") return new Promise(() => {});
    if (this.mode === "fail") return Promise.reject(new Error("Controller not connected"));
    return Promise.resolve((hostNs - this.mcuOffsetNs) / 1000n);
  }
  setClockOffsetNs(offsetNs: bigint): void {
    this.offsets.push(offsetNs);
    this.calibrated = true;
    this.misses = 0;
  }
  noteClockPingMissed(): void {
    if (++this.misses >= 2) this.calibrated = false;
  }
  get clockCalibrated(): boolean {
    return this.calibrated;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  hostNs = 50_000_000_000n;
  setHostClock(() => hostNs);
  clearCalibrations();
  mockReports.length = 0;
  mockFakes.length = 0;
  activeController = null;
});

afterEach(() => {
  vi.useRealTimers();
  setHostClock(() => process.hrtime.bigint());
});

describe("startControllerClockSync", () => {
  it("pings at once, installs the offset, and re-pings every 30 s", async () => {
    const c = new FakeClockController();
    const changes: boolean[] = [];
    const stop = startControllerClockSync(c, { onChange: (v) => changes.push(v) });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.reads).toBe(10);
    expect(c.offsets).toEqual([7_000_000n]);
    expect(c.clockCalibrated).toBe(true);
    expect(changes).toEqual([true]);
    expect(calibration("controller")).toMatchObject({ offsetNs: 7_000_000n, method: "ping" });

    // The MCU drifts: the next round, 30 s later, swaps the offset in.
    c.mcuOffsetNs = 7_040_000n;
    hostNs += 30_000_000_000n;
    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS - 1);
    expect(c.reads).toBe(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.reads).toBe(20);
    expect(c.offsets).toEqual([7_000_000n, 7_040_000n]);
    expect(calibration("controller")!.offsetNs).toBe(7_040_000n);
    expect(changes).toEqual([true]); // still calibrated: no flip
    stop();
    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS * 3);
    expect(c.reads).toBe(20);
  });

  it("two timed-out rounds in a row flip clockCalibrated false; the next landed one restores it", async () => {
    const c = new FakeClockController();
    const changes: boolean[] = [];
    const stop = startControllerClockSync(c, { onChange: (v) => changes.push(v) });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.clockCalibrated).toBe(true);

    c.mode = "hang";
    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS + CLOCK_PING_TIMEOUT_MS);
    expect(c.misses).toBe(1);
    expect(c.clockCalibrated).toBe(true); // one miss is tolerated
    expect(mockReports).toEqual(["controller: clock re-calibration ping timed out"]);

    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS);
    expect(c.misses).toBe(2);
    expect(c.clockCalibrated).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(mockReports).toHaveLength(1); // one report per streak

    c.mode = "answer";
    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS);
    expect(c.clockCalibrated).toBe(true);
    expect(changes).toEqual([true, false, true]);
    stop();
  });

  it("a failing ping counts as a miss too", async () => {
    const c = new FakeClockController();
    c.mode = "fail";
    const stop = startControllerClockSync(c);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.misses).toBe(1);
    expect(mockReports[0]).toMatch(/clock calibration failed: Controller not connected/);
    stop();
  });

  it("pre-v1.1 firmware (never answers): uncalibrated, reported once, rounds never overlap", async () => {
    const c = new FakeClockController();
    c.mode = "hang";
    const changes: boolean[] = [];
    const stop = startControllerClockSync(c, { onChange: (v) => changes.push(v) });
    await vi.advanceTimersByTimeAsync(CLOCK_PING_TIMEOUT_MS - 1);
    expect(c.misses).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.misses).toBe(1);
    expect(c.clockCalibrated).toBe(false);
    expect(mockReports).toEqual([
      "controller: timestamp ping timed out (pre-v1.1 firmware?) — clock UNCALIBRATED",
    ]);
    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS * 2);
    expect(c.misses).toBe(3);
    expect(c.reads).toBe(3); // one hung read per round, never two at once
    expect(mockReports).toHaveLength(1);
    expect(changes).toEqual([]); // never calibrated: nothing flipped
    stop();
  });
});

describe("controller session clock telemetry", () => {
  it("publishes clockCalibrated, re-pings on the 30 s cadence, and stops on disconnect", async () => {
    const fake = new FakeClockController();
    mockFakes.push(fake);
    const { controllerSession } = await import("@orchestrator/sessions/controller");
    const session = controllerSession();
    const [serverEp, clientEp] = createEndpointPair();
    const server = new Channel(serverEp);
    const client = new Channel(clientEp);
    session.attach(server);
    session.subscribe(server);
    const telemetry: any[] = [];
    client.on(topic.telemetry("controller"), (patch) => telemetry.push(patch));

    await client.request(topic.command("controller", "connect"));
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(fake.clockCalibrated).toBe(true);
    expect(telemetry.filter((t) => "clockCalibrated" in t).at(-1)).toMatchObject({
      clockCalibrated: true,
    });
    expect(fake.reads).toBeGreaterThanOrEqual(10);

    // The 500 ms probe also reads the timestamp (RTT probe): count only
    // whole calibration rounds through the installed offsets.
    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS);
    expect(fake.offsets).toHaveLength(2);

    await client.request(topic.command("controller", "disconnect"));
    await flush();
    expect(telemetry.at(-1)).toMatchObject({ connected: false, clockCalibrated: false });
    await vi.advanceTimersByTimeAsync(CLOCK_REPING_INTERVAL_MS * 2);
    expect(fake.offsets).toHaveLength(2);
  });
});
