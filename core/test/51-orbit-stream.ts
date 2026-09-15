// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native circular-scan ORBIT brick — NO hardware. Proves:
//   1. PACE — the brick emits at ~1 kHz off its own thread while the orbit is
//      enabled (counted on the brick's own meter, so consumer drops cannot
//      flatter the result).
//   2. GEOMETRY — per eye, `v − center` traces the circle `J · amp · (cos φ,
//      sin φ)`: all four quadrants are visited, the RMS radius error is under
//      1 %, and the row-major Jacobian ordering holds (the right eye's J is a
//      scaled 90° rotation of the left's, and its offsets follow).
//   3. PHASE CONTINUITY — a live `hz` change does NOT restart the phase (only
//      a disabled→enabled transition does), and the new rate takes effect.
//   4. IDLE — with the orbit disabled the brick emits the CENTER (amp is
//      irrelevant), emits while the center slew is still moving, and goes
//      QUIET once it settles.
//   5. TEARDOWN — `release()` returns promptly both while idle and while a
//      live port link into the controller's native `pos_in` pins the brick.
//
// Run UNSANDBOXED: node core/test/51-orbit-stream.ts

import assert from "node:assert/strict";
import { Aravis, Controller, cleanup } from "core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type XY = { x: number; y: number };
type Volts = { left: XY; right: XY };
type Orbit = {
  setPose(p: { centerL: XY; centerR: XY; jL: number[]; jR: number[] }): void;
  setOrbit(p: { ampRad: number; hz: number; enabled: boolean }): void;
  probe(): { outputs: Record<string, { count: number }> };
  volt_out: { streamTag: string; pipe(t: unknown, o?: unknown): Link };
  release(): void;
  [Symbol.asyncIterator](): AsyncIterator<Volts>;
};
type Link = { release(): void };
type Sink = { pos_in: { streamTag: string }; release(): void };

const A = Aravis as unknown as { createOrbitStream(name: string): Orbit };
const C = Controller as unknown as {
  Device: new (path: string) => { release(): void };
  createMirrorSink(
    dev: unknown,
    o: { streamId: number; nodeId?: string },
  ): Sink;
  __serialTestPty(): { fd: number; path: string };
};

// Geometry fixture. The left Jacobian is isotropic (a circle of radius
// K_L·amp); the right is the SAME scaled by K_R/K_L and rotated 90°, which
// only holds if the brick reads the arrays row-major.
const AMP = 0.5; // radians
const K_L = 10; // volts per radian
const K_R = 6;
const J_L = [K_L, 0, 0, K_L];
const J_R = [0, -K_R, K_R, 0];
const CENTER_0 = { l: { x: 12, y: -7 }, r: { x: -3, y: 21 } };
const CENTER_1 = { l: { x: 22, y: -17 }, r: { x: 5, y: 13 } };

const wrapPi = (a: number): number => {
  const t = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
};

