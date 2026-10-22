// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE decisions shared by the disparity-scope and manual-control trigger-sync
// capture modes (spec docs/spec/disparity-scope.md §trigger-sync and
// docs/spec/manual-control.md §trigger-sync): engage-precondition reasons, the
// achieved-rate maturity window, the curated engage-failure line, and the
// engage/disengage op chain. Vue/DOM-free so the sessions' gates unit-test
// without a session (trigger-sync-core.test.ts) — same idiom as
// match-join.ts / tracker-feed.ts. The match-join-COUPLED parts (pair window,
// engaged staleness scale) live in disparity-scope's own trigger-sync.ts.

import type { PairTriggerBudget } from "@lib/camera-config";
import type { ScheduledFrameTarget } from "@orchestrator/scheduler";

/** A CMD_FRAME camera mask in name form (`"C" | "L" | "R"`). */
export type FrameCameras = Extract<NonNullable<ScheduledFrameTarget["cameras"]>, unknown[]>;

/** The fovea pair — what both trigger-sync engage sites trigger today. The V0.1
 *  board cables the center camera too (`CAM_C`), but adding C to a session's
 *  mask also needs that session to put C into trigger mode and pace on its
 *  exposure; that is a per-session product decision, not a wiring limit. */
export const PAIR_CAMERAS: readonly ["L", "R"] = ["L", "R"];

/** The ONE scheduler target both trigger-sync engage sites push: the budget's
 *  pulse rides the wire in MICROSECONDS (`FrameArg.pulse`), so it is `pulseUs`
 *  verbatim — no scaling. `cameras` is always an explicit mask, `[L,R]` unless
 *  the caller names one (an absent mask is NAPI-encoded as 0, not the
 *  documented CAM_L|CAM_R default). */
export function frameRequestFromBudget(
  budget: PairTriggerBudget,
  streamId: number,
  settleUs: number,
  cameras: Readonly<FrameCameras> = PAIR_CAMERAS,
): ScheduledFrameTarget {
  return {
    stream: streamId,
    cameras: [...cameras],
    pulse: budget.pulseUs,
    settle_time: settleUs,
    minIntervalMs: budget.minIntervalMs,
  };
}

/** Everything engagement waits on, snapshot-shaped for the retry tick. */
export interface TriggerPreconditions {
  tripleLeased: boolean;
  /** The active controller's `v2Capable`, or null while none is connected. */
  controller: { v2Capable: boolean } | null;
  /** `nativePos.streamId` — null until the lazy/async native sink attach lands. */
  streamId: number | null;
}

/** The `trigger_blocked` reason engagement is waiting on, or null = go.
 *  Checked most-fundamental first so the surfaced reason names the actual
 *  missing piece, not a downstream symptom. */
export function triggerBlockReason(p: TriggerPreconditions): string | null {
  if (!p.tripleLeased) return "no camera triple leased";
  if (!p.controller) return "no controller connected";
  if (!p.controller.v2Capable)
    return "controller firmware is not v2-capable (CMD_FRAME unavailable)";
  if (p.streamId === null) return "native mirror stream not attached yet";
  return null;
}

/** Live trigger-sync readout while ENGAGED (spec §trigger-sync): achieved FIN
 *  rate, the derived pulse width, and cumulative scheduler outcome counters
 *  for this engagement (counters update at the publish throttle).
 *
 *  MUST stay a `type` alias, NOT an `interface`: it rides a `defineContract`
 *  telemetry slot whose values are constrained to `Serializable` (an index-
 *  signature type). An object-literal `type` alias satisfies that constraint;
 *  an `interface` has no implicit index signature and would degrade the whole
 *  contract's inferred store types to `Serializable`. */
export type TriggerTelemetry = {
  /** Achieved FIN rate, computed over ≥1 s maturity windows and HELD between
   *  rolls (a per-publish 33 ms window would quantize the rate to 0 or ~30);
   *  null until the first window matures after (re-)engage. */
  hz: number | null;
  pulseMs: number;
  frames: number;
  rejects: number;
  timeouts: number;
};

/** Achieved-FIN-rate window. The session samples at its 33 ms telemetry
 *  throttle, but a per-publish window that short quantizes hz to 0 or ~30 —
 *  so the window only ROLLS once it spans ≥ `minWindowMs`; between rolls the
 *  last computed rate is republished, and it reads null until the first
 *  window matures (and again after a `reset`). */
export class TriggerRateWindow {
  private fins = 0;
  private startedAt: number | null = null;
  private lastHz: number | null = null;

  constructor(private readonly minWindowMs = 1000) {}

  /** New engagement: drop the held rate, start a fresh maturity window. */
  reset(now: number): void {
    this.fins = 0;
    this.startedAt = now;
    this.lastHz = null;
  }

  onFin(): void {
    this.fins++;
  }

  /** The rate to publish NOW — rolls the window iff it has matured. */
  sample(now: number): number | null {
    if (this.startedAt === null) {
      this.startedAt = now;
      return this.lastHz;
    }
    const windowMs = now - this.startedAt;
    if (windowMs >= this.minWindowMs) {
      this.lastHz = (this.fins * 1000) / windowMs;
      this.fins = 0;
      this.startedAt = now;
    }
    return this.lastHz;
  }
}

