// Controller request PIPELINING at the JS layer (docs/spec/serial-protocol.md
// #pipelining): nothing in `Controller` waits for one request's ACK before
// writing the next. A fake `Device` whose awaited requests stay UNANSWERED
// until the test releases them proves (1) the connect-time config sequence
// is written back-to-back in wire order, (2) a fire-and-forget stream update
// goes out while awaited requests are still pending, (3) a latest-wins drop
// never throws into the hot path and re-arms the dedupe, and (4) the stream
// min-interval is a live per-controller tunable shared with native sinks.

import { describe, expect, it, vi } from "vitest";

type Call = { method: "get" | "set" | "fireAndForget"; prop: string; arg?: unknown };

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const parked: Array<() => void> = [];
  const sinkGovernor: unknown[] = [];
  const ff = { failNext: false };
  return { calls, parked, sinkGovernor, ff };
});

vi.mock("core/Controller", () => {
  class FakeDevice {
    connected = true;
    v2Capable = true;
    stats = {};
    constructor(_path: string) {
      void _path;
    }
    verifyVersion = vi.fn(async () => ({ major: 2, minor: 2, patch: 0, compatible: true }));
    release = vi.fn();
    fireAndForget = vi.fn((prop: string, arg: unknown) => {
      if (h.ff.failNext) {
        h.ff.failNext = false;
        throw new Error("Failed to write to serial port: Resource temporarily unavailable");
      }
      h.calls.push({ method: "fireAndForget", prop, arg });
    });
    get = vi.fn((prop: string) => {
      h.calls.push({ method: "get", prop });
      return new Promise((resolve) => h.parked.push(() => resolve(Object(1n))));
    });
    set = vi.fn((prop: string, arg: unknown) => {
      h.calls.push({ method: "set", prop, arg });
      // Awaited requests stay unanswered until the test releases them —
      // anything that serialised on an ACK would stall right here.
      return new Promise((resolve) =>
        h.parked.push(() => resolve(prop === "Bias" ? 200 : prop === "MirrorStream" ? arg : true)),
      );
    });
  }
  const Protocol = {
    System: { Enable: "Enable", Info: "Info", Version: "Version", Timestamp: "Timestamp" },
    Config: { Log: "Log", LPF: "LPF", Bias: "Bias" },
    Command: { Actuate: "Actuate", Trigger: "Trigger", MirrorStream: "MirrorStream", Frame: "Frame" },
  };
  const createMirrorSink = vi.fn(() => ({
    setGovernor: (p: unknown) => h.sinkGovernor.push(p),
    release: vi.fn(),
  }));
  return { Device: FakeDevice, Protocol, createMirrorSink };
});
vi.mock("serialport", () => ({ SerialPort: { list: vi.fn(async () => []) } }));

import {
  Controller,
  STREAM_MIN_UPDATE_INTERVAL_MS,
  StreamUpdateGate,
} from "@orchestrator/controller";

const flush = () => new Promise((r) => setTimeout(r, 0));
const releaseAll = async () => {
  while (h.parked.length) h.parked.shift()!();
  await flush();
};
const pose = (x: number) => ({ left: { x, y: 0 }, right: { x: 0, y: 0 } });

describe("Controller request pipelining", () => {
  it("writes the connect-time config sequence back-to-back, in wire order", async () => {
    h.calls.length = 0;
    const ctrl = new Controller({ path: "/dev/fake-pipelining" } as never);
    await flush(); // verifyVersion resolves; the config requests go out
    const cfg = h.calls.filter((c) => c.method === "set").map((c) => c.prop);
    // All four are on the wire while NONE has been answered.
    expect(cfg).toEqual(["Enable", "Bias", "LPF", "Log"]);
    expect(h.parked.length).toBe(4);
    await releaseAll();
    await ctrl.ready;
    expect(ctrl.enabled).toBe(false);
    ctrl.release();
  });

  it("sends a fire-and-forget update while awaited requests are unanswered", async () => {
    const ctrl = new Controller({ path: "/dev/fake-pipelining-2" } as never);
    await flush();
    await releaseAll();
    await ctrl.ready;
    ctrl.streamMinIntervalMs = 0; // no interval gating for this probe
    const created = ctrl.createStream(pose(0));
    await releaseAll(); // CREATE ACK
    const stream = await created;
    h.calls.length = 0;
    // Two awaited requests left PENDING (no ACK yet)...
    const pendingA = ctrl.readTimestamp();
    const pendingB = ctrl.setLPF(100);
    // ...and the stream update still goes straight out.
    stream.update(pose(1));
    expect(h.calls.map((c) => c.method)).toEqual(["get", "set", "fireAndForget"]);
    await releaseAll();
    await Promise.all([pendingA, pendingB]);
    ctrl.release();
  });

  it("a latest-wins drop never throws into the caller and the pose is re-sent", async () => {
    const ctrl = new Controller({ path: "/dev/fake-pipelining-4" } as never);
    await flush();
    await releaseAll();
    await ctrl.ready;
    ctrl.streamMinIntervalMs = 0;
    const created = ctrl.createStream(pose(0));
    await releaseAll();
    const stream = await created;
    h.calls.length = 0;
    h.ff.failNext = true; // the kernel queue is full for this one write
    expect(() => stream.update(pose(7))).not.toThrow();
    expect(h.calls).toEqual([]);
    // The SAME resting pose is re-sent on the next push (dedupe re-armed).
    stream.update(pose(7));
    expect(h.calls.map((c) => c.method)).toEqual(["fireAndForget"]);
    stream.update(pose(7)); // ...and dedupes normally once it landed
    expect(h.calls.length).toBe(1);
    ctrl.release();
  });

  it("streamMinIntervalMs is a live tunable, shared with native sinks", async () => {
    expect(STREAM_MIN_UPDATE_INTERVAL_MS).toBeLessThan(1); // re-derived sub-ms floor
    let interval = 5;
    const gate = new StreamUpdateGate(pose(0), () => interval, 0);
    expect(gate.accept(pose(1), 4)).toBe(false);
    interval = 1; // a live retune applies to the very next accept
    expect(gate.accept(pose(1), 4)).toBe(true);

    const ctrl = new Controller({ path: "/dev/fake-pipelining-3" } as never);
    await flush();
    await releaseAll();
    await ctrl.ready;
    ctrl.streamMinIntervalMs = 0.5;
    h.sinkGovernor.length = 0;
    const handle = ctrl.createNativeMirrorSink(pose(0));
    await releaseAll();
    await handle;
    expect(h.sinkGovernor).toEqual([{ minIntervalUs: 500 }]);
    ctrl.release();
  });
});