// --- 1-4: one brick, one subscriber, sliced by wall-clock marks --------------
{
  const orb = A.createOrbitStream("win/51/orbit");
  assert.equal(orb.volt_out.streamTag, "volts", "volt_out tag");

  type Sample = { t: number; v: Volts };
  const samples: Sample[] = [];
  const it = orb[Symbol.asyncIterator]();
  const drain = (async () => {
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      samples.push({ t: performance.now(), v: r.value });
    }
  })().catch(() => {});
  const since = (from: number, to = Infinity): Sample[] =>
    samples.filter((s) => s.t > from && s.t <= to);
  const emitted = (): number => orb.probe().outputs.volt!.count;

  orb.setPose({ centerL: CENTER_0.l, centerR: CENTER_0.r, jL: J_L, jR: J_R });
  orb.setOrbit({ ampRad: AMP, hz: 2, enabled: true });

  // --- 1: pace ---------------------------------------------------------------
  await sleep(100); // let the producer thread spin up on the first subscribe
  const t0 = performance.now();
  const c0 = emitted();
  await sleep(1000);
  const t1 = performance.now();
  const rateHz = ((emitted() - c0) * 1000) / (t1 - t0);
  assert(
    rateHz > 800 && rateHz < 1100,
    `orbit paces at ~1 kHz (got ${rateHz.toFixed(0)} Hz)`,
  );

  // --- 2: geometry -----------------------------------------------------------
  const ring = since(t0, t1);
  assert(ring.length > 500, `ring samples delivered (${ring.length})`);
  const quadrants = new Set<number>();
  let sumSqL = 0;
  let sumSqR = 0;
  let maxRotErr = 0;
  for (const { v } of ring) {
    const oL = { x: v.left.x - CENTER_0.l.x, y: v.left.y - CENTER_0.l.y };
    const oR = { x: v.right.x - CENTER_0.r.x, y: v.right.y - CENTER_0.r.y };
    const phi = Math.atan2(oL.y, oL.x);
    quadrants.add(
      Math.floor(((phi + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)),
    );
    sumSqL += (Math.hypot(oL.x, oL.y) / (K_L * AMP) - 1) ** 2;
    sumSqR += (Math.hypot(oR.x, oR.y) / (K_R * AMP) - 1) ** 2;
    // Row-major J: the right eye's offset is (K_R/K_L)·rot90(left offset).
    const k = K_R / K_L;
    maxRotErr = Math.max(
      maxRotErr,
      Math.abs(oR.x - -k * oL.y),
      Math.abs(oR.y - k * oL.x),
    );
  }
  assert.equal(
    quadrants.size,
    4,
    `all four quadrants traced (${[...quadrants].join(",")})`,
  );
  const rmsL = Math.sqrt(sumSqL / ring.length);
  const rmsR = Math.sqrt(sumSqR / ring.length);
  assert(
    rmsL < 0.01,
    `left RMS radius error under 1 % (${(rmsL * 100).toFixed(3)} %)`,
  );
  assert(
    rmsR < 0.01,
    `right RMS radius error under 1 % (${(rmsR * 100).toFixed(3)} %)`,
  );
  assert(
    maxRotErr < 1e-9,
    `right offsets follow the row-major J (max ${maxRotErr})`,
  );

  // --- 3: phase continuity across an hz change -------------------------------
  const phaseOf = (s: Sample): number =>
    Math.atan2(s.v.left.y - CENTER_0.l.y, s.v.left.x - CENTER_0.l.x);
  // Switch only once the phase is well AWAY from 0, so a reset would be a
  // jump of a radian or more — unmistakable next to one tick of accumulation.
  let before = samples[samples.length - 1]!;
  for (let i = 0; i < 100 && Math.abs(phaseOf(before)) < 1; i++) {
    await sleep(20);
    before = samples[samples.length - 1]!;
  }
  assert(
    Math.abs(phaseOf(before)) >= 1,
    "the hz change lands away from phase 0",
  );
  orb.setOrbit({ ampRad: AMP, hz: 8, enabled: true });
  await sleep(300);
  const after = since(before.t)[0]!;
  const step = Math.abs(wrapPi(phaseOf(after) - phaseOf(before)));
  // One tick of the FASTER rate, plus slack for a late delivery.
  const stepBound = 2 * Math.PI * 8 * ((after.t - before.t) / 1000) + 0.05;
  assert(
    step < Math.min(stepBound, 0.5),
    `phase accumulates across the hz change (jumped ${step.toFixed(3)} rad)`,
  );
  // ...and the new rate is live: unwrap the phase over the tail.
  const tail = since(after.t);
  let turns = 0;
  for (let i = 1; i < tail.length; i++)
    turns += wrapPi(phaseOf(tail[i]!) - phaseOf(tail[i - 1]!));
  const tailHz =
    turns / (2 * Math.PI) / ((tail[tail.length - 1]!.t - tail[0]!.t) / 1000);
  assert(
    Math.abs(tailHz - 8) < 0.8,
    `the new hz took effect (${tailHz.toFixed(2)} Hz)`,
  );

  // --- 4: idle — center only, emit while slewing, then go quiet --------------
  orb.setOrbit({ ampRad: AMP, hz: 8, enabled: false });
  await sleep(200);
  const t2 = performance.now();
  orb.setPose({ centerL: CENTER_1.l, centerR: CENTER_1.r, jL: J_L, jR: J_R });
  await sleep(150);
  const t3 = performance.now();
  await sleep(250);
  const slewing = since(t2, t3);
  const quiet = since(t3);
  assert(
    slewing.length > 10,
    `the center slew emits while it moves (${slewing.length})`,
  );
  assert.equal(
    quiet.length,
    0,
    `the settled brick goes quiet (${quiet.length} stray emits)`,
  );
  const last = slewing[slewing.length - 1]!.v;
  // A disabled orbit with amp > 0 commands the CENTER, exactly.
  assert.deepEqual(
    { left: last.left, right: last.right },
    { left: CENTER_1.l, right: CENTER_1.r },
    "disabled orbit settles on the exact center",
  );

  // --- 5a: release while idle -------------------------------------------------
  const tRel = performance.now();
  orb.release();
  const idleReleaseMs = performance.now() - tRel;
  assert(
    idleReleaseMs < 1000,
    `idle release returns promptly (${idleReleaseMs.toFixed(0)} ms)`,
  );
  await Promise.race([drain, sleep(1000)]);
  console.log(
    `51-orbit-stream: pace ${rateHz.toFixed(0)} Hz, radius RMS ${(rmsL * 100).toFixed(3)}/` +
      `${(rmsR * 100).toFixed(3)} %, phase step ${step.toFixed(3)} rad, tail ${tailHz.toFixed(2)} Hz, ` +
      `idle release ${idleReleaseMs.toFixed(0)} ms.`,
  );
}

// --- 5b: release while a live link pins the brick ----------------------------
{
  const pty = C.__serialTestPty();
  const dev = new C.Device(pty.path);
  const sink = C.createMirrorSink(dev, { streamId: 7, nodeId: "controller" });
  assert.equal(sink.pos_in.streamTag, "volts", "pos_in tag");

  const orb = A.createOrbitStream("win/51/orbit-piped");
  const link = orb.volt_out.pipe(sink.pos_in); // latest — the production shape
  orb.setPose({ centerL: CENTER_0.l, centerR: CENTER_0.r, jL: J_L, jR: J_R });
  orb.setOrbit({ ampRad: AMP, hz: 8, enabled: true });
  await sleep(200);
  assert(orb.probe().outputs.volt!.count > 100, "the piped brick is producing");

  const tRel = performance.now();
  orb.release(); // thread joins BEFORE the stream ejects the link's subscriber
  const pipedReleaseMs = performance.now() - tRel;
  assert(
    pipedReleaseMs < 1000,
    `release under a live link returns promptly (${pipedReleaseMs.toFixed(0)} ms)`,
  );
  link.release();
  sink.release();
  dev.release();
  console.log(
    `51-orbit-stream: piped release ${pipedReleaseMs.toFixed(0)} ms, no crash.`,
  );
}

cleanup();
console.log("51-orbit-stream: all checks passed.");
