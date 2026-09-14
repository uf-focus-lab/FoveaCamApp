// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Fovea gain override (spec docs/spec/mirror-link.md §gain): clamping to the
// camera's live range, auto-gain Off BEFORE the value and restored LAST, a
// byte-identical restore, and the L/R range intersection (a disjoint pair
// degrades to {0,0} — no slider rather than a bound one camera would reject).

import { describe, expect, it } from "vitest";
import {
  applyGain,
  intersectRanges,
  restoreGain,
  snapshotGain,
  type GainCamera,
} from "@modules/mirror-link/gain";

class FakeCamera implements GainCamera {
  /** Every write, in order — the field names alone. */
  readonly writes: string[] = [];
  private _gain: number;
  private _auto: "Off" | "Once" | "Continuous";

  constructor(
    gain = 3,
    auto: "Off" | "Once" | "Continuous" = "Continuous",
    private readonly range = { min: 0, max: 24 },
  ) {
    this._gain = gain;
    this._auto = auto;
  }

  get gain_range(): { min: number; max: number } {
    return this.range;
  }
  get gain(): number {
    return this._gain;
  }
  set gain(v: number) {
    this.writes.push("gain");
    this._gain = v;
  }
  get gain_auto(): "Off" | "Once" | "Continuous" {
    return this._auto;
  }
  set gain_auto(v: "Off" | "Once" | "Continuous") {
    this.writes.push("gain_auto");
    this._auto = v;
  }
}

/** A model with NO auto-gain node: every `gain_auto` access throws. */
class NoAutoCamera implements GainCamera {
  readonly writes: string[] = [];
  private _gain = 4;

  get gain_range(): { min: number; max: number } {
    return { min: 0, max: 24 };
  }
  get gain(): number {
    return this._gain;
  }
  set gain(v: number) {
    this.writes.push("gain");
    this._gain = v;
  }
  get gain_auto(): "Off" | "Once" | "Continuous" {
    throw new Error("GainAuto: node not available");
  }
  set gain_auto(_v: "Off" | "Once" | "Continuous") {
    throw new Error("GainAuto: node not available");
  }
}

describe("a camera without an auto-gain node", () => {
  it("snapshots the value alone, still applies, and restores without the auto write", () => {
    const cam = new NoAutoCamera();
    const snap = snapshotGain(cam);
    expect(snap).toEqual({ gain: 4 });
    expect(applyGain(cam, 18)).toBe(18);
    cam.writes.length = 0;
    restoreGain(cam, snap);
    expect(cam.writes).toEqual(["gain"]);
    expect(cam.gain).toBe(4);
  });
});

describe("applyGain", () => {
  it("clamps to the camera's live range and returns what it took", () => {
    const cam = new FakeCamera();
    expect(applyGain(cam, 100)).toBe(24);
    expect(cam.gain).toBe(24);
    expect(applyGain(cam, -5)).toBe(0);
    expect(applyGain(cam, 12.5)).toBe(12.5);
  });

  it("forces auto-gain Off BEFORE writing the value", () => {
    const cam = new FakeCamera(3, "Continuous");
    applyGain(cam, 6);
    expect(cam.gain_auto).toBe("Off");
    expect(cam.writes).toEqual(["gain_auto", "gain"]);
  });
});

describe("restoreGain", () => {
  it("returns the snapshot byte-identically after any number of applies", () => {
    for (const auto of ["Off", "Once", "Continuous"] as const) {
      const cam = new FakeCamera(7.5, auto);
      const snap = snapshotGain(cam);
      for (const dB of [0, 24, 12.3, 100]) {
        applyGain(cam, dB);
        restoreGain(cam, snap);
        expect(snapshotGain(cam)).toEqual(snap);
      }
    }
  });

  it("writes the value first and the auto mode LAST", () => {
    const cam = new FakeCamera(7.5, "Continuous");
    const snap = snapshotGain(cam);
    applyGain(cam, 20);
    cam.writes.length = 0;
    restoreGain(cam, snap);
    expect(cam.writes).toEqual(["gain", "gain_auto"]);
    expect(cam.gain_auto).toBe("Continuous");
  });
});

describe("intersectRanges", () => {
  it("keeps the tightest shared bounds", () => {
    expect(intersectRanges({ min: 0, max: 24 }, { min: 2, max: 18 })).toEqual({
      min: 2,
      max: 18,
    });
    expect(intersectRanges({ min: 3, max: 30 }, { min: 0, max: 24 })).toEqual({
      min: 3,
      max: 24,
    });
  });

  it("collapses a DISJOINT pair to {0,0} (no common value ⇒ no slider)", () => {
    expect(intersectRanges({ min: 0, max: 5 }, { min: 10, max: 20 })).toEqual({
      min: 0,
      max: 0,
    });
  });

  it("keeps a single shared point (min === max reads as disabled too)", () => {
    expect(intersectRanges({ min: 0, max: 10 }, { min: 10, max: 30 })).toEqual({
      min: 10,
      max: 10,
    });
  });
});
