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
import Drawer from "@src/components/Drawer.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";
import { vergeToDistance } from "@lib/stereo";
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
const stroke = computed(
  () => Math.max(size.value.width, size.value.height, 1) * 0.003,
);

// --- steering (spec §targeting) ---------------------------------------------
const cursor = shallowRef<(Rect & { buttons: number }) | null>(null);
watch(cursor, (c) => {
  if (c) void session.call("steer", { x: c.x, y: c.y });
});

const drawer_height = ref(0);
const distance = computed(() => vergeToDistance(state.verge, state.baseline));
const plusSign = (v: string) => (v.startsWith("-") ? v : "+" + v);
const ms = (us: number) => (us / 1000).toFixed(1);

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
      />
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
      />
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
</style>
