// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Serial rate GOVERNOR + pressure instrumentation — NO hardware: a pty Device + the native
// compose/sink chain, pressure scripted via `Device.__testPressure`
// (synthetic outq readings, injected ACK-RTT samples, soft-fail bumps).
// Proves:
//   1. PRESSURE STATS — Device.stats carries the outq gauge/high-water,
//      txSoftFail, ackRttMs percentiles + connect-time baseline, and the
//      governor mirror; SYS_TIMESTAMP GET (the probe ping) COEXISTS with an
//      active mirror stream and feeds ackRttMs (it is not
//      Actuate).
//   2. AIMD — additive climb (+stepHz per eval) to the ceiling on a clean
//      link; multiplicative halve → floor on EACH pressure signal (EAGAIN
//      burst, outq HIGH breach, RTT inflation), then re-probe upward; the
//      floor and ceiling clamp; a lowered ceiling clamps immediately.
//   3. FAIRNESS — OFF by default (fairnessMs = 0: a FIFO link gains nothing
//      from holding UPDATEs behind an already-written request, and holding
//      them froze the mirror behind every pending two-phase CMD_FRAME —
//      asserted in §1). Opted in (fairnessMs > 0), under a full-rate flood a
//      pending request older than fairnessMs DEFERS updates (counted) until
//      its ACK; maxDeferMs caps starvation.
//   4. OFF SWITCH — `setGovernor({enabled:false})` pins the fixed
//      minIntervalUs gate (throttle behavior identical; no governor
//      evaluation).
//   5. FRAMING under real EAGAIN — flooding an undrained pty until the
//      kernel buffer fills produces txSoftFail events while every frame that
//      reaches the wire still decodes cleanly (short writes
//      tail the remainder; drops never truncate a frame).
//   6. Latency-comp math parity (Part 4): EMA(p50)/2 — the JS estimator's
//      fixture is pinned in vitest; here the ackRttP50 probe surface it
//      reads is asserted live.
//
// Run UNSANDBOXED: node core/test/46-rate-governor.ts

import assert from "node:assert/strict";
import { readSync } from "node:fs";
import { Controller, Tracker, cleanup } from "core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type XY = { x: number; y: number };
const C = Controller as unknown as {
  Device: new (path: string) => {
    stats: {
      outqBytes: number;
      outqHighWater: number;
      outqSupported: boolean;
      txSoftFail: number;
      inFlight: number;
      txQueuedBytes: number;
      ackRttMs: { p50: number; p95: number; max: number; count: number; baselineP50: number };
      governor: { effectiveRateHz: number; ceilingHz: number; state: string };
    };
    get(fn: unknown, arg?: unknown): Promise<unknown> & { accepted?: Promise<unknown> };
    __testPressure(p: { outq?: number; rttMs?: number; rttCount?: number; softFail?: number }): void;
    release(): void;
  };
  Protocol: { System: { Timestamp: unknown } };
  createMirrorSink(dev: unknown, o: object): Sink;
  __serialTestPty(): { fd: number; path: string };
};
type Sink = {
  pos_in: { streamTag: string };
  probe(): {
    received: number; written: number; deduped: number; throttled: number;
    errors: number; deferred: number; backoffs: number; open: boolean;
    effectiveRateHz: number; ceilingHz: number; minIntervalUs: number; governorState: string;
    ackRttP50: number; ackRttP95: number; ackRttCount: number;
  };
  setGovernor(p: object): void;
  release(): void;
};
type Compose = {
  rebase(p: object): void;
  volt_out: { pipe(t: unknown, o?: unknown): { release(): void } };
  release(): void;
};
const T = Tracker as unknown as {
  createComposeStream(o: object): Compose;
};

/** Drive distinct poses at ~500 Hz so the governor eval keeps ticking. */
function startDrive(compose: Compose): () => void {
  let i = 0;
  const t = setInterval(() => {
    for (let k = 0; k < 2; k++)
      compose.rebase({
        vPid: { l: { x: (++i % 997) / 10, y: 0 }, r: { x: 0, y: 0 } },
        feedForward: false,
      });
  }, 2);
  return () => clearInterval(t);
}

async function waitFor(pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    assert(Date.now() < deadline, `waitFor timed out: ${what}`);
    await sleep(10);
  }
}

