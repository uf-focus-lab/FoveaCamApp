// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Marker-keyed vertical FLIP brick (FlipStream, docs/spec/core-streams.md
// #flip-stream) — NO hardware. A SYNTHETIC ConvertedFrame producer
// (`createPairTestSource` / `pushPairTestFrame` with an explicit pixel buffer
// and deviceTimestamp) feeds the brick one frame at a time; each frame's
// pixels are tagged in RGBA byte order (byte 0 R = row index, byte 1 G = frame
// index, byte 2 B = column, byte 3 A = 255), so a flipped frame reads its row
// tags reversed. Proves:
//   1. ATTACH GUARDS — unknown pipe / unknown source / missing, Number or
//      negative toleranceNs / non-integer anchorCap / non-string anchorFrom
//      throw; anchorCap clamps to [1, 1024]; pushFlipAnchor / flipProbe on an
//      unknown pipe → false / null; a malformed anchor (missing or Number
//      edge, tEnd < tStart, missing flip) throws. Every probe field is a
//      Number and flipProbeAll() JSON-stringifies.
//   2. ON-DEMAND — attached with no consumer, the brick processes nothing;
//      anchors pushed while parked climb `anchorDrops` harmlessly.
//   3. MATCHING — per frame, the NEAREST anchor EDGE (tStart or tEnd) within
//      ±toleranceNs (two-sided, inclusive, on deviceTimestamp) decides:
//      `flip: true` → rows reversed, `flip: false` → byte-exact pass-through,
//      no edge in tolerance → byte-exact pass-through counted `unmatched`.
//      Covers early/late anchors, the inclusive edge, an out-of-tolerance
//      anchor, an END-edge-only match, a nearer pass edge beating a farther
//      flip edge (and vice versa, across anchors and edges), the older-anchor
//      tie rule, a frame with no anchor at all, and a LATE anchor (pushed after
//      its frame was processed → unflipped, unmatched).
//   4. SKEW — `matchedSkewNs` is the mean signed (frame − matched edge) since
//      the last flipProbe (reset there; flipProbeAll only peeks).
//   5. FORWARDING — dims, crop origin and deviceTimestamp ride the v4 slot
//      header unchanged (trusted-time).
//   6. COUNTERS — frames / flipped / unmatched match the script; the anchor
//      pool is pruned per frame; `anchorCap` bounds it drop-oldest.
//   7. RE-ATTACH of a live id: the old producer leaves the ring first — one
//      offer per frame afterwards.
//   8. PARK on disconnect, TOPOLOGY row (kind "flip", a `frame` input edge
//      from the source + an `anchor` edge from `anchorFrom`), detach
//      idempotency + orderly teardown → natural exit 0.
// Run UNSANDBOXED: node core/test/54-flip-stream.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, Topology, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
type ReadOk = {
  seq: bigint;
  width: number;
  height: number;
  originX: number;
  originY: number;
  meta: { deviceTimestamp: bigint };
  closed?: undefined;
};
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint): ReadOk | { closed: true } | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Pipe as any;
type FlipProbe = {
  frames: number;
  flipped: number;
  unmatched: number;
  anchorPoolSize: number;
  anchorDrops: number;
  toleranceNs: number;
  matchedSkewNs: number;
  name: string;
  outputs: Record<string, { count: number }>;
};
const A = Aravis as unknown as {
  createPairTestSource(id: string): boolean;
  pushPairTestFrame(
    id: string,
    f: { deviceTimestamp: bigint; width: number; height: number; originX?: number; originY?: number; buffer?: Uint8Array },
  ): boolean;
  releasePairTestSource(id: string): boolean;
  attachFlipPipe(src: string, id: string, opts: unknown): boolean;
  pushFlipAnchor(id: string, anchor: unknown): boolean;
  flipProbe(id: string): FlipProbe | null;
  flipProbeAll(): Record<string, FlipProbe>;
  detachFlipPipe(id: string): boolean;
};
const T = Topology as unknown as {
  report(): Array<{ id: string; kind: string; inputs: Array<{ from: string; port: string; type?: { kind: string } }> }>;
};

