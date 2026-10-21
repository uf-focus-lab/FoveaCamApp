// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native compose brick + controller pos_in sink — NO hardware. Proves:
//   1. COMPOSE CONFORMANCE — shared vectors (docs/schema/codec/
//      compose-vectors.json, generated from the JS composeVolts
//      reference): rebase + a piped prediction tick reproduce
//      V = V_pid + J·(p_pred − p_meas); feedForward=false and a coasted miss
//      hold the baseline; every rebase emits the baseline FLOOR.
//   2. GATE — the native stream-update gate replicates the JS
//      StreamUpdateGate: dedupe (same pose → no write) + min interval
//      (minIntervalUs, pinned to 1 ms for the throttle probe; counted, never
//      blocking the link delivery thread).
//   3. WIRE — UPDATE frames actually land on the serial fd (a PTY pair —
//      `__serialTestPty`; the Device opens the slave, the test reads the
//      master) and decode to CMD_STREAM UPDATE packets with the exact
//      channels() DAC math; history records the predictVolts-parity
//      DAC round-trip volts.
//   4. HISTORY — ring recording + historyLatest/historyAt (mirrorAt-parity
//      interpolation + clamped ends) + historyQuery range.
//   5. TEARDOWN under load: link release mid-flood, then
//      Device release mid-flow — the write seam closes FIRST, sink writes
//      become counted no-ops (open:false), no crash, no further bytes.
//
// Run UNSANDBOXED: node core/test/45-native-compose.ts

import assert from "node:assert/strict";
import { readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Controller, Tracker, cleanup } from "core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type XY = { x: number; y: number };
type Volts = { left: XY; right: XY };
type Compose = {
  rebase(p: {
    vPid: { l: XY; r: XY };
    pMeas?: XY;
    jL?: number[];
    jR?: number[];
    feedForward?: boolean;
  }): void;
  probe(): { inputs: Record<string, { count: number }>; outputs: Record<string, { count: number }> };
  pred_in: { streamTag: string };
  volt_out: { streamTag: string; pipe(t: unknown, o?: unknown): Link };
  release(): void;
  [Symbol.asyncIterator](): AsyncIterator<Volts>;
};
type Link = { probe(): { written: number; delivered: number }; release(): void };
type PredSource = {
  predict_out: { streamTag: string; pipe(t: unknown, o?: unknown): Link };
  push(p: { found: boolean; center: XY | null; seq?: number; ageMs?: number }): void;
  release(): void;
};
type Sink = {
  pos_in: { streamTag: string };
  probe(): {
    received: number; written: number; deduped: number;
    throttled: number; errors: number; open: boolean;
  };
  historyLatest(): { tNs: bigint; left: XY; right: XY } | null;
  historyAt(tNs: bigint): { left: XY; right: XY; ageNs: bigint; interpolated: boolean } | null;
  historyQuery(fromNs: bigint, toNs: bigint): Array<{ tNs: bigint }>;
  setGovernor(p: object): void;
  release(): void;
};

const T = Tracker as unknown as {
  createComposeStream(o: { name: string; initial: { l: XY; r: XY }; staleAfterMs?: number; maxDeltaV?: number }): Compose;
  createTestPredictionSource(id: string): PredSource;
};
const C = Controller as unknown as {
  Device: new (path: string) => { release(): void };
  createMirrorSink(dev: unknown, o: { streamId: number; bias?: number; dv?: number; nodeId?: string }): Sink;
  __serialTestPty(): { fd: number; path: string };
};

type FixtureRebase = {
  vPid: { l: XY; r: XY };
  pMeas?: XY;
  jL?: number[];
  jR?: number[];
  feedForward: boolean;
};
interface Fixture {
  tolerance: number;
  vectors: Array<{
    seq: number;
    rebase: FixtureRebase;
    pred: { found: boolean; center: XY | null };
    expected: { l: XY; r: XY };
  }>;
  floorPolicy: {
    tolerance: number;
    steps: Array<{
      op: "rebase" | "pred";
      note: string;
      rebase?: FixtureRebase;
      pred?: { found: boolean; center: XY | null };
      expected: { l: XY; r: XY };
    }>;
  };
}
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../docs/schema/codec/compose-vectors.json", import.meta.url)),
    "utf8",
  ),
) as Fixture;

