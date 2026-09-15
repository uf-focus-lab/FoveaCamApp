<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  MirrorLink — a thin client over the `mirror-link` session: drag the wide view
  to place the scan center, fine-align with verge/shift (or Auto Align), and run
  a circular scan whose per-frame exposure spans one revolution. Renders frames,
  overlays telemetry, drives state; no core / camera / calibration access.
  Behavior spec: docs/spec/mirror-link.md.
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
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
import SingleSelect, {
  type SingleSelectOption,
} from "@src/inputs/single-select.vue";
import Drawer from "@src/components/Drawer.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { vergeToDistance } from "@lib/stereo";
import RingOverlay from "./RingOverlay.vue";
import RingHistogram from "./RingHistogram.vue";
import { ringGeometry, strokeFor } from "./overlay";
import { mirrorLink } from "./contract";
import { SCAN_AMP_RANGE, SCAN_HZ_RANGE, SHIFT_RANGE_DEG } from "./scan";

const session = useSession(mirrorLink, "mirror-link");
const { state, telemetry } = session;
const controller = computed(getController);

// Title-bar capture + record buttons (the facades register themselves on
// construction; capture opens the preview window with Cmd/Ctrl-S).
new Capture(session, "mirror-link");
new Recording(session, "mirror-link");

// The L/R views bind the RAW convert pipes — a frame integrating a full
// revolution has no single mirror pose to warp against (spec §views). The
// center view binds the intrinsic undistort pipe, raw fallback uncalibrated.
const frameL = usePipeFrame(() =>
  state.serials?.L ? nodeId.convert(state.serials.L) : null,
);
const frameR = usePipeFrame(() =>
  state.serials?.R ? nodeId.convert(state.serials.R) : null,
);
const frameC = usePipeFrame(
  () =>
    state.undistortPipe ??
    (state.serials?.C ? nodeId.convert(state.serials.C) : null),
);

// Overlay geometry comes from the wide payload itself (no telemetry.size).
const size = computed(() => ({
  width: frameC.value?.shape[1] ?? 0,
  height: frameC.value?.shape[0] ?? 0,
}));
const stroke = computed(() => strokeFor(frameC.value?.shape));

// --- steering (spec §targeting) ---------------------------------------------
const cursor = shallowRef<(Rect & { buttons: number }) | null>(null);
watch(cursor, (c) => {
  if (c) void session.call("steer", { x: c.x, y: c.y });
});

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

// --- scan (spec §lifecycle) -------------------------------------------------
const scanning = computed(() => telemetry.scan !== null);
const period_ms = computed(() =>
  (1000 / Math.max(state.scan_hz, SCAN_HZ_RANGE.min)).toFixed(1),
);

const scanStatus = computed<{ text: string; tone: string; title: string }>(
  () => {
    const t = telemetry.scan;
    if (t)
      return {
        text: `${t.hz.toFixed(1)} Hz · ${ms(t.period_us)} ms · L ${ms(t.exposure_us.L)} ms · R ${ms(
          t.exposure_us.R,
        )} ms`,
        tone: t.mismatch ? "warn" : "",
        title: t.mismatch
          ? `A fovea exposure misses the ${ms(t.period_us)} ms revolution — its frame covers ` +
            `only part of the ring. Applied frame rates: L ${t.frame_rate.L.toFixed(
              1,
            )} Hz, R ${t.frame_rate.R.toFixed(1)} Hz.`
          : `Each fovea frame integrates one full ${ms(t.period_us)} ms revolution.`,
      };
    const reason = telemetry.scan_blocked;
    return {
      text: reason ? "idle — refused" : "idle",
      tone: reason ? "warn" : "muted",
      title:
        reason ??
        `Start the scan to override both fovea cameras to ${period_ms.value} ms exposure at ` +
          `${state.scan_hz.toFixed(1)} Hz. Manage Cameras' settings are restored on stop.`,
    };
  },
);

// The commanded ring in volt space, closed back onto its first point so the
// PosView polyline reads as a loop (spec §views). Empty stays empty.
const close = (path: readonly Pos[]): Pos[] =>
  path.length > 1 ? [...path, path[0]] : [...path];