const CH = 4;
const W = 32;
const H = 24;
const BYTES = W * H * CH;
const TOL = 2_000_000n; // 2 ms
const PERIOD = 10_000_000n; // 10 ms between frames
const PULSE = 1_000_000n; // default exposure length (tEnd − tStart)
const MS = 1_000_000n;
const T0 = 5_000_000_000n;
const ORIGIN = { originX: 7, originY: 3 };
const ANCHOR_FROM = "controller/test-54/trajectory";

const srcId = "test/flip/src/54";
const pipeId = `${srcId}/flip`;
const pipe2 = `${srcId}/flip2`;
const SPEC = { pixelFormat: "RGBA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: BYTES, ringDepth: 4 };

// Row-tagged frame in RGBA byte order: R = row index, G = frame index,
// B = column, A = 255.
function frameBuffer(k: number): Uint8Array {
  const b = new Uint8Array(BYTES);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      b[i] = y;
      b[i + 1] = k;
      b[i + 2] = x;
      b[i + 3] = 255;
    }
  return b;
}
const anchor = (tStart: bigint, flip: boolean, tEnd = tStart + PULSE) => ({ tStart, tEnd, flip });
const NUMBER_FIELDS = ["frames", "flipped", "unmatched", "anchorPoolSize", "anchorDrops", "toleranceNs", "matchedSkewNs"] as const;

assert.equal(A.createPairTestSource(srcId), true, "test source created");
P.advertise({ id: pipeId, ...SPEC });
P.advertise({ id: pipe2, ...SPEC });

// --- 1: attach guards --------------------------------------------------------
assert.throws(() => A.attachFlipPipe(srcId, "test/flip/none", { toleranceNs: TOL }), /unknown pipe/, "unknown target pipe throws");
assert.throws(() => A.attachFlipPipe("test/flip/nosrc", pipeId, { toleranceNs: TOL }), /no convert\/undistort\/fovea\/scale/, "unknown source throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, {}), /toleranceNs/, "missing toleranceNs throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: 2_000_000 }), /toleranceNs.*bigint/, "Number toleranceNs throws (no int32 truncation)");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: -1n }), /toleranceNs/, "negative toleranceNs throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorCap: 1.5 }), /anchorCap/, "fractional anchorCap throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorCap: "8" }), /anchorCap/, "string anchorCap throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorCap: Infinity }), /anchorCap/, "infinite anchorCap throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorFrom: 5 }), /anchorFrom/, "non-string anchorFrom throws");
assert.throws(() => A.flipProbe(5 as unknown as string), /pipeId/, "flipProbe: non-string id throws");
assert.throws(() => A.detachFlipPipe(5 as unknown as string), /pipeId/, "detachFlipPipe: non-string id throws");
assert.equal(A.pushFlipAnchor(pipeId, anchor(T0, true)), false, "pushFlipAnchor before attach → false");
assert.equal(A.flipProbe(pipeId), null, "flipProbe before attach → null");

// anchorCap clamps to [1, 1024] (on a second, consumer-less pipe: the brick is
// PARKED, so nothing prunes and anchorDrops climbs — harmlessly).
{
  assert.equal(A.attachFlipPipe(srcId, pipe2, { toleranceNs: TOL, anchorCap: 0 }), true, "anchorCap 0 attaches (clamped)");
  for (let i = 0; i < 3; i++) A.pushFlipAnchor(pipe2, anchor(T0 + BigInt(i) * PERIOD, false));
  let p = A.flipProbe(pipe2)!;
  assert.equal(p.anchorPoolSize, 1, "anchorCap 0 → clamped to 1");
  assert.equal(p.anchorDrops, 2, "parked brick: drops climb, nothing else happens");
  assert.equal(p.frames, 0, "parked brick processed nothing");
  // Re-attach the same id with no consumer (replaces the brick; fresh counters).
  assert.equal(A.attachFlipPipe(srcId, pipe2, { toleranceNs: TOL, anchorCap: 5000 }), true, "anchorCap 5000 attaches (clamped)");
  for (let i = 0; i < 1030; i++) A.pushFlipAnchor(pipe2, anchor(T0 + BigInt(i) * PERIOD, false));
  p = A.flipProbe(pipe2)!;
  assert.equal(p.anchorPoolSize, 1024, "anchorCap 5000 → clamped to 1024");
  assert.equal(p.anchorDrops, 6, "re-attached brick counts from 0");
  assert.equal(A.detachFlipPipe(pipe2), true, "detach the clamp-test brick");
  P.close(pipe2);
  P.drop(pipe2);
}

