// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera hardware-trigger mode config (docs/spec/disparity-scope.md
// §trigger-sync): flips a leased camera between free-run and
// FrameStart-triggered capture. Pure over the `CameraLease` seam, so it
// unit-tests with a fake lease (camera-trigger.test.ts).

import type { CameraLease } from "./registry.js";

/** GenICam names for a lease's trigger input + strobe output — camera-model
 *  specific. Defaults follow the FLIR Blackfly S line map AND the V0.1
 *  controller board (docs/hardware/rig.md §Cameras, `firmware/include/Board.h`),
 *  which cables all four lines of every camera (C, L and R) 1:1 through
 *  `J_CAMn`:
 *
 *  - `triggerSource` = **Line3** (FLIR BFS: non-isolated INPUT-ONLY line,
 *    high 2.6..3.6 V, pin 1): the camera input the Teensy drives at 3.3 V
 *    (`Board::camera[n].trigger`). Line3 is also the camera's 8-24 V VAUX
 *    power input; never power a camera through its GPIO cable on this rig.
 *  - `lineSelector` = **Line2** (non-isolated bidirectional, pin 3): set as
 *    an ExposureActive output. The BFS Line2 output is OPEN DRAIN and, with
 *    `LineInverter=false`, is ON (pulls LOW) while idle and releases during
 *    exposure (bench 2026-10-22).
 *  - `lineInverter` = **true**: the line idles released (HIGH on the Teensy's
 *    INPUT_PULLUP pin, `Board::camera[n].strobe`) and pulls LOW while
 *    exposing, matching `Board::STROBE_ACTIVE_LEVEL = LOW`; an unplugged or
 *    unprogrammed line reads released and fails as a clean strobe timeout.
 *    `false` makes an idle line read as a permanent exposure ("line stuck at
 *    active level"). Bench 2026-10-22: 20/20 FINs, trigger→exposure 14–16 µs.
 *
 *  Bench fallback, the opto pair: `{ triggerSource: "Line0", lineSelector:
 *  "Line1" }`. Its `lineInverter` polarity is unmeasured; check it with
 *  `playground/trigger-bench.ts --lines Line0,Line1 --inverter <x>`. The
 *  firmware would also have to pulse the Line0 pins
 *  (`Board::camera[n].opto_trigger`), which the V0.1 build does not. Verify the names against
 *  `lease.camera.trigger_source_options` on a new camera model
 *  ({@link enableHardwareTrigger} checks it). */
export interface TriggerLines {
  triggerSource?: string;
  lineSelector?: string;
  lineInverter?: boolean;
}

/** FLIR BFS lines whose `LineMode` is writable: only Line2. Line0/Line1 are
 *  fixed-direction opto lines and Line3 is input-only, so a trigger on any of
 *  those needs no `LineMode=Input` write. */
const BIDIRECTIONAL_LINES: ReadonlySet<string> = new Set(["Line2"]);

/** What {@link enableHardwareTrigger} could not program, for the caller's
 *  diagnostics. `lineInverter` is the first error line of a failed
 *  `LineInverter` write (null = written). */
export type HardwareTriggerResult = { lineInverter: string | null };

/** `LineInverter` is a GenICam IBoolean. The native `setFeature` goes
 *  through `arv_camera_set_string`, which refuses non-string nodes
 *  ("[LineInverter:ArvGcBoolean] Not a ArvGcString"), so the write goes
 *  through the binding's `setFeatureBool` (`arv_camera_set_boolean`). The
 *  string path stays as a fallback for a camera object without it (an older
 *  addon build, or a test fake). */
function setBooleanFeature(
  camera: CameraLease["camera"],
  name: string,
  value: boolean,
): void {
  if (typeof camera.setFeatureBool === "function")
    camera.setFeatureBool(name, value);
  else camera.setFeature(name, value ? "true" : "false");
}

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];

/**
 * Switches `lease`'s camera into hardware-triggered mode and configures
 * `lineSelector` as an ExposureActive output (strobe) via the generic
 * feature accessors. The GenICam sequence, in order:
 *
 * 1. `LineSelector=<triggerSource>`, `LineMode=Input`, only when the
 *    trigger line is the bidirectional Line2, so a camera whose saved config
 *    left it as an output never drives against the Teensy's trigger pin.
 *    (The default Line3 is input-only on the BFS; nothing to force.)
 * 2. `setTrigger(triggerSource)`.
 * 3. `LineSelector=<lineSelector>`, `LineMode=Output`,
 *    `LineSource=ExposureActive`, `LineInverter=<lineInverter>`.
 *
 * `setTrigger` wraps `arv_camera_set_trigger(source)`, whose argument is the
 * trigger SOURCE — Aravis itself sets TriggerMode=On,
 * TriggerSelector=FrameStart, and TriggerActivation=RisingEdge. (Passing
 * "FrameStart" here fails with "[TriggerSource] 'FrameStart' not an entry".)
 * A source missing from `trigger_source_options` is refused up front with
 * the offered list. `LineInverter` is written through the binding's boolean
 * setter `setFeatureBool` (see {@link setBooleanFeature}); a failure of that
 * one write is still returned, not thrown (the engage diagnostics surface it;
 * the firmware then reports "line stuck at active level"). Runs through
 * `lease.reconfigure()` so shared-handle mutation stays on the lease's safe
 * path — pipe consumers ride the transient.
 */
