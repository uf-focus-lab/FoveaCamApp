// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera hardware-trigger config (spec disparity-scope §trigger-sync): both
// directions ride `lease.reconfigure()`, enable programs the trigger source
// + the strobe line, disable clears — driven with a fake lease (no native core).
// Defaults follow the V0.1 board (docs/hardware/rig.md §Cameras): trigger on
// camera Line3 (the BFS's input-only non-isolated line), ExposureActive strobe
// on camera Line2 (open-drain, active LOW at the Teensy), not inverted.

import { describe, expect, it, vi } from "vitest";
import {
  disableHardwareTrigger,
  enableHardwareTrigger,
  enableSoftwareTrigger,
  readTriggerConfig,
} from "@orchestrator/camera-trigger";
import type { CameraLease } from "@orchestrator/registry";

function makeFakeLease(
  opts: { triggerSourceOptions?: string[]; boolWriter?: boolean } = {},
) {
  /** Every write in call order: setFeature (`Name=value`), setTrigger
   *  (`setTrigger=src`) and setFeatureBool (`Name:bool=value`). */
  const writes: string[] = [];
  const features: Record<string, string> = {};
  const camera: Record<string, any> = {
    setTrigger: vi.fn((source: string) => {
      writes.push(`setTrigger=${source}`);
    }),
    clearTriggers: vi.fn(),
    setFeature: vi.fn((name: string, value: string) => {
      writes.push(`${name}=${value}`);
      features[name] = value;
    }),
    getFeature: vi.fn((name: string) => {
      if (!(name in features)) throw new Error(`[${name}] Not found`);
      return features[name];
    }),
    getFeatureBool: vi.fn((name: string) => {
      if (!(name in features)) throw new Error(`[${name}] Not found`);
      return features[name] === "true";
    }),
  };
  // The native binding's boolean setter (arv_camera_set_boolean). Omit it
  // (boolWriter: false) to model an older addon build without the method.
  if (opts.boolWriter !== false)
    camera.setFeatureBool = vi.fn((name: string, value: boolean) => {
      writes.push(`${name}:bool=${value}`);
      features[name] = String(value);
    });
  if (opts.triggerSourceOptions)
    camera.trigger_source_options = opts.triggerSourceOptions;
  const lease = {
    camera,
    reconfigure: vi.fn(async (mutate: () => void | Promise<void>) => {
      await mutate();
    }),
    release: vi.fn(),
  };
  return {
    lease: lease as unknown as CameraLease,
    raw: lease,
    camera,
    features,
    writes,
  };
}

/** The writes after `setTrigger` (the strobe-line block). */
const strobeWrites = (writes: string[]) =>
  writes.slice(writes.findIndex((w) => w.startsWith("setTrigger=")) + 1);