// Fast eval cadence for the whole test (real default is 100 ms).
const EVAL = { evalMs: 20 };

// --- setup --------------------------------------------------------------------
const pty = C.__serialTestPty();
const dev = new C.Device(pty.path);
const sink = C.createMirrorSink(dev, { streamId: 2, bias: 90, dv: 170, nodeId: "controller" });
const compose = T.createComposeStream({
  name: "win/46/compose",
  initial: { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } },
});
const voltLink = compose.volt_out.pipe(sink.pos_in);
const drainPty = () => {
  const buf = Buffer.alloc(65536);
  try {
    return readSync(pty.fd, buf, 0, buf.length, null);
  } catch {
    return 0;
  }
};
const drainTimer = setInterval(drainPty, 10); // keep the pty buffer empty

// --- 1: pressure stats + probe-ping coexistence --------------------------------
{
  // Baseline RTT: 8 synthetic samples @2ms → baselineP50 = 2.
  dev.__testPressure({ rttMs: 2, rttCount: 8 });
  const st = dev.stats;
  assert.equal(st.ackRttMs.count, 8, "rtt samples recorded");
  assert.equal(st.ackRttMs.baselineP50, 2, "connect-time baseline = median of first samples");
  assert.equal(st.governor.state, "steady", "governor mirror live (defaults)");
  {
    // Re-derived V0.1 defaults (spec serial-protocol.md#rate-limits): 200 µs
    // emission floor, 5 kHz ceiling (the session lowers it to its rate).
    const p = sink.probe();
    assert.equal(p.minIntervalUs, 200, "default emission floor 200 µs");
    assert.equal(p.ceilingHz, 5000, "default ceiling 5 kHz");
    assert.equal(p.effectiveRateHz, 5000, "optimistic start at the ceiling");
  }
  assert(st.outqSupported, "TIOCOUTQ supported on this platform (Linux tty)");
  // PROBE PING coexists with the active stream (SYS_TIMESTAMP GET is not
  // Actuate): fire one against the silent pty — the WRITE must succeed (the
  // request times out later without a responder; that rejection is benign).
  const stop = startDrive(compose);
  await sleep(30);
  const ping = dev.get(C.Protocol.System.Timestamp);
  ping.catch(() => {}); // no responder on a pty — timeout is expected
  await sleep(30);
  const st2 = dev.stats;
  assert(st2.txSoftFail === 0, "ping + stream writes clean (no soft fails)");
  assert(st2.inFlight >= 1, "the unanswered ping is counted in flight");
  // FAIRNESS OFF BY DEFAULT: the ping now sits pending inside the old
  // 5..100 ms defer window — UPDATEs must keep flowing, none deferred.
  {
    const before = sink.probe();
    await sleep(60);
    const after = sink.probe();
    assert.equal(after.deferred, before.deferred, "no UPDATE deferred behind a pending request (default)");
    assert(after.written > before.written, "stream keeps writing while the request is pending");
  }
  stop();
  console.log("46-rate-governor: pressure stats + probe-ping/stream coexistence OK.");
}