const CAP = 8;
assert.equal(
  A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorCap: CAP, anchorFrom: ANCHOR_FROM }),
  true,
  "flip attaches on the test source",
);
assert.throws(() => A.pushFlipAnchor(pipeId, { tStart: T0, tEnd: T0 }), /flip/, "anchor without `flip` throws");
assert.throws(() => A.pushFlipAnchor(pipeId, { tEnd: T0, flip: true }), /tStart/, "anchor without `tStart` throws");
assert.throws(() => A.pushFlipAnchor(pipeId, { tStart: T0, flip: true }), /tEnd/, "anchor without `tEnd` throws");
assert.throws(() => A.pushFlipAnchor(pipeId, { tStart: 5_000_000_000, tEnd: T0, flip: true }), /tStart/, "Number tStart throws (no int32 truncation)");
assert.throws(() => A.pushFlipAnchor(pipeId, { tStart: T0, tEnd: T0 - 1n, flip: true }), /tEnd/, "tEnd < tStart throws");
assert.throws(() => A.pushFlipAnchor(pipeId, { tExposure: T0, flip: true }), /tStart/, "the old one-edge shape throws");
{
  const p = A.flipProbe(pipeId)!;
  assert.equal(p.name, pipeId, "meter name == pipeId (node id)");
  for (const k of NUMBER_FIELDS) assert.equal(typeof p[k], "number", `probe.${k} is a Number`);
  assert.equal(p.toleranceNs, Number(TOL), "probe echoes toleranceNs (as a Number)");
  assert.equal(p.frames, 0, "no frames yet");
  assert.equal(p.anchorPoolSize, 0, "empty anchor pool");
  assert.equal(p.matchedSkewNs, 0, "no skew before any match");
  const all = A.flipProbeAll();
  assert(all[pipeId], "flipProbeAll lists the pipe");
  for (const k of NUMBER_FIELDS) assert.equal(typeof all[pipeId]![k], "number", `probeAll.${k} is a Number`);
  assert.doesNotThrow(() => JSON.stringify(all), "flipProbeAll rows JSON-stringify (perf snapshot)");
}
console.log("54-flip-stream: attach guards + clamps OK.");

// --- 2: on-demand — parked with no consumer ----------------------------------
await sleep(150);
assert.equal(A.flipProbe(pipeId)!.frames, 0, "brick PARKED before any consumer");

