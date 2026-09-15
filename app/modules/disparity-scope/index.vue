<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Auto-vergence — a thin client over the `disparity-scope` session (renders
  frames, overlays telemetry, drives tuning/target via state/commands; no core /
  camera / calibration access). Behavior spec: docs/spec/disparity-scope.md.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Point2d, Size } from "core/Geometry";
import { ROLE, THEME } from "@lib/camera-config";
import { useConfigRef } from "@lib/config";
import { DEFAULT_PREDICTION_RATE_HZ } from "@lib/config-schema";
import {
  anaglyphEyeLabel,
  DEFAULT_ANAGLYPH_STYLE,
  type AnaglyphStyle,
} from "../../../docs/schema/anaglyph";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { degrees, clamp } from "@lib/util";
import { logScale } from "@lib/conversion";
import { distanceToVerge } from "@lib/stereo";
import {
  disparity,
  DEFAULT_TUNING,
  VERGE_MIN_DISTANCE_MM,
  SHIFT_LIMIT_DEG,
  VSHIFT_LIMIT_DEG,
  type Gains,
  type Tuning,
} from "./contract";
// Core-free display math (NOT ./vergence — that module runtime-imports
// core/Vision, which the renderer must never pull).
import { foveaFootprintOnWide } from "@lib/vergence/display-geometry";
import Recording from "@src/record";
import Capture from "@src/capture";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import InlineSelect from "@src/components/InlineSelect.vue";
import Drawer from "@src/components/Drawer.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import SingleSelect, {
  type SingleSelectOption,
} from "@src/inputs/single-select.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faArrowRotateLeft,
  faPause,
  faPlay,
  faPowerOff,
} from "@src/windows/icons";
import type { TrackerType } from "./tracker-swap";

const session = useSession(disparity, "disparity-scope");
const { state, telemetry } = session;
// Title-bar RecordButton + camera-icon Capture toggle — the shared facades
// (per-window singletons, disposed on unmount). See docs/spec/disparity-scope.md §capture.
new Recording(session, "disparity-scope");
new Capture(session, "disparity-scope");

// L/C/R main views source their per-camera `undistort` pipes DIRECTLY (off the
// scope kernel, so a busy kernel can't cap their fps). C binds `undistort` (not
// `convert`) so its overlays share the undistorted-wide space they draw in.
const frameL = usePipeFrame(() =>
  state.serials?.L ? nodeId.undistort(state.serials.L) : null,
);
const frameC = usePipeFrame(() =>
  state.serials?.C ? nodeId.undistort(state.serials.C) : null,
);
const frameR = usePipeFrame(() =>
  state.serials?.R ? nodeId.undistort(state.serials.R) : null,
);
// Center view = ONE pipe-backed StreamView over a computed pipe id (spec
// §topology): sliced → scope-tile slice, disparity/anaglyph → the composite
// brick (one pipe, mode retuned server-side), sgbm → the stereo heatmap.
// Binding only the selected pipe parks the rest (consumer gate).
const centerFrame = usePipeFrame(() => {
  const c = state.serials?.C;
  if (!c) return null;
  switch (state.view) {
    case "sliced":
      return nodeId.slice(c, "scope-tile");
    case "disparity":
    case "anaglyph":
      return nodeId.stereo("composite");
    case "sgbm":
      return nodeId.heatmap(nodeId.stereo("scope"), "view");
    default:
      return null;
  }
});

// Configured anaglyph style — labels the "Anaglyph" option with the actual
// L/R colors; live via the shared config doc, RC default until it resolves.
const anaglyphStyle = ref<AnaglyphStyle>(DEFAULT_ANAGLYPH_STYLE);
void useConfigRef("anaglyph_style").then((r) => {
  anaglyphStyle.value = r.value ?? DEFAULT_ANAGLYPH_STYLE;
  watch(r, (v) => (anaglyphStyle.value = v ?? DEFAULT_ANAGLYPH_STYLE));
});

// GLOBAL prediction rate (Hz) — the IMM brick's emit rate (spec §actuation).
// Binds the same `prediction_rate_hz` config key Settings edits, so this drawer
// slider live-applies through the shared config doc; writes clamp 60..1000.
const PREDICTION_RATE_DEFAULT = DEFAULT_PREDICTION_RATE_HZ;
const predictionRateLocal = ref<number>(PREDICTION_RATE_DEFAULT);
let predictionRateCfg: { value: number | undefined } | null = null;
void useConfigRef("prediction_rate_hz").then((r) => {
  predictionRateLocal.value = r.value ?? PREDICTION_RATE_DEFAULT;
  predictionRateCfg = r;
  watch(r, (v) => (predictionRateLocal.value = v ?? PREDICTION_RATE_DEFAULT));
});
const prediction_rate = computed<number>({
  get: () => predictionRateLocal.value,
  set: (v) => {
    const clamped = Math.min(1000, Math.max(60, Math.round(v)));
    predictionRateLocal.value = clamped;
    if (predictionRateCfg) predictionRateCfg.value = clamped;
  },
});