// --- 2: AIMD climb / backoff / re-probe / clamps -------------------------------
{
  sink.setGovernor({ ...EVAL, ceilingHz: 600, floorHz: 60, stepHz: 100 });
  const stop = startDrive(compose);

  // Clean link → climbs to the ceiling and reports steady.
  await waitFor(
    () => sink.probe().effectiveRateHz >= 600,
    "climb to ceiling",
  );
  assert.equal(sink.probe().governorState, "steady", "steady at ceiling");

  // EAGAIN (soft-fail) burst → halve + backoff state, then re-probe upward.
  const preBackoffs = sink.probe().backoffs;
  dev.__testPressure({ softFail: 3 });
  await waitFor(() => sink.probe().backoffs > preBackoffs, "soft-fail backoff");
  {
    const p = sink.probe();
    assert(p.effectiveRateHz <= 300, `halved on soft-fail (${p.effectiveRateHz})`);
  }
  await waitFor(
    () => sink.probe().effectiveRateHz >= 600,
    "re-probe upward after soft-fail",
  );

  // outq HIGH breach → backoff to the floor under SUSTAINED pressure; clamps
  // at the floor, never below.
  dev.__testPressure({ outq: 100000 });
  await waitFor(() => sink.probe().effectiveRateHz <= 60, "outq backoff to floor");
  await sleep(100); // sustained pressure — must NOT go below the floor
  {
    const p = sink.probe();
    assert.equal(p.effectiveRateHz, 60, "floor clamp holds under sustained pressure");
    assert.equal(p.governorState, "backoff", "backoff state reported");
  }
  dev.__testPressure({ outq: 0 }); // pressure clears
  await waitFor(() => sink.probe().effectiveRateHz >= 600, "re-probe after outq clears");

  // RTT inflation (p95 > 2× baseline) → backoff; recovery after the window
  // flushes back to baseline-ish samples.
  dev.__testPressure({ rttMs: 50, rttCount: 130 }); // flood the window: p95 = 50 >> 2×2
  await waitFor(() => sink.probe().governorState === "backoff", "rtt-inflation backoff");
  dev.__testPressure({ rttMs: 2, rttCount: 130 }); // window back to baseline
  await waitFor(() => sink.probe().effectiveRateHz >= 600, "re-probe after rtt recovers");

  // A LOWERED ceiling clamps immediately (release-and-reprobe not needed).
  sink.setGovernor({ ceilingHz: 200 });
  {
    const p = sink.probe();
    assert(p.effectiveRateHz <= 200, `lowered ceiling clamps (${p.effectiveRateHz})`);
  }
  sink.setGovernor({ ceilingHz: 600 });

  // Bad params throw (named).
  assert.throws(() => sink.setGovernor({ floorHz: 900, ceilingHz: 600 }), /floorHz/);
  assert.throws(() => sink.setGovernor({ outqLow: 5000, outqHigh: 100 }), /outqLow/);
  assert.throws(() => sink.setGovernor({ stepHz: -5 }), /stepHz/);

  stop();
  console.log("46-rate-governor: AIMD climb/backoff/re-probe + clamps OK.");
}

// --- 3: fairness deferral under full-rate flood ---------------------------------
{
  // Opt-in: the reserve is OFF by default (see §1); enable it explicitly.
  sink.setGovernor({ ...EVAL, ceilingHz: 1000, fairnessMs: 5, maxDeferMs: 150 });
  const stop = startDrive(compose);
  await sleep(50);
  const before = sink.probe();
  // A pending two-phase-ish request against the silent pty: it will never ACK,
  // so it ages past fairnessMs → updates DEFER (coalesce) until maxDeferMs
  // caps the starvation window.
  const req = dev.get(C.Protocol.System.Timestamp);
  req.catch(() => {});
  await sleep(100);
  const after = sink.probe();
  assert(
    after.deferred > before.deferred,
    `updates deferred behind the aged pending request (${after.deferred - before.deferred})`,
  );
  // maxDeferMs caps the starvation: writes RESUME while the request is still
  // pending (the pty never ACKs).
  const w0 = sink.probe().written;
  await sleep(150);
  assert(sink.probe().written > w0, "maxDeferMs caps deferral — updates resumed");
  stop();
  console.log("46-rate-governor: fairness deferral + starvation cap OK.");
}

// --- 4: OFF switch = fixed-gate parity -----------------------------------
{
  sink.setGovernor({ enabled: false });
  {
    const p = sink.probe();
    assert.equal(p.governorState, "off", "governor reports off");
    assert.equal(p.effectiveRateHz, 0, "no governed rate advertised");
  }
  assert.equal(dev.stats.governor.state, "off", "stats mirror reports off");
  // The fixed minIntervalUs gate still applies: a 3 ms-spaced pair of
  // distinct poses both write; pressure signals change NOTHING while off.
  dev.__testPressure({ outq: 100000, softFail: 5 });
  // Timing flake guard: a preceding flood can finish <1 ms before this pose, so
  // the fixed min-interval gate would THROTTLE pose 1 (dropped — latest-wins has no
  // retry) and only pose 2 writes. Clear the min-interval first, then confirm
  // each pose actually lands before the next. The assertion's meaning is
  // unchanged: with the governor off, both DISTINCT spaced poses write through
  // the fixed min-interval gate.
  await sleep(5); // clear the fixed min-interval (≤ 1 ms) after the flood
  const w0 = sink.probe().written;
  compose.rebase({ vPid: { l: { x: 500, y: 1 }, r: { x: 0, y: 0 } }, feedForward: false });
  await waitFor(() => sink.probe().written - w0 >= 1, "first off-switch pose written");
  await sleep(3); // clear the min-interval again for pose 2
  compose.rebase({ vPid: { l: { x: 501, y: 1 }, r: { x: 0, y: 0 } }, feedForward: false });
  await sleep(50);
  const p = sink.probe();
  assert.equal(p.written - w0, 2, "off switch: fixed gate writes both spaced poses");
  dev.__testPressure({ outq: -1 }); // restore the real ioctl
  sink.setGovernor({ enabled: true, ceilingHz: 1000 });
  console.log("46-rate-governor: OFF-switch parity with the wave-5 fixed gate OK.");
}

