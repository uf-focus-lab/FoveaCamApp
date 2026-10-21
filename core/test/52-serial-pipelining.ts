// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Serial PIPELINING, host side — core's Device driving the firmware simulator
// (test/build/fovea-fw-sim, as in test 47). The firmware half (the MCU loop
// answers back-to-back requests in order, no one-in-flight gate) is proven
// wire-level by test/build/fw-sim-check stage D; this proves core's Device
// never serialises requests on their ACKs. The sim is FROZEN with SIGSTOP so
// "in flight" is deterministic (nothing can be answered while it is stopped).
// Proves:
//   1. N awaited GETs issued back-to-back are ALL in flight at once
//      (stats.inFlight === N), resolve in seq (issue) order, and cost about
//      one round trip plus per-packet handling once the device runs — not N
//      round trips (sim: ~1 ms for 64 vs ~11 ms awaited one by one).
//   2. fire-and-forget (seq 0) never queues behind an awaited request: with
//      a GET unanswered, fireAndForget() still returns synchronously and its
//      UPDATE is on the wire (and applied) before that GET's ACK; during a
//      pending two-phase CMD_FRAME (FIN far away) a train of UPDATEs all
//      reach the DAC and an unrelated GET ACKs before the FIN.
//   3. A request burst bigger than the kernel tty queue QUEUES in the
//      Device's TX tail (stats.txQueuedBytes > 0) instead of throwing, and
//      drains on its own (rx-thread POLLOUT) — every request resolves, in
//      order, with nothing written after it. Past the tail cap the excess
//      REJECTS ("TX queue full") — every request returns a promise and
//      settles exactly once (pre-fix, the failed ones returned `undefined`).
//
// Spec: docs/spec/serial-protocol.md#pipelining.
// Run UNSANDBOXED: node core/test/52-serial-pipelining.ts

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type AnalogChannels, Device, Protocol } from "core/Controller";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      timer.unref();
    }),
  ]);
}

// --- Sim process wrapper (test 47's, trimmed) ----------------------------------

class Sim {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  private waiters: {
    pred: (line: string) => boolean;
    resolve: (hit: { line: string; index: number }) => void;
  }[] = [];

  constructor(binary: string) {
    this.proc = spawn(binary, ["--loop-us", "50"], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const index = this.lines.push(line) - 1;
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(line)) return true;
        w.resolve({ line, index });
        return false;
      });
    });
  }

  mark(): number {
    return this.lines.length;
  }

  waitLine(
    pred: (line: string) => boolean,
    from = 0,
    timeoutMs = 5000,
    label = "sim line",
  ): Promise<{ line: string; index: number }> {
    for (let i = from; i < this.lines.length; i++)
      if (pred(this.lines[i])) return Promise.resolve({ line: this.lines[i], index: i });
    return withTimeout(
      new Promise((resolve) => this.waiters.push({ pred, resolve })),
      timeoutMs,
      label,
    );
  }

  async ctl(cmd: string): Promise<void> {
    const from = this.mark();
    this.proc.stdin.write(cmd + "\n");
    await this.waitLine((l) => l === `ok ${cmd}`, from, 5000, `ctl(${cmd})`);
  }

  /** Freeze / thaw the whole simulated MCU (nothing is read or answered while
   *  stopped — the host's writes pile up in the pty). */
  freeze(): void {
    assert(this.proc.kill("SIGSTOP"), "SIGSTOP sim");
  }
  thaw(): void {
    assert(this.proc.kill("SIGCONT"), "SIGCONT sim");
  }
}

/** Format-agnostic left-DAC match: the dual-bus shim may change the word's
 *  command nibble / cs split, but a left word still ends in its 16-bit value. */
const leftDacEndsWith = (hex4: string) => (l: string) =>
  l.startsWith("dac cs=L") && l.endsWith(hex4);
const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");

const simBinary = fileURLToPath(new URL("../../test/build/fovea-fw-sim", import.meta.url));
if (!existsSync(simBinary)) {
  console.error(`fovea-fw-sim not built at ${simBinary} — run: cd test && make build`);
  process.exit(1);
}

const sim = new Sim(simBinary);
let device: InstanceType<typeof Device> | null = null;
let frozen = false;