// --- 1: compose conformance -----------------------------------------------------
{
  const compose = T.createComposeStream({
    name: "win/45/compose",
    initial: { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } },
    // Algebra pin only — the staleness bound and the guard-5 delta clamp
    // each have their OWN sections; the fixture's cross-vector
    // floor deltas legitimately exceed the default 50 V clamp.
    staleAfterMs: 0,
    maxDeltaV: 0,
  });
  const src = T.createTestPredictionSource("test/45/imm");
  assert.equal(src.predict_out.streamTag, "prediction", "predict_out tag");
  assert.equal(compose.pred_in.streamTag, "prediction", "pred_in tag");
  assert.equal(compose.volt_out.streamTag, "volts", "volt_out tag");
  const link = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 16 });

  const it = compose[Symbol.asyncIterator]();
  const next = async (): Promise<Volts> => {
    const r = await Promise.race([
      it.next(),
      sleep(8000).then(() => {
        throw new Error("compose emit timed out");
      }),
    ]);
    return (r as IteratorResult<Volts>).value;
  };
  const tol = fixture.tolerance;
  const close = (a: number, b: number, what: string) =>
    assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

  // Expected FLOOR emission under the D2 policy:
  // the newest cached prediction applied against the NEW linearization; a cold
  // brick (no prediction yet) or an unhealthy rebase floors the raw baseline.
  const floorExpect = (r: Fixture["vectors"][number]["rebase"], lastPred: XY | null): { l: XY; r: XY } => {
    if (!lastPred || !r.feedForward || !r.pMeas || !r.jL || !r.jR)
      return { l: r.vPid.l, r: r.vPid.r };
    const dx = lastPred.x - r.pMeas.x;
    const dy = lastPred.y - r.pMeas.y;
    return {
      l: { x: r.vPid.l.x + r.jL[0]! * dx + r.jL[1]! * dy, y: r.vPid.l.y + r.jL[2]! * dx + r.jL[3]! * dy },
      r: { x: r.vPid.r.x + r.jR[0]! * dx + r.jR[1]! * dy, y: r.vPid.r.y + r.jR[2]! * dx + r.jR[3]! * dy },
    };
  };

  let seq = 0;
  let lastPred: XY | null = null;
  for (const v of fixture.vectors) {
    compose.rebase(v.rebase);
    const floor = await next();
    // Policy: every rebase emits a floor, but
    // the floor no longer RESCINDS a healthy feed-forward — it re-applies the
    // cached prediction against the new linearization (raw only while cold).
    const fexp = floorExpect(v.rebase, lastPred);
    close(floor.left.x, fexp.l.x, `vector ${v.seq} floor l.x`);
    close(floor.left.y, fexp.l.y, `vector ${v.seq} floor l.y`);
    close(floor.right.x, fexp.r.x, `vector ${v.seq} floor r.x`);
    close(floor.right.y, fexp.r.y, `vector ${v.seq} floor r.y`);
    src.push({ found: v.pred.found, center: v.pred.center, seq: ++seq });
    // Mirror the brick's cache: the LATEST prediction wins — a found=false
    // pred overwrites the cache and the next floor degrades to raw.
    lastPred = v.pred.found && v.pred.center ? v.pred.center : null;
    const tick = await next();
    close(tick.left.x, v.expected.l.x, `vector ${v.seq} tick l.x`);
    close(tick.left.y, v.expected.l.y, `vector ${v.seq} tick l.y`);
    close(tick.right.x, v.expected.r.x, `vector ${v.seq} tick r.x`);
    close(tick.right.y, v.expected.r.y, `vector ${v.seq} tick r.y`);
  }
  await it.return?.();
  link.release();
  src.release();
  compose.release();
  console.log(
    `45-native-compose: conformance OK — ${fixture.vectors.length} vectors match the JS composeVolts reference (floor + tick).`,
  );
}