// --- 5: framing integrity under REAL EAGAIN (undrained pty) ---------------------
{
  clearInterval(drainTimer);
  drainPty(); // start from an empty buffer
  const sf0 = dev.stats.txSoftFail;
  sink.setGovernor({ enabled: false }); // fixed minIntervalUs gate — maximum push
  const stop = startDrive(compose);
  // Flood until the kernel tty buffer fills → real EAGAIN/short-write events.
  await waitFor(() => dev.stats.txSoftFail > sf0, "real EAGAIN under flood", 30000);
  stop();
  await sleep(20);
  // Drain EVERYTHING and verify framing: every complete frame COBS-decodes to
  // an 18-byte MirrorStream payload (op=UPDATE, id=2) — a truncated frame
  // would desync its successor.
  const chunks: Buffer[] = [];
  for (;;) {
    const buf = Buffer.alloc(65536);
    let n = 0;
    try {
      n = readSync(pty.fd, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (n <= 0) break;
    chunks.push(buf.subarray(0, n));
    await sleep(5); // let the tail flush push the remainder through
  }
  const all = Buffer.concat(chunks);
  let start = 0;
  let frames = 0;
  let bad = 0;
  const cobsDecode = (frame: Buffer): Buffer => {
    const out: number[] = [];
    let i = 0;
    while (i < frame.length) {
      const code = frame[i]!;
      for (let j = 1; j < code && i + j < frame.length; j++) out.push(frame[i + j]!);
      i += code;
      if (code < 0xff && i < frame.length) out.push(0);
    }
    if (out[out.length - 1] === 0) out.pop();
    return Buffer.from(out);
  };
  for (let i = 0; i < all.length; i++) {
    if (all[i] === 0) {
      if (i > start) {
        const f = cobsDecode(all.subarray(start, i));
        frames++;
        // header(4) + payload(18) = 22 decoded bytes; op byte at [-18] == 1.
        if (f.length !== 22 || f[f.length - 18] !== 1) bad++;
      }
      start = i + 1;
    }
  }
  // Volume floor is PLATFORM-dependent: the flood runs until the kernel tty
  // buffer fills (real EAGAIN), and that buffer is ~64 KB on Linux (thousands
  // of ~23-byte frames) but only ~1 KB on macOS (≈40 frames, measured ~42 on
  // darwin/arm64). The floor only proves the flood
  // actually pushed data; the INTEGRITY assertions below (bad === 0, soft
  // fails counted) are the real checks and are platform-independent.
  assert(frames > 30, `flood produced frames (${frames})`);
  assert.equal(bad, 0, `every on-wire frame decodes cleanly (${bad}/${frames} bad) — framing survived EAGAIN`);
  assert(dev.stats.txSoftFail > sf0, "soft-fail events counted");
  console.log(
    `46-rate-governor: framing integrity under real EAGAIN (softFail=${dev.stats.txSoftFail}, frames=${frames}, bad=0) OK.`,
  );
}

// --- 6: latency-comp probe surface (Part 4) -------------------------------------
{
  const p = sink.probe();
  assert(p.ackRttCount > 0, "ackRtt view live on the sink probe");
  assert(p.ackRttP50 > 0, "p50 present (the session's EMA(p50)/2 input)");
  console.log("46-rate-governor: latency-comp probe surface OK.");
}

voltLink.release();
sink.release();
compose.release();
dev.release();
cleanup();
console.log("46-rate-governor: governor + pressure instrumentation passed.");
