// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Marker-keyed vertical FLIP brick (FlipStream, docs/spec/core-streams.md
// #flip-stream) — NO hardware. A SYNTHETIC ConvertedFrame producer
// (`createPairTestSource` / `pushPairTestFrame` with an explicit pixel buffer
// and deviceTimestamp) feeds the brick one frame at a time; each frame's rows
// are tagged (B = row index, G = frame index), so a flipped frame reads its
// row tags reversed. Proves:
//   1. ATTACH GUARDS — unknown pipe / unknown source / missing or negative
//      toleranceNs / bad anchorCap throw; pushFlipAnchor / flipProbe on an
//      unknown pipe → false / null; a malformed anchor throws.
//   2. ON-DEMAND — attached with no consumer, the brick processes nothing.
//   3. MATCHING — per frame, the NEAREST anchor within ±toleranceNs (two-sided,
//      inclusive, on deviceTimestamp) decides: `flip: true` → rows reversed,
//      `flip: false` → byte-exact pass-through, none in tolerance → byte-exact
//      pass-through counted `unmatched`. Covers early/late anchors, the
//      inclusive edge, an out-of-tolerance anchor, a nearer pass anchor beating
//      a farther flip anchor, and a frame with no anchor at all.
//   4. FORWARDING — dims, crop origin and deviceTimestamp ride the v4 slot
//      header unchanged (trusted-time).
//   5. COUNTERS — frames / flipped / unmatched match the script; the anchor
//      pool is pruned per frame; `anchorCap` bounds it drop-oldest.
//   6. PARK on disconnect, TOPOLOGY row (kind "flip", one `frame` input edge),
//      detach idempotency + orderly teardown → natural exit 0.
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
  toleranceNs: bigint;
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
  report(): Array<{ id: string; kind: string; inputs: Array<{ from: string; port: string }> }>;
};

const CH = 4;
const W = 32;
const H = 24;
const BYTES = W * H * CH;
const TOL = 2_000_000n; // 2 ms
const PERIOD = 10_000_000n; // 10 ms between frames
const T0 = 5_000_000_000n;
const ORIGIN = { originX: 7, originY: 3 };

const srcId = "test/flip/src/54";
const pipeId = `${srcId}/flip`;

// Row-tagged frame: B = row index, G = frame index, R = column, A = 255.
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

assert.equal(A.createPairTestSource(srcId), true, "test source created");
P.advertise({ id: pipeId, pixelFormat: "RGBA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: BYTES, ringDepth: 4 });

// --- 1: attach guards --------------------------------------------------------
assert.throws(() => A.attachFlipPipe(srcId, "test/flip/none", { toleranceNs: TOL }), /unknown pipe/, "unknown target pipe throws");
assert.throws(() => A.attachFlipPipe("test/flip/nosrc", pipeId, { toleranceNs: TOL }), /no convert\/undistort\/fovea\/scale/, "unknown source throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, {}), /toleranceNs/, "missing toleranceNs throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: -1n }), /toleranceNs/, "negative toleranceNs throws");
assert.throws(() => A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorCap: 0 }), /anchorCap/, "anchorCap 0 throws");
assert.equal(A.pushFlipAnchor(pipeId, { tExposure: T0, flip: true }), false, "pushFlipAnchor before attach → false");
assert.equal(A.flipProbe(pipeId), null, "flipProbe before attach → null");

const CAP = 8;
assert.equal(A.attachFlipPipe(srcId, pipeId, { toleranceNs: TOL, anchorCap: CAP }), true, "flip attaches on the test source");
assert.throws(() => A.pushFlipAnchor(pipeId, { tExposure: T0 }), /flip/, "anchor without `flip` throws");
assert.throws(() => A.pushFlipAnchor(pipeId, { flip: true }), /tExposure/, "anchor without `tExposure` throws");
{
  const p = A.flipProbe(pipeId)!;
  assert.equal(p.name, pipeId, "meter name == pipeId (node id)");
  assert.equal(p.toleranceNs, TOL, "probe echoes toleranceNs");
  assert.equal(p.frames, 0, "no frames yet");
  assert.equal(p.anchorPoolSize, 0, "empty anchor pool");
  assert(A.flipProbeAll()[pipeId], "flipProbeAll lists the pipe");
}
console.log("54-flip-stream: attach guards OK.");

