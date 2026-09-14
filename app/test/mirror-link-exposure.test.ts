// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Exposure override (spec docs/spec/mirror-link.md §exposure) against a fake
// camera whose exposure CEILING tracks its frame rate — the constraint the
// two-sided write order exists for. Every write is checked against the range
// live at that write, in BOTH directions (raising and lowering the frequency),
// and apply→restore must land byte-identically on the snapshot.

import { describe, expect, it } from "vitest";
import {
  applyScanTiming,
  exposureMismatch,
  restoreTiming,
  scanPeriodUs,
  snapshotTiming,
  type TimingCamera,
} from "@modules/mirror-link/exposure";

/** Exposure ceiling while frame-rate control is ON: one period minus the
 *  readout gap; free-running the camera allows a 30 s exposure. */
const ceiling = (enabled: boolean, rate: number): number =>
  enabled ? 1e6 / rate - 100 : 30e6;

const MAX_RATE = 60;

class FakeCamera implements TimingCamera {
  /** Writes that landed OUTSIDE the range live at the moment of the write. */
  readonly violations: string[] = [];
  /** Every write, in order — the field names alone. */
  readonly writes: string[] = [];
  private _enable = false;
  private _auto: "Off" | "Once" | "Continuous" = "Continuous";
  private _rate = 30;
  private _exposure = 12_000;

  /** Seed the camera's pre-scan timing without recording the writes. */
  seed(
    enable: boolean,
    rate: number,
    exposure: number,
    auto: FakeCamera["_auto"],
  ): this {
    this._enable = enable;
    this._rate = rate;
    this._exposure = exposure;
    this._auto = auto;
    return this;
  }

  get frame_rate_range(): { min: number; max: number } {
    return { min: 1, max: MAX_RATE };
  }
  get exposure_range(): { min: number; max: number } {
    return { min: 20, max: ceiling(this._enable, this._rate) };
  }
  get frame_rate_enable(): boolean {
    return this._enable;
  }
  set frame_rate_enable(v: boolean) {
    this.writes.push("frame_rate_enable");
    this._enable = v;
  }
  get exposure_auto(): "Off" | "Once" | "Continuous" {
    return this._auto;
  }
  set exposure_auto(v: "Off" | "Once" | "Continuous") {
    this.writes.push("exposure_auto");
    this._auto = v;
  }
  get frame_rate(): number {
    return this._rate;
  }
  set frame_rate(v: number) {
    this.writes.push("frame_rate");
    const r = this.frame_rate_range;
    if (v < r.min || v > r.max)
      this.violations.push(`frame_rate=${v} outside ${r.min}..${r.max}`);
    this._rate = v;
  }
  get exposure(): number {
    return this._exposure;
  }
  set exposure(v: number) {
    this.writes.push("exposure");
    const r = this.exposure_range;
    if (v < r.min || v > r.max)
      this.violations.push(`exposure=${v} outside ${r.min}..${r.max}`);
    this._exposure = v;
  }
}

describe("applyScanTiming", () => {
  it("keeps every write inside the LIVE range while LOWERING the frequency", () => {
    // Short period → long exposure: the ceiling only WIDENS after the rate write.
    const cam = new FakeCamera().seed(true, 50, 15_000, "Off");
    const applied = applyScanTiming(cam, 2);
    expect(cam.violations).toEqual([]);
    expect(applied.frame_rate).toBe(2);
    expect(applied.exposure_us).toBeCloseTo(ceiling(true, 2), 6);
  });

  it("keeps every write inside the LIVE range while RAISING the frequency", () => {
    // A long exposure the new rate could never hold: it must shrink FIRST.
    const cam = new FakeCamera().seed(true, 2, 400_000, "Off");
    const applied = applyScanTiming(cam, 50);
    expect(cam.violations).toEqual([]);
    expect(applied.frame_rate).toBe(50);
    expect(applied.exposure_us).toBeCloseTo(ceiling(true, 50), 6);
  });

  it("writes exposure BEFORE and AFTER the rate, with exposure_auto Off first", () => {
    const cam = new FakeCamera();
    applyScanTiming(cam, 10);
    expect(cam.exposure_auto).toBe("Off");
    expect(cam.frame_rate_enable).toBe(true);
    expect(cam.writes).toEqual([
      "exposure_auto",
      "exposure",
      "frame_rate_enable",
      "frame_rate",
      "exposure",
    ]);
  });

  it("clamps a frequency above the camera's max rate and keeps exposure = period", () => {
    const cam = new FakeCamera();
    const hz = 100; // > MAX_RATE
    const applied = applyScanTiming(cam, hz);
    expect(cam.violations).toEqual([]);
    expect(applied.frame_rate).toBe(MAX_RATE);
    // Dead time between frames — the frame still spans exactly one revolution.
    expect(applied.exposure_us).toBeCloseTo(scanPeriodUs(hz), 6);
    expect(exposureMismatch(applied.exposure_us, scanPeriodUs(hz))).toBe(false);
  });

  it("flags a mismatch when the ceiling forces a shorter exposure than the period", () => {
    const cam = new FakeCamera();
    const hz = 1; // period 1e6 µs, ceiling at rate 1 is 999900 µs
    const applied = applyScanTiming(cam, hz);
    expect(applied.exposure_us).toBeLessThan(scanPeriodUs(hz));
    // ...but only by 0.01 %, so it is NOT a mismatch at the 2 % tolerance.
    expect(exposureMismatch(applied.exposure_us, scanPeriodUs(hz))).toBe(false);
    expect(exposureMismatch(applied.exposure_us, scanPeriodUs(hz), 0)).toBe(
      true,
    );
  });
});

describe("restoreTiming", () => {
  it("returns the snapshot byte-identically after an apply (both directions)", () => {
    for (const [enable, rate, exposure, auto] of [
      [false, 30, 12_000, "Continuous"],
      [true, 50, 15_000, "Off"],
      [true, 2, 400_000, "Once"],
    ] as const) {
      const cam = new FakeCamera().seed(enable, rate, exposure, auto);
      const snap = snapshotTiming(cam);

      for (const hz of [2, 50, 100]) {
        applyScanTiming(cam, hz);
        restoreTiming(cam, snap);
        expect(snapshotTiming(cam)).toEqual(snap);
      }
      expect(cam.violations).toEqual([]);
    }
  });

  it("writes exposure twice around the rate and exposure_auto LAST", () => {
    const cam = new FakeCamera();
    const snap = snapshotTiming(cam); // exposure_auto "Continuous"
    applyScanTiming(cam, 20);
    cam.writes.length = 0;
    restoreTiming(cam, snap);
    expect(cam.writes).toEqual([
      "exposure",
      "frame_rate",
      "frame_rate_enable",
      "exposure",
      "exposure_auto",
    ]);
    expect(cam.exposure_auto).toBe("Continuous");
  });
});

describe("exposureMismatch", () => {
  it("tolerates 2 % and flags beyond it", () => {
    expect(exposureMismatch(49_900, 50_000)).toBe(false);
    expect(exposureMismatch(49_100, 50_000)).toBe(false); // 1.8 %
    expect(exposureMismatch(48_000, 50_000)).toBe(true); // 4 %
    expect(exposureMismatch(16_566, 10_000)).toBe(true);
  });
});