// --- helpers for the sink phases --------------------------------------------------
// Tiny COBS decode + packet parse (lib/COBS framing: 0x00-delimited frames;
// packet = header(method|property, checksum? layout: [0]=xor checksum settled
// by finalize at byte1? — we assert only the STABLE facts: frame count, frame
// length, the MirrorStream payload tail: op, id, 8×uint16 LE channels).
function cobsDecode(frame: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < frame.length) {
    const code = frame[i]!;
    for (let j = 1; j < code && i + j < frame.length; j++) out.push(frame[i + j]!);
    i += code;
    if (code < 0xff && i < frame.length) out.push(0);
  }
  // trailing phantom zero from the loop above (frame never ends mid-block)
  if (out[out.length - 1] === 0) out.pop();
  return Buffer.from(out);
}
function drainFrames(fd: number): Buffer[] {
  const buf = Buffer.alloc(65536);
  let n = 0;
  try {
    n = readSync(fd, buf, 0, buf.length, null);
  } catch {
    return []; // EAGAIN — nothing buffered
  }
  const frames: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      if (i > start) frames.push(cobsDecode(buf.subarray(start, i)));
      start = i + 1;
    }
  }
  return frames;
}
// @lib/controller-codec channels() reimplemented for the wire assertion.
const volt2dac = (v: number): number => Math.min(65535, Math.max(0, (65535 * v) / 200)) | 0;
function channels(p: XY, bias: number, dv: number): number[] {
  const ch = (volt: number, d: number): [number, number] => {
    const v = Math.min(d, Math.max(-d, volt / 2));
    return [volt2dac(bias + v), volt2dac(bias - v)];
  };
  return [...ch(p.x, dv / 2), ...ch(p.y, dv / 2)];
}

