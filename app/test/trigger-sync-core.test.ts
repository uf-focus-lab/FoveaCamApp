// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SHARED trigger-sync PURE core decisions (spec disparity-scope §trigger-sync
// and manual-control §trigger-sync): the engage-precondition reasons the
// sessions surface as `trigger_blocked`, the achieved-rate maturity window, the
// curated engage-failure line, and the engage/disengage op chain. The
// match-join-coupled pair gating is exercised separately (trigger-sync.test.ts).

import { describe, expect, it, vi } from "vitest";
import {
  createTriggerOpChain,
  engageFailureReason,
  frameRequestFromBudget,
  TRIGGER_FAULT_STREAK,
  TRIGGER_SPAN_EVERY_K,
  TRIGGER_SPAN_FIRST_N,
  triggerBlockReason,
  triggerFaultBlocked,
  triggerFaultMessage,
  TriggerFaultDetector,
  TriggerRateWindow,
  TriggerSpanSampler,
} from "@lib/trigger-sync";
import { pairTriggerBudget } from "@lib/camera-config";

describe("frameRequestFromBudget (engage-site scheduler target)", () => {
  it("sends the pulse in WIRE µs and an explicit L|R mask", () => {
    const budget = pairTriggerBudget({ exposureUsL: 16700, exposureUsR: 16700 });
    const target = frameRequestFromBudget(budget, 7, 1500);
    // The pulse rides the wire verbatim as µs — a ×1000 would be 16.7 s.
    expect(target.pulse).toBe(Math.round(16700));
    expect(target.pulse).toBe(budget.pulseUs);
    expect(target.stream).toBe(7);
    expect(target.settle_time).toBe(1500);
    expect(target.minIntervalMs).toBe(budget.minIntervalMs);
    // Explicit mask (an absent mask NAPI-encodes to 0, not CAM_L|CAM_R).
    expect(target.cameras).toEqual(["L", "R"]);
  });

  it("takes an explicit mask including the center camera (V0.1 board cables CAM_C)", () => {
    const budget = pairTriggerBudget({ exposureUsL: 10000, exposureUsR: 10000 });
    const cameras = ["C", "L", "R"] as const;
    const target = frameRequestFromBudget(budget, 2, 0, cameras);
    expect(target.cameras).toEqual(["C", "L", "R"]);
    // A copy: the scheduler target never aliases the caller's array.
    expect(target.cameras).not.toBe(cameras);
  });
});

const READY = {
  tripleLeased: true,
  controller: { v2Capable: true },
  streamId: 3,
};

describe("triggerBlockReason (engage preconditions)", () => {
  it("all preconditions met → null (engage)", () => {
    expect(triggerBlockReason(READY)).toBeNull();
  });

  it("names the most fundamental missing piece, in order", () => {
    expect(
      triggerBlockReason({ ...READY, tripleLeased: false, controller: null }),
    ).toBe("no camera triple leased");
    expect(triggerBlockReason({ ...READY, controller: null })).toBe(
      "no controller connected",
    );
    expect(
      triggerBlockReason({ ...READY, controller: { v2Capable: false } }),
    ).toBe("controller firmware is not v2-capable (CMD_FRAME unavailable)");
    expect(triggerBlockReason({ ...READY, streamId: null })).toBe(
      "native mirror stream not attached yet",
    );
  });
});

