// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Triggered exposure override (spec docs/spec/mirror-link.md §exposure-windows)
// against a fake camera whose exposure CEILING tracks its frame rate and whose
// exposure is only writable in Timed mode — the constraints the write order
// exists for. TriggerWidth is the primary mode (the pulse IS the exposure), the
// Timed fallback clamps the pulse, and apply→restore lands byte-identically on
// the snapshot (exposure mode + TriggerActivation included).

import { describe, expect, it } from "vitest";
import {
  applyTriggeredTiming,
  exposureMismatch,
  readoutSpacingUs,
  readTimingLimits,
  restoreTiming,
  snapshotTiming,
  type TimingCamera,
} from "@modules/mirror-link/exposure";

/** Exposure ceiling while frame-rate control is ON: one period minus the
 *  readout gap; free-running (or triggered) the camera allows 30 s. */
const ceiling = (enabled: boolean, rate: number): number =>
  enabled ? 1e6 / rate - 100 : 30e6;

const MAX_RATE = 60;
const MIN_EXPOSURE = 20;

class FakeCamera implements TimingCamera {
  /** Writes that landed OUTSIDE the range live at the moment of the write, or
   *  on a node the current mode makes read-only. */
  readonly violations: string[] = [];
  /** Every write, in order — the field names alone. */
  readonly writes: string[] = [];
  private _enable = false;
  private _auto: "Off" | "Once" | "Continuous" = "Continuous";
  private _rate = 30;
  private _exposure = 12_000;
  readonly features: Record<string, string> = {
    ExposureMode: "Timed",
    TriggerActivation: "RisingEdge",
  };

  constructor(
    /** Modes `setExposureMode` accepts. */
    private readonly modes: string[] = ["Timed", "TriggerWidth"],
    /** Feature names whose `setFeature` throws (a model lacking the entry). */
    private readonly refuse: Set<string> = new Set(),
    /** Feature names `getFeature` throws on (a model without the node). */
    private readonly missing: Set<string> = new Set(),
  ) {}

  /** Seed the camera's pre-scan timing without recording the writes. */
  seed(
    enable: boolean,
    rate: number,
    exposure: number,
    auto: FakeCamera["_auto"],
    features: Partial<Record<string, string>> = {},
  ): this {
    this._enable = enable;
    this._rate = rate;
    this._exposure = exposure;
    this._auto = auto;
    Object.assign(this.features, features);
    return this;
  }

  get frame_rate_range(): { min: number; max: number } {
    return { min: 1, max: MAX_RATE };
  }
  get exposure_range(): { min: number; max: number } {
    return { min: MIN_EXPOSURE, max: ceiling(this._enable, this._rate) };
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
    if (this.features.ExposureMode !== "Timed")
      this.violations.push(`exposure written in ${this.features.ExposureMode} mode`);
    const r = this.exposure_range;
    if (v < r.min || v > r.max)
      this.violations.push(`exposure=${v} outside ${r.min}..${r.max}`);
    this._exposure = v;
  }
  setExposureMode(mode: string): boolean {
    this.writes.push(`ExposureMode=${mode}`);
    if (!this.modes.includes(mode)) return false;
    this.features.ExposureMode = mode;
    return true;
  }
  getFeature(name: string): string {
    if (this.missing.has(name)) throw new Error(`[${name}] not found`);
    const v = this.features[name];
    if (v === undefined) throw new Error(`[${name}] not found`);
    return v;
  }
  setFeature(name: string, value: string): void {
    this.writes.push(`${name}=${value}`);
    if (this.refuse.has(name)) throw new Error(`[${name}] '${value}' not an entry`);
    this.features[name] = value;
  }
}

describe("applyTriggeredTiming — TriggerWidth (primary)", () => {
  it("takes the pulse as the exposure: no exposure write, LevelHigh activation", () => {
    const cam = new FakeCamera().seed(true, 30, 12_000, "Continuous");
    const applied = applyTriggeredTiming(cam, { pulseUs: 45_000, preferTriggerWidth: true });
    expect(applied).toEqual({ exposure_mode: "TriggerWidth", exposure_us: 0, frame_rate: 30 });
    expect(cam.features.ExposureMode).toBe("TriggerWidth");
    expect(cam.features.TriggerActivation).toBe("LevelHigh");
    expect(cam.exposure_auto).toBe("Off");
    expect(cam.frame_rate_enable).toBe(false);
    expect(cam.writes).toEqual([
      "exposure_auto",
      "frame_rate_enable",
      "ExposureMode=TriggerWidth",
      "TriggerActivation=LevelHigh",
    ]);
    expect(cam.violations).toEqual([]);
  });
});

