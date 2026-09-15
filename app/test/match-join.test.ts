// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// L/R match-join staleness bound: a stalled side must read as LOST,
// not steer one frozen eye forever.

import { describe, expect, it } from "vitest";
import {
  matchPartnerStale,
  pairEpochSkewed,
  MATCH_STALE_MS,
  MATCH_STALE_SEQ_GAP,
} from "@lib/vergence/match-join";

describe("matchPartnerStale", () => {
  it("fresh partner (small age, small gap) steers", () => {
    expect(matchPartnerStale({ ageMs: 30, seqGap: 1 })).toBe(false);
    expect(matchPartnerStale({ ageMs: 0, seqGap: 0 })).toBe(false);
  });

  it("a DEAD side trips the age bound even with a small seq gap", () => {
    expect(matchPartnerStale({ ageMs: MATCH_STALE_MS + 1, seqGap: 1 })).toBe(true);
    expect(matchPartnerStale({ ageMs: MATCH_STALE_MS, seqGap: 1 })).toBe(false); // boundary
  });

  it("a LAGGING side trips the seq bound even while still producing", () => {
    expect(matchPartnerStale({ ageMs: 50, seqGap: MATCH_STALE_SEQ_GAP + 1 })).toBe(true);
    expect(matchPartnerStale({ ageMs: 50, seqGap: MATCH_STALE_SEQ_GAP })).toBe(false); // boundary
  });

  it("a partner NEWER than the arriving side (negative gap) is never seq-stale", () => {
    expect(matchPartnerStale({ ageMs: 50, seqGap: -3 })).toBe(false);
  });

  it("a corrupt clock (negative / non-finite age) holds rather than steering", () => {
    expect(matchPartnerStale({ ageMs: -5, seqGap: 0 })).toBe(true);
    expect(matchPartnerStale({ ageMs: NaN, seqGap: 0 })).toBe(true);
  });

  it("custom horizons apply", () => {
    expect(matchPartnerStale({ ageMs: 100, seqGap: 0 }, 80)).toBe(true);
    expect(matchPartnerStale({ ageMs: 100, seqGap: 5 }, 200, 4)).toBe(true);
  });
});

describe("pairEpochSkewed (trigger-sync pair window)", () => {
  // window = half a 20 ms trigger interval, in ns.
  const WINDOW_NS = (20 * 1e6) / 2;
  const T0 = 5_000_000_000; // arbitrary trusted-time host-ns base

  it("equal epochs (same trigger slot) pair", () => {
    expect(pairEpochSkewed(T0, T0, WINDOW_NS)).toBe(false);
  });

  it("jitter inside the window pairs, either sign", () => {
    expect(pairEpochSkewed(T0, T0 + 1_000_000, WINDOW_NS)).toBe(false);
    expect(pairEpochSkewed(T0 + 1_000_000, T0, WINDOW_NS)).toBe(false);
  });

  it("EXACTLY the window still pairs (inclusive bound — pinned)", () => {
    expect(pairEpochSkewed(T0, T0 + WINDOW_NS, WINDOW_NS)).toBe(false);
    expect(pairEpochSkewed(T0, T0 + WINDOW_NS + 1, WINDOW_NS)).toBe(true);
  });

  it("adjacent-slot epochs (one full trigger interval apart) do not pair", () => {
    expect(pairEpochSkewed(T0, T0 + 2 * WINDOW_NS, WINDOW_NS)).toBe(true);
  });

  it("a non-finite epoch is unjudgeable — do not pair", () => {
    expect(pairEpochSkewed(NaN, T0, WINDOW_NS)).toBe(true);
    expect(pairEpochSkewed(T0, Infinity, WINDOW_NS)).toBe(true);
  });
});