describe("enableHardwareTrigger", () => {
  it("triggers on Line3 and programs the Line2 ExposureActive strobe through reconfigure", async () => {
    const { lease, raw, camera, writes } = makeFakeLease();
    const result = await enableHardwareTrigger(lease);
    expect(raw.reconfigure).toHaveBeenCalledTimes(1);
    // setTrigger takes the SOURCE (arv_camera_set_trigger semantics — Aravis
    // sets TriggerMode/TriggerSelector itself). Passing "FrameStart" is wrong;
    // pin the source argument.
    expect(camera.setTrigger).toHaveBeenCalledTimes(1);
    expect(camera.setTrigger).toHaveBeenCalledWith("Line3");
    // The full GenICam sequence: the source (Line3 is input-only, so no
    // LineMode=Input write), then the strobe line LineSelector → LineMode →
    // LineSource → LineInverter=false (open-drain, the firmware's active-LOW
    // read).
    expect(writes).toEqual([
      "setTrigger=Line3",
      "LineSelector=Line2",
      "LineMode=Output",
      "LineSource=ExposureActive",
      "LineInverter:bool=false",
    ]);
    expect(result).toEqual({ lineInverter: null });
    expect(camera.clearTriggers).not.toHaveBeenCalled();
  });

  it("selects the strobe line BEFORE its line-scoped writes (LineMode/LineSource/LineInverter)", async () => {
    const { lease, writes } = makeFakeLease();
    await enableHardwareTrigger(lease);
    expect(strobeWrites(writes)).toEqual([
      "LineSelector=Line2",
      "LineMode=Output",
      "LineSource=ExposureActive",
      "LineInverter:bool=false",
    ]);
  });

  it("forces LineMode=Input on a bidirectional (Line2) trigger line before selecting it", async () => {
    const { lease, writes } = makeFakeLease();
    await enableHardwareTrigger(lease, { triggerSource: "Line2", lineSelector: "Line1" });
    expect(writes.slice(0, 3)).toEqual([
      "LineSelector=Line2",
      "LineMode=Input",
      "setTrigger=Line2",
    ]);
  });

  it("writes LineInverter through the boolean setter, never the string one", async () => {
    const { lease, camera } = makeFakeLease();
    await enableHardwareTrigger(lease);
    expect(camera.setFeatureBool).toHaveBeenCalledTimes(1);
    expect(camera.setFeatureBool).toHaveBeenCalledWith("LineInverter", false);
    expect(camera.setFeature).not.toHaveBeenCalledWith("LineInverter", expect.anything());
  });

  it("writes LineInverter=true through the boolean setter when asked", async () => {
    const { lease, camera } = makeFakeLease();
    await enableHardwareTrigger(lease, { lineInverter: true });
    expect(camera.setFeatureBool).toHaveBeenCalledWith("LineInverter", true);
    expect(camera.setFeature).not.toHaveBeenCalledWith("LineInverter", expect.anything());
  });

  it("falls back to the string setter on a binding without setFeatureBool", async () => {
    const { lease, writes } = makeFakeLease({ boolWriter: false });
    const result = await enableHardwareTrigger(lease);
    expect(writes.at(-1)).toBe("LineInverter=false");
    expect(result).toEqual({ lineInverter: null });
  });

  it("reports (does not throw) a failed boolean LineInverter write", async () => {
    const { lease, camera } = makeFakeLease();
    camera.setFeatureBool.mockImplementation(() => {
      throw new Error("[LineInverter] Not writable\nmore");
    });
    const result = await enableHardwareTrigger(lease);
    expect(result.lineInverter).toBe("[LineInverter] Not writable");
    expect(camera.setTrigger).toHaveBeenCalledWith("Line3");
  });

  it("reports (does not throw) a LineInverter write the string fallback cannot do", async () => {
    const { lease, camera } = makeFakeLease({ boolWriter: false });
    const base = camera.setFeature.getMockImplementation()!;
    camera.setFeature.mockImplementation((name: string, value: string) => {
      if (name === "LineInverter")
        throw new Error("[LineInverter:ArvGcBoolean] Not a ArvGcString\nmore");
      base(name, value);
    });
    const result = await enableHardwareTrigger(lease);
    expect(result.lineInverter).toBe("[LineInverter:ArvGcBoolean] Not a ArvGcString");
    expect(camera.setTrigger).toHaveBeenCalledWith("Line3");
  });

  it("keeps the opto pair selectable as a bench fallback (inverter is the caller's call)", async () => {
    const { lease, camera, writes } = makeFakeLease();
    await enableHardwareTrigger(lease, {
      triggerSource: "Line0",
      lineSelector: "Line1",
      lineInverter: true,
    });
    expect(camera.setTrigger).toHaveBeenCalledWith("Line0");
    // Line0/Line1 are fixed-direction opto lines: no LineMode=Input write on
    // the trigger side.
    expect(writes).toEqual([
      "setTrigger=Line0",
      "LineSelector=Line1",
      "LineMode=Output",
      "LineSource=ExposureActive",
      "LineInverter:bool=true",
    ]);
  });

  it("refuses one line as both trigger and strobe", async () => {
    const { lease, raw } = makeFakeLease();
    await expect(
      enableHardwareTrigger(lease, { triggerSource: "Line2", lineSelector: "Line2" }),
    ).rejects.toThrow("both Line2");
    expect(raw.reconfigure).not.toHaveBeenCalled();
  });

  it("refuses a source missing from trigger_source_options, naming the offered list", async () => {
    const { lease, camera } = makeFakeLease({
      triggerSourceOptions: ["Line0", "Software"],
    });
    await expect(enableHardwareTrigger(lease)).rejects.toThrow(
      "TriggerSource 'Line3' not offered by this camera (options: Line0, Software)",
    );
    expect(camera.setTrigger).not.toHaveBeenCalled();
    expect(camera.setFeature).not.toHaveBeenCalled();
  });

  it("accepts a source the camera offers", async () => {
    const { lease, camera } = makeFakeLease({
      triggerSourceOptions: ["Line0", "Line2", "Line3", "Software"],
    });
    await enableHardwareTrigger(lease);
    expect(camera.setTrigger).toHaveBeenCalledWith("Line3");
  });

  it("propagates a feature-write failure (caller reverts + surfaces it)", async () => {
    const { lease, camera } = makeFakeLease();
    camera.setTrigger.mockImplementation(() => {
      throw new Error("TriggerMode not writable");
    });
    await expect(enableHardwareTrigger(lease)).rejects.toThrow(
      "TriggerMode not writable",
    );
  });
});

describe("enableSoftwareTrigger", () => {
  it("uses the Software source and still programs the Line2 strobe", async () => {
    const { lease, camera, writes } = makeFakeLease();
    await enableSoftwareTrigger(lease);
    expect(camera.setTrigger).toHaveBeenCalledWith("Software");
    // No line to force to Input for a software source.
    expect(writes).toEqual([
      "setTrigger=Software",
      "LineSelector=Line2",
      "LineMode=Output",
      "LineSource=ExposureActive",
      "LineInverter:bool=false",
    ]);
  });
});

describe("disableHardwareTrigger", () => {
  it("clears triggers through reconfigure (back to free-run)", async () => {
    const { lease, raw, camera } = makeFakeLease();
    await disableHardwareTrigger(lease);
    expect(raw.reconfigure).toHaveBeenCalledTimes(1);
    expect(camera.clearTriggers).toHaveBeenCalledTimes(1);
    expect(camera.setTrigger).not.toHaveBeenCalled();
  });
});

describe("readTriggerConfig", () => {
  it("snapshots LineInverter alongside the line config, per-node errors isolated", async () => {
    const { lease } = makeFakeLease();
    await enableHardwareTrigger(lease);
    const snap = readTriggerConfig(lease);
    expect(snap.LineSelector).toBe("Line2");
    expect(snap.LineSource).toBe("ExposureActive");
    expect(snap.LineInverter).toBe("false"); // via getFeatureBool, stringified
    // A node the fake never wrote reads as an error string, not a throw.
    expect(snap.TriggerActivation).toMatch(/^<error: /);
  });
});