describe("TriggerRateWindow (hz maturity — finding 1)", () => {
  it("null until the first ≥1 s window matures, sampled at the 33 ms throttle", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    for (let t = 33; t < 1000; t += 33) {
      w.onFin();
      expect(w.sample(t)).toBeNull(); // never a quantized 0/30 flap
    }
  });

  it("rolls at maturity with the rate over the WHOLE window", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    for (let i = 0; i < 20; i++) w.onFin(); // 20 FINs over 1 s
    expect(w.sample(1000)).toBe(20);
  });

  it("HOLDS the last rate between rolls (throttle publishes keep reading it)", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    for (let i = 0; i < 20; i++) w.onFin();
    expect(w.sample(1000)).toBe(20);
    expect(w.sample(1033)).toBe(20); // immature next window — held
    expect(w.sample(1500)).toBe(20); // still held
    for (let i = 0; i < 5; i++) w.onFin(); // 5 FINs over the next 1 s
    expect(w.sample(2000)).toBe(5); // matured — recomputed
  });

  it("reset (re-engage) drops the held rate back to null", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    w.onFin();
    expect(w.sample(1000)).toBe(1);
    w.reset(1000);
    expect(w.sample(1033)).toBeNull();
  });
});

describe("engageFailureReason (finding 10 — curated blocked line)", () => {
  it("prefixes and keeps only the error's first line", () => {
    expect(
      engageFailureReason(new Error("TriggerMode not writable\n  at Camera.setTrigger")),
    ).toBe("engage failed: TriggerMode not writable");
  });

  it("truncates a long first line to ~80 chars", () => {
    const detail = "x".repeat(200);
    const out = engageFailureReason(new Error(detail));
    expect(out.startsWith("engage failed: ")).toBe(true);
    expect(out).toBe(`engage failed: ${"x".repeat(79)}…`);
  });

  it("stringifies non-Error throwables; empty message reads unknown", () => {
    expect(engageFailureReason("boom")).toBe("engage failed: boom");
    expect(engageFailureReason(new Error(""))).toBe("engage failed: unknown error");
  });
});

describe("TriggerFaultDetector (passive fault gate)", () => {
  const trip = (d: TriggerFaultDetector, reason: string, n: number): string | null => {
    let out: string | null = null;
    for (let i = 0; i < n; i++) out = d.onFailure(reason) ?? out;
    return out;
  };

  it("trips on the Nth consecutive identical-reason failure, once", () => {
    const d = new TriggerFaultDetector();
    // The first N-1 are below threshold.
    for (let i = 0; i < TRIGGER_FAULT_STREAK - 1; i++)
      expect(d.onFailure("Strobe timeout")).toBeNull();
    // The Nth trips, returning the reason.
    expect(d.onFailure("Strobe timeout")).toBe("Strobe timeout");
    // Past the trip it stays null — the session fires exactly once.
    expect(d.onFailure("Strobe timeout")).toBeNull();
    expect(d.onFailure("Strobe timeout")).toBeNull();
  });

  it("a FIN clears the streak (frames flowing = no fault)", () => {
    const d = new TriggerFaultDetector();
    trip(d, "Strobe timeout", TRIGGER_FAULT_STREAK - 1); // one short
    d.onFin();
    // The streak restarts from zero — one more failure is not a trip.
    expect(d.onFailure("Strobe timeout")).toBeNull();
    expect(trip(d, "Strobe timeout", TRIGGER_FAULT_STREAK - 1)).toBe("Strobe timeout");
  });

  it("a reason change restarts the count (a different failure isn't the fault)", () => {
    const d = new TriggerFaultDetector();
    trip(d, "queue full", TRIGGER_FAULT_STREAK - 1); // one short
    // A new reason resets the streak to 1 — not a trip.
    expect(d.onFailure("Strobe timeout")).toBeNull();
    // It takes a full fresh streak of the NEW reason to trip.
    expect(trip(d, "Strobe timeout", TRIGGER_FAULT_STREAK - 1)).toBe("Strobe timeout");
  });

  it("reset (re-engage) drops any streak", () => {
    const d = new TriggerFaultDetector();
    trip(d, "Strobe timeout", TRIGGER_FAULT_STREAK - 1);
    d.reset();
    expect(d.onFailure("Strobe timeout")).toBeNull();
  });

  it("messages name the reason (detail line + compact blocked reason)", () => {
    expect(triggerFaultMessage("Strobe timeout")).toContain('"Strobe timeout"');
    expect(triggerFaultMessage("Strobe timeout")).toContain("check trigger wiring");
    expect(triggerFaultBlocked("Strobe timeout")).toBe(
      'hardware trigger fault ("Strobe timeout") — check wiring',
    );
  });
});