// Center-view select options; the anaglyph label follows the configured style.
const VIEW_OPTIONS = computed(
  () =>
    [
      { value: "sliced", label: "Wide Angle Sliced" },
      { value: "disparity", label: "Disparity (Left v.s. Right)" },
      { value: "anaglyph", label: `Anaglyph (${anaglyphEyeLabel(anaglyphStyle.value)})` },
      { value: "sgbm", label: "SGBM Disparity" },
    ] as const,
);

// Object-tracker engine choices — bound to `state.tracker_type`; the session
// hot-swaps on the fly and pins this back on a degraded swap (spec §tracker).
const TRACKER_OPTIONS: readonly SingleSelectOption<TrackerType>[] = [
  {
    value: "hybrid",
    label: "Hybrid (NCC + re-detect)",
    title: "Locks mono needles / low-texture; re-acquires after occlusion.",
  },
  {
    value: "kcf",
    label: "KCF (GRAY)",
    title: "Classic correlation filter; fast, but silent-forever once lost.",
  },
];

const drawer_height = ref(0);
const stroke = computed(() => Math.max(telemetry.size.width, telemetry.size.height, 1) * 0.003);

// Per-eye pose markers = the fovea FOOTPRINT (size / zoom), not the full wide
// frame — routed through the resolved `match_zoom` so Auto frames the measured
// footprint (spec §magnification).
const foveaFootprint = computed(() =>
  foveaFootprintOnWide(telemetry.size, match_zoom.value),
);

// Every tuning write replaces the whole `state.tuning` object — it's a single
// customRef, so a nested `state.tuning.x = v` reaches neither server nor render.
function setTuning<K extends keyof Tuning>(key: K, value: Tuning[K]): void {
  state.tuning = { ...state.tuning, [key]: value };
}

const sensitivityScale = logScale(0.01, 1.0);
const sensitivity_ratio = computed<number>({
  get: () => sensitivityScale.toRatio(state.tuning.sensitivity),
  set: (r) => setTuning("sensitivity", sensitivityScale.fromRatio(r)),
});
const timeoutScale = logScale(100, 10000, { infinityAt: 0, round: true });
// Ratio 0 (hard left) is the -1 "auto-vergence disabled" sentinel — the log
// scale proper starts one step in. Ratio 1 stays the 0 = ∞ sentinel (forever).
const timeout_ratio = computed<number>({
  get: () =>
    state.tuning.timeout < 0 ? 0 : Math.max(timeoutScale.toRatio(state.tuning.timeout), 0.001),
  set: (r) => setTuning("timeout", r <= 0 ? -1 : timeoutScale.fromRatio(r)),
});
const timeout_disabled = computed(() => state.tuning.timeout < 0);
const timeout_ms = computed(() => (state.tuning.timeout > 0 ? state.tuning.timeout : Infinity));
const scale_ratio = computed<number>({
  get: () => state.tuning.scale,
  set: (v) => setTuning("scale", v),
});
// The per-triple zoom override (>0), or null — the middle resolution tier.
const triple_override = computed(() =>
  telemetry.zoom_override != null && telemetry.zoom_override > 0
    ? telemetry.zoom_override
    : null,
);
// The magnification actually driving the match, mirroring the session's
// `matchZoom()` under the resolution order (spec §magnification) — keeps the readouts honest.
const match_zoom = computed(() =>
  state.zoom > 0
    ? state.zoom
    : (triple_override.value ?? telemetry.match_magnification ?? 1),
);
// Auto-mode readout (zoom 0 only): the resolved magnification + its source —
// "(triple override)", plain "Auto N×", or "(no cal)" when it degenerates to 1×.
const auto_hint = computed(() => {
  const z = `Auto ${match_zoom.value.toFixed(1)}×`;
  if (triple_override.value !== null) return `${z} (triple override)`;
  return telemetry.match_magnification !== null ? z : `${z} (no cal)`;
});
const min_score = computed<number>({
  get: () => state.tuning.min_score,
  set: (v) => setTuning("min_score", v),
});
const expand_x = computed<number>({
  get: () => state.tuning.expand_x,
  set: (v) => setTuning("expand_x", v),
});
const expand_y = computed<number>({
  get: () => state.tuning.expand_y,
  set: (v) => setTuning("expand_y", v),
});
function resetAllParams(): void {
  state.tuning = {
    ...state.tuning,
    sensitivity: DEFAULT_TUNING.sensitivity,
    scale: DEFAULT_TUNING.scale,
    min_score: DEFAULT_TUNING.min_score,
    expand_x: DEFAULT_TUNING.expand_x,
    expand_y: DEFAULT_TUNING.expand_y,
    timeout: DEFAULT_TUNING.timeout,
  };
}