// --- 2: on-demand — parked with no consumer ----------------------------------
await sleep(150);
assert.equal(A.flipProbe(pipeId)!.frames, 0, "brick PARKED before any consumer");

// --- 3/4/5: scripted frames ---------------------------------------------------
// Each step: anchors pushed BEFORE the frame (FIN precedes the frame's arrival),
// then the frame; expected outcome: "flip" | "pass" | "unmatched".
type Step = { anchors: Array<{ dt: bigint; flip: boolean }>; expect: "flip" | "pass" | "unmatched" };
const steps: Step[] = [
  { anchors: [{ dt: 0n, flip: false }], expect: "pass" }, // exact, rising
  { anchors: [{ dt: 0n, flip: true }], expect: "flip" }, // exact, falling
  { anchors: [{ dt: -1_500_000n, flip: false }], expect: "pass" }, // early anchor
  { anchors: [{ dt: 1_500_000n, flip: true }], expect: "flip" }, // late anchor
  { anchors: [{ dt: TOL, flip: true }], expect: "flip" }, // inclusive edge
  { anchors: [{ dt: TOL + 1n, flip: true }], expect: "unmatched" }, // just outside
  { anchors: [], expect: "unmatched" }, // no anchor at all (failed trigger)
  // A nearer PASS anchor beats a farther FLIP anchor (nearest wins).
  { anchors: [{ dt: -1_800_000n, flip: true }, { dt: 400_000n, flip: false }], expect: "pass" },
  // ... and the other way round.
  { anchors: [{ dt: -300_000n, flip: true }, { dt: 1_900_000n, flip: false }], expect: "flip" },
  { anchors: [{ dt: 3_000_000n, flip: true }], expect: "unmatched" }, // far late
  { anchors: [{ dt: 0n, flip: false }], expect: "pass" },
  { anchors: [{ dt: 0n, flip: true }], expect: "flip" },
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
  for (const a of step.anchors)
    assert.equal(A.pushFlipAnchor(pipeId, { tExposure: ts + a.dt, flip: a.flip }), true, "anchor pushed");
  assert.equal(
    A.pushPairTestFrame(srcId, { deviceTimestamp: ts, width: W, height: H, ...ORIGIN, buffer: frameBuffer(k) }),
    true,
    "frame pushed",
  );
  const r = await readFrame(ts);
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
  const p = A.flipProbe(pipeId)!;
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
console.log(`54-flip-stream: matching (${expFlipped} flipped, ${expUnmatched} unmatched of ${steps.length}) + forwarding OK.`);

// --- 5b: anchorCap bounds the pool drop-oldest --------------------------------
{
  const far = T0 + 1_000n * PERIOD; // beyond every frame above — never pruned yet
  const before = A.flipProbe(pipeId)!;
  for (let i = 0; i < CAP + 5; i++)
    A.pushFlipAnchor(pipeId, { tExposure: far + BigInt(i) * PERIOD, flip: i % 2 === 0 });
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

// --- 6a: park on disconnect ---------------------------------------------------
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

// --- 6b: topology row ---------------------------------------------------------
{
  const row = T.report().find((n) => n.id === pipeId);
  assert(row, "flip pipe appears in Topology.report()");
  assert.equal(row!.kind, "flip", "topology kind == flip");
  assert.equal(row!.inputs.length, 1, "one input edge");
  assert(row!.inputs.some((i) => i.from === srcId && i.port === "frame"), "input edge source → flip, port frame");
}
console.log("54-flip-stream: topology OK.");

// --- 6c: detach idempotency + orderly teardown --------------------------------
assert.equal(A.detachFlipPipe(pipeId), true, "detach flip");
assert.equal(A.detachFlipPipe(pipeId), false, "detach idempotent");
assert.equal(A.flipProbe(pipeId), null, "detached id → null probe");
assert.equal(A.flipProbeAll()[pipeId], undefined, "detached id absent from flipProbeAll");
assert.equal(A.pushFlipAnchor(pipeId, { tExposure: T0, flip: true }), false, "pushFlipAnchor after detach → false");
P.close(pipeId);
P.drop(pipeId);
assert.equal(A.releasePairTestSource(srcId), true, "release test source");

await sleep(100);
console.log("54-flip-stream: orderly teardown complete — exiting naturally.");