/** The error's first line, trimmed and clipped to `maxLen` — the shape both the
 *  status line and the diagnostic reject/timeout spans want (the raw multi-line
 *  Error.message is unusable in either). */
export function firstErrorLine(error: unknown, maxLen: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0]!.trim() || "unknown error";
  return firstLine.length > maxLen
    ? `${firstLine.slice(0, maxLen - 1)}…`
    : firstLine;
}

/** Curated `trigger_blocked` line for a hardware-trigger enable failure: a
 *  stable prefix + the error's first line, truncated — the raw multi-line
 *  Error.message verbatim broke the status voice. */
export function engageFailureReason(error: unknown, maxLen = 80): string {
  return `engage failed: ${firstErrorLine(error, maxLen)}`;
}

/** First-N per kind per engage, then every-Kth. */
export const TRIGGER_SPAN_FIRST_N = 40;
export const TRIGGER_SPAN_EVERY_K = 25;

/** Bounds how many trigger outcome spans reach the 200-entry diagnostics ring
 *  so the interesting engage window isn't flooded out: the first
 *  {@link TRIGGER_SPAN_FIRST_N} events of each kind, then every
 *  {@link TRIGGER_SPAN_EVERY_K}th. An event whose `reason` differs from the
 *  previous one of its kind ALWAYS logs — a new firmware REJ reason is never
 *  sampled away. `reset` per engage. Pure (trigger-sync-core.test.ts). */
export class TriggerSpanSampler {
  private readonly counts = new Map<string, number>();
  private readonly lastReason = new Map<string, string>();

  reset(): void {
    this.counts.clear();
    this.lastReason.clear();
  }

  /** Log this event of `kind`? `reason` (reject/timeout only) drives the
   *  distinct-reason bypass; omit it for reasonless kinds (fin). */
  shouldLog(kind: string, reason?: string): boolean {
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const distinct = reason !== undefined && this.lastReason.get(kind) !== reason;
    if (reason !== undefined) this.lastReason.set(kind, reason);
    return (
      distinct || n <= TRIGGER_SPAN_FIRST_N || n % TRIGGER_SPAN_EVERY_K === 0
    );
  }
}

/** Consecutive identical-reason frame FAILURES (reject/timeout) before the
 *  passive fault gate trips. At the observed ~39 ms storm cadence this is
 *  < 0.5 s — long enough to never trip on a transient reject, short enough to
 *  restore free-run before the frozen feed reads as a hang. */
export const TRIGGER_FAULT_STREAK = 10;

/** PASSIVE hardware-trigger fault gate (spec disparity-scope §trigger-sync):
 *  a run of {@link TRIGGER_FAULT_STREAK} identical-reason failures with ZERO
 *  FINs in between means the MCU pulse never reaches the cameras (the rig's
 *  deterministic REJ "Strobe timeout" storm — no exposures, no frames). Any
 *  FIN clears the streak (frames ARE flowing); a reason change restarts it
 *  (a different failure is not the same fault). `trip` returns the fault
 *  reason exactly ONCE per streak so the session fires (report + disengage)
 *  once and does not flap. Pure (trigger-sync-core.test.ts). */
export class TriggerFaultDetector {
  private streak = 0;
  private reason: string | null = null;
  private tripped = false;

  constructor(private readonly threshold = TRIGGER_FAULT_STREAK) {}

  /** New engage — drop any streak. */
  reset(): void {
    this.streak = 0;
    this.reason = null;
    this.tripped = false;
  }

  /** A FIN arrived: frames flow, no fault. */
  onFin(): void {
    this.streak = 0;
    this.reason = null;
    this.tripped = false;
  }

  /** A reject/timeout carrying `reason`. Returns the reason the FIRST time the
   *  streak reaches the threshold, else null (including every failure past the
   *  trip — the session acts once). */
  onFailure(reason: string): string | null {
    if (reason !== this.reason) {
      this.reason = reason;
      this.streak = 1;
      this.tripped = false;
    } else {
      this.streak++;
    }
    if (!this.tripped && this.streak >= this.threshold) {
      this.tripped = true;
      return reason;
    }
    return null;
  }
}

/** The ERROR-tray line for a tripped {@link TriggerFaultDetector} (spec
 *  §trigger-sync fault gate): names the firmware reason and the check, lowercase
 *  curated voice. The compact `trigger_blocked` reason ({@link triggerFaultBlocked})
 *  carries the short form; this carries the detail. */
export function triggerFaultMessage(reason: string): string {
  return (
    `hardware trigger fault: every frame rejected ("${reason}") — ` +
    `no camera exposures; check trigger wiring. Restoring free-run.`
  );
}

/** The compact `trigger_blocked` reason for a tripped fault gate (the tray
 *  error carries the detail). */
export function triggerFaultBlocked(reason: string): string {
  return `hardware trigger fault ("${reason}") — check wiring`;
}

/** FIFO op chain serializing engage/disengage: their lease trigger
 *  reconfigures must never interleave (a fast OFF→ON otherwise re-enables
 *  against in-flight disables and can leave one camera untriggered while the
 *  session reports engaged). An op failure reports via `onError` and never
 *  wedges the chain; each queued op awaits every earlier one. */
export function createTriggerOpChain(
  onError: (error: unknown) => void = () => {},
): (op: () => Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (op) => {
    chain = chain.then(op).catch(onError);
    return chain;
  };
}
