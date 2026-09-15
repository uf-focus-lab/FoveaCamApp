// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE staleness bound for the L/R match JOIN (spec disparity-scope §match-join,
// shared by every app running the vergence loop):
// per pairing attempt, decide whether the partner result is still fresh enough to
// steer on (else the caller holds + surfaces "match stale"). Two bounds, either
// trips: AGE (wall-clock ms — a wedged side stops producing seqs) and SEQ GAP
// (a lagging side whose center describes where the target WAS). Types-only.
//
// PAIR WINDOW (trigger-sync, spec §trigger-sync): while capture is hardware-
// triggered, both sides of a pair expose SIMULTANEOUSLY — their trusted-time
// capture epochs differ only by trigger jitter. Half the trigger interval
// separates adjacent trigger slots unambiguously: a same-slot pair always lands
// inside it, a one-frame-offset pair always lands outside. `pairEpochSkewed`
// applies that bound; the session consults it ONLY while trigger-sync is
// engaged (free-run epochs are frame-phase-offset by nature).

/** Defaults: ~12 strip frames at the ~38 fps floor ≈ 300 ms; seq gap of 12
 *  matches (the same horizon expressed in frames). Hardware-tunable via the
 *  function params if the bench wants different horizons. */
export const MATCH_STALE_MS = 300;
export const MATCH_STALE_SEQ_GAP = 12;

export interface MatchFreshness {
  /** Partner side's result age (ms) — `now - partner.at`. */
  ageMs: number;
  /** `arriving.seq - partner.seq` (0/negative = partner is newer). */
  seqGap: number;
}

/** True when the L/R capture epochs (trusted-time host-ns) are too far apart
 *  to be the SAME trigger slot — do not pair (latest-wins recovers on the next
 *  arrival). Exactly `windowNs` apart still pairs (inclusive bound, matching
 *  {@link matchPartnerStale}'s boundary convention); a non-finite epoch is
 *  unjudgeable — hold. `windowNs` = half the trigger interval (header). */
export function pairEpochSkewed(
  epochL: number,
  epochR: number,
  windowNs: number,
): boolean {
  if (!Number.isFinite(epochL) || !Number.isFinite(epochR)) return true;
  return Math.abs(epochL - epochR) > windowNs;
}

/** True when the PARTNER side is too stale to steer on. */
export function matchPartnerStale(
  f: MatchFreshness,
  staleMs = MATCH_STALE_MS,
  staleSeqGap = MATCH_STALE_SEQ_GAP,
): boolean {
  if (!Number.isFinite(f.ageMs) || f.ageMs < 0) return true; // corrupt clock — hold
  if (f.ageMs > staleMs) return true;
  return f.seqGap > staleSeqGap;
}