describe("applyTriggeredTiming — Timed fallback", () => {
  it("falls back when the model refuses TriggerWidth: RisingEdge + exposure = pulse", () => {
    const cam = new FakeCamera(["Timed"]).seed(true, 30, 12_000, "Off");
    const applied = applyTriggeredTiming(cam, { pulseUs: 45_000, preferTriggerWidth: true });
    expect(applied).toEqual({ exposure_mode: "Timed", exposure_us: 45_000, frame_rate: 30 });
    expect(cam.features.ExposureMode).toBe("Timed");
    expect(cam.features.TriggerActivation).toBe("RisingEdge");
    expect(cam.writes).toEqual([
      "exposure_auto",
      "frame_rate_enable",
      "ExposureMode=TriggerWidth",
      "ExposureMode=Timed",
      "TriggerActivation=RisingEdge",
      "exposure",
    ]);
    // Rate limit OFF first: a 45 ms exposure never fits the 30 fps ceiling,
    // but the free-running ceiling holds it.
    expect(cam.violations).toEqual([]);
  });

  it("falls back when LevelHigh is not an entry (TriggerWidth would expose for nothing)", () => {
    const cam = new FakeCamera(undefined, new Set(["TriggerActivation"]));
    // RisingEdge is refused too by this fake — so the Timed path throws.
    expect(() =>
      applyTriggeredTiming(cam, { pulseUs: 1_000, preferTriggerWidth: true }),
    ).toThrow(/not an entry/);
    const ok = new FakeCamera();
    const orig = ok.setFeature.bind(ok);
    ok.setFeature = (n, v) => {
      if (v === "LevelHigh") throw new Error("[TriggerActivation] 'LevelHigh' not an entry");
      orig(n, v);
    };
    expect(applyTriggeredTiming(ok, { pulseUs: 1_000, preferTriggerWidth: true }).exposure_mode).toBe(
      "Timed",
    );
  });

  it("uses Timed directly when TriggerWidth is not preferred", () => {
    const cam = new FakeCamera();
    const applied = applyTriggeredTiming(cam, { pulseUs: 2_000, preferTriggerWidth: false });
    expect(applied.exposure_mode).toBe("Timed");
    expect(cam.writes).not.toContain("ExposureMode=TriggerWidth");
  });

  it("clamps the pulse to the live exposure range (min and max)", () => {
    const short = new FakeCamera(["Timed"]);
    expect(applyTriggeredTiming(short, { pulseUs: 5, preferTriggerWidth: true }).exposure_us).toBe(
      MIN_EXPOSURE,
    );
    const long = new FakeCamera(["Timed"]);
    expect(
      applyTriggeredTiming(long, { pulseUs: 60e6, preferTriggerWidth: true }).exposure_us,
    ).toBe(30e6);
    expect(short.violations).toEqual([]);
    expect(long.violations).toEqual([]);
  });

  it("throws when the model takes neither mode", () => {
    const cam = new FakeCamera([]);
    expect(() =>
      applyTriggeredTiming(cam, { pulseUs: 1_000, preferTriggerWidth: true }),
    ).toThrow(/refused both/);
  });
});