// --- per-DOF gain groups (Pan / Depth / Vertical) ---------------------------
type GainKey = "pan" | "depth" | "v_shift";
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
  setTuning(key, [...DEFAULT_TUNING[key]] as Gains);
}
type GainGroup = {
  key: GainKey;
  title: string;
  /** One-line explanation of what this DOF does, on the heading. */
  hint: string;
  range: [number, number];
  step: number;
  terms: [ReturnType<typeof gainRef>, ReturnType<typeof gainRef>, ReturnType<typeof gainRef>];
};
const gainGroups: GainGroup[] = [
  { key: "pan", title: "Pan PID", hint: "Common-mode aim: how the PAIR is centred on the target.", range: [0, 1], step: 0.01, terms: [gainRef("pan", 0), gainRef("pan", 1), gainRef("pan", 2)] },
  { key: "depth", title: "Depth PID", hint: "Convergence distance: nulls the horizontal disparity between the foveas.", range: [0, 10], step: 0.02, terms: [gainRef("depth", 0), gainRef("depth", 1), gainRef("depth", 2)] },
  { key: "v_shift", title: "Vertical PID", hint: "Vertical toe: nulls the residual vertical disparity between the foveas.", range: [0, 1], step: 0.01, terms: [gainRef("v_shift", 0), gainRef("v_shift", 1), gainRef("v_shift", 2)] },
];

/** kp / ki / kd, in order — one label + hover per term, across all three
 *  groups (shared verbatim with mirror-link's identical block). */
const GAIN_LABELS = ["Kp", "Ki", "Kd"] as const;
const GAIN_TITLES = [
  "Proportional gain: how much of the measured error this DOF corrects each step.",
  "Integral gain: removes the steady-state offset the proportional term leaves behind.",
  "Derivative gain: damps overshoot; leave at 0 unless the loop rings.",
] as const;

// --- vergence PID debug/manual-nudge sliders --------------------------------
type Dof = "verge" | "panX" | "panY" | "v_shift";
function radians(deg: number) {
  return (deg * Math.PI) / 180;
}
const shiftLimit = radians(SHIFT_LIMIT_DEG);
const vShiftLimit = radians(VSHIFT_LIMIT_DEG);
const vergeLimits = computed<[number, number]>(() => [
  0,
  distanceToVerge(VERGE_MIN_DISTANCE_MM, state.baseline),
]);
// Two-way sliders (manual vergence override): a write freezes auto-vergence
// corrections server-side (the tracker keeps following) and actuates
// immediately. The knob follows a LOCAL ECHO of the
// last write instead of the ~30 Hz `pids` readout, so a drag isn't yanked
// around by in-flight telemetry. The echo releases on CONFIRMATION — the
// readout matching the written value — not on a timer (a loaded IPC lane
// could outlive any fixed window and snap the knob back); the
// hard cap only covers a write the server clamped and will never echo back.
const PID_ECHO_EPS = 1e-6;
const PID_ECHO_MAX_MS = 1000;
function pidRef(dof: Dof) {
  const echo = ref<{ v: number; at: number } | null>(null);
  watch(
    () => telemetry.pids[dof],
    (live) => {
      const e = echo.value;
      if (!e) return;
      const confirmed = Math.abs(live - e.v) < PID_ECHO_EPS;
      if (confirmed || performance.now() - e.at > PID_ECHO_MAX_MS)
        echo.value = null;
    },
  );
  return computed<number>({
    get: () => echo.value?.v ?? telemetry.pids[dof],
    set: (v) => {
      echo.value = { v, at: performance.now() };
      session.call("setPid", { dof, value: v });
    },
  });
}
const pidVerge = pidRef("verge");
const pidPanX = pidRef("panX");
const pidPanY = pidRef("panY");
const pidVshift = pidRef("v_shift");
const resetVergence = () => session.call("reset_vergence", undefined);
// Takeover cue: the four sliders shift to the accent while manual
// control holds the loop ("held" latch / Timeout hard-left / a live auto-tune
// run wiggling them), restoring one visual identity per state — color only,
// no reflow, no transition.
const vergenceHeld = computed(
  () =>
    // Prefix match: the held/auto-off states carry a " · following" suffix
    // while a live tracker keeps steering the aim (spec §freeze-window).
    telemetry.status.startsWith("held") ||
    telemetry.status.startsWith("auto off") ||
    telemetry.status === "autotune",
);
const vergenceSliderColor = computed(() =>
  vergenceHeld.value ? "var(--accent-bright)" : "currentColor",
);

// Pause/play (spec §freeze-window): pause latches the manual hold — the
// slider-write takeover without a value change — and play clears it. The
// Timeout slider's "disabled" sentinel outranks it, so the button goes inert
// there instead of pretending a resume it can't deliver.
const pauseTitle = computed(() => {
  if (timeout_disabled.value)
    return "Auto-vergence is disabled by the Timeout slider (hard left) — move it right to re-enable";
  if (tuneActive.value)
    return "Resume auto-vergence — aborts the running auto-tune (pre-tune gains restored)";
  return telemetry.vergence_paused
    ? "Resume auto-vergence"
    : "Pause auto-vergence corrections — a following tracker keeps steering the aim";
});
const togglePause = () =>
  session.call("pauseVergence", !telemetry.vergence_paused);

// Whole-object replace (like `tuning`) — a nested `state.kernel.w = v` reaches
// neither server nor render.
const kernel_w = computed<number>({
  get: () => state.kernel.w,
  set: (v) => (state.kernel = { ...state.kernel, w: v }),
});
const kernel_h = computed<number>({
  get: () => state.kernel.h,
  set: (v) => (state.kernel = { ...state.kernel, h: v }),
});