// --- 3/4/5/6: scripted frames -------------------------------------------------
// Each step: anchors (edges as offsets from the frame's ts) pushed BEFORE the
// frame (FIN precedes the frame's arrival) unless `late`, then the frame;
// expected outcome + the expected signed skew (frame − matched edge).
type A2 = { s: bigint; e?: bigint; flip: boolean };
type Step = { anchors: A2[]; expect: "flip" | "pass" | "unmatched"; skew?: bigint; late?: true };
const steps: Step[] = [
  { anchors: [{ s: 0n, flip: false }], expect: "pass", skew: 0n }, // exact start, rising
  { anchors: [{ s: 0n, flip: true }], expect: "flip", skew: 0n }, // exact start, falling
  // Early anchor: tEnd (−0.5 ms) is nearer than tStart (−1.5 ms).
  { anchors: [{ s: -1_500_000n, flip: false }], expect: "pass", skew: 500_000n },
  { anchors: [{ s: 1_500_000n, flip: true }], expect: "flip", skew: -1_500_000n }, // late anchor
  { anchors: [{ s: TOL, flip: true }], expect: "flip", skew: -TOL }, // inclusive edge
  { anchors: [{ s: TOL + 1n, flip: true }], expect: "unmatched" }, // both edges outside
  { anchors: [], expect: "unmatched" }, // no anchor at all (failed trigger)
  // END-edge-only match: tStart 5 ms early (outside), tEnd 1 ms early (inside)
  // — the frame is stamped at exposure END.
  { anchors: [{ s: -5n * MS, e: -1n * MS, flip: true }], expect: "flip", skew: 1n * MS },
  // A nearer PASS edge beats a farther FLIP edge (nearest wins)...
  { anchors: [{ s: -3_800_000n, e: -1_800_000n, flip: true }, { s: 400_000n, flip: false }], expect: "pass", skew: -400_000n },
  // ... and the other way round.
  { anchors: [{ s: -1_300_000n, flip: true }, { s: 1_900_000n, flip: false }], expect: "flip", skew: 300_000n },
  // Across anchors AND edges: one anchor's END (−0.2 ms) beats the next one's
  // START (+0.5 ms).
  { anchors: [{ s: -4n * MS, e: -200_000n, flip: true }, { s: 500_000n, flip: false }], expect: "flip", skew: 200_000n },
  // Tie (1 ms each side) → the OLDER anchor (pushed first) wins.
  { anchors: [{ s: -3n * MS, e: -1n * MS, flip: true }, { s: 1n * MS, flip: false }], expect: "flip", skew: 1n * MS },
  { anchors: [{ s: 3_000_000n, flip: true }], expect: "unmatched" }, // far late
  // LATE anchor: pushed only after its frame was processed → the frame passes
  // through unflipped and counts unmatched.
  { anchors: [{ s: 0n, flip: true }], expect: "unmatched", late: true },
  { anchors: [{ s: 0n, flip: false }], expect: "pass", skew: 0n },
  // Exact END edge (start 1 ms early).
  { anchors: [{ s: -1n * MS, flip: true }], expect: "flip", skew: 0n },
];

const rh = reader.open(P.connect(pipeId).shmName);
const dest = new ArrayBuffer(BYTES);
let lastSeq = 0n;
await sleep(100); // let the gate wake the brick + open its tap

async function readFrame(ts: bigint): Promise<ReadOk> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const r = reader.readInto(rh, dest, lastSeq);
    if (r && !(r as { closed?: true }).closed) {
      const ok = r as ReadOk;
      lastSeq = ok.seq;
      if (ok.meta.deviceTimestamp === ts) return ok;
      continue;
    }
    await sleep(2);
  }
  throw new Error(`frame @${ts} never reached the flip pipe`);
}