describe("snapshot + restore", () => {
  it("returns the snapshot byte-identically after an apply (both modes, many seeds)", () => {
    for (const [enable, rate, exposure, auto] of [
      [false, 30, 12_000, "Continuous"],
      [true, 50, 15_000, "Off"],
      [true, 2, 400_000, "Once"],
    ] as const)
      for (const modes of [["Timed", "TriggerWidth"], ["Timed"]]) {
        const cam = new FakeCamera(modes).seed(enable, rate, exposure, auto, {
          TriggerActivation: "FallingEdge",
        });
        const snap = snapshotTiming(cam);
        expect(snap.exposure_mode).toBe("Timed");
        expect(snap.trigger_activation).toBe("FallingEdge");
        for (const pulseUs of [500, 45_000, 2e6]) {
          applyTriggeredTiming(cam, { pulseUs, preferTriggerWidth: true });
          restoreTiming(cam, snap);
          expect(snapshotTiming(cam)).toEqual(snap);
        }
        expect(cam.violations).toEqual([]);
      }
  });

  it("restores the mode FIRST, TriggerActivation next, exposure twice around the rate, exposure_auto LAST", () => {
    const cam = new FakeCamera();
    const snap = snapshotTiming(cam);
    applyTriggeredTiming(cam, { pulseUs: 10_000, preferTriggerWidth: true });
    cam.writes.length = 0;
    restoreTiming(cam, snap);
    expect(cam.writes).toEqual([
      "ExposureMode=Timed",
      "TriggerActivation=RisingEdge",
      "exposure",
      "frame_rate",
      "frame_rate_enable",
      "exposure",
      "exposure_auto",
    ]);
    // The exposure writes landed in Timed mode (TriggerWidth makes it read-only).
    expect(cam.violations).toEqual([]);
    expect(cam.exposure_auto).toBe("Continuous");
  });

  it("skips nodes the model lacks (null in the snapshot, never written back)", () => {
    const cam = new FakeCamera(undefined, undefined, new Set(["ExposureMode", "TriggerActivation"]));
    const snap = snapshotTiming(cam);
    expect(snap.exposure_mode).toBeNull();
    expect(snap.trigger_activation).toBeNull();
    applyTriggeredTiming(cam, { pulseUs: 10_000, preferTriggerWidth: false });
    cam.writes.length = 0;
    restoreTiming(cam, snap);
    expect(cam.writes.some((w) => w.startsWith("ExposureMode") || w.startsWith("TriggerActivation"))).toBe(
      false,
    );
  });

  it("falls back to the generic feature write when setExposureMode refuses the saved mode", () => {
    const cam = new FakeCamera(["Timed", "TriggerWidth"]).seed(false, 30, 12_000, "Off", {
      ExposureMode: "TriggerControlled",
    });
    const snap = snapshotTiming(cam);
    // Restore the exposure writes in Timed: seed the fake back to Timed after apply.
    applyTriggeredTiming(cam, { pulseUs: 10_000, preferTriggerWidth: true });
    cam.writes.length = 0;
    try {
      restoreTiming(cam, snap);
    } catch {
      // the fake's exposure guard may complain; only the mode write matters here
    }
    expect(cam.writes.slice(0, 2)).toEqual([
      "ExposureMode=TriggerControlled",
      "ExposureMode=TriggerControlled",
    ]);
    expect(cam.features.ExposureMode).toBe("TriggerControlled");
  });
});

describe("TriggerOverlap = ReadOut", () => {
  it("is set in both modes where the node exists, and restored verbatim", () => {
    for (const modes of [["Timed", "TriggerWidth"], ["Timed"]]) {
      const cam = new FakeCamera(modes).seed(true, 30, 12_000, "Off", { TriggerOverlap: "Off" });
      const snap = snapshotTiming(cam);
      expect(snap.trigger_overlap).toBe("Off");
      applyTriggeredTiming(cam, { pulseUs: 10_000, preferTriggerWidth: true });
      expect(cam.features.TriggerOverlap).toBe("ReadOut");
      expect(restoreTiming(cam, snap)).toEqual([]);
      expect(cam.features.TriggerOverlap).toBe("Off");
      expect(snapshotTiming(cam)).toEqual(snap);
    }
  });

  it("is skipped silently on a model without the node (no write, null snapshot)", () => {
    const cam = new FakeCamera();
    const snap = snapshotTiming(cam);
    expect(snap.trigger_overlap).toBeNull();
    applyTriggeredTiming(cam, { pulseUs: 10_000, preferTriggerWidth: true });
    restoreTiming(cam, snap);
    expect(cam.writes.some((w) => w.startsWith("TriggerOverlap"))).toBe(false);
  });

  it("a refused ReadOut entry does not fail the apply", () => {
    const cam = new FakeCamera(undefined, new Set(["TriggerOverlap"])).seed(true, 30, 12_000, "Off", {
      TriggerOverlap: "Off",
    });
    expect(applyTriggeredTiming(cam, { pulseUs: 10_000, preferTriggerWidth: true }).exposure_mode).toBe(
      "TriggerWidth",
    );
  });
});

