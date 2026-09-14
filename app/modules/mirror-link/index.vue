<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  MirrorLink — a thin client over the `mirror-link` session: drag the wide view
  to place the scan center, fine-align each fovea with the trim sliders, and run
  a circular scan whose per-frame exposure spans one revolution. Renders frames,
  overlays telemetry, drives state; no core / camera / calibration access.
  Behavior spec: docs/spec/mirror-link.md.
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import type { Rect } from "core/Geometry";
import { ROLE, THEME } from "@lib/camera-config";
import { useSession, usePipeFrame } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { getController } from "@src/components/Controller.vue";
import Recording from "@src/record";
import StreamView from "@src/components/StreamView.vue";
import PosView from "@src/components/PosView.vue";
import FrameCursor from "@src/components/FrameCursor.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import SingleSelect, {
  type SingleSelectOption,
} from "@src/inputs/single-select.vue";
import Drawer from "@src/components/Drawer.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { vergeToDistance } from "@lib/stereo";
import RingOverlay from "./RingOverlay.vue";
import { ringGeometry, strokeFor } from "./overlay";
import { mirrorLink } from "./contract";
import { SCAN_AMP_RANGE, SCAN_HZ_RANGE, TRIM_RANGE_DEG } from "./scan";

const session = useSession(mirrorLink, "mirror-link");
const { state, telemetry } = session;
const controller = computed(getController);

// Title-bar record button (the facade registers itself on construction).
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
  const last = r.last ? ` · last ${ellipsis(r.last.text)}` : "";
  return {
    text: `${r.reason}${last}`,
    tone: r.last ? "muted" : "warn",
    title: r.last
      ? `Last decode on this eye: "${r.last.text}" · ${r.last.hex}`
      : "No frame has decoded on this eye yet.",
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
      />
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
        <!-- Where each fovea is AIMED (the offset-free center pose, trims
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
          :class="{ on: scanning }"
          :disabled="!telemetry.ready || busy"
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
      />
    </div>
  </div>
  <Drawer v-model="drawer_height">
    <HorizontalDivision
      :division="0.5"
      class="fill"
      :min-width-left="0.25"
      :min-width-right="0.25"
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
            v-model="state.trim_lx"
            title="Fine LEFT-eye horizontal offset — nudges that fovea's ring center without changing the ring. Right-click resets to neutral."
            :min="TRIM_RANGE_DEG.min"
            :max="TRIM_RANGE_DEG.max"
            :neutral="0"
            :step="0.005"
          >
            <span>Left Trim H</span>
            <span>{{ plusSign(state.trim_lx.toFixed(3)) }}&deg;</span>
          </RangeSlider>
          <RangeSlider
            v-model="state.trim_ly"
            title="Fine LEFT-eye vertical offset — nudges that fovea's ring center without changing the ring. Right-click resets to neutral."
            :min="TRIM_RANGE_DEG.min"
            :max="TRIM_RANGE_DEG.max"
            :neutral="0"
            :step="0.005"
          >
            <span>Left Trim V</span>
            <span>{{ plusSign(state.trim_ly.toFixed(3)) }}&deg;</span>
          </RangeSlider>
          <RangeSlider
            v-model="state.trim_rx"
            title="Fine RIGHT-eye horizontal offset — nudges that fovea's ring center without changing the ring. Right-click resets to neutral."
            :min="TRIM_RANGE_DEG.min"
            :max="TRIM_RANGE_DEG.max"
            :neutral="0"
            :step="0.005"
          >
            <span>Right Trim H</span>
            <span>{{ plusSign(state.trim_rx.toFixed(3)) }}&deg;</span>
          </RangeSlider>
          <RangeSlider
            v-model="state.trim_ry"
            title="Fine RIGHT-eye vertical offset — nudges that fovea's ring center without changing the ring. Right-click resets to neutral."
            :min="TRIM_RANGE_DEG.min"
            :max="TRIM_RANGE_DEG.max"
            :neutral="0"
            :step="0.005"
          >
            <span>Right Trim V</span>
            <span>{{ plusSign(state.trim_ry.toFixed(3)) }}&deg;</span>
          </RangeSlider>
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
            :neutral="20"
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
.scan-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1ch;
  margin: 0.4em 0;
}

// ONE button whose label swaps — a fixed min-width keeps the row from
// reflowing on the swap (interaction principle: layout-stable).
.scan-button {
  min-width: 13ch;
  &.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background: none;
  }
}

.scan-status {
  font-family: var(--font-mono);
  // Shrinkable so the declared ellipsis engages instead of re-packing the row
  // when the text swaps.
  flex: 1 1 auto;
  min-width: 0;
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

.options {
  padding: 1em;
  overflow-x: hidden;
  overflow-y: scroll;
  & > * {
    height: 2em;
  }
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  font-size: 0.9em;
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