// --- auto-tune (spec §autotune) — drawer-gated hardware experiments --------------
const tuneActive = computed(() => {
  const p = telemetry.autotune;
  return p !== null && (p.phase === "relay" || p.phase === "eval");
});
// The condition currently blocking a run, mirroring the session's
// `autotuneRefusal()` order — null means runnable. Feeds both the :disabled
// gate and the state-dependent titles (Timeout-slider precedent).
const tuneBlocked = computed<string | null>(() => {
  if (tuneActive.value) return "a run is in progress";
  if (!telemetry.ready) return "session is not ready";
  if (!telemetry.calibrated) return "no calibration on this triple";
  if (telemetry.overridden) return "release the drag first";
  // An enabled tracker no longer blocks — starting a tune disengages it
  // (the slider-write takeover semantics; session autotuneRefusal matches).
  if (state.pidOverride.engaged) return "release the PID override first";
  return null;
});
const tuneRunnable = computed(() => tuneBlocked.value === null);
const tuneLine = computed(() => {
  const p = telemetry.autotune;
  if (!p) return "idle";
  const costs =
    p.bestCost !== null && p.baselineCost !== null
      ? ` best ${p.bestCost.toFixed(3)} (base ${p.baselineCost.toFixed(3)})`
      : "";
  switch (p.phase) {
    case "relay":
      // {dof: null, dofsDone: 4} is the completing transient — no cycle count.
      return p.dof
        ? `relay ${p.dof} ${p.cycles} cyc (${p.dofsDone}/4)`
        : `relay — ${p.dofsDone}/4`;
    case "eval":
      return `eval ${p.evals}/${p.budget}${costs}`;
    case "done":
      return (
        `done${costs}${p.message ? ` — ${p.message}` : ""}` +
        " — gains applied (loop held; drag or tracker to resume)"
      );
    case "failed":
      return `failed — ${p.message ?? ""}`;
    case "aborted":
      // Session-built messages carry the gains outcome (kept vs restored).
      return p.message ? `aborted — ${p.message}` : "aborted (gains restored)";
  }
});
const TUNE_TITLE =
  "Relay auto-tune, per DOF: small (2–10% of range) square-wave experiments " +
  "about the held pose measure each DOF's ultimate gain/period, then apply " +
  "conservative Tyreus-Luyben gains. Runs a live experiment on the physical " +
  "hardware — needs a calibrated triple and a static matchable target; " +
  "starting a tune disengages the tracker. Experimental: not yet validated " +
  "on hardware.";
const POLISH_TITLE =
  "Relay tune, then CMA-ES joint polish: scripted target steps scored by " +
  "ITAE + overshoot + actuation effort, budget-capped (takes minutes). " +
  "Same rig requirements as tune.";
// State-dependent titles: name WHY the button is disabled right now.
const tuneTitle = computed(() =>
  tuneBlocked.value ? `Disabled: ${tuneBlocked.value}. ${TUNE_TITLE}` : TUNE_TITLE,
);
const polishTitle = computed(() =>
  tuneBlocked.value
    ? `Disabled: ${tuneBlocked.value}. ${POLISH_TITLE}`
    : POLISH_TITLE,
);
const startTune = (stage: "relay" | "full") =>
  session.call("autotune", { stage });
const abortTune = () => session.call("autotuneAbort", undefined);

// --- trigger-sync capture (spec §trigger-sync) ------------------------------
// `state.trigger_sync` is USER INTENT — a plain state binding (the `view` /
// `tracker_type` pattern; the server never refuses the write). Engagement is
// the session's: `telemetry.trigger` is non-null exactly while engaged, and
// `trigger_blocked` names why it's still waiting.
// Segmented control (the Tracker Type idiom) over the boolean state key —
// SingleSelect is string/number-generic, so a tiny computed proxy maps it.
const CAPTURE_OPTIONS: readonly SingleSelectOption<"freerun" | "trigger">[] = [
  {
    value: "freerun",
    label: "Free-run",
    title: "Each camera streams independently at its configured Frame Rate.",
  },
  {
    value: "trigger",
    label: "Trigger sync",
    title:
      "Every measurement becomes a true stereo pair at a uniform rate, paced " +
      "by the fovea pair's exposure budget. The paired rate is usually lower " +
      "than free-run, and the per-camera Frame Rate setting no longer " +
      "applies — shorten the pair's exposure to raise it.",
  },
];
const captureMode = computed<"freerun" | "trigger">({
  get: () => (state.trigger_sync ? "trigger" : "freerun"),
  set: (v) => (state.trigger_sync = v === "trigger"),
});
// Intent ≠ effect while waiting: the ACTIVE option tints warn; the status line
// stays compact — the blocked DETAIL goes to the title-bar tray as a warning
// (published by the session on each reason transition).
const capturePending = computed(
  () => state.trigger_sync && telemetry.trigger === null,
);
const captureStatus = computed<{ text: string; tone: string; title?: string }>(
  () => {
    if (!state.trigger_sync) return { text: "free-run", tone: "muted" };
    const t = telemetry.trigger;
    if (t) {
      const title = `${t.frames} frames, ${t.rejects} rejects, ${t.timeouts} timeouts`;
      // hz null = the ≥1 s measurement window hasn't matured yet.
      return t.hz === null
        ? { text: "engaged · measuring…", tone: "", title }
        : {
            text: `≈ ${t.hz.toFixed(1)} Hz · pulse ${t.pulseMs.toFixed(1)} ms`,
            tone: "",
            title,
          };
    }
    const reason = telemetry.trigger_blocked ?? "waiting to engage";
    return { text: "free-run — waiting", tone: "warn", title: reason };
  },
);