// --- 2 + 3 + 4: gate, wire framing, history ---------------------------------------
{
  const pty = C.__serialTestPty();
  const dev = new C.Device(pty.path);
  const sink = C.createMirrorSink(dev, { streamId: 5, bias: 90, dv: 170, nodeId: "controller" });
  assert.equal(sink.pos_in.streamTag, "volts", "pos_in tag");

  const compose = T.createComposeStream({
    name: "win/45/compose2",
    initial: { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } },
  });
  const voltLink = compose.volt_out.pipe(sink.pos_in); // latest (production shape)

  const drive = (l: XY, r: XY) =>
    compose.rebase({ vPid: { l, r }, feedForward: false });

  // First pose → 1 write.
  drive({ x: 10, y: 20 }, { x: 30, y: 40 });
  await sleep(50);
  {
    const p = sink.probe();
    assert.equal(p.written, 1, "first pose written");
    assert.equal(p.errors, 0, "no write errors");
  }
  // Same pose repeatedly → DEDUPED, no extra writes. NOTE the volt link is
  // LATEST (the production shape): the Leaky channel may itself shed some of
  // the duplicates before they reach the sink, so the deterministic contract
  // is `written stays 1` + `at least one duplicate was gate-deduped`.
  for (let i = 0; i < 5; i++) {
    drive({ x: 10, y: 20 }, { x: 30, y: 40 });
    await sleep(5);
  }
  {
    const p = sink.probe();
    assert.equal(p.written, 1, "identical poses dedupe (no extra writes)");
    assert(p.deduped >= 1, `dedupe counted (${p.deduped})`);
  }
  // Distinct poses spaced beyond the 1 ms gate → each writes.
  for (let i = 1; i <= 5; i++) {
    drive({ x: 10 + i, y: 20 }, { x: 30, y: 40 });
    await sleep(5);
  }
  {
    const p = sink.probe();
    assert.equal(p.written, 6, "spaced distinct poses all write");
  }
  // Distinct poses FASTER than 1 ms → throttled (min interval). Two flake
  // traps to avoid (both hit in accepted-run loops):
  //  - a LATEST volt link can shed the burst down to >1 ms-apart deliveries;
  //  - a REBASE burst is legitimately COALESCED by the brick (iterate reads
  //    the CURRENT linearization, so queued floor events all emit the LAST
  //    pose → dedupe, never throttle).
  // Deterministic proof: PREDICTION ticks carry their center IN the event, so
  // 20 distinct predictions through FIFO links (pred + volt — lossless, back-
  // to-back on the delivery threads) MUST produce distinct sub-ms volts, and
  // the second-and-later ones MUST hit the 1 ms gate. The emission floor is
  // a tunable (GovernorParams.minIntervalUs, default 200 µs since the V0.1
  // board): pin it to 1 ms here so "sub-ms apart" deterministically throttles.
  sink.setGovernor({ minIntervalUs: 1000, ceilingHz: 1000 });
  {
    const fifoVolt = compose.volt_out.pipe(sink.pos_in, { type: "fifo", depth: 32 });
    const src = T.createTestPredictionSource("test/45/throttle-src");
    const fifoPred = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 32 });
    compose.rebase({
      vPid: { l: { x: 50, y: 20 }, r: { x: 30, y: 40 } },
      pMeas: { x: 0, y: 0 },
      jL: [0.1, 0, 0, 0.1],
      jR: [0.1, 0, 0, 0.1],
      feedForward: true,
    });
    await sleep(20); // let the floor emit land
    for (let i = 0; i < 20; i++)
      src.push({ found: true, center: { x: 10 + i, y: 0 }, seq: i + 1 });
    await sleep(100);
    const p = sink.probe();
    assert(p.throttled > 0, `min-interval throttling engaged (${p.throttled})`);
    assert(p.written < 30, "burst did not all reach the wire");
    fifoPred.release();
    src.release();
    fifoVolt.release();
  }

  // WIRE: frames decode to CMD_STREAM UPDATE with the exact channels() DACs.
  const frames = drainFrames(pty.fd);
  const p = sink.probe();
  assert.equal(frames.length, p.written, `one COBS frame per written UPDATE (${frames.length}/${p.written})`);
  {
    // First frame = the first pose. Payload tail: [-18..] op(1) id(1) 8×u16 LE.
    const f = frames[0]!;
    const payload = f.subarray(f.length - 18);
    assert.equal(payload[0], 1, "op == UPDATE");
    assert.equal(payload[1], 5, "stream id");
    const expect = [...channels({ x: 10, y: 20 }, 90, 170), ...channels({ x: 30, y: 40 }, 90, 170)];
    for (let i = 0; i < 8; i++)
      assert.equal(payload.readUInt16LE(2 + i * 2), expect[i], `DAC channel ${i}`);
  }
  console.log(`45-native-compose: gate (dedupe+throttle) + wire framing (${frames.length} UPDATEs decoded) OK.`);

  // HISTORY: latest reflects the last WRITTEN pose (DAC round-trip volts);
  // interpolation + range + clamped ends behave like the JS mirrorAt.
  {
    const latest = sink.historyLatest();
    assert(latest, "history has samples");
    const q = sink.historyQuery(0n, latest!.tNs);
    assert.equal(q.length, sink.probe().written, "one history sample per write");
    // Clamped BEFORE the span.
    const before = sink.historyAt(q[0]!.tNs - 1000n);
    assert(before && !before.interpolated, "pre-span query clamps (interpolated=false)");
    // Midpoint between two samples interpolates.
    if (q.length >= 2) {
      const a = q[q.length - 2]!.tNs, b = q[q.length - 1]!.tNs;
      const mid = sink.historyAt((a + b) / 2n);
      assert(mid && mid.interpolated, "mid-span query interpolates");
    }
    // DAC round-trip parity: |recorded − commanded| < one DAC step (~3 mV·2).
    assert(Math.abs(latest!.left.y - 20) < 0.01, `history volts ≈ commanded (${latest!.left.y})`);
  }
  console.log("45-native-compose: history ring (latest/at/query, mirrorAt parity) OK.");

  // --- 5: teardown under load + seam close --------------------------
  // Flood ticks while links churn (the port-pipe release-under-load discipline).
  const src = T.createTestPredictionSource("test/45/imm2");
  compose.rebase({
    vPid: { l: { x: 1, y: 1 }, r: { x: 1, y: 1 } },
    pMeas: { x: 0, y: 0 }, jL: [0.01, 0, 0, 0.01], jR: [0.01, 0, 0, 0.01],
    feedForward: true,
  });
  let seq = 0;
  const flood = setInterval(() => {
    for (let i = 0; i < 5; i++) src.push({ found: true, center: { x: ++seq % 400, y: 7 }, seq });
  }, 1);
  for (let i = 0; i < 10; i++) {
    const l = src.predict_out.pipe(compose.pred_in);
    await sleep(10);
    l.release(); // release under producer load
  }
  const keep = src.predict_out.pipe(compose.pred_in);
  await sleep(50);
  const beforeRelease = sink.probe().written;
  assert(beforeRelease > 6, `flood reached the wire (${beforeRelease})`);

  // Device release MID-FLOW: the seam closes FIRST → sink writes become
  // counted no-ops (open:false), never a crash / a write on a dead fd.
  dev.release();
  await sleep(30);
  const afterClose = sink.probe();
  assert.equal(afterClose.open, false, "seam closed on device release");
  const wrote = afterClose.written;
  await sleep(60); // flood continues against the closed seam
  const later = sink.probe();
  assert.equal(later.written, wrote, "no writes after the seam closed");
  assert(later.errors > 0, `post-close writes counted as errors (${later.errors})`);
  clearInterval(flood);
  keep.release();
  voltLink.release();
  src.release();
  compose.release();
  sink.release();
  console.log("45-native-compose: teardown under load + FW5 seam close (no writes after disconnect) OK.");
}