const scanPath = computed(() => ({
  L: close(telemetry.scan_path.L),
  R: close(telemetry.scan_path.R),
}));

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
    ? "Stop the scan and restore both fovea cameras' exposure settings."
    : "Start the circular scan and override both fovea cameras so one frame spans one revolution.";
});
// --- auto-align servo (spec §targeting) -------------------------------------
// A closed loop, not a one-shot: engage it and the mirrors keep the emitter at
// both fovea centers, rewriting Verge Distance + Vertical Shift every step.
const engaged = computed(() => telemetry.align?.engaged === true);
const aligning = ref(false);
async function toggleAlign(): Promise<void> {
  if (aligning.value) return;
  aligning.value = true;
  try {
    if (engaged.value) await session.call("stopAlign", undefined);
    else await session.call("startAlign", undefined);
  } finally {
    aligning.value = false;
  }
}
const alignHint = computed(() =>
  !telemetry.ready
    ? "Waiting for the camera triple to be leased."
    : engaged.value
      ? "Stop the servo — the mirrors hold where they are."
      : "Track the emitter: both foveas are driven onto it and kept there, " +
        "rewriting Verge Distance and Vertical Shift as they go.",
);
/** Metres, exactly as the Verge Distance readout writes them. */
const metres = (mm: number | null): string =>
  mm !== null && Number.isFinite(mm) ? `${(mm / 1000).toFixed(4)}m` : "∞";
const fmtErr = (e: { x: number; y: number } | null) =>
  e ? `${e.x.toFixed(2)},${e.y.toFixed(2)}°` : "—";

const alignStatus = computed<{ text: string; tone: string; title: string }>(
  () => {
    const a = telemetry.align;
    if (!a) return { text: "off", tone: "", title: alignHint.value };
    if (a.reason)
      return {
        text: a.reason,
        tone: "warn",
        title: `${a.reason} — the servo is engaged but blind; steer closer or raise Gain.`,
      };
    const text = `L ${fmtErr(a.error_deg.L)} · R ${fmtErr(a.error_deg.R)}`;
    return {
      text,
      tone: "ok",
      title:
        `${text} residual per eye. Applied ${metres(a.applied?.distance_mm ?? null)}, ` +
        `shift ${plusSign((a.applied?.shift_deg ?? 0).toFixed(2))}°. ` +
        "If the error GROWS, the pixel→angle sign is inverted for this rig.",
    };
  },
);

/** The three gain terms, one range/step/precision across them (the
 *  disparity-scope PID block's shape). */
