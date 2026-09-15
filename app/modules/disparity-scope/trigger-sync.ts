// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The MATCH-JOIN-coupled trigger-sync decisions for disparity-scope (spec
// §trigger-sync): the pair window derived from the trigger budget and the
// engaged staleness scale. The generic pure core (engage preconditions, rate
// window, failure line, op chain, TriggerTelemetry) lives in @lib/trigger-sync,
// shared with manual-control. Types-only so the session's gates unit-test
// without the session (trigger-sync.test.ts) — same idiom as match-join.ts /
// tracker-feed.ts.

import { MATCH_STALE_MS, pairEpochSkewed } from "@lib/vergence/match-join";

/** Pair window (ns) = half the trigger interval — see match-join.ts header. */
export function pairWindowNs(minIntervalMs: number): number {
  return (minIntervalMs * 1e6) / 2;
}

/** The onMatch pair gate exactly as the session consults it: only an ENGAGED
 *  trigger session gates on capture epochs — free-run pairing (engaged=false,
 *  or no budget yet) is byte-identical to the pre-trigger-sync behavior. */
export function pairEpochGateTrips(
  engaged: boolean,
  minIntervalMs: number | null,
  epochA: number,
  epochB: number,
): boolean {
  if (!engaged || minIntervalMs === null) return false;
  return pairEpochSkewed(epochA, epochB, pairWindowNs(minIntervalMs));
}

/** Engaged staleness AGE bound: triggered pairs arrive at the scheduler's
 *  interval, not the free-run frame rate, so the free-run horizon would flag
 *  a healthy slow cadence as stale. Seq-gap bound is unchanged (frames are
 *  frames). Free-run keeps {@link MATCH_STALE_MS}. */
export function matchStaleMsFor(
  engaged: boolean,
  minIntervalMs: number | null,
): number {
  return engaged && minIntervalMs !== null
    ? Math.max(MATCH_STALE_MS, 4 * minIntervalMs)
    : MATCH_STALE_MS;
}
