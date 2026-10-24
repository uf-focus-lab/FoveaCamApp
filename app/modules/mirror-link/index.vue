<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  MirrorLink — a thin client over the `mirror-link` session: drag the wide view
  to place the scan center (or its handle to turn the scan axis), converge with
  verge/shift (or Auto Vergence), and run the scan pattern set in the Scan
  Pattern pane — an ellipse or a triangle sweep whose exposure windows trigger
  the foveas. Renders frames, overlays telemetry, drives state; no core /
  camera / calibration access.
  Behavior spec: docs/spec/mirror-link.md.
-->
<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import type { Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { ROLE, THEME } from "@lib/camera-config";
import { useFrames, useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { getController } from "@src/components/Controller.vue";
import Capture from "@src/capture";
import Recording from "@src/record";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import Line2D from "@src/components/Line2D.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import { faArrowRotateLeft } from "@fortawesome/free-solid-svg-icons";
import SingleSelect, {
  type SingleSelectOption,
} from "@src/inputs/single-select.vue";
import Drawer from "@src/components/Drawer.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { distanceToVerge, vergeToDistance } from "@lib/stereo";
import {
  DEFAULT_VERGENCE_TUNING,
  VERGE_MIN_DISTANCE_MM,
  type Gains,
  type VergenceTuning,
} from "@lib/vergence/tuning";
import RingOverlay from "./RingOverlay.vue";
import RingHistogram from "./RingHistogram.vue";
import ScanPatternPane from "./ScanPatternPane.vue";
import {
  AXIS_HANDLE_DOT,
  axisHandleAt,
  hitsAxisHandle,
  polylinePath,
  scanCenterOf,
  ringGeometry,
  strokeFor,
} from "./overlay";
import { mirrorLink, type ScanTelemetry } from "./contract";
import { SCAN_HZ_RANGE, SHIFT_RANGE_DEG } from "./scan";

const session = useSession(mirrorLink, "mirror-link");
const { state, telemetry } = session;
const controller = computed(getController);

// Title-bar capture + record buttons (the facades register themselves on
// construction; capture opens the preview window with Cmd/Ctrl-S).
new Capture(session, "mirror-link");
new Recording(session, "mirror-link");

// The L/R views bind the RAW convert pipes — a frame integrating a scan window
// has no single mirror pose to warp against (spec §views) — or, while the
// triangle runs, the session's FLIP pipes over them, which turn the
// falling-sweep frame upright (spec §triangle-flip). The center view binds the
// intrinsic undistort pipe, raw fallback uncalibrated.
function foveaPipe(side: "L" | "R"): string | null {
  const flip = state.flipPipes?.[side];
  if (flip) return flip;
  const serial = state.serials?.[side];
  return serial ? nodeId.convert(serial) : null;
}
const frameL = usePipeFrame(() => foveaPipe("L"));
const frameR = usePipeFrame(() => foveaPipe("R"));
const frameC = usePipeFrame(
  () =>
    state.undistortPipe ??
    (state.serials?.C ? nodeId.convert(state.serials.C) : null),
);

// Overlay geometry comes from the wide payload itself — the session never
// publishes a frame size, the pipe already carries it.
const size = computed(() => ({
  width: frameC.value?.shape[1] ?? 0,
  height: frameC.value?.shape[0] ?? 0,
}));
const stroke = computed(() => strokeFor(frameC.value?.shape));

// --- steering + the axis handle (spec §targeting, §views) -------------------
// The StreamView cursor is already in wide FRAME px (the overlay's viewBox).
// The handle is DRAWN at least `AXIS_HANDLE_MIN_DIST` strokes out along the
// axis (`axisHandleAt` — it only sets a direction), and a press landing within
// `stroke · AXIS_HANDLE_HIT` of that drawn dot — but never that close to the
// center itself — starts an AXIS drag: every move then turns the main axis
// (`setAxis`) and steering is suppressed until release. Anywhere else the drag
// steers, as it always has.
// The spoke, the handle ray and the hit test are anchored on the PATH center
// (`scan_center_px`, the panned center the trajectory and `setAxis` use), not
// on `target`: the two differ while the vergence loop holds a pan. The
// crosshair stays at `target`.
// Both go out per cursor event, fire-and-forget, exactly alike — the session
// coalesces the trajectory re-upload (spec §actuation).
const cursor = shallowRef<(Rect & { buttons: number }) | null>(null);
const axisDrag = ref(false);
const scanCenter = computed(() =>
  scanCenterOf(telemetry.scan_center_px, telemetry.target),
);
watch(cursor, (c, prev) => {
  if (!c) {
    axisDrag.value = false;
    return;
  }
  // The FIRST event of a drag (null → point) is the press: classify it once.
  if (!prev)
    axisDrag.value = hitsAxisHandle(
      c,
      scanCenter.value,
      telemetry.axis_handle_px,
      stroke.value,
    );
  const px = { x: c.x, y: c.y };
  if (axisDrag.value) void session.call("setAxis", px);
  else void session.call("steer", px);
});
/** The DRAWN handle; null (hidden) on the {0,0} uncalibrated sentinel or a
 *  handle with no direction from the center. */
const handlePx = computed(() =>
  axisHandleAt(scanCenter.value, telemetry.axis_handle_px, stroke.value),
);
// Hover affordance: a grab cursor over the handle's hit zone.
const overHandle = ref(false);
function onHover(m: { x: number; y: number } | null): void {
  overHandle.value =
    m !== null &&
    hitsAxisHandle(m, scanCenter.value, telemetry.axis_handle_px, stroke.value);
}

const drawer_height = ref(0);
const distance = computed(() => vergeToDistance(state.verge, state.baseline));
const plusSign = (v: string) => (v.startsWith("-") ? v : "+" + v);
const ms = (us: number) => (us / 1000).toFixed(1);

// --- gain (spec §gain) ------------------------------------------------------
// `state.gain` is null until the session seeds it from the leased cameras, and
// a carried-over value may sit outside a new pair's range — so the proxy CLAMPS
// on read (an out-of-range value would paint the cursor past the track) and
// refuses writes while disabled (RangeSlider only checks `disabled` at
// mousedown, so a lease drop mid-drag would otherwise persist range-min).
const gainDisabled = computed(
  () =>
    !telemetry.ready ||
    telemetry.gain_range.min === telemetry.gain_range.max ||
    state.gain === null,
);
const gain = computed<number>({
  get: () => {
    const { min, max } = telemetry.gain_range;
    return Math.min(Math.max(state.gain ?? min, min), max);
  },
  set: (v) => {
    if (!gainDisabled.value) state.gain = v;
  },
});
const gainTitle = computed(() =>
  gainDisabled.value
    ? "Waiting for both foveas to report a shared gain range."
    : "Sensor gain applied to BOTH foveas while MirrorLink is open; Manage Cameras' gain is restored on exit. " +
      "No right-click reset: that would slam a live camera to minimum gain.",
);

// --- scan (spec §lifecycle, §scan-patterns) ---------------------------------
const scanning = computed(() => telemetry.scan !== null);
/** The base period T in ms, unrounded (readouts format it themselves). */
const periodMs = computed(
  () => 1000 / Math.max(state.scan_hz, SCAN_HZ_RANGE.min),
);

/** One exposure window as `start–end` (ms) within the trajectory period. */
const windowText = (w: { t_offset_us: number; pulse_us: number }) =>
  `${ms(w.t_offset_us)}–${ms(w.t_offset_us + w.pulse_us)}`;

/** One eye's flip skew — "—" until a frame of that eye matched a marker (a
 *  0 µs skew would otherwise read as a perfect match). */
const skewText = (flipped: number, us: number) =>
  flipped > 0 ? `${us.toFixed(0)} µs` : "—";

/** The MCU run's bookkeeping, for the status hover (spec §actuation). */
const trajectoryDetail = computed(() => {
  const p = telemetry.perf.trajectory;
  const n = p.pushes;
  let s =
    `Marker pushes: ${n.ok} ok · ${n.timeout} timeout · ${n.busy} busy · ${n.other} other; ` +
    `last lateness ${p.lateness_us.toFixed(0)} µs; ${p.reuploads} live re-uploads` +
    (p.last_swap
      ? ` (last swap ${p.last_swap === "atomic" ? "atomic" : "stop + start"})`
      : "");
  if (telemetry.scan?.mode === "triangle")
    s +=
      `; flipped L ${p.flipped.L} · R ${p.flipped.R}, ` +
      `unmatched L ${p.unmatched.L} · R ${p.unmatched.R}, ` +
      `skew L ${skewText(p.flipped.L, p.skew_us.L)} · R ${skewText(p.flipped.R, p.skew_us.R)} ` +
      `(tolerance ${p.flip_tolerance_us.toFixed(0)} µs)`;
  return s + ".";
});

/** One eye's applied exposure for the scan hovers (spec §views): on
 *  TriggerWidth the trigger pulse IS the exposure (the window's length) — the
 *  scan's mode, or an eye whose `exposure_us` is the contract's TriggerWidth
 *  0 — and Timed prints the applied ms. */
const eyeExposure = (t: ScanTelemetry, side: "L" | "R") =>
  t.exposure_mode === "TriggerWidth" || t.exposure_us[side] === 0
    ? "exposure = trigger pulse"
    : `exposure ${ms(t.exposure_us[side])} ms`;

const scanStatus = computed<{ text: string; tone: string; title: string }>(
  () => {
    const t = telemetry.scan;
    if (t) {
      const timed = t.exposure_mode === "Timed";
      const text =
        `${t.mode} · ${t.hz.toFixed(1)} Hz · ${ms(t.period_us)} ms · ` +
        `${t.windows.map(windowText).join(" + ")} ms` +
        (timed ? " · timed" : "");
      const traj = telemetry.perf.trajectory;
      const p = traj.pushes;
      const failed = p.timeout + p.busy + p.other;
      // `stalled` = no OK push for two periods (a cable coming loose after N
      // good exposures); a run that never answered says so instead.
      const stall = traj.stalled
        ? p.ok > 0
          ? "No exposure has completed for two scan periods — the cameras stopped answering the trigger. "
          : "No exposure has completed this run — the cameras are not answering the trigger. "
        : "";
      if (t.mismatch)
        return {
          text,
          tone: "warn",
          // A neutral lead-in for every reason: not all are camera limits
          // (the flip-spacing one is the windows' own geometry).
          title:
            "Exposure mismatch — " +
            (t.mismatch_reason
              ? t.mismatch_reason.replace(/\.\s*$/, "")
              : `the cameras cannot take the requested ${t.mode === "triangle" ? "windows" : "window"}`) +
            (timed
              ? " (Timed fallback: no TriggerWidth exposure on this model)"
              : "") +
            ". " +
            `Applied: L ${eyeExposure(t, "L")} · R ${eyeExposure(t, "R")}; ` +
            `max frame rate L ${t.frame_rate.L.toFixed(1)} Hz · R ${t.frame_rate.R.toFixed(1)} Hz. ` +
            stall +
            trajectoryDetail.value,
        };
      // Amber also mid-run (stalled), not only when none ever succeeded.
      if (traj.stalled || (p.ok === 0 && failed > 0))
        return {
          text,
          tone: "warn",
          title:
            (stall ||
              "No exposure has completed this run — the cameras are not answering the trigger. ") +
            trajectoryDetail.value,
        };
      return {
        text,
        tone: "ok",
        title:
          (timed
            ? `Timed fallback, per trigger: L ${eyeExposure(t, "L")} · R ${eyeExposure(t, "R")}. `
            : "Each trigger pulse is the exposure: every fovea frame covers exactly its window of the path. ") +
          trajectoryDetail.value,
      };
    }
    // A latched block (spec §lifecycle): a Start refusal or a scan stopped
    // under the operator — never re-evaluated, so the hover says how to.
    const reason = telemetry.scan_blocked;
    const stopped = telemetry.scan_blocked_kind === "stopped";
    const triangle = state.scan_mode === "triangle";
    const period = (periodMs.value * (triangle ? 2 : 1)).toFixed(1);
    if (reason)
      return {
        text: stopped ? "idle — stopped" : "idle — refused",
        tone: "warn",
        title: `${reason.replace(/\.\s*$/, "")}. Press Start to re-check.`,
      };
    return {
      text: "idle",
      tone: "muted",
      title:
        `Start the ${state.scan_mode} scan: the controller runs it and triggers both foveas ` +
        `${triangle ? "twice" : "once"} per ${period} ms period. Manage Cameras' settings are restored on stop.`,
    };
  },
);

// The commanded path in volt space, closed back onto its first point for the
// ellipse so the PosView polyline reads as a loop; the line and the triangle
// stay open (spec §views). Whether to close comes from the session WITH the
// path (`scan_path_closed`), so a mode/ratio write in flight never pairs the
// old path with the new rule. Empty stays empty.
const closedPath = computed(() => telemetry.scan_path_closed);
const closeIf = (path: readonly Pos[]): Pos[] =>
  closedPath.value && path.length > 1 ? [...path, path[0]] : [...path];
const scanPath = computed(() => ({
  L: closeIf(telemetry.scan_path.L),
  R: closeIf(telemetry.scan_path.R),
}));

// The same path and its exposed windows in wide px, for the center view.
const pathD = computed(() =>
  polylinePath(telemetry.scan_path_px, closedPath.value),
);
const windowDs = computed(() =>
  telemetry.scan_window_px.map((w) => polylinePath(w, false)),
);

// The button label stays telemetry-truthful (`scanning`); `busy` only disables
// it while a start/stop round-trip is in flight.
const busy = ref(false);
async function toggleScan(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (scanning.value) await session.call("stopScan", undefined);
    else await session.call("startScan", undefined);
  } finally {
    busy.value = false;
  }
}

// Chromium suppresses hover on a DISABLED button, so the explanation rides the
// ROW instead.
const scanHint = computed(() => {
  if (!telemetry.ready) return "Waiting for the camera triple to be leased.";
  return scanning.value
    ? "Stop the scan and restore both fovea cameras' trigger and exposure settings."
    : "Start the scan pattern and trigger both fovea cameras at its exposure windows.";
});
// --- auto vergence (spec §targeting) ----------------------------------------
// The SAME fovea-into-wide template-match loop Disparity Scope runs: engage it
// and the two foveas converge on whatever the wide view is aimed at, driving
// Verge Distance + Vertical Shift as they go.
const engaged = computed(() => state.auto_vergence);
const verging = ref(false);
async function toggleVergence(): Promise<void> {
  if (verging.value) return;
  verging.value = true;
  try {
    if (engaged.value) await session.call("stopVergence", undefined);
    else await session.call("startVergence", undefined);
  } finally {
    verging.value = false;
  }
}
// A Verge/Shift slider is under the pointer: the loop's 10 Hz write-back must
// not yank a fully-controlled knob mid-drag (spec §targeting). RangeSlider
// tracks the drag on a WINDOW listener and never captures the pointer, so the
// release can land anywhere on screen — listen for it where it will arrive.
let dofHeld = false;
function releaseDof(): void {
  if (!dofHeld) return;
  dofHeld = false;
  window.removeEventListener("pointerup", releaseDof);
  window.removeEventListener("pointercancel", releaseDof);
  void session.call("holdDof", false);
}
function holdDof(): void {
  if (dofHeld) return;
  dofHeld = true;
  window.addEventListener("pointerup", releaseDof);
  window.addEventListener("pointercancel", releaseDof);
  void session.call("holdDof", true);
}
onUnmounted(releaseDof);
/** While the loop drives them, the two DOF sliders read as loop-owned — never
 *  disabled: a drag hands the loop a new starting point. */
const dofSliderColor = computed(() =>
  engaged.value ? "var(--accent-bright)" : "currentColor",
);
const DOF_SLIDER_TITLE =
  "Auto Vergence drives this; drag to hand it a new starting point — " +
  "the loop carries on from there.";

const vergenceHint = computed(() =>
  !telemetry.ready
    ? "Waiting for the camera triple to be leased."
    : engaged.value
      ? "Stop the loop — the mirrors hold the verge and shift it reached."
      : "Converge both foveas on the wide view's target by matching each fovea " +
        "into the wide frame, driving Verge Distance and Vertical Shift.",
);

const vergenceStatus = computed<{ text: string; tone: string; title: string }>(
  () => {
    const text = telemetry.vergence_status;
    const reason = telemetry.vergence_blocked;
    if (!engaged.value)
      return reason
        ? { text: "off — refused", tone: "warn", title: reason }
        : { text: "off", tone: "muted", title: vergenceHint.value };
    const score = (m: { score: number } | null): string =>
      m ? m.score.toFixed(2) : "—";
    const scores = `L ${score(telemetry.match_left)} · R ${score(telemetry.match_right)}`;
    const min = `(min ${state.tuning.min_score.toFixed(2)})`;
    if (text === "tracking")
      return { text, tone: "ok", title: `Match confidence ${scores} ${min}.` };
    if (text === "paused: scanning")
      return {
        text,
        // Its own tone: a deliberate, expected pause — not a fault, not "off".
        tone: "ok dim",
        title:
          "Held while the scan runs: each fovea frame is the scanned PATH, not the patch the " +
          "match needs. Stop the scan to converge, then start it again.",
      };
    if (text === "no calibration")
      return {
        text,
        tone: "warn",
        title:
          "The wide camera has no undistort calibration, so the loop has no " +
          "pixel→angle map to steer with. Calibrate it first.",
      };
    return {
      text,
      tone: "warn",
      title: `${text} — match confidence ${scores} ${min}.`,
    };
  },
);

// --- the shared vergence tuning block (identical to Disparity Scope) ---------
type GainKey = "pan" | "depth" | "v_shift";
function setTuning<K extends keyof VergenceTuning>(
  key: K,
  value: VergenceTuning[K],
): void {
  state.tuning = { ...state.tuning, [key]: value };
}
function gainRef(key: GainKey, idx: 0 | 1 | 2) {
  return computed<number>({
    get: () => state.tuning[key][idx],
    set: (v) => {
      const next = [...state.tuning[key]] as Gains;
      next[idx] = v;
      setTuning(key, next);
    },
  });
}
function resetGain(key: GainKey): void {
  setTuning(key, [...DEFAULT_VERGENCE_TUNING[key]] as Gains);
}
const gainGroups = [
  {
    key: "pan" as const,
    title: "Pan PID",
    hint: "Common-mode aim: how the PAIR is centred on the wide-view target.",
    range: [0, 1] as const,
    step: 0.01,
  },
  {
    key: "depth" as const,
    title: "Depth PID",
    hint: "Convergence distance: nulls the horizontal disparity between the foveas.",
    range: [0, 10] as const,
    step: 0.02,
  },
  {
    key: "v_shift" as const,
    title: "Vertical PID",
    hint: "Vertical toe: nulls the residual vertical disparity between the foveas.",
    range: [0, 1] as const,
    step: 0.01,
  },
].map((g) => ({
  ...g,
  terms: [gainRef(g.key, 0), gainRef(g.key, 1), gainRef(g.key, 2)] as const,
}));
/** kp / ki / kd, in order — one label + hover per term, across all three
 *  groups (the Disparity Scope block's shape). */
const GAIN_LABELS = ["Kp", "Ki", "Kd"] as const;
const GAIN_TITLES = [
  "Proportional gain: how much of the measured error this DOF corrects each step.",
  "Integral gain: removes the steady-state offset the proportional term leaves behind.",
  "Derivative gain: damps overshoot; leave at 0 unless the loop rings.",
] as const;
const minScore = computed<number>({
  get: () => state.tuning.min_score,
  set: (v) => setTuning("min_score", v),
});
/** The matched fovea centres in ABSOLUTE wide px, one marker per side that
 *  reported a match this activation. */
const matchMarkers = computed(() =>
  (
    [
      { side: "L" as const, m: telemetry.match_left, color: THEME.L },
      { side: "R" as const, m: telemetry.match_right, color: THEME.R },
    ] as const
  )
    .filter((e) => e.m !== null)
    .map((e) => ({
      side: e.side,
      color: e.color,
      x: e.m!.rect.x + e.m!.rect.width / 2,
      y: e.m!.rect.y + e.m!.rect.height / 2,
    })),
);

/** The verge slider's near end IS the controller's saturation limit. */
const vergeLimit = computed(() =>
  distanceToVerge(VERGE_MIN_DISTANCE_MM, state.baseline),
);

// --- ring histogram views (spec §ring-views) --------------------------------
const RING_VIEW_OPTIONS: readonly SingleSelectOption<
  "off" | "polar" | "binary" | "segments"
>[] = [
  { value: "off", label: "Off" },
  { value: "polar", label: "Polar" },
  { value: "binary", label: "Binary" },
  { value: "segments", label: "Segments" },
];
const { "ring-L": stripL, "ring-R": stripR } = useFrames(session, [
  "ring-L",
  "ring-R",
]);
const ringViewOn = computed(
  () => state.ring_reader && state.ring_view !== "off",
);
const RING_VIEW_TITLE =
  "What the decoder sees, per eye: the polar image of the annulus, the " +
  "normalized ring with its threshold, or the decoded frame boundaries. " +
  "Needs the Ring Reader on; Off stops the worker building them.";
const ringStage = computed(() =>
  state.ring_view === "off"
    ? ("polar" as const)
    : (state.ring_view as "polar" | "binary" | "segments"),
);

// --- ring reader (spec §reader) ---------------------------------------------
// An OPTIONAL node, default off — the session builds/disposes it on this state.
// SingleSelect over a string proxy is the house idiom for a boolean drawer
// control (manual-control's Capture Mode).
const RING_OPTIONS: readonly SingleSelectOption<"off" | "on">[] = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
];
const ringReader = computed<"off" | "on">({
  get: () => (state.ring_reader ? "on" : "off"),
  set: (v) => (state.ring_reader = v === "on"),
});
const RING_TITLE =
  "Decode the blinking emitter's message from the ring in each fovea frame. " +
  "Runs only while the scan is active, and costs a worker thread reading every fovea frame.";