const PID_DEFAULTS = { kp: 0.5, ki: 0.05, kd: 0 } as const;
const pidTerms = computed(() => [
  {
    label: "Kp",
    value: state.pid_kp,
    neutral: PID_DEFAULTS.kp,
    set: (v: number) => (state.pid_kp = v),
    title:
      "Proportional gain: how much of the measured angular error the servo corrects each step.",
  },
  {
    label: "Ki",
    value: state.pid_ki,
    neutral: PID_DEFAULTS.ki,
    set: (v: number) => (state.pid_ki = v),
    title:
      "Integral gain: removes the steady-state offset the proportional term leaves behind.",
  },
  {
    label: "Kd",
    value: state.pid_kd,
    neutral: PID_DEFAULTS.kd,
    set: (v: number) => (state.pid_kd = v),
    title: "Derivative gain: damps overshoot; leave at 0 unless the servo rings.",
  },
]);
function resetPid(): void {
  state.pid_kp = PID_DEFAULTS.kp;
  state.pid_ki = PID_DEFAULTS.ki;
  state.pid_kd = PID_DEFAULTS.kd;
  state.pid_max_step_deg = 0.2;
}

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
  if (!state.ring_reader)
    return {
      text: "off",
      tone: "muted",
      title: "Turn Ring Reader on in the drawer to decode the emitter.",
    };
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
        <RingOverlay
          v-if="state.ring_reader"
          :view="ringL"
          :color="THEME.L"
        />
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
        <!-- The commanded scan circle in volt space; the crosshair marks its
             CENTER (spec §views). An empty path draws nothing. -->
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
        v-model="cursor"
      >
        <!-- Scan ring: dashed + faint while idle (a preview of the path),
             solid while active (spec §views). -->
        <circle
          v-if="telemetry.scan_px > 0"
          :cx="telemetry.target.x"
          :cy="telemetry.target.y"
          :r="telemetry.scan_px"
          fill="none"
          :stroke="THEME.C"
          :stroke-width="stroke"
          :stroke-dasharray="scanning ? undefined : stroke * 4"
          :opacity="scanning ? 1 : 0.4"
        />
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
          :disabled="!telemetry.ready || busy || aligning"
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
    </div>
    <div class="view">
      <StreamView
        class="stream"
        :title="ROLE.R"
        :payload="frameR"
        :theme="THEME.R"
      >
        <RingOverlay
          v-if="state.ring_reader"
          :view="ringR"
          :color="THEME.R"
        />
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
        <!-- The commanded scan circle in volt space; the crosshair marks its
             CENTER (spec §views). An empty path draws nothing. -->
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
    <!-- THREE columns (spec §views): mirror controls · servo + ring views ·
         scan. A nested split rather than a new layout component. -->
    <HorizontalDivision
      :division="0.3"
      class="fill"
      :min-width-left="0.2"
      :min-width-right="0.4"
    >
      <template #left>
        <div class="options fill">
          <RangeSlider
            v-model="state.verge"
            title="Depth both foveas converge on — far end is ∞ (parallel gaze). Right-click resets to neutral."
            :min="1"
            :max="0"
            :neutral="0"
            :step="0.01"
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
            title="Vertical toe between the foveas: raises the LEFT eye and lowers the RIGHT by this much. Right-click resets to neutral."
            :min="SHIFT_RANGE_DEG.min"
            :max="SHIFT_RANGE_DEG.max"
            :neutral="0"
            :step="0.01"
          >
            <span>Vertical Shift</span>
            <span>{{ plusSign(state.shift.toFixed(2)) }}&deg;</span>
          </RangeSlider>
        </div>
      </template>
      <template #right>
        <!-- Nested split: the PID/servo column, then the scan column. -->
        <HorizontalDivision
          :division="0.5"
          class="fill"
          :min-width-left="0.3"
          :min-width-right="0.3"
        >
          <template #left>
            <div class="options fill">
              <!-- The decoder's own view leads the column: at a typical drawer
                   height both eyes stay comparable without scrolling. -->
              <h4><span>Ring View</span></h4>
              <SingleSelect
                v-model="state.ring_view"
                :options="RING_VIEW_OPTIONS"
                :disabled="!state.ring_reader"
                :title="RING_VIEW_TITLE"
                class="ring-stage"
                aria-label="Ring histogram stage"
              />
              <template v-if="ringViewOn">
                <RingHistogram
                  :title="ROLE.L"
                  :color="THEME.L"
                  :stage="ringStage"
                  :payload="stripL.payload.value"
                  :readout="telemetry.ring.L"
                  :scanning="scanning"
                  :reader="state.ring_reader"
                />
                <RingHistogram
                  :title="ROLE.R"
                  :color="THEME.R"
                  :stage="ringStage"
                  :payload="stripR.payload.value"
                  :readout="telemetry.ring.R"
                  :scanning="scanning"
                  :reader="state.ring_reader"
                />
              </template>
              <h4>
                <span>Align PID</span>
                <button class="reset" title="Reset to defaults" @click="resetPid">
                  ↺
                </button>
              </h4>
              <RangeSlider
                v-for="term in pidTerms"
                :key="term.label"
                :model-value="term.value"
                @update:model-value="term.set($event)"
                :title="term.title"
                :min="0"
                :max="1"
                :neutral="term.neutral"
                :step="0.01"
              >
                <span>{{ term.label }}</span>
                <span>{{ term.value.toFixed(2) }}</span>
              </RangeSlider>
              <RangeSlider
                v-model="state.pid_max_step_deg"
                title="Largest angle each controller may add per measurement — the servo's slew limit."
                :min="0.01"
                :max="1"
                :neutral="0.2"
                :step="0.01"
              >
                <span>Max Step</span>
                <span>{{ state.pid_max_step_deg.toFixed(2) }}&deg;</span>
              </RangeSlider>
              <!-- The servo toggle: one button whose label swaps, styled like
                   Start/Stop Scan (spec §targeting). -->
              <div class="align-row" :title="alignHint">
                <button
                  class="align-button"
                  :class="{ on: engaged, busy: aligning }"
                  :disabled="!telemetry.ready || aligning"
                  @click="toggleAlign"
                >
                  {{ engaged ? "Stop Align" : "Auto Align" }}
                </button>
                <span
                  class="align-status"
                  :class="alignStatus.tone"
                  :title="alignStatus.title"
                >
                  {{ alignStatus.text }}
                </span>
              </div>
            </div>
          </template>
          <template #right>
        <div class="options fill">
          <!-- Gain leads the column: it is SESSION-wide, not scan-scoped
               (spec §gain). No `neutral` — a stray right-click must never slam
               a LIVE camera to range-min. -->
          <RangeSlider
            v-model="gain"
            :title="gainTitle"
            :min="telemetry.gain_range.min"
            :max="telemetry.gain_range.max"
            :step="0.1"
            :disabled="gainDisabled"
          >
            <span>Gain</span>
            <span>{{ gainDisabled ? "—" : gain.toFixed(1) + " dB" }}</span>
          </RangeSlider>
          <RangeSlider
            v-model="state.scan_hz"
            title="Revolutions per second — also the per-frame exposure the foveas are overridden to while scanning. Right-click resets to neutral."
            :min="SCAN_HZ_RANGE.min"
            :max="SCAN_HZ_RANGE.max"
            :neutral="10"
            :step="0.5"
          >
            <span>Scan Frequency</span>
            <span
              >{{ state.scan_hz.toFixed(1) }} Hz &middot;
              {{ period_ms }} ms</span
            >
          </RangeSlider>
          <RangeSlider
            v-model="state.scan_amp"
            title="Ring RADIUS in degrees; the mirrors attenuate it at high frequency. Right-click resets to neutral."
            :min="SCAN_AMP_RANGE.min"
            :max="SCAN_AMP_RANGE.max"
            :neutral="0.5"
            :step="0.01"
          >
            <span>Scan Amplitude</span>
            <span>{{ state.scan_amp.toFixed(2) }}&deg;</span>
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
}

