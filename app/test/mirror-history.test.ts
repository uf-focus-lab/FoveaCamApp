// Mirror-position history:
// ring semantics, interpolation, clamping, monotonic guard, wraparound.

import { describe, expect, it } from "vitest";
import { MirrorHistory } from "@orchestrator/mirror-history";

const pos = (x: number, y = 0) => ({ x, y });

describe("MirrorHistory", () => {
  it("interpolates linearly between bracketing samples", () => {
    const h = new MirrorHistory();
    h.record(1000n, pos(0), pos(10));
    h.record(2000n, pos(4), pos(20));
    const m = h.mirrorAt(1500n)!;
    expect(m.left.x).toBeCloseTo(2);
    expect(m.right.x).toBeCloseTo(15);
    expect(m.interpolated).toBe(true);
    expect(m.ageNs).toBe(500n);
  });

  it("clamps (flagged) outside the recorded span", () => {
    const h = new MirrorHistory();
    h.record(1000n, pos(1), pos(1));
    h.record(2000n, pos(2), pos(2));
    const early = h.mirrorAt(500n)!;
    expect(early.left.x).toBe(1);
    expect(early.interpolated).toBe(false);
    expect(early.ageNs).toBe(500n);
    const late = h.mirrorAt(3000n)!;
    expect(late.left.x).toBe(2);
    expect(late.interpolated).toBe(false);
    expect(late.ageNs).toBe(1000n);
  });

  it("returns null when empty and drops out-of-order samples", () => {
    const h = new MirrorHistory();
    expect(h.mirrorAt(1n)).toBeNull();
    h.record(2000n, pos(2), pos(2));
    h.record(1000n, pos(9), pos(9)); // out of order — dropped
    expect(h.size).toBe(1);
    expect(h.mirrorAt(1500n)!.left.x).toBe(2);
  });

  it("wraps at capacity keeping the newest samples queryable", () => {
    const h = new MirrorHistory(4);
    for (let i = 1; i <= 10; i++) h.record(BigInt(i * 1000), pos(i), pos(i));
    expect(h.size).toBe(4); // 7,8,9,10 remain
    expect(h.mirrorAt(500n)!.left.x).toBe(7); // clamped to oldest survivor
    const m = h.mirrorAt(9500n)!;
    expect(m.left.x).toBeCloseTo(9.5);
    expect(m.interpolated).toBe(true);
  });

  it("copies positions on record (no aliasing with caller mutation)", () => {
    const h = new MirrorHistory();
    const p = pos(1);
    h.record(1000n, p, p);
    p.x = 99;
    expect(h.mirrorAt(1000n)!.left.x).toBe(1);
  });

  it("truncateAfter drops only the samples newer than the cut (wrapped ring too)", () => {
    const h = new MirrorHistory(4);
    for (let i = 1; i <= 6; i++) h.record(BigInt(i) * 1000n, pos(i), pos(i));
    expect(h.size).toBe(4); // 3000..6000
    expect(h.truncateAfter(4500n)).toBe(2);
    expect(h.size).toBe(2);
    expect(h.newest()).toMatchObject({ hostNs: 4000n, left: pos(4) });
    // Monotonic appends resume from the cut.
    h.record(4200n, pos(42), pos(42));
    expect(h.mirrorAt(4200n)!.left.x).toBe(42);
    expect(h.truncateAfter(0n)).toBe(3);
    expect(h.newest()).toBeNull();
  });
});
