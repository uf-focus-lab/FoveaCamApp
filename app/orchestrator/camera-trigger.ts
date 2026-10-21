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
 *  - `triggerSource` = **Line2** (non-isolated, bidirectional 3.3 V): the
 *    camera input the Teensy drives (`Board::camera[n].trigger`).
 *  - `lineSelector` = **Line3** (non-isolated, bidirectional 3.3 V): the
 *    camera drives ExposureActive into a Teensy INPUT_PULLUP pin
 *    (`Board::camera[n].strobe`). Line3 doubles as the camera's 8-24 V VAUX
 *    input; the Teensy never drives it, and the camera must never be set to
 *    put VAUX on it.
 *  - `lineInverter` = **false**: the firmware reads ExposureActive as
 *    active-HIGH (`Board::STROBE_ACTIVE_LEVEL`).
 *
 *  Bench fallback, the opto pair: `{ triggerSource: "Line0", lineSelector:
 *  "Line1" }`. Line1 is an open-collector opto output that can only pull
 *  LOW, so ExposureActive reads active-LOW at the Teensy. Using it needs
 *  either `lineInverter: true` (the line then idles LOW and the pull-up
 *  reads HIGH during exposure, matching `STROBE_ACTIVE_LEVEL`) or a firmware
 *  built with `Board::OPTO_STROBE_ACTIVE_LEVEL`. The V0.1 firmware pulses
 *  Line2, not Line0, so an opto trigger also needs a firmware that drives
 *  the opto pins. Verify the names against `lease.camera.trigger_source_options`
 *  on a new camera model ({@link enableHardwareTrigger} checks it). */
export interface TriggerLines {
  triggerSource?: string;
  lineSelector?: string;
  lineInverter?: boolean;
}

/** FLIR lines that are bidirectional (non-isolated), the only ones whose
 *  `LineMode` is writable; Line0/Line1 are fixed-direction opto lines. */
const BIDIRECTIONAL_LINES: ReadonlySet<string> = new Set(["Line2", "Line3"]);

/** What {@link enableHardwareTrigger} could not program, for the caller's
 *  diagnostics. `lineInverter` is the first error line of a failed
 *  `LineInverter` write (null = written). */
export type HardwareTriggerResult = { lineInverter: string | null };

type BooleanFeatureWriter = {
  setFeatureBool?: (name: string, value: boolean) => void;
};

/** `LineInverter` is a GenICam IBoolean. The native `setFeature` goes
 *  through `arv_camera_set_string`, which refuses non-string nodes
 *  ("[LineInverter:ArvGcBoolean] Not a ArvGcString"), so prefer a boolean
 *  writer when the binding has one and fall back to the string path. */
function setBooleanFeature(
  camera: CameraLease["camera"],
  name: string,
  value: boolean,
): void {
  const writer = (camera as unknown as BooleanFeatureWriter).setFeatureBool;
  if (typeof writer === "function") writer.call(camera, name, value);
  else camera.setFeature(name, value ? "true" : "false");
}

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];

/**
 * Switches `lease`'s camera into hardware-triggered mode and configures
 * `lineSelector` as an ExposureActive output (strobe) via the generic
 * feature accessors. The GenICam sequence, in order:
 *
 * 1. `LineSelector=<triggerSource>`, `LineMode=Input`, only for a
 *    bidirectional trigger line (Line2/Line3), so a camera whose saved
 *    config left that line as an output never drives against the Teensy's
 *    trigger pin.
 * 2. `setTrigger(triggerSource)`.
 * 3. `LineSelector=<lineSelector>`, `LineMode=Output`,
 *    `LineSource=ExposureActive`, `LineInverter=<lineInverter>`.
 *
 * `setTrigger` wraps `arv_camera_set_trigger(source)`, whose argument is the
 * trigger SOURCE — Aravis itself sets TriggerMode=On,
 * TriggerSelector=FrameStart, and TriggerActivation=RisingEdge. (Passing
 * "FrameStart" here fails with "[TriggerSource] 'FrameStart' not an entry".)
 * A source missing from `trigger_source_options` is refused up front with
 * the offered list. The `LineInverter` write is best-effort (see
 * {@link setBooleanFeature}): its failure is returned, not thrown, since the
 * camera default (`false`) is what the firmware expects. Runs through
 * `lease.reconfigure()` so shared-handle mutation stays on the lease's safe
 * path — pipe consumers ride the transient.
 */
export async function enableHardwareTrigger(
  lease: CameraLease,
  {
    triggerSource = "Line2",
    lineSelector = "Line3",
    lineInverter = false,
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
  // IBoolean: the string reader reports `<error: … Not a ArvGcString>` until
  // the binding grows a boolean getter.
  "LineInverter",
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
    probe(name, () => camera.getFeature(name));
  probe("trigger_source", () => camera.trigger_source);
  probe("trigger_source_options", () => camera.trigger_source_options.join(", "));
  return out;
}