// --- 6: D2 floor policy + runaway guards --------
// (a) the shared floorPolicy sequence vector: a rebase BETWEEN predictions
//     emits NO baseline dip (pre-fix, every rebase floored RAW vPid — the
//     60 Hz sawtooth); (b) cold brick still floor-emits; (c) a stalled imm
//     degrades to the raw floor within the staleness bound; (d) guard 5
//     clamps the composed |J·Δp| per axis.
{
  const mkCompose = (name: string, opts: { staleAfterMs?: number; maxDeltaV?: number } = {}) =>
    T.createComposeStream({ name, initial: { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } }, ...opts } as never);
  const reader = (compose: Compose) => {
    const it = compose[Symbol.asyncIterator]();
    return {
      next: async (): Promise<Volts> => {
        const r = await Promise.race([
          it.next(),
          sleep(8000).then(() => {
            throw new Error("compose emit timed out");
          }),
        ]);
        return (r as IteratorResult<Volts>).value;
      },
      done: () => it.return?.(),
    };
  };
  const closeTo = (a: number, b: number, tol: number, what: string) =>
    assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

  // (a) the floorPolicy sequence vector — both implementations pin these numbers.
  {
    const fp = fixture.floorPolicy;
    const compose = mkCompose("win/45/floor-policy", { staleAfterMs: 0 });
    const src = T.createTestPredictionSource("test/45/floor-imm");
    const link = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 16 });
    const r = reader(compose);
    let seq = 100;
    for (const [i, step] of fp.steps.entries()) {
      if (step.op === "rebase") compose.rebase(step.rebase!);
      else src.push({ found: step.pred!.found, center: step.pred!.center, seq: ++seq });
      const out = await r.next();
      closeTo(out.left.x, step.expected.l.x, fp.tolerance, `floorPolicy[${i}] l.x (${step.note})`);
      closeTo(out.left.y, step.expected.l.y, fp.tolerance, `floorPolicy[${i}] l.y`);
      closeTo(out.right.x, step.expected.r.x, fp.tolerance, `floorPolicy[${i}] r.x`);
      closeTo(out.right.y, step.expected.r.y, fp.tolerance, `floorPolicy[${i}] r.y`);
    }
    await r.done();
    link.release();
    src.release();
    compose.release();
    console.log(`45-native-compose: floorPolicy vector OK — ${fp.steps.length} steps (rebase between predictions emits NO baseline dip).`);
  }

  // (a′) sawtooth regression: predictions at ~600 Hz with a CONSTANT lead +
  // rebases at ~60 Hz with feedForward=true → EVERY emitted pose includes the
  // delta (pre-fix this failed on every rebase: 21/21 raw floors measured).
  {
    const compose = mkCompose("win/45/sawtooth", { staleAfterMs: 0 });
    const src = T.createTestPredictionSource("test/45/sawtooth-imm");
    const link = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 64 });
    const J = [0.02, 0, 0, 0.02];
    const rb = {
      vPid: { l: { x: 1, y: 1 }, r: { x: 1, y: 1 } },
      pMeas: { x: 100, y: 100 },
      jL: J,
      jR: J,
      feedForward: true,
    };
    const PRED = { x: 150, y: 100 }; // constant lead: +50 px → +1.0 V on x
    const out: Volts[] = [];
    const it = compose[Symbol.asyncIterator]();
    const pump = (async () => {
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        out.push(r.value as Volts);
      }
    })().catch(() => {});
    compose.rebase(rb);
    await sleep(5);
    src.push({ found: true, center: PRED, seq: 1 }); // warm the cache
    // Deterministic warm-up: wait until the first LEAD emission lands (the
    // link delivery + compose thread hop is asynchronous — a fixed sleep
    // flakes under load, and a rebase issued before the cache warms would
    // legitimately floor raw).
    {
      const deadline = Date.now() + 5000;
      while (!out.some((v) => Math.abs(v.left.x - 2.0) < 1e-9)) {
        assert(Date.now() < deadline, "warm-up prediction never emitted");
        await sleep(2);
      }
    }
    let seq = 1;
    for (let i = 0; i < 20; i++) {
      for (let k = 0; k < 5; k++) {
        src.push({ found: true, center: PRED, seq: ++seq });
        await sleep(1);
      }
      compose.rebase(rb); // the pre-fix dip point
      await sleep(2);
    }
    await sleep(20);
    await it.return?.();
    await pump;
    // Everything from the FIRST lead emission onward must carry the delta —
    // cold floors before the first prediction are expected (decision 4); the
    // D2 bug was raw floors AFTER predictions.
    const firstLead = out.findIndex((v) => Math.abs(v.left.x - 2.0) < 1e-9);
    assert(firstLead >= 0, "a lead emission exists");
    const warm = out.slice(firstLead);
    assert(warm.length > 80, `enough emissions collected (${warm.length})`);
    // The lead is x-only (PRED shifts +50 px in x; J is diagonal): every warm
    // emission must carry l.x = vPid + 1.0 V while l.y holds the baseline.
    let maxDev = 0;
    for (const v of warm) maxDev = Math.max(maxDev, Math.abs(v.left.x - 2.0), Math.abs(v.left.y - 1.0));
    assert(maxDev < 1e-9, `every warm emission includes the feed-forward delta (max dev ${maxDev})`);
    link.release();
    src.release();
    compose.release();
    console.log(`45-native-compose: sawtooth regression OK — ${warm.length} emissions, zero baseline dips (pre-fix: every rebase dipped).`);
  }

  // (b) cold brick: zero predictions ever → floors emit the RAW baseline.
  {
    const compose = mkCompose("win/45/cold");
    const r = reader(compose);
    const rb = {
      vPid: { l: { x: 3, y: 4 }, r: { x: 5, y: 6 } },
      pMeas: { x: 0, y: 0 },
      jL: [1, 0, 0, 1],
      jR: [1, 0, 0, 1],
      feedForward: true,
    };
    compose.rebase(rb);
    const f1 = await r.next();
    assert.equal(f1.left.x, 3, "cold floor l.x = raw vPid");
    assert.equal(f1.right.y, 6, "cold floor r.y = raw vPid");
    compose.rebase(rb);
    const f2 = await r.next();
    assert.equal(f2.left.x, 3, "cold floor stays raw across rebases");
    await r.done();
    compose.release();
    console.log("45-native-compose: cold brick floor-emits the raw baseline OK.");
  }

  // (c) STALLED imm: predictions stop, rebases keep coming → once the cached
  // prediction exceeds the staleness bound, floors degrade to the RAW
  // baseline (value-sweep staleness discipline). Also: an already-stale push
  // (ageMs) is never applied.
  {
    const compose = mkCompose("win/45/stale", { staleAfterMs: 40 });
    const src = T.createTestPredictionSource("test/45/stale-imm");
    const link = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 16 });
    const r = reader(compose);
    const J = [0.02, 0, 0, 0.02];
    const rb = {
      vPid: { l: { x: 1, y: 1 }, r: { x: 1, y: 1 } },
      pMeas: { x: 100, y: 100 },
      jL: J,
      jR: J,
      feedForward: true,
    };
    compose.rebase(rb);
    await r.next(); // cold floor
    src.push({ found: true, center: { x: 150, y: 100 }, seq: 1 });
    const tick = await r.next();
    closeTo(tick.left.x, 2.0, 1e-9, "fresh prediction applies");
    compose.rebase(rb);
    const floorFresh = await r.next();
    closeTo(floorFresh.left.x, 2.0, 1e-9, "floor within the bound keeps the lead");
    await sleep(80); // exceed staleAfterMs=40 with NO new predictions
    compose.rebase(rb);
    const floorStale = await r.next();
    closeTo(floorStale.left.x, 1.0, 1e-9, "stale floor degrades to the raw baseline");
    // A prediction tick that is ITSELF stale (ageMs) must not apply either.
    src.push({ found: true, center: { x: 150, y: 100 }, seq: 2, ageMs: 500 });
    const tickStale = await r.next();
    closeTo(tickStale.left.x, 1.0, 1e-9, "stale prediction tick holds the baseline");
    await r.done();
    link.release();
    src.release();
    compose.release();
    console.log("45-native-compose: stalled-imm staleness degrade (floor AND tick) OK.");
  }

  // (d) guard 5: the composed |J·Δp| clamps per axis to maxDeltaV.
  {
    const compose = mkCompose("win/45/clamp", { staleAfterMs: 0, maxDeltaV: 0.5 });
    const src = T.createTestPredictionSource("test/45/clamp-imm");
    const link = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 16 });
    const r = reader(compose);
    compose.rebase({
      vPid: { l: { x: 1, y: 1 }, r: { x: 1, y: 1 } },
      pMeas: { x: 0, y: 0 },
      // Row-major [dVx/dpx, dVx/dpy, dVy/dpx, dVy/dpy]: dx drives BOTH left
      // axes (+1 into x, −1 into y) so both clamp rails are exercised.
      jL: [1, 0, -1, 0],
      jR: [0.001, 0, 0, 0.001],
      feedForward: true,
    });
    await r.next(); // cold floor
    // Runaway-sized delta: 300 px → J·Δp = +300 V on l.x and −300 V on l.y —
    // both clamp to ±maxDeltaV (0.5); the right eye's small legitimate delta
    // (0.001·300 = 0.3 V) passes through unclamped.
    src.push({ found: true, center: { x: 300, y: 0 }, seq: 1 });
    const t = await r.next();
    assert.equal(t.left.x, 1 + 0.5, "l.x delta clamped to +maxDeltaV");
    assert.equal(t.left.y, 1 - 0.5, "l.y delta clamped to −maxDeltaV");
    closeTo(t.right.x, 1 + 0.3, 1e-9, "legitimate small delta passes unclamped");
    await r.done();
    link.release();
    src.release();
    compose.release();
    console.log("45-native-compose: guard-5 volt-space delta clamp OK.");
  }
}

cleanup();
console.log("45-native-compose: native compose + controller pos_in passed.");