try {
  const ptyLine = await sim.waitLine((l) => l.startsWith("pty "), 0, 5000, "pty path");
  device = new Device(ptyLine.line.slice(4));
  const dev = device;
  const version = await withTimeout(dev.verifyVersion(), 5000, "verifyVersion");
  assert.equal(version.compatible, true, "v2-compatible firmware");
  const mcuNow = async () =>
    ((await dev.get<BigInt>(Protocol.System.Timestamp)).valueOf() as bigint);

  // --- 1: N awaited GETs in flight at once, ~one RTT -------------------------
  {
    const N = 128;
    const issue = (order: number[]) =>
      Array.from({ length: N }, (_, i) =>
        dev.get<BigInt>(Protocol.System.Timestamp).then((v) => {
          order.push(i);
          return v.valueOf() as bigint;
        }),
      );

    // (a) Deterministic in-flight depth: freeze the MCU, issue N, count.
    sim.freeze();
    frozen = true;
    const frozenOrder: number[] = [];
    const frozenReqs = issue(frozenOrder);
    await sleep(20); // the frozen MCU cannot answer any of them
    assert.equal(dev.stats.inFlight, N, `all ${N} requests in flight at once`);
    assert.equal(frozenOrder.length, 0, "nothing resolved while the device is frozen");
    sim.thaw();
    frozen = false;
    const stamps = await withTimeout(Promise.all(frozenReqs), 5000, "frozen-burst GETs");
    assert.deepEqual(frozenOrder, [...Array(N).keys()], "resolved in seq (issue) order");
    for (let i = 1; i < N; i++)
      assert(stamps[i] >= stamps[i - 1], "MCU handled them in send order");
    assert.equal(dev.stats.inFlight, 0, "pending map drained");

    // (b) Cost: N awaited one by one vs N issued back-to-back (live device).
    const s0 = performance.now();
    for (let i = 0; i < N; i++) await withTimeout(mcuNow(), 5000, `sequential GET ${i}`);
    const seqMs = performance.now() - s0;
    const liveOrder: number[] = [];
    const p0 = performance.now();
    await withTimeout(Promise.all(issue(liveOrder)), 5000, "pipelined GETs");
    const pipeMs = performance.now() - p0;
    assert.deepEqual(liveOrder, [...Array(N).keys()], "live burst resolved in seq order");
    const rttMs = seqMs / N;
    assert(
      pipeMs * 2 < seqMs,
      `N pipelined GETs cost ~one RTT, not N (pipelined ${pipeMs.toFixed(2)} ms vs ` +
        `sequential ${seqMs.toFixed(2)} ms)`,
    );
    console.log(
      `52-serial-pipelining: §1 ${N} GETs in flight at once; pipelined ${pipeMs.toFixed(2)} ms ` +
        `(~${(pipeMs / rttMs).toFixed(1)} RTT) vs sequential ${seqMs.toFixed(2)} ms ` +
        `(RTT ${rttMs.toFixed(3)} ms); MCU span ${stamps[N - 1] - stamps[0]} µs OK.`,
    );
  }

  // --- 2: fire-and-forget never waits behind an awaited request --------------
  {
    await dev.set(Protocol.System.Enable, true);
    const Z: AnalogChannels = [0x1111, 0x2222, 0x3333, 0x4444];
    await dev.set(Protocol.Command.MirrorStream, { op: "CREATE", id: 1, left: Z, right: Z });

    // (a) A GET stuck unanswered (device frozen) does not hold back a seq-0
    // UPDATE: fireAndForget returns synchronously and the frame is on the
    // wire at once, while the GET ahead of it is still unanswered; the
    // firmware then handles both in wire order.
    sim.freeze();
    frozen = true;
    const mark = sim.mark();
    let getDone = false;
    const get = dev.get(Protocol.System.Info).then(() => (getDone = true));
    const tx0 = dev.stats.txPackets;
    const V = 0x6a6a;
    dev.fireAndForget(Protocol.Command.MirrorStream, {
      op: "UPDATE",
      id: 1,
      left: [V, 0x2222, 0x3333, 0x4444],
      right: Z,
    });
    assert.equal(dev.stats.txPackets, tx0 + 1, "seq-0 UPDATE written immediately");
    assert.equal(dev.stats.inFlight, 1, "the UPDATE added no pending entry");
    assert.equal(getDone, false, "the GET ahead of it is still unanswered");
    sim.thaw();
    frozen = false;
    await withTimeout(get, 5000, "GET ahead of the UPDATE");
    await sim.waitLine(leftDacEndsWith(hex4(V)), mark, 2000, "UPDATE applied");

    // (b) A two-phase CMD_FRAME pending ~60 ms for its FIN: a train of
    // UPDATEs issued meanwhile all land, and an unrelated GET ACKs before the
    // FIN.
    await sim.ctl("strobe L 500 60000");
    await sim.ctl("strobe R 700 60000");
    const frame = dev.get(Protocol.Command.Frame, {
      stream: 1,
      cameras: ["L", "R"],
      pulse: 58000,
      settle_time: 0,
    });
    let finDone = false;
    void frame.then(() => (finDone = true));
    await withTimeout(frame.accepted, 5000, "frame ACK");
    const m2 = sim.mark();
    const train = [0x7a01, 0x7a02, 0x7a03, 0x7a04, 0x7a05];
    for (const v of train) {
      dev.fireAndForget(Protocol.Command.MirrorStream, {
        op: "UPDATE",
        id: 1,
        left: [v, 0x2222, 0x3333, 0x4444],
        right: Z,
      });
      await sleep(3);
    }
    await mcuNow();
    assert.equal(finDone, false, "GET answered while the FRAME still awaits its FIN");
    for (const v of train)
      await sim.waitLine(leftDacEndsWith(hex4(v)), m2, 2000, `UPDATE ${hex4(v)} during FRAME`);
    assert.equal(finDone, false, "every UPDATE landed before the FRAME's FIN");
    await withTimeout(frame, 5000, "frame FIN");
    await sim.ctl("strobe L 500 2500");
    await sim.ctl("strobe R 700 2500");
    console.log(
      "52-serial-pipelining: §2 seq-0 UPDATEs never wait behind a pending GET / two-phase FRAME OK.",
    );
  }

  // --- 3: a burst past the kernel queue QUEUES, then drains on its own --------
  {
    sim.freeze();
    frozen = true;
    const reqs: Promise<unknown>[] = [];
    const order: number[] = [];
    let queuedPeak = 0;
    for (let i = 0; i < 20000 && queuedPeak === 0; i++) {
      const v = (i % 4000) + 1;
      const r = dev
        .set(Protocol.Command.MirrorStream, {
          op: "UPDATE",
          id: 1,
          left: [v, v, v, v],
          right: [v, v, v, v],
        })
        .then(() => order.push(i));
      reqs.push(r);
      if (i % 64 === 63) queuedPeak = dev.stats.txQueuedBytes;
    }
    assert(queuedPeak > 0, `burst overflowed the kernel tty queue into the TX tail (${queuedPeak} B)`);
    const n = reqs.length;
    assert.equal(dev.stats.inFlight, n, `${n} requests in flight, none thrown`);
    sim.thaw();
    frozen = false;
    // Nothing is written after the burst: the rx thread's POLLOUT drain alone
    // must push the queued tail out.
    await withTimeout(Promise.all(reqs), 30000, "queued burst");
    assert.deepEqual(order, [...Array(n).keys()], "queued requests resolve in order");
    assert.equal(dev.stats.txQueuedBytes, 0, "TX tail drained");
    assert.equal(dev.stats.inFlight, 0, "pending map drained");
    console.log(
      `52-serial-pipelining: §3 ${n}-request burst queued (peak tail ${queuedPeak} B, ` +
        `txSoftFail ${dev.stats.txSoftFail}) and drained without a follow-up write OK.`,
    );
  }

  // --- 3b: past the TX tail cap, the excess REJECTS — never vanishes ----------
  // (Pre-fix, a request that could not be written returned a bare `undefined`
  // — the JS exception was eaten by the dying PendingRequest — so a burst
  // past the kernel queue silently lost requests.)
  {
    sim.freeze();
    frozen = true;
    const N = 14000; // ≈ 330 KB of 24-byte frames: kernel queue + 256 KB tail overflow
    const order: number[] = [];
    const reqs: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      const r = dev.set(Protocol.Command.MirrorStream, {
        op: "UPDATE",
        id: 1,
        left: [i & 0xffff, 1, 2, 3],
        right: [3, 2, 1, 0],
      });
      assert.equal(typeof (r as Promise<unknown>)?.then, "function", `request ${i} returned a promise`);
      reqs.push(r.then(() => order.push(i)));
    }
    sim.thaw();
    frozen = false;
    const settled = await withTimeout(Promise.allSettled(reqs), 60000, "overflow burst");
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    assert(rejected.length > 0, "the burst overflowed the TX tail cap");
    for (const r of rejected)
      assert.match(String(r.reason), /TX queue full/, "overflow rejects with the queue-full reason");
    assert.equal(order.length + rejected.length, N, "every request settled exactly once");
    for (let i = 1; i < order.length; i++)
      assert(order[i] > order[i - 1], "accepted requests still resolve in issue order");
    assert.equal(dev.stats.inFlight, 0, "pending map drained");
    assert.equal(dev.stats.txQueuedBytes, 0, "TX tail drained");
    console.log(
      `52-serial-pipelining: §3b ${N}-request burst: ${order.length} resolved in order, ` +
        `${rejected.length} rejected "TX queue full" (none lost) OK.`,
    );
  }

  // --- 4: shutdown ------------------------------------------------------------
  {
    await dev.set(Protocol.System.Enable, false);
    dev.release();
    device = null;
    const exited = once(sim.proc, "exit");
    await sim.ctl("quit");
    const [code] = (await withTimeout(exited, 5000, "sim exit")) as [number | null];
    assert.equal(code, 0, "sim exits 0 on quit");
  }
  console.log("52-serial-pipelining: ALL OK");
  process.exit(0);
} finally {
  if (frozen) sim.proc.kill("SIGCONT");
  device?.release();
  if (sim.proc.exitCode === null) sim.proc.kill("SIGKILL");
}