describe("restoreTiming — best-effort per feature", () => {
  it("keeps writing after a refused feature and returns the failures", () => {
    const cam = new FakeCamera().seed(true, 30, 12_000, "Continuous", { TriggerOverlap: "Off" });
    const snap = snapshotTiming(cam);
    applyTriggeredTiming(cam, { pulseUs: 10_000, preferTriggerWidth: true });
    const orig = cam.setFeature.bind(cam);
    cam.setFeature = (n, v) => {
      if (n === "TriggerActivation") throw new Error("[TriggerActivation] locked\nstack");
      orig(n, v);
    };
    const failed = restoreTiming(cam, snap);
    expect(failed).toEqual(["TriggerActivation: [TriggerActivation] locked"]);
    // Everything after the refused write still landed.
    expect(cam.features.TriggerOverlap).toBe("Off");
    expect(cam.frame_rate_enable).toBe(true);
    expect(cam.exposure).toBe(12_000);
    expect(cam.exposure_auto).toBe("Continuous");
  });
});

describe("readTimingLimits — read AFTER the triggered timing", () => {
  /** A Timed-only camera whose maximum frame rate is capped by its CURRENT
   *  exposure (the Blackfly S readback): a long pre-scan exposure caps it low. */
  const capped = (): FakeCamera => {
    const cam = new FakeCamera(["Timed"]).seed(true, 4, 200_000, "Off");
    Object.defineProperty(cam, "frame_rate_range", {
      get: () => ({ min: 1, max: Math.min(MAX_RATE, 1e6 / cam.exposure) }),
    });
    return cam;
  };

  it("sees the rate the TRIGGERED exposure allows, not the pre-scan one", () => {
    const cam = capped();
    expect(readTimingLimits(cam).frame_rate_max).toBe(5); // 200 ms pre-scan
    applyTriggeredTiming(cam, { pulseUs: 50_000, preferTriggerWidth: true });
    expect(readTimingLimits(cam)).toEqual({ frame_rate_max: 20, readout_us: null });
  });

  it("takes SensorReadoutTime when readable (string, else integer), best-effort", () => {
    const str = new FakeCamera().seed(true, 30, 12_000, "Off", { SensorReadoutTime: "8123.5" });
    expect(readTimingLimits(str)).toEqual({ frame_rate_max: MAX_RATE, readout_us: 8123.5 });
    const int = Object.assign(new FakeCamera(), {
      getFeatureInt: (n: string) => (n === "SensorReadoutTime" ? 9000 : 0),
    });
    expect(readTimingLimits(int).readout_us).toBe(9000);
    const none = Object.assign(new FakeCamera(), {
      getFeatureInt: (): number => {
        throw new Error("Not a ArvGcInteger");
      },
    });
    expect(readTimingLimits(none).readout_us).toBeNull();
  });

  it("readoutSpacingUs: the readout time, else 1 / max fps, else 0", () => {
    expect(readoutSpacingUs({ frame_rate_max: 50, readout_us: 7_000 })).toBe(7_000);
    expect(readoutSpacingUs({ frame_rate_max: 50, readout_us: null })).toBe(20_000);
    expect(readoutSpacingUs({ frame_rate_max: Infinity, readout_us: null })).toBe(0);
  });
});

describe("exposureMismatch", () => {

  it("tolerates 2 % of the window and flags beyond it", () => {
    expect(exposureMismatch(49_900, 50_000)).toBe(false);
    expect(exposureMismatch(49_100, 50_000)).toBe(false); // 1.8 %
    expect(exposureMismatch(48_000, 50_000)).toBe(true); // 4 %
    expect(exposureMismatch(16_566, 10_000)).toBe(true);
    expect(exposureMismatch(49_900, 50_000, 0)).toBe(true);
  });
});