.fill {
  width: 100%;
  height: 100%;
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

.scan-status {
  font-family: var(--font-mono);
  // Confined to its grid cell so the declared ellipsis engages instead of
  // widening the row (and with it, the button's column).
  min-width: 0;
  text-align: end;
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

  // The stage selector is a segmented row of its own.
  .ring-stage {
    height: auto;
    flex-direction: row;
    gap: 0.25em;

    :deep(.option) {
      width: auto;
      flex: 1;
      align-items: center;
      text-align: center;
      padding: 0.1em 0.4em;
    }
  }
  // The histogram strips own their height (fixed aspect) — opt them out of the
  // slider row cap.
  & > .histogram {
    height: auto;
    margin-top: 0.5em;
  }
}

// Auto Align: an ORDINARY control (Principles §5) — no solid fill, that is
// reserved for the primary/destructive scan action. Fixed track so the
// "Aligning…" label swap never moves anything.
.align-row {
  display: grid;
  grid-template-columns: 9em minmax(0, 1fr);
  align-items: center;
  gap: 1ch;
  font-size: 0.9em;

  // ONE running-toggle vocabulary app-wide: the same fills as Start/Stop Scan
  // — `--accent` idle, `--danger` while it runs.
  .align-button {
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

  .align-status {
    font-family: var(--font-mono);
    min-width: 0;
    text-align: end;
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
