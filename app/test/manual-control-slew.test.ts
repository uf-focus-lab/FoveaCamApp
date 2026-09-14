// Drag-target slew math — the pure first-order smoother behind the
// manual-control pacer (@lib/slew): convergence,
// per-channel monotonicity (no overshoot), epsilon termination with an EXACT
// final target, and dt scaling.

import { describe, expect, it } from "vitest";
import {
  SLEW_EPSILON_V,
  SLEW_TAU_MS,
  slewStep,
  type SlewPair,
} from "@lib/slew";

const pair = (lx: number, ly = 0, rx = 0, ry = 0): SlewPair => ({
  l: { x: lx, y: ly },
  r: { x: rx, y: ry },
});

describe("slewStep", () => {
  it("converges to the target and epsilon-terminates with the EXACT value", () => {
    let pose = pair(0, 0, 0, 0);
    const target = pair(100, -50, 25, 80);
    let settledAt = -1;
    for (let tick = 0; tick < 200; tick++) {
      const s = slewStep(pose, target, 1);
      pose = s.pose;
      if (s.settled) {
        settledAt = tick;
        break;
      }
    }
    expect(settledAt).toBeGreaterThan(0); // finite settle
    // Settled pose IS the exact target (deep equal, not approx) — the wire
    // then goes quiet through the dedupe gate.
    expect(pose).toEqual(target);
    // ~τ·ln(range/ε) ≈ 8·ln(100/0.005) ≈ 79 ms of 1 ms ticks — sanity bound.
    expect(settledAt).toBeLessThan(150);
  });

  it("is monotonic per channel and never overshoots", () => {
    let pose = pair(-10);
    const target = pair(10);
    let prev = pose.l.x;
    for (let tick = 0; tick < 100; tick++) {
      const s = slewStep(pose, target, 1);
      pose = s.pose;
      expect(pose.l.x).toBeGreaterThanOrEqual(prev); // toward the target only
      expect(pose.l.x).toBeLessThanOrEqual(target.l.x); // never past it
      prev = pose.l.x;
      if (s.settled) break;
    }
    expect(pose.l.x).toBe(10);
  });

  it("produces DISTINCT intermediate poses every tick while moving (gate-passable)", () => {
    let pose = pair(0);
    const target = pair(50);
    const seen = new Set<number>();
    for (let tick = 0; tick < 20; tick++) {
      const s = slewStep(pose, target, 1);
      if (s.settled) break;
      expect(seen.has(s.pose.l.x)).toBe(false); // every tick moves the wire
      seen.add(s.pose.l.x);
      pose = s.pose;
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it("stays settled (idempotent) once at the target", () => {
    const target = pair(5, 5, 5, 5);
    const s1 = slewStep(target, target, 1);
    expect(s1.settled).toBe(true);
    expect(s1.pose).toEqual(target);
    const s2 = slewStep(s1.pose, target, 1);
    expect(s2.settled).toBe(true);
    expect(s2.pose).toEqual(target);
  });

  it("lags a moving target by roughly τ (perceived latency does not grow)", () => {
    // Target ramps 1 V/ms; after transient, the smoothed pose should trail by
    // ~τ·slope = 8 V (first-order tracking lag), well within 2 pointer
    // intervals' worth of motion.
    let pose = pair(0);
    for (let t = 1; t <= 200; t++) {
      pose = slewStep(pose, pair(t), 1).pose;
    }
    const lag = 200 - pose.l.x;
    expect(lag).toBeGreaterThan(SLEW_TAU_MS * 0.5);
    expect(lag).toBeLessThan(SLEW_TAU_MS * 2);
  });

  it("scales the step with dt (bigger tick, bigger move; huge dt ≈ snap)", () => {
    const from = pair(0);
    const to = pair(100);
    const small = slewStep(from, to, 1).pose.l.x;
    const large = slewStep(from, to, 8).pose.l.x;
    expect(large).toBeGreaterThan(small);
    const jump = slewStep(from, to, 1000).pose.l.x;
    expect(jump).toBeGreaterThan(100 - SLEW_EPSILON_V - 1e-9);
  });

  it("treats sub-epsilon differences as settled (no sub-quantization chatter)", () => {
    const target = pair(1);
    const near = pair(1 - SLEW_EPSILON_V / 2);
    const s = slewStep(near, target, 1);
    expect(s.settled).toBe(true);
    expect(s.pose.l.x).toBe(1);
  });
});