// Synthesize down/move/up phases from StreamView's plain (un-phased) mouse stream.
let wasDown = false;
let lastP: Point2d = { x: 0, y: 0 };
function onCursor(c: (Point2d & Size & { buttons: number }) | null): void {
  const down = c !== null && (c.buttons & 1) !== 0;
  if (c) lastP = { x: c.x, y: c.y };
  if (down && !wasDown) {
    session.call("pointer", { p: lastP, buttons: c!.buttons, phase: "down" });
  } else if (down && wasDown) {
    session.call("pointer", { p: lastP, buttons: c!.buttons, phase: "move" });
  } else if (!down && wasDown) {
    session.call("pointer", { p: lastP, buttons: 0, phase: "up" });
  }
  wasDown = down;
}

</script>

<template>
  <!-- --p reserves the drawer's height below the content (same idiom as
       manual-control) so the fixed-position drawer never obscures the tail of
       the scrollable page. -->
  <div
    class="cameras"
    :style="{ '--p': (drawer_height ? drawer_height + 20 : 0) + 'px' }"
  >
    <div class="view">
      <StreamView class="stream" :title="ROLE.L" :payload="frameL" :theme="THEME.L" />
      <PosView :pos="telemetry.volt.L" :color="THEME.L" style="width: 100%" />
    </div>
    <div class="view">
      <!-- Single pipe-backed center view: `centerFrame` picks the pipe per
           `state.view` (spec §topology); the InlineSelect rides the #title slot. -->
      <StreamView class="stream" :payload="centerFrame" :theme="THEME.C">
        <template #title>
          <InlineSelect v-model="state.view">
            <option v-for="o in VIEW_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </InlineSelect>
        </template>
      </StreamView>
      <StreamView class="stream" :title="ROLE.C" :payload="frameC" :theme="THEME.C" @mouse="onCursor">
        <!-- Target center. -->
        <circle :cx="state.target.x" :cy="state.target.y" :r="stroke * 3" :fill="THEME.C" />
        <!-- Per-eye projected pose (fovea footprint = wide size / zoom). -->
        <rect
          :x="telemetry.L_PX.x - foveaFootprint.width / 2"
          :y="telemetry.L_PX.y - foveaFootprint.height / 2"
          :width="foveaFootprint.width"
          :height="foveaFootprint.height"
          :stroke="THEME.L"
          fill="none"
          :stroke-width="stroke"
        />
        <rect
          :x="telemetry.R_PX.x - foveaFootprint.width / 2"
          :y="telemetry.R_PX.y - foveaFootprint.height / 2"
          :width="foveaFootprint.width"
          :height="foveaFootprint.height"
          :stroke="THEME.R"
          fill="none"
          :stroke-width="stroke"
        />
        <!-- Tracker bounding box. -->
        <rect
          v-if="telemetry.tracker_bbox"
          :x="telemetry.tracker_bbox.x"
          :y="telemetry.tracker_bbox.y"
          :width="telemetry.tracker_bbox.width"
          :height="telemetry.tracker_bbox.height"
          stroke="#0f0"
          :stroke-width="stroke"
          fill="none"
        />
      </StreamView>
      <div class="report">
        Vergence
        <span class="value">{{ degrees(telemetry.vergence).toFixed(2) }}</span>&deg; | Depth
        <span class="value">{{
          telemetry.realized_distance === Infinity ? "&#x221E;" : telemetry.realized_distance.toFixed(4)
        }}</span>m
        | <span class="value">{{ telemetry.status }}</span>
        <!-- Drags ride the tracker override (spec §drag); this badge mirrors
             the propagated flag, NOT the programmatic-only PID slot. -->
        <span
          v-if="telemetry.overridden"
          class="value override"
          title="Target pinned by pointer drag (tracker override; both eyes follow the cursor ray in parallel, vergence at infinity)"
          >override</span
        >
      </div>
      <!-- The Debugger sub-window toggle lives in the title bar (AppMeta.debugWindow). -->
    </div>
    <div class="view">
      <StreamView class="stream" :title="ROLE.R" :payload="frameR" :theme="THEME.R" />
      <PosView :pos="telemetry.volt.R" :color="THEME.R" style="width: 100%" />
    </div>
  </div>

  <Drawer v-model="drawer_height">
    <div class="drawer-columns">
      <!-- Column 1: Global Parameters -->
      <div class="options">
        <h4>
          <span>Parameters</span>
          <button class="reset" title="Reset to defaults" @click="resetAllParams"><Icon :icon="faArrowRotateLeft" /></button>
        </h4>
        <RangeSlider
          v-model="sensitivity_ratio"
          :min="0"
          :max="1"
          :neutral="sensitivityScale.toRatio(DEFAULT_TUNING.sensitivity)"
          :step="0.001"
        >
          <span>Sensitivity</span>
          <span>{{ state.tuning.sensitivity.toFixed(3) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="scale_ratio"
          :min="0"
          :max="1"
          :neutral="DEFAULT_TUNING.scale"
          :step="0.01"
        >
          <span>Template Scale</span>
          <span>{{ (1 + (match_zoom - 1) * clamp(scale_ratio, [0, 1])).toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider v-model="min_score" :min="0" :max="1" :neutral="DEFAULT_TUNING.min_score" :step="0.01">
          <span>Min Match Score</span>
          <span>{{ min_score.toFixed(2) }}</span>
        </RangeSlider>
        <RangeSlider
          v-model="timeout_ratio"
          :min="0"
          :max="1"
          :neutral="timeoutScale.toRatio(DEFAULT_TUNING.timeout)"
          :step="0.01"
          title="Convergence window after the last activity. Hard left disables auto-vergence corrections — a running tracker keeps the foveas following its target; hard right never times out."
        >
          <span>Timeout</span>
          <span>
            <!-- Tinted: the hard-left knob sits ~0 px from the
                 ~100 ms position, so the label is the disambiguator. -->
            <template v-if="timeout_disabled"
              ><span :style="{ color: 'var(--warn)' }">disabled</span></template
            >
            <template v-else-if="timeout_ms !== Infinity">{{ timeout_ms }} ms</template>
            <template v-else> &#x221E; </template>
          </span>
        </RangeSlider>
        <RangeSlider v-model="expand_x" :min="1.0" :max="4.0" :neutral="DEFAULT_TUNING.expand_x" :step="0.1">
          <span>X Expansion</span>
          <span>{{ (expand_x * 100).toFixed(1) }}%</span>
        </RangeSlider>
        <RangeSlider v-model="expand_y" :min="1.0" :max="4.0" :neutral="DEFAULT_TUNING.expand_y" :step="0.1">
          <span>Y Expansion</span>
          <span>{{ (expand_y * 100).toFixed(1) }}%</span>
        </RangeSlider>
        <RangeSlider
          v-model="prediction_rate"
          :min="60"
          :max="1000"
          :neutral="PREDICTION_RATE_DEFAULT"
          :step="10"
        >
          <span>Prediction Rate</span>
          <span>{{ prediction_rate }} Hz</span>
        </RangeSlider>
        <h4><span>Display</span></h4>
        <label
          class="entry"
          :title="
            state.zoom > 0
              ? 'Explicit zoom drives both the sliced-view crop and the ' +
                'template-match magnification (takes priority over ' +
                'the per-triple override and the measured value)'
              : triple_override !== null
                ? `Auto — using this triple's stored zoom override ` +
                  `(${triple_override.toFixed(2)}x); set a value here to override it`
                : telemetry.match_magnification !== null
                  ? `Auto — using the calibration-measured magnification ` +
                    `(${telemetry.match_magnification.toFixed(2)}x); set a value to override`
                  : 'Auto — no override or calibrated magnification available (falls back to 1); set a value'
          "
        >
          <span>Zoom Ratio</span>
          <!-- Auto hint expands to the LEFT; the input stays anchored so
               toggling zoom 0↔value never reflows a neighbor. -->
          <span class="zoom-value">
            <span
              v-if="state.zoom === 0"
              class="auto-hint"
              :class="{
                uncal: triple_override === null && telemetry.match_magnification === null,
              }"
              >{{ auto_hint }}</span
            >
            <input type="number" min="0" step="0.1" v-model.number="state.zoom" />
          </span>
        </label>
        <h4><span>Capture Mode</span></h4>
        <!-- Intent selector — ALWAYS enabled (the session gates engagement) —
             the Tracker Type segmented idiom. While intent is on but not
             engaged the ACTIVE option tints warn (intent ≠ effect cue) and
             the blocked DETAIL rides the title-bar tray as a warning; the
             always-rendered Status row stays compact (text swaps only,
             layout-stable). -->
        <SingleSelect
          v-model="captureMode"
          :options="CAPTURE_OPTIONS"
          class="capture-select"
          :class="{ pending: capturePending }"
          aria-label="Capture mode"
        />
        <div class="entry">
          <span>Status</span>
          <span
            class="capture-status"
            :class="captureStatus.tone"
            :title="captureStatus.title"
          >{{ captureStatus.text }}</span>
        </div>
      </div>
      <!-- Columns 2-4: per-DOF gain PIDs (Pan / Depth / Vertical) -->
      <div class="options" v-for="g in gainGroups" :key="g.key">
        <h4 :title="g.hint">
          <span>{{ g.title }}</span>
          <button class="reset" title="Reset to defaults" @click="resetGain(g.key)"><Icon :icon="faArrowRotateLeft" /></button>
        </h4>
        <RangeSlider
          v-for="(term, i) in g.terms"
          :key="i"
          :model-value="term.value"
          @update:model-value="term.value = $event"
          :title="GAIN_TITLES[i]"
          :min="g.range[0]"
          :max="g.range[1]"
          :neutral="DEFAULT_TUNING[g.key][i]"
          :step="g.step"
        >
          <span>{{ GAIN_LABELS[i] }}</span>
          <span>{{ term.value.toFixed(2) }}</span>
        </RangeSlider>
      </div>
      <!-- Column 5: Vergence Angles -->
      <div class="options">
        <h4
          title="Live loop readout — dragging a slider takes over: auto-vergence corrections freeze and the dragged value applies. A running tracker stays on and the foveas keep following it through your manual values. Drag on the view or toggle the tracker off and on to hand control back."
        >
          <span>Vergence Angles</span>
          <span class="h4-actions">
            <button
              class="reset"
              :disabled="timeout_disabled"
              :title="pauseTitle"
              @click="togglePause"
            ><Icon :icon="telemetry.vergence_paused ? faPlay : faPause" /></button>
            <button
              class="reset"
              title="Zero the loop state — auto re-converges; under a manual hold this zeroes your corrections (a following tracker keeps the aim; otherwise the eyes re-aim at the last target)"
              @click="resetVergence"
            ><Icon :icon="faArrowRotateLeft" /></button>
          </span>
        </h4>
        <RangeSlider v-model="pidVerge" :min="vergeLimits[0]" :max="vergeLimits[1]" :neutral="0" :step="0.01" :color="vergenceSliderColor">
          <span>Verge</span>
          <span>{{ degrees(pidVerge).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <RangeSlider v-model="pidPanX" :min="-shiftLimit" :max="shiftLimit" :neutral="0" :step="0.01" :color="vergenceSliderColor">
          <span>Pan X</span>
          <span>{{ degrees(pidPanX).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <RangeSlider v-model="pidPanY" :min="-shiftLimit" :max="shiftLimit" :neutral="0" :step="0.01" :color="vergenceSliderColor">
          <span>Pan Y</span>
          <span>{{ degrees(pidPanY).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <RangeSlider v-model="pidVshift" :min="-vShiftLimit" :max="vShiftLimit" :neutral="0" :step="0.01" :color="vergenceSliderColor">
          <span>V-Shift</span>
          <span>{{ degrees(pidVshift).toFixed(2) }}&deg;</span>
        </RangeSlider>
        <fieldset class="debug">
          <legend>PID Debug</legend>
          <div><span>Status</span><span>{{ telemetry.status }}</span></div>
          <div>
            <span>Pan&nbsp;X&nbsp;/&nbsp;Y</span>
            <span>{{ degrees(pidPanX).toFixed(3) }}&deg; / {{ degrees(pidPanY).toFixed(3) }}&deg;</span>
          </div>
          <div><span>Verge</span><span>{{ degrees(pidVerge).toFixed(4) }}</span></div>
          <div>
            <span>Distance (cmd)</span>
            <span>
              <template v-if="telemetry.commanded_distance !== Infinity">
                {{ (telemetry.commanded_distance / 1000).toFixed(3) }} m
              </template>
              <template v-else> &#x221E; </template>
            </span>
          </div>
          <div><span>V-Shift</span><span>{{ degrees(pidVshift).toFixed(3) }}&deg;</span></div>
          <div><span>Actuate</span><span>{{ telemetry.perf.actuateMs.mean.toFixed(2) }} ms</span></div>
        </fieldset>
      </div>
      <!-- Column 6: Wide-angle Tracker -->
      <div class="options">
        <h4>
          <span>Tracker</span>
          <button
            class="reset toggle"
            :class="{ active: state.tracker_enabled }"
            :title="state.tracker_enabled ? 'Disable tracker' : 'Enable tracker'"
            @click="state.tracker_enabled = !state.tracker_enabled"
          >
            <Icon :icon="faPowerOff" />
          </button>
        </h4>
        <!-- Plain row + aria-label on the select (a bare <label> with no
             control was inert + misassociated for a11y). -->
        <div class="entry">
          <span>Type</span>
        </div>
        <!-- Tracker engine — swaps on the fly; always shows the ACTIVE engine (spec §tracker). -->
        <SingleSelect
          v-model="state.tracker_type"
          :options="TRACKER_OPTIONS"
          aria-label="Tracker type"
        />
        <label class="entry">
          <span>Kernel</span>
          <span class="kernel-size">
            <input type="number" v-model.number="kernel_w" min="8" />
            <span>&times;</span>
            <input type="number" v-model.number="kernel_h" min="8" />
          </span>
        </label>
        <div class="entry">
          <span>Status</span>
          <!-- "lost" = the auto-follow gate hit the lost-latch (spec §tracker);
               re-enable or drag to re-arm. -->
          <span>{{
            telemetry.tracker_bbox
              ? "tracking"
              : state.tracker_enabled
                ? telemetry.tracker_lost
                  ? "lost"
                  : "armed"
                : "off"
          }}</span>
        </div>
        <!-- Auto-tune (spec §autotune): drawer-gated hardware experiments, never
             automatic. Buttons disable while not runnable (title names the
             blocking condition); abort is ALWAYS rendered — visibility only —
             so the header slot is truly reserved (no line-height shift). -->
        <h4>
          <span>Auto-Tune</span>
          <button
            class="reset"
            :style="{ visibility: tuneActive ? 'visible' : 'hidden' }"
            title="Abort the running auto-tune — restores the pre-tune gains and pose"
            @click="abortTune"
          >abort</button>
        </h4>
        <div class="entry tune-actions">
          <button class="tune" :disabled="!tuneRunnable" :title="tuneTitle" @click="startTune('relay')">
            tune
          </button>
          <button class="tune" :disabled="!tuneRunnable" :title="polishTitle" @click="startTune('full')">
            tune + polish
          </button>
        </div>
        <div class="entry">
          <span>Status</span>
          <!-- title mirrors the line: the narrow column ellipsizes long
               failure/done messages, hover recovers the full text. -->
          <span class="tune-status" :title="tuneLine">{{ tuneLine }}</span>
        </div>
      </div>
    </div>
  </Drawer>
</template>

<style scoped lang="scss">
.cameras {
  --p: 0; // drawer-height bottom reserve (bound inline from drawer_height)
  position: relative;
  display: flex;
  justify-content: space-evenly;
  align-items: flex-start;
  flex-wrap: wrap;
  flex-direction: row;
  width: 100%;
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
}

.report {
  user-select: none;
  font-family: var(--font-mono);
  font-size: 1.4em;
  font-weight: 500;
  padding: 1em 0;
  .value {
    display: inline-block;
    text-align: right;
    font-weight: 600;
    min-width: 6ch;
  }
  .override {
    min-width: 0;
    padding: 0 0.5ch;
    border-radius: 4px;
    background: #fd05;
    color: var(--text);
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
}

.drawer-columns {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;

  & > .options {
    flex: 1;
    border-right: 1px solid var(--tint-2);
    &:last-child {
      border-right: none;
    }
  }
}

.options {
  width: 100%;
  height: 100%;
  padding: 1em;
  overflow-x: hidden;
  overflow-y: auto;

  h4 {
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

  // Shared by the h4 header buttons AND the Auto-Tune action row (one button
  // identity across the drawer). `text-transform`/`letter-spacing` undo the
  // h4 header styling; harmless outside it.
  .h4-actions {
    display: flex;
    gap: 0.5ch;
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

    &:hover:not(:disabled) {
      opacity: 1;
      background: var(--tint-3);
    }

    &:active:not(:disabled) {
      background: var(--tint-2);
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }

    &.toggle {
      min-width: 3ch;
      text-align: center;
      text-transform: uppercase;
      font-size: 0.9em;

      &.active {
        border-color: #0f08;
        background: #0f02;
        color: #6f6;
        opacity: 1;

        &:hover {
          background: #0f03;
        }
      }
    }
  }

  .capture-select {
    margin: 0.35em 0;

    // Intent on, not engaged — the selected option itself shows intent ≠
    // effect (warn outline; the blocked detail rides the title-bar tray).
    &.pending :deep(.option.active) {
      border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 14%, transparent);
    }
  }

  .entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1ch;
    margin: 0.35em 0;
    font-size: 0.9em;

    input[type="number"] {
      width: 5ch;
      font: inherit;
      color: inherit;
      background: var(--tint-1);
      border: 1px solid var(--tint-3);
      border-radius: 4px;
      padding: 0.1em 0.4em;
    }

    input[type="checkbox"] {
      margin: 0;
    }

    select {
      font: inherit;
      color: inherit;
      background: var(--tint-1);
      border: 1px solid var(--tint-3);
      border-radius: 4px;
      padding: 0.1em 0.4em;
      cursor: pointer;
    }

    .capture-status {
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      &.muted {
        color: var(--text-muted);
      }
      &.warn {
        color: var(--warn);
      }
    }

    .kernel-size {
      display: inline-flex;
      align-items: center;
      gap: 0.5ch;

      input[type="number"] {
        width: 6ch;
      }
    }

    .zoom-value {
      display: inline-flex;
      align-items: center;
      gap: 0.5ch;
    }

    &.tune-actions {
      gap: 1ch;

      // First-class actions, not reset-sized links: the SingleSelect option
      // identity, sharing the column width.
      .tune {
        flex: 1;
        padding: 0.4em 0.6em;
        font: inherit;
        color: inherit;
        background: var(--tint-1);
        border: 1px solid var(--tint-3);
        border-radius: 4px;
        cursor: pointer;

        &:hover:not(:disabled) {
          background: var(--tint-2);
          border-color: var(--accent);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }
    }

    .tune-status {
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .auto-hint {
      font-size: var(--fs-sm);
      color: var(--text-muted);
      white-space: nowrap;
      // Degenerate Auto (no calibrated magnification) is warn-colored, not silent.
      &.uncal {
        color: var(--warn);
      }
    }
  }
}

.debug {
  margin-top: 1em;
  border: 1px solid var(--tint-4);
  border-radius: 4px;
  padding: 0.5em 1em 1em;
  font-family: var(--font-mono);
  font-size: 0.9em;

  legend {
    padding: 0 0.5ch;
    opacity: 0.7;
  }

  div {
    display: flex;
    justify-content: space-between;
    gap: 1ch;
    padding: 0.15em 0;

    span:first-child {
      opacity: 0.7;
    }
  }
}
</style>
