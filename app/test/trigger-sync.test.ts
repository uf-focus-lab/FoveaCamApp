// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Trigger-sync MATCH-JOIN-coupled PURE decisions (spec disparity-scope
// §trigger-sync): the budget-derived pair window and the engaged-only gating —
// free-run (disengaged) behavior must be untouched by construction. The
// generic core (preconditions, rate window, failure line, op chain) is shared
// with manual-control and exercised in trigger-sync-core.test.ts.

import { describe, expect, it } from "vitest";
import {
  matchStaleMsFor,
  pairEpochGateTrips,
  pairWindowNs,
} from "@modules/disparity-scope/trigger-sync";
import { MATCH_STALE_MS } from "@lib/vergence/match-join";

describe("pairWindowNs", () => {
  it("is half the trigger interval, in ns", () => {
    expect(pairWindowNs(20)).toBe(10e6);
    expect(pairWindowNs(2.5)).toBe(1.25e6);
  });
});

describe("pairEpochGateTrips (engaged-only)", () => {
  const T0 = 7_000_000_000;

  it("NEVER trips while disengaged — free-run pairing is untouched", () => {
    // Epochs a full second apart (wildly skewed): free-run must still pair.
    expect(pairEpochGateTrips(false, 20, T0, T0 + 1e9)).toBe(false);
    expect(pairEpochGateTrips(false, null, NaN, T0)).toBe(false);
  });

  it("never trips without a derived budget (engaged but no interval yet)", () => {
    expect(pairEpochGateTrips(true, null, T0, T0 + 1e9)).toBe(false);
  });

  it("engaged: same-slot pairs, adjacent-slot trips", () => {
    expect(pairEpochGateTrips(true, 20, T0, T0 + 1e6)).toBe(false);
    expect(pairEpochGateTrips(true, 20, T0, T0 + 20e6)).toBe(true);
  });
});

describe("matchStaleMsFor", () => {
  it("free-run keeps the default horizon exactly", () => {
    expect(matchStaleMsFor(false, 500)).toBe(MATCH_STALE_MS);
    expect(matchStaleMsFor(false, null)).toBe(MATCH_STALE_MS);
    expect(matchStaleMsFor(true, null)).toBe(MATCH_STALE_MS);
  });

  it("engaged: 4× the trigger interval, floored at the default", () => {
    expect(matchStaleMsFor(true, 500)).toBe(2000);
    expect(matchStaleMsFor(true, 10)).toBe(MATCH_STALE_MS); // 40 < 300 — floor
  });
});