describe("createTriggerOpChain (finding 2 — engage/disengage serialization)", () => {
  it("a queued op always awaits the in-flight one (FIFO, no interleave)", async () => {
    const queue = createTriggerOpChain();
    const events: string[] = [];
    let releaseDisable!: () => void;
    const disable = queue(async () => {
      events.push("disable:start");
      await new Promise<void>((r) => (releaseDisable = r));
      events.push("disable:end");
    });
    const enable = queue(async () => {
      events.push("enable:start");
      events.push("enable:end");
    });
    await Promise.resolve();
    expect(events).toEqual(["disable:start"]); // enable is WAITING
    releaseDisable();
    await Promise.all([disable, enable]);
    expect(events).toEqual([
      "disable:start",
      "disable:end",
      "enable:start",
      "enable:end",
    ]);
  });

  it("an op failure reports via onError and never wedges the chain", async () => {
    const onError = vi.fn();
    const queue = createTriggerOpChain(onError);
    await queue(async () => {
      throw new Error("enable exploded");
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const ran = vi.fn(async () => {});
    await queue(ran);
    expect(ran).toHaveBeenCalledTimes(1); // chain recovered
  });
});

describe("TriggerSpanSampler (outcome-span rate cap)", () => {
  const logged = (
    sampler: TriggerSpanSampler,
    kind: string,
    count: number,
    reason?: string,
  ): number => {
    let hits = 0;
    for (let i = 0; i < count; i++) if (sampler.shouldLog(kind, reason)) hits++;
    return hits;
  };

  it("logs the first N of a reasonless kind, then rejects until the Kth", () => {
    const sampler = new TriggerSpanSampler();
    for (let n = 1; n <= TRIGGER_SPAN_FIRST_N; n++)
      expect(sampler.shouldLog("fin")).toBe(true);
    // Past the window only absolute multiples of K log.
    for (let n = TRIGGER_SPAN_FIRST_N + 1; n < 2 * TRIGGER_SPAN_EVERY_K; n++)
      expect(sampler.shouldLog("fin")).toBe(n % TRIGGER_SPAN_EVERY_K === 0);
    // 2*K is the next multiple.
    expect(sampler.shouldLog("fin")).toBe(true);
  });

  it("a reason distinct from the previous ALWAYS logs, even mid-window", () => {
    const sampler = new TriggerSpanSampler();
    // Burn past the first-N window with one repeated reason.
    logged(sampler, "rej", TRIGGER_SPAN_FIRST_N, "queue full");
    // Same reason at a non-multiple index is sampled away...
    expect(sampler.shouldLog("rej", "queue full")).toBe(false);
    // ...but a NEW reason at the very next (still non-multiple) index logs.
    expect(sampler.shouldLog("rej", "strobe timeout")).toBe(true);
    // Repeating THAT one is sampled away again.
    expect(sampler.shouldLog("rej", "strobe timeout")).toBe(false);
  });

  it("counts each kind independently", () => {
    const sampler = new TriggerSpanSampler();
    logged(sampler, "rej", TRIGGER_SPAN_FIRST_N, "dup");
    // rej is now past its window, but timeout starts fresh.
    expect(sampler.shouldLog("rej", "dup")).toBe(false);
    expect(sampler.shouldLog("timeout", "dup")).toBe(true);
  });

  it("reset() restarts the first-N window", () => {
    const sampler = new TriggerSpanSampler();
    logged(sampler, "fin", TRIGGER_SPAN_FIRST_N + 5);
    expect(sampler.shouldLog("fin")).toBe(false); // past window
    sampler.reset();
    expect(sampler.shouldLog("fin")).toBe(true); // window fresh again
  });
});