let expFlipped = 0;
let expUnmatched = 0;
for (let k = 0; k < steps.length; k++) {
  const step = steps[k]!;
  const ts = T0 + BigInt(k) * PERIOD;
  const push = () => {
    for (const a of step.anchors)
      assert.equal(
        A.pushFlipAnchor(pipeId, anchor(ts + a.s, a.flip, ts + (a.e ?? a.s + PULSE))),
        true,
        "anchor pushed",
      );
  };
  if (!step.late) push();
  assert.equal(
    A.pushPairTestFrame(srcId, { deviceTimestamp: ts, width: W, height: H, ...ORIGIN, buffer: frameBuffer(k) }),
    true,
    "frame pushed",
  );
  const r = await readFrame(ts);
  if (step.late) push(); // too late: the frame is already out
  assert.equal(r.width, W, `frame ${k}: width forwarded`);
  assert.equal(r.height, H, `frame ${k}: height forwarded`);
  assert.equal(r.originX, ORIGIN.originX, `frame ${k}: originX forwarded`);
  assert.equal(r.originY, ORIGIN.originY, `frame ${k}: originY forwarded`);
  const px = new Uint8Array(dest, 0, BYTES);
  const flipped = step.expect === "flip";
  for (let y = 0; y < H; y++) {
    const srcRow = flipped ? H - 1 - y : y;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      assert.equal(px[i], srcRow, `frame ${k} (${step.expect}): row ${y} carries source row ${srcRow}`);
      assert.equal(px[i + 1], k, `frame ${k}: frame tag`);
      assert.equal(px[i + 2], x, `frame ${k}: columns NOT mirrored`);
      assert.equal(px[i + 3], 255, `frame ${k}: alpha`);
    }
  }
  if (step.expect === "flip") expFlipped++;
  if (step.expect === "unmatched") expUnmatched++;
  // The skew of THIS frame (the loop's flipProbe resets the window each step;
  // the flipProbeAll peek before it must not).
  const expSkew = step.skew === undefined ? 0 : Number(step.skew);
  assert.equal(A.flipProbeAll()[pipeId]!.matchedSkewNs, expSkew, `frame ${k}: peeked skew`);
  const p = A.flipProbe(pipeId)!;
  assert.equal(p.matchedSkewNs, expSkew, `frame ${k}: matchedSkewNs (peek did not reset)`);
  assert.equal(A.flipProbe(pipeId)!.matchedSkewNs, 0, `frame ${k}: flipProbe reset the skew window`);
  assert(p.anchorPoolSize <= 2, `frame ${k}: anchor pool pruned per frame (size ${p.anchorPoolSize})`);
}
{
  const p = A.flipProbe(pipeId)!;
  assert.equal(p.frames, steps.length, "frames counter");
  assert.equal(p.flipped, expFlipped, "flipped counter");
  assert.equal(p.unmatched, expUnmatched, "unmatched counter");
  assert.equal(p.outputs.flip.count, steps.length, "meter output count");
  assert.equal(p.anchorDrops, 0, "no cap evictions during the script");
}
// The skew is a MEAN over the matched frames since the last flipProbe.
{
  const base = T0 + 500n * PERIOD;
  A.pushFlipAnchor(pipeId, anchor(base - 300_000n, false)); // skew +0.3 ms
  A.pushPairTestFrame(srcId, { deviceTimestamp: base, width: W, height: H, buffer: frameBuffer(50) });
  await readFrame(base);
  A.pushFlipAnchor(pipeId, anchor(base + PERIOD + 100_000n, false)); // skew −0.1 ms
  A.pushPairTestFrame(srcId, { deviceTimestamp: base + PERIOD, width: W, height: H, buffer: frameBuffer(51) });
  await readFrame(base + PERIOD);
  A.pushPairTestFrame(srcId, { deviceTimestamp: base + 2n * PERIOD, width: W, height: H, buffer: frameBuffer(52) });
  await readFrame(base + 2n * PERIOD); // unmatched: not in the mean
  assert.equal(A.flipProbe(pipeId)!.matchedSkewNs, 100_000, "mean skew over the matched frames only");
}
console.log(`54-flip-stream: matching (${expFlipped} flipped, ${expUnmatched} unmatched of ${steps.length}) + skew + forwarding OK.`);

// --- 6b: anchorCap bounds the pool drop-oldest --------------------------------
{
  const far = T0 + 1_000n * PERIOD; // beyond every frame above — never pruned yet
  const before = A.flipProbe(pipeId)!;
  for (let i = 0; i < CAP + 5; i++) A.pushFlipAnchor(pipeId, anchor(far + BigInt(i) * PERIOD, i % 2 === 0));
  const p = A.flipProbe(pipeId)!;
  assert.equal(p.anchorPoolSize, CAP, "pool bounded at anchorCap");
  assert.equal(p.anchorDrops - before.anchorDrops, before.anchorPoolSize + 5, "overflow evicted drop-oldest");
  // The survivors are the NEWEST CAP anchors: the last pushed (i = CAP+4, a
  // FLIP anchor) still decides a frame at its exact time — under drop-newest it
  // would be gone and the frame would pass through unmatched.
  const iLast = CAP + 4;
  const ts = far + BigInt(iLast) * PERIOD;
  A.pushPairTestFrame(srcId, { deviceTimestamp: ts, width: W, height: H, buffer: frameBuffer(99) });
  await readFrame(ts);
  const px = new Uint8Array(dest, 0, BYTES);
  assert.equal(iLast % 2, 0, "fixture: the newest anchor is a flip anchor");
  assert.equal(px[0], H - 1, "newest anchor survived the cap and decided the frame");
  assert.equal(A.flipProbe(pipeId)!.anchorPoolSize, 1, "older anchors pruned once a later one matched");
}
console.log("54-flip-stream: anchorCap drop-oldest + prune OK.");