export async function enableHardwareTrigger(
  lease: CameraLease,
  {
    triggerSource = "Line3",
    lineSelector = "Line2",
    lineInverter = true,
  }: TriggerLines = {},
): Promise<HardwareTriggerResult> {
  if (triggerSource === lineSelector)
    throw new Error(
      `trigger source and strobe line are both ${triggerSource}: one line cannot be input and output`,
    );
  const result: HardwareTriggerResult = { lineInverter: null };
  await lease.reconfigure(() => {
    const { camera } = lease;
    let offered: unknown;
    try {
      offered = camera.trigger_source_options;
    } catch {
      offered = undefined; // unreadable list: setTrigger is the judge
    }
    if (
      Array.isArray(offered) &&
      offered.length > 0 &&
      !offered.includes(triggerSource)
    )
      throw new Error(
        `TriggerSource '${triggerSource}' not offered by this camera (options: ${offered.join(", ")})`,
      );
    if (BIDIRECTIONAL_LINES.has(triggerSource)) {
      camera.setFeature("LineSelector", triggerSource);
      camera.setFeature("LineMode", "Input");
    }
    camera.setTrigger(triggerSource);
    camera.setFeature("LineSelector", lineSelector);
    camera.setFeature("LineMode", "Output");
    camera.setFeature("LineSource", "ExposureActive");
    try {
      setBooleanFeature(camera, "LineInverter", lineInverter);
    } catch (e) {
      result.lineInverter = firstLine(e);
    }
  });
  return result;
}

/**
 * Trigger self-test flip (manage-cameras §Trigger test): TriggerMode On with
 * `TriggerSource=Software` — the SAME machinery as {@link enableHardwareTrigger}
 * but fired by `camera.softwareTrigger()` instead of a hardware pulse. It
 * exercises the camera → convert-pipe frame path WITHOUT any trigger wiring,
 * so a self-test that flips here, fires software, and sees no frame indicts the
 * camera/stream path — not the trigger cabling (which the hardware leg tests next).
 * Restore with {@link disableHardwareTrigger}.
 */
export async function enableSoftwareTrigger(lease: CameraLease): Promise<void> {
  await enableHardwareTrigger(lease, { triggerSource: "Software" });
}

/** Reverts {@link enableHardwareTrigger} — back to free-run, matching every
 *  other (non-synced) camera. */
export async function disableHardwareTrigger(
  lease: CameraLease,
): Promise<void> {
  await lease.reconfigure(() => {
    lease.camera.clearTriggers();
  });
}

/** GenICam nodes whose live values name the trigger-sync freeze cause. */
const TRIGGER_CONFIG_FEATURES = [
  "TriggerMode",
  "TriggerSelector",
  "TriggerSource",
  "TriggerActivation",
  "LineSelector",
  "LineMode",
  "LineSource",
  "LineInverter", // IBoolean: read through getFeatureBool when available

  "ExposureMode",
  "ExposureAuto",
] as const;

/** Best-effort snapshot of a leased camera's trigger/strobe/exposure GenICam
 *  state for diagnostic spans — no reconfigure, reads only. Every node is read
 *  independently; a node the model lacks stores `<error: …>` for that key
 *  instead of failing the whole snapshot. */
export function readTriggerConfig(lease: CameraLease): Record<string, string> {
  const { camera } = lease;
  const out: Record<string, string> = {};
  const probe = (key: string, read: () => string): void => {
    try {
      out[key] = read();
    } catch (e) {
      const line = (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];
      out[key] = `<error: ${line}>`;
    }
  };
  for (const name of TRIGGER_CONFIG_FEATURES)
    probe(name, () =>
      name === "LineInverter" && typeof camera.getFeatureBool === "function"
        ? String(camera.getFeatureBool(name))
        : camera.getFeature(name),
    );
  probe("trigger_source", () => camera.trigger_source);
  probe("trigger_source_options", () => camera.trigger_source_options.join(", "));
  return out;
}