// Annotations are drawn in FOVEA FRAME px. The stroke scalar is hoisted per eye
// so a new frame with unchanged dims does NOT invalidate the geometry: the
// overlay then recomputes only when the readout itself changes.
const sL = computed(() => strokeFor(frameL.value?.shape));
const sR = computed(() => strokeFor(frameR.value?.shape));

/** Annotations assert a decode of the CURRENT frame — they are meaningless
 *  with the reader off or the scan stopped (the session also clears the
 *  readouts; this is the renderer-side belt). */
const ringActive = computed(() => state.ring_reader && telemetry.scan !== null);

const ringL = computed(() =>
  ringGeometry(ringActive.value ? telemetry.ring.L : null, sL.value),
);
const ringR = computed(() =>
  ringGeometry(ringActive.value ? telemetry.ring.R : null, sR.value),
);

const ellipsis = (t: string) => (t.length > 12 ? t.slice(0, 12) + "…" : t);
// The kernel samples θ = 2πi/N with y DOWN (image coords), so a rising sample
// index runs CLOCKWISE on screen.
const directionOf = (reverse: boolean | undefined) =>
  reverse ? "counter-clockwise" : "clockwise";

/** The compact row under each fovea view: the decode, or why it dropped. */
function ringStatus(side: "L" | "R"): {
  text: string;
  tone: string;
  title: string;
} {
  // Mounted only while the reader is on (no `off` branch); the strip's
  // caption uses the same `idle` / `reading…` (spec §views).
  const r = ringActive.value ? telemetry.ring[side] : null;
  if (!r)
    return {
      text: scanning.value ? "reading…" : "idle",
      tone: "muted",
      title: scanning.value
        ? "Waiting for the first fovea frame of the scan."
        : "The ring reader decodes only while the scan is running.",
    };
  if (r.ok) {
    const text = r.text ?? "";
    const chip =
      r.chipPx === undefined ? "" : ` · ${r.chipPx.toFixed(1)} px/chip`;
    return {
      text: `${text}${chip}`,
      tone: "ok",
      title: `"${text}" · ${r.hex ?? ""} · read ${directionOf(r.reverse)}`,
    };
  }
  // A failure names WHERE it gave up when the read got that far — the bit index
  // is the offline-debugging hook (spec ring-code.md §reader).
  const at = r.bitIndex === undefined ? "" : ` @ bit ${r.bitIndex}`;
  const last = r.last ? ` · last ${ellipsis(r.last.text)}` : "";
  const detail = [
    r.contrast === undefined
      ? null
      : `contrast ${r.contrast.toFixed(2)} (needs 0.15)`,
    r.chipPx === undefined ? null : `${r.chipPx.toFixed(1)} px/chip`,
    r.ridgePx === undefined
      ? null
      : `path ${r.ridgePx.toFixed(1)} px off the fitted circle`,
    r.last ? `last decode "${r.last.text}" · ${r.last.hex}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    text: `${r.reason}${at}${last}`,
    tone: r.last ? "muted" : "warn",
    title: detail || "No frame has decoded on this eye yet.",
  };
}
const statusL = computed(() => ringStatus("L"));
const statusR = computed(() => ringStatus("R"));
</script>

<template>
  <div
    class="cameras"
    :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.L"
        :payload="frameL"
        :theme="THEME.L"
      >
        <RingOverlay v-if="state.ring_reader" :view="ringL" :color="THEME.L" />
      </StreamView>
      <div
        v-if="state.ring_reader"
        class="ring-row"
        :class="statusL.tone"
        :title="statusL.title"
      >
        {{ statusL.text }}
      </div>
      <PosView
        :pos="telemetry.volt.L"
        :lim="controller?.dv ?? 200"
        :color="THEME.L"
        style="width: 100%"
      >
        <!-- The commanded scan path in volt space (closed for the ellipse,
             open otherwise); the crosshair marks its CENTER (spec §views). An
             empty path draws nothing. -->
        <Line2D
          :data="scanPath.L"
          :color="THEME.L"
          :marker="null"
          :line-width="(controller?.dv ?? 200) * 0.012"
          :style="{ opacity: scanning ? 1 : 0.7 }"
        />
      </PosView>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.C"
        :payload="frameC"
        :theme="THEME.C"
        :class="{ 'axis-grab': overHandle, 'axis-drag': axisDrag }"
        v-model="cursor"
        @mouse="onHover"
      >
        <!-- Scan path: dashed + faint while idle (a preview), solid while
             active; closed for the ellipse, open for the line and the
             triangle. The EXPOSED windows ride on top, emphasized — thicker,
             full opacity — and dashed with it while idle (spec §views). Empty
             uncalibrated. -->
        <path
          v-if="pathD"
          :d="pathD"
          fill="none"
          :stroke="THEME.C"
          :stroke-width="stroke"
          stroke-linejoin="round"
          :stroke-dasharray="scanning ? undefined : stroke * 4"
          :opacity="scanning ? 0.6 : 0.4"
        />
        <path
          v-for="(d, i) in windowDs"
          :key="'w' + i"
          :d="d"
          fill="none"
          :stroke="THEME.C"
          :stroke-width="stroke * 2"
          stroke-linejoin="round"
          :stroke-dasharray="scanning ? undefined : stroke * 4"
        />
        <!-- The main-axis handle: a spoke from the scan center
             (`scan_center_px`, not the crosshair) out along the axis
             direction and a dot at its end — at the +amp end, or further out
             when the amplitude is small (`axisHandleAt`: it only sets the
             direction); press within its hit zone and drag to turn the axis
             (spec §views). Hidden uncalibrated ({0,0}). -->
        <g v-if="handlePx" :opacity="overHandle || axisDrag ? 1 : 0.75">
          <line
            :x1="scanCenter.x"
            :y1="scanCenter.y"
            :x2="handlePx.x"
            :y2="handlePx.y"
            :stroke="THEME.C"
            :stroke-width="stroke"
          />
          <circle
            :cx="handlePx.x"
            :cy="handlePx.y"
            :r="stroke * AXIS_HANDLE_DOT * (axisDrag ? 1.3 : 1)"
            :fill="THEME.C"
          />
        </g>
        <!-- Where each fovea is AIMED (the offset-free center pose, shift
             included) — hidden uncalibrated. -->
        <template v-if="state.undistortPipe">
          <circle
            :cx="telemetry.L_PX.x"
            :cy="telemetry.L_PX.y"
            :r="stroke * 2.5"
            fill="none"
            :stroke="THEME.L"
            :stroke-width="stroke"
          />
          <circle
            :cx="telemetry.R_PX.x"
            :cy="telemetry.R_PX.y"
            :r="stroke * 2.5"
            fill="none"
            :stroke="THEME.R"
            :stroke-width="stroke"
          />
        </template>
        <!-- Where each fovea was MATCHED into the wide view while the loop runs
             (spec §targeting): a `hold: match low score` still shows what it
             found, so a wrong lock is visible instead of inferred. -->
        <template v-if="engaged">
          <circle
            v-for="m in matchMarkers"
            :key="m.side"
            :cx="m.x"
            :cy="m.y"
            :r="stroke * 1.5"
            fill="none"
            :stroke="m.color"
            :stroke-width="stroke"
            :stroke-dasharray="stroke * 2"
          />
        </template>
        <FrameCursor
          :cursor="{
            ...telemetry.target,
            width: size.width,
            height: size.height,
          }"
          :angle="telemetry.target_angle"
          box="dot"
          :color="THEME.C"
        />
      </StreamView>
      <!-- A plain row, NOT a ConfigEntry: that renders a <label>, which would
           forward a click on the status text to the button and toggle a
           hardware exposure override. -->
      <div class="scan-row" :title="scanHint">
        <button
          class="scan-button"
          :class="{ on: scanning, busy }"
          :disabled="!telemetry.ready || busy || verging"
          @click="toggleScan"
        >
          {{ scanning ? "Stop Scan" : "Start Scan" }}
        </button>
        <span
          class="scan-status"
          :class="scanStatus.tone"
          :title="scanStatus.title"
        >
          {{ scanStatus.text }}
        </span>
      </div>
      <!-- The decoder's own views (spec §ring-views) fill the center column's
           tail — it is shorter than L/R by their PosViews — so both eyes' rings
           sit under the wide tile they came from. -->
      <div class="ring-views">
        <!-- The title rides the ROW: a disabled option suppresses hover. -->
        <div class="toggle-row" :title="RING_VIEW_TITLE">
          <span>Ring View</span>
          <SingleSelect
            v-model="state.ring_view"
            :options="RING_VIEW_OPTIONS"
            :disabled="!state.ring_reader"
            class="ring-stage"
            aria-label="Ring histogram stage"
          />
        </div>
        <template v-if="ringViewOn">
          <RingHistogram
            :title="ROLE.L"
            :color="THEME.L"
            :stage="ringStage"
            :payload="stripL.payload.value"
            :readout="telemetry.ring.L"
            :scanning="scanning"
          />
          <RingHistogram
            :title="ROLE.R"
            :color="THEME.R"
            :stage="ringStage"
            :payload="stripR.payload.value"
            :readout="telemetry.ring.R"
            :scanning="scanning"
          />
        </template>
      </div>
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.R"
        :payload="frameR"
        :theme="THEME.R"
      >
        <RingOverlay v-if="state.ring_reader" :view="ringR" :color="THEME.R" />
      </StreamView>
      <div
        v-if="state.ring_reader"
        class="ring-row"
        :class="statusR.tone"
        :title="statusR.title"
      >
        {{ statusR.text }}
      </div>
      <PosView
        :pos="telemetry.volt.R"
        :lim="controller?.dv ?? 200"
        :color="THEME.R"
        style="width: 100%"
      >
        <!-- The commanded scan path in volt space (closed for the ellipse,
             open otherwise); the crosshair marks its CENTER (spec §views). An
             empty path draws nothing. -->
        <Line2D
          :data="scanPath.R"
          :color="THEME.R"
          :marker="null"
          :line-width="(controller?.dv ?? 200) * 0.012"
          :style="{ opacity: scanning ? 1 : 0.7 }"
        />
      </PosView>
    </div>
  </div>
  <Drawer v-model="drawer_height">
    <!-- FOUR columns (spec §views): mirror controls · the vergence loop (its
         toggle + status, then the shared tuning block) · the Scan Pattern
         pane · gain / scan frequency / ring reader / status. The ring views
         live under the center tile, not here. Nested splits rather than a new
         layout component, ≈ 0.20 / 0.23 / 0.27 / 0.30 of the drawer: the two
         right columns carry the longest strings (the window readouts, the
         frequency readout and the status line). -->
    <HorizontalDivision
      :division="0.2"
      class="fill"
      :min-width-left="0.15"
      :min-width-right="0.6"
    >
      <template #left>
        <div class="options fill">
          <!-- Both DOF sliders belong to the vergence loop while it runs: the
               pointer takes the write-back offline for the length of the drag
               (`holdDof`) and hands the loop the final value on release. -->
          <div @pointerdown="holdDof">
            <RangeSlider
              v-model="state.verge"
              :title="`Depth both foveas converge on — far end is ∞ (parallel gaze). ${DOF_SLIDER_TITLE} Right-click resets to neutral.`"
              :min="vergeLimit"
              :max="0"
              :neutral="0"
              :step="0.01"
              :color="dofSliderColor"
            >
              <span>Verge Distance</span>
              <span>
                <template v-if="distance !== Infinity">
                  {{ (distance / 1000).toFixed(4) }}m
                </template>
                <template v-else> &#x221E; </template>
              </span>
            </RangeSlider>
            <RangeSlider
              v-model="state.shift"
              :title="`Vertical toe between the foveas: raises the LEFT eye and lowers the RIGHT by this much. ${DOF_SLIDER_TITLE} Right-click resets to neutral.`"
              :min="SHIFT_RANGE_DEG.min"
              :max="SHIFT_RANGE_DEG.max"
              :neutral="0"
              :step="0.01"
              :color="dofSliderColor"
            >
              <span>Vertical Shift</span>
              <span>{{ plusSign(state.shift.toFixed(2)) }}&deg;</span>
            </RangeSlider>
          </div>
        </div>
      </template>
      <template #right>
        <!-- Nested split: the vergence column, then the two scan columns. -->
        <HorizontalDivision
          :division="0.29"
          class="fill"
          :min-width-left="0.2"
          :min-width-right="0.5"
        >
          <template #left>
            <div class="options fill">
              <!-- The loop toggle + its status FIRST: the thing you press and
                   the thing you read, above the knobs that tune them. -->
              <div class="vergence-row" :title="vergenceHint">
                <button
                  class="vergence-button"
                  :class="{ on: engaged, busy: verging }"
                  :disabled="!telemetry.ready || verging"
                  @click="toggleVergence"
                >
                  {{ engaged ? "Stop Vergence" : "Auto Vergence" }}
                </button>
                <span
                  class="vergence-status"
                  :class="vergenceStatus.tone"
                  :title="vergenceStatus.title"
                >
                  {{ vergenceStatus.text }}
                </span>
              </div>
              <!-- The shared vergence tuning block — the same groups, keys,
                   defaults, ranges and hovers as Disparity Scope's. -->
              <template v-for="g in gainGroups" :key="g.key">
                <h4 :title="g.hint">
                  <span>{{ g.title }}</span>
                  <button
                    class="reset"
                    title="Reset to defaults"
                    @click="resetGain(g.key)"
                  >
                    <Icon :icon="faArrowRotateLeft" />
                  </button>
                </h4>
                <RangeSlider
                  v-for="(term, i) in g.terms"
                  :key="i"
                  v-model="term.value"
                  :title="GAIN_TITLES[i]"
                  :min="g.range[0]"
                  :max="g.range[1]"
                  :neutral="DEFAULT_VERGENCE_TUNING[g.key][i]"
                  :step="g.step"
                >
                  <span>{{ GAIN_LABELS[i] }}</span>
                  <span>{{ term.value.toFixed(2) }}</span>
                </RangeSlider>
              </template>
              <RangeSlider
                v-model="minScore"
                title="Minimum match confidence the loop will steer on — below it the mirrors hold."
                :min="0"
                :max="1"
                :neutral="DEFAULT_VERGENCE_TUNING.min_score"
                :step="0.01"
              >
                <span>Min Match Score</span>
                <span>{{ minScore.toFixed(2) }}</span>
              </RangeSlider>
            </div>
          </template>
          <template #right>
            <!-- Innermost split: the Scan Pattern pane, then gain / frequency
                 / ring reader / status. -->
            <HorizontalDivision
              :division="0.47"
              class="fill"
              :min-width-left="0.35"
              :min-width-right="0.35"
            >
              <template #left>
                <ScanPatternPane
                  :state="state"
                  :timed="telemetry.scan?.exposure_mode === 'Timed'"
                />
              </template>
              <template #right>
                <div class="options fill">
                  <!-- Gain leads the column: it is SESSION-wide, not
                       scan-scoped (spec §gain). No `neutral` — a stray
                       right-click must never slam a LIVE camera to range-min. -->
                  <RangeSlider
                    v-model="gain"
                    :title="gainTitle"
                    :min="telemetry.gain_range.min"
                    :max="telemetry.gain_range.max"
                    :step="0.1"
                    :disabled="gainDisabled"
                  >
                    <span>Gain</span>
                    <span>{{
                      gainDisabled ? "—" : gain.toFixed(1) + " dB"
                    }}</span>
                  </RangeSlider>
                  <!-- The BASE period both patterns share (spec
                       §scan-patterns): one ellipse revolution, one triangle
                       sweep. -->
                  <RangeSlider
                    v-model="state.scan_hz"
                    title="Base scan frequency: one ellipse revolution or one triangle sweep per period — the triangle's full period is twice this. Right-click resets to neutral."
                    :min="SCAN_HZ_RANGE.min"
                    :max="SCAN_HZ_RANGE.max"
                    :neutral="10"
                    :step="0.5"
                  >
                    <span>Scan Frequency</span>
                    <span
                      >{{ state.scan_hz.toFixed(1) }} Hz &middot;
                      {{ periodMs.toFixed(1) }} ms</span
                    >
                  </RangeSlider>
                  <div class="toggle-row" :title="RING_TITLE">
                    <span>Ring Reader</span>
                    <SingleSelect
                      v-model="ringReader"
                      :options="RING_OPTIONS"
                      :disabled="!telemetry.ready"
                      class="ring-toggle"
                      aria-label="Ring reader"
                    />
                  </div>
                  <div class="status-row">
                    <span>Status</span>
                    <span
                      class="scan-status"
                      :class="scanStatus.tone"
                      :title="scanStatus.title"
                    >
                      {{ scanStatus.text }}
                    </span>
                  </div>
                </div>
              </template>
            </HorizontalDivision>
          </template>
        </HorizontalDivision>
      </template>
    </HorizontalDivision>
  </Drawer>
</template>

<style scoped lang="scss">
.cameras {
  position: relative;
  display: flex;
  justify-content: space-evenly;
  align-items: flex-start;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
  --p: 0;
  padding: 1em 0 calc(1em + var(--p)) 0;
  margin: 0;

  & > * {
    width: 30vw;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
  }

  .stream {
    width: 30vw;
    height: 22.5vw;
  }

  // The axis handle's affordance on the center view (spec §views): the grab
  // cursor over its hit zone, grabbing for the length of an axis drag.
  .stream.axis-grab :deep(canvas) {
    cursor: grab;
  }
  .stream.axis-drag :deep(canvas) {
    cursor: grabbing;
  }
}

.fill {
  width: 100%;
  height: 100%;
}

// The decoder's views under the wide tile: a segmented stage row, then the two
// strips at the tile's own width (4:1 → 7.5vw each, so the column still ends
// well short of L/R's PosViews).
.ring-views {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.4em;

  .ring-stage {
    flex: 1;
    flex-direction: row;
    gap: 0.25em;

    :deep(.option) {
      width: auto;
      flex: 1;
      align-items: center;
      text-align: center;
      padding: 0.1em 0.4em;
    }
    // The GROUP's 0.5 is the whole dim — SingleSelect also fades each disabled
    // option, and 0.5 × 0.55 on --bg-app is unreadable.
    :deep(.option:disabled) {
      opacity: 1;
    }
  }
}

// The ring readout under each fovea view. ALWAYS occupies its row (fixed
// height, no reflow when the text swaps between a decode and a reason).
.ring-row {
  width: 100%;
  height: 1.6em;
  line-height: 1.6em;
  font-family: var(--font-mono);
  font-size: 0.85em;
  // START-aligned: a centered nowrap row clips the HEAD of a long decode, which
  // is exactly the part being read. The full text rides the `title`.
  text-align: start;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  &.ok {
    color: var(--text-bright);
  }
  &.warn {
    color: var(--warn);
  }
}

// The button + status line under the center tile. A plain row (see the
// template): a <label> would forward status-span clicks to the button.
// The row spans the tile, and the button owns a FIXED first column: its left
// edge is the row's, its width never depends on the label or on the status
// text (which is confined to a `minmax(0, 1fr)` ellipsis cell). No status
// string can move it.
.scan-row {
  width: 100%;
  display: grid;
  grid-template-columns: 9em minmax(0, 1fr);
  align-items: center;
  gap: 1ch;
  margin: 0.4em 0;
}

// ONE button whose label swaps. Emphasis is a SOLID FILL, never a border
// (Principles §5, borderless inline controls; the RecordControls action-button
// recipe). Text/fill pairs are AA: #111 on --accent = 4.9:1, #fff on --danger
// = 7.8:1, and both press/hover states BRIGHTEN the fill, which only raises the
// dark-on-accent ratio. No transition — state changes snap.
.scan-button {
  width: 100%;
  min-height: 2em;
  padding: 0.35em 1em;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: var(--bg-chrome);
  font: inherit;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;

  &.on {
    background: var(--danger);
    color: var(--text);
  }
  &:hover:not(:disabled) {
    filter: brightness(1.15);
  }
  &:active:not(:disabled) {
    filter: brightness(1.25);
  }
  &:focus-visible {
    outline: 2px solid var(--accent-bright);
    outline-offset: 2px;
  }
  // Mid-round-trip: hold the CURRENT fill, just dimmed (a flash through a
  // neutral grey on every toggle reads as a third state).
  &.busy {
    opacity: 0.5;
    cursor: progress;
  }
  &:disabled:not(.busy) {
    background: var(--tint-2);
    color: var(--text);
    opacity: 0.5;
    cursor: not-allowed;
  }
}

// ONE status vocabulary across the drawer (scan + vergence): `muted` = nothing
// running, `ok` = healthy, `warn` = the operator must look; `dim` rides `ok`
// for a deliberate, expected pause.
.scan-status,
.vergence-status {
  font-family: var(--font-mono);
  // Confined to its grid cell so the declared ellipsis engages instead of
  // widening the row (and with it, the button's column).
  min-width: 0;
  text-align: end;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  &.ok {
    color: var(--text-bright);
  }
  &.dim {
    opacity: 0.65;
  }
  &.warn {
    color: var(--warn);
  }
}

.options {
  padding: 1em;
  overflow-x: hidden;
  overflow-y: scroll;
  & > * {
    height: 2em;
  }

  // Group heading + its reset, as in the disparity-scope drawer.
  h4 {
    height: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0.75em 0 0.25em;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    font-size: 0.8em;
    letter-spacing: 0.02em;

    &:first-child {
      margin-top: 0;
    }
  }

  .reset {
    min-width: 3ch;
    cursor: pointer;
    border: 1px solid var(--tint-4);
    border-radius: 4px;
    background: var(--tint-1);
    color: inherit;
    font: inherit;
    text-transform: none;
    letter-spacing: 0;
    padding: 0.1em 0.6em;
    opacity: 0.8;

    &:hover {
      background: var(--tint-3);
      opacity: 1;
    }
  }
}

// Auto Vergence: a running toggle that shares Start/Stop Scan's solid fills
// on purpose (Principles §5 — emphasis is a fill, never a border). Fixed track
// so the label swap never moves anything.
.vergence-row {
  display: grid;
  // 10.5em: "Stop Vergence" is 13 characters — a narrower track spills it.
  grid-template-columns: 10.5em minmax(0, 1fr);
  align-items: center;
  gap: 1ch;
  font-size: 0.9em;

  // ONE running-toggle vocabulary app-wide: the same fills as Start/Stop Scan
  // — `--accent` idle, `--danger` while it runs.
  .vergence-button {
    width: 100%;
    min-height: 2em;
    padding: 0.25em 1em;
    border: none;
    border-radius: 4px;
    background: var(--accent);
    color: var(--bg-chrome);
    font: inherit;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;

    &.on {
      background: var(--danger);
      color: var(--text);
    }
    &:hover:not(:disabled) {
      filter: brightness(1.15);
    }
    &:active:not(:disabled) {
      filter: brightness(1.25);
    }
    &:focus-visible {
      outline: 2px solid var(--accent-bright);
      outline-offset: 2px;
    }
    // Mid-round-trip: hold the CURRENT fill, dimmed (mirrors .scan-button).
    &.busy {
      opacity: 0.5;
      cursor: progress;
    }
    &:disabled:not(.busy) {
      background: var(--tint-2);
      color: var(--text);
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  font-size: 0.9em;

  // Flex needs the explicit shrink basis the grid cell provides on its own.
  .scan-status {
    flex: 1 1 auto;
  }
}

// Ring Reader (spec §reader): a label + a compact two-option SingleSelect on
// ONE drawer row — the component stacks vertically by default, which would
// tower over the slider rows it sits among.
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  font-size: 0.9em;

  .ring-toggle {
    flex-direction: row;
    gap: 0.25em;

    :deep(.option) {
      width: auto;
      align-items: center;
      text-align: center;
      padding: 0.1em 0.9em;
    }
  }
}
</style>