// --- 7: re-attach a LIVE id: one producer on the ring afterwards -------------
{
  assert.equal(
    A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorCap: CAP, anchorFrom: ANCHOR_FROM }),
    true,
    "re-attach the live flip pipe",
  );
  assert.equal(A.flipProbe(pipeId)!.frames, 0, "the replacement brick counts from 0");
  await sleep(100); // the gate fired at once (consumer present); let the tap open
  const ts = T0 + 2_000n * PERIOD;
  A.pushFlipAnchor(pipeId, anchor(ts, true));
  A.pushPairTestFrame(srcId, { deviceTimestamp: ts, width: W, height: H, buffer: frameBuffer(7) });
  await readFrame(ts);
  assert.equal(new Uint8Array(dest, 0, BYTES)[0], H - 1, "the replacement brick flipped the frame");
  await sleep(150);
  // Had the old subscriber survived, the OLD brick (still tapping the source)
  // would have offered the same frame a second time (unflipped, no anchors).
  assert.equal(reader.readInto(rh, dest, lastSeq), null, "exactly one offer per frame after re-attach");
  assert.equal(A.flipProbe(pipeId)!.frames, 1, "the replacement brick saw the frame");
}
console.log("54-flip-stream: re-attach OK.");

// --- 8a: park on disconnect ---------------------------------------------------
reader.close(rh);
P.disconnect(pipeId);
await sleep(200);
{
  // The brick thread may still be blocked in its tap read when the consumer
  // leaves, so ONE in-flight frame can drain before it parks (34's rule).
  const parked = A.flipProbe(pipeId)!.frames;
  for (let i = 0; i < 4; i++) {
    A.pushPairTestFrame(srcId, { deviceTimestamp: T0 + (5_000n + BigInt(i)) * PERIOD, width: W, height: H });
    await sleep(50);
  }
  await sleep(300);
  const delta = A.flipProbe(pipeId)!.frames - parked;
  assert(delta <= 1, `brick parked after the consumer left (Δ=${delta})`);
}
console.log("54-flip-stream: park on disconnect OK.");

// --- 8b: topology row ---------------------------------------------------------
{
  const row = T.report().find((n) => n.id === pipeId);
  assert(row, "flip pipe appears in Topology.report()");
  assert.equal(row!.kind, "flip", "topology kind == flip");
  assert.equal(row!.inputs.length, 2, "two input edges (frame + anchor)");
  assert(row!.inputs.some((i) => i.from === srcId && i.port === "frame"), "input edge source → flip, port frame");
  const a = row!.inputs.find((i) => i.port === "anchor");
  assert(a && a.from === ANCHOR_FROM, "anchor edge from the `anchorFrom` node");
  assert.equal(a!.type?.kind, "analysis", "anchor edge typed as the trajectory record stream");
}
console.log("54-flip-stream: topology OK.");

// --- 8c: detach idempotency + orderly teardown --------------------------------
assert.equal(A.detachFlipPipe(pipeId), true, "detach flip");
assert.equal(A.detachFlipPipe(pipeId), false, "detach idempotent");
assert.equal(A.flipProbe(pipeId), null, "detached id → null probe");
assert.equal(A.flipProbeAll()[pipeId], undefined, "detached id absent from flipProbeAll");
assert.equal(A.pushFlipAnchor(pipeId, anchor(T0, true)), false, "pushFlipAnchor after detach → false");
P.close(pipeId);
P.drop(pipeId);
assert.equal(A.releasePairTestSource(srcId), true, "release test source");

await sleep(100);
console.log("54-flip-stream: orderly teardown complete — exiting naturally.");
