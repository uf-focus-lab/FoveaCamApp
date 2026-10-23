<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  The Scan Pattern drawer column (spec §views, §scan-patterns): mode, main axis,
  amplitude, then the per-mode shape + exposure windows. A thin view over the
  session's `state` proxy — every control writes a state key, the session
  rebuilds (and, while scanning, re-uploads) the trajectory from it.
-->
<script setup lang="ts">
import { computed } from "vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import DualRangeSlider from "@src/inputs/dual-range-slider.vue";
import SingleSelect, {
  type SingleSelectOption,
} from "@src/inputs/single-select.vue";
import type { StateOf } from "@lib/orchestrator/protocol";
import { mirrorLink, type ScanMode, type ScanWindow } from "./contract";
import { SCAN_AMP_RANGE, SCAN_HZ_RANGE, WINDOW_MAX, WINDOW_MIN } from "./scan";

/** The session's live `state` proxy (`useSession(...).state`): writes go
 *  straight to the session, as with every other drawer control. */
const props = defineProps<{ state: StateOf<typeof mirrorLink> }>();
const state = props.state;

/** One keyboard step = the narrowest window the session accepts
 *  (`WINDOW_MIN`, spec §scan-patterns); the cap is `WINDOW_MAX` from the same
 *  place, so the pane can never produce a window the session rewrites. */
const WINDOW_STEP = WINDOW_MIN;
const DEFAULT_WINDOW: ScanWindow = [0, WINDOW_MAX];
const DEFAULT_TRI_WINDOW: ScanWindow = [0.05, WINDOW_MAX];

const MODE_OPTIONS: readonly SingleSelectOption<ScanMode>[] = [
  { value: "ellipse", label: "Ellipse" },
  { value: "triangle", label: "Triangle" },
];

const ellipse = computed(() => state.scan_mode === "ellipse");
const plusSign = (v: string) => (v.startsWith("-") ? v : "+" + v);

/** The base period T (ms): one ellipse revolution, one triangle sweep. Window
 *  fractions are of T in both modes (the triangle's are per sweep). */
const periodMs = computed(
  () => 1000 / Math.max(state.scan_hz, SCAN_HZ_RANGE.min),
);
const windowMs = (w: readonly number[]) =>
  `${(w[0] * periodMs.value).toFixed(1)}–${(w[1] * periodMs.value).toFixed(1)} ms`;
/** One thumb's ms readout — the dual slider's per-thumb `aria-valuetext`. */
const thumbMs = (v: number) => `${(v * periodMs.value).toFixed(1)} ms`;

const scanWindow = computed<ScanWindow>({
  get: () => state.scan_window,
  set: (v) => (state.scan_window = v),
});
const riseWindow = computed<ScanWindow>({
  get: () => state.tri_window_rise,
  set: (v) => (state.tri_window_rise = v),
});
/** While synced the falling slider SHOWS the rising window (the session keeps
 *  the state mirrored; this only keeps the paint honest between the write and
 *  the echo) and refuses writes — it is disabled anyway. */
const fallWindow = computed<ScanWindow>({
  get: () =>
    state.tri_window_sync ? state.tri_window_rise : state.tri_window_fall,
  set: (v) => {
    if (!state.tri_window_sync) state.tri_window_fall = v;
  },
});

const MODE_TITLE =
  "Ellipse traces one closed loop per period; Triangle sweeps out and back along the axis over twice the period.";
const AXIS_TITLE =
  "Direction of the main axis in degrees from the wide view's +x — or drag the handle on the center view. Right-click resets to neutral.";
const ampTitle = computed(() =>
  ellipse.value
    ? "Radius along the main axis in degrees; the mirrors attenuate it at high frequency. Right-click resets to neutral."
    : "Half the sweep along the main axis in degrees; the mirrors attenuate it at high frequency. Right-click resets to neutral.",
);
const RATIO_TITLE =
  "Minor-to-major radius of the ellipse: 1 is a circle, 0 collapses it to a line along the axis. Right-click resets to neutral.";
const WINDOW_TITLE =
  "The part of each revolution the foveas expose, as start–end within the period. Right-click resets to neutral.";
const RISE_TITLE =
  "The part of the outward sweep the foveas expose, as start–end within the sweep. Right-click resets to neutral.";
// Sync means identical TIMING (spec review round 1, decided): the falling
// window takes the rising window's fractions, each counted from the start of
// its own sweep — so an asymmetric window exposes opposite ends of the line on
// the two frames.
const SYNC_MEANS =
  "the same timing within the return sweep, which starts from the far end — so a window not centred in its sweep exposes opposite ends of the line on the two frames";
const fallTitle = computed(() =>
  state.tri_window_sync
    ? `Follows Rising Window while Sync is on: ${SYNC_MEANS}.`
    : "The part of the return sweep the foveas expose, as start–end within the sweep; that frame arrives flipped vertically. Right-click resets to neutral.",
);
const SYNC_TITLE = `Give the falling sweep the rising sweep's window: ${SYNC_MEANS}.`;
</script>

<template>
  <div class="options fill">
    <h4 title="The path both foveas trace around the aimed center, and where along it they expose.">
      <span>Scan Pattern</span>
    </h4>
    <div class="toggle-row" :title="MODE_TITLE">
      <span>Mode</span>
      <SingleSelect
        v-model="state.scan_mode"
        :options="MODE_OPTIONS"
        class="segmented"
        aria-label="Scan pattern"
      />
    </div>
    <RangeSlider
      v-model="state.scan_axis_deg"
      :title="AXIS_TITLE"
      :min="-179.5"
      :max="180"
      :neutral="0"
      :step="0.5"
    >
      <span>Axis</span>
      <span>{{ plusSign(state.scan_axis_deg.toFixed(1)) }}&deg;</span>
    </RangeSlider>
    <RangeSlider
      v-model="state.scan_amp"
      :title="ampTitle"
      :min="SCAN_AMP_RANGE.min"
      :max="SCAN_AMP_RANGE.max"
      :neutral="0.5"
      :step="0.01"
    >
      <span>Amplitude</span>
      <span>{{ state.scan_amp.toFixed(2) }}&deg;</span>
    </RangeSlider>
    <template v-if="ellipse">
      <RangeSlider
        v-model="state.scan_ratio"
        :title="RATIO_TITLE"
        :min="0"
        :max="1"
        :neutral="1"
        :step="0.01"
        :detents="[0]"
      >
        <span>Ratio</span>
        <span>{{ state.scan_ratio > 0 ? state.scan_ratio.toFixed(2) : "line" }}</span>
      </RangeSlider>
      <DualRangeSlider
        v-model="scanWindow"
        :title="WINDOW_TITLE"
        :min="0"
        :max="WINDOW_MAX"
        :step="WINDOW_STEP"
        :min-gap="WINDOW_STEP"
        :neutral="DEFAULT_WINDOW"
        :value-text="thumbMs"
        label="Exposure window"
      >
        <span>Exposure Window</span>
        <span>{{ windowMs(scanWindow) }}</span>
      </DualRangeSlider>
    </template>
    <template v-else>
      <DualRangeSlider
        v-model="riseWindow"
        :title="RISE_TITLE"
        :min="0"
        :max="WINDOW_MAX"
        :step="WINDOW_STEP"
        :min-gap="WINDOW_STEP"
        :neutral="DEFAULT_TRI_WINDOW"
        :value-text="thumbMs"
        label="Rising window"
      >
        <span>Rising Window</span>
        <span>{{ windowMs(riseWindow) }}</span>
      </DualRangeSlider>
      <!-- Disabled (and showing the rising values) while synced; a disabled
           slider is a <div>, so its hover still explains why. -->
      <DualRangeSlider
        v-model="fallWindow"
        :title="fallTitle"
        :min="0"
        :max="WINDOW_MAX"
        :step="WINDOW_STEP"
        :min-gap="WINDOW_STEP"
        :neutral="DEFAULT_TRI_WINDOW"
        :disabled="state.tri_window_sync"
        :value-text="thumbMs"
        label="Falling window"
      >
        <span>Falling Window</span>
        <span>{{ windowMs(fallWindow) }}</span>
      </DualRangeSlider>
      <!-- A real checkbox (owner's ask), checked by default: the drawer's
           other on/off controls are selectors, this one is a plain tick. -->
      <label class="check-row" :title="SYNC_TITLE">
        <span>Sync Windows</span>
        <input
          type="checkbox"
          v-model="state.tri_window_sync"
          aria-label="Sync the falling window to the rising window"
        />
      </label>
    </template>
  </div>
</template>

<style scoped lang="scss">
// The drawer-column recipe from index.vue (`.options`, `h4`, `.toggle-row`),
// repeated here because scoped styles do not cross the component boundary.
.fill {
  width: 100%;
  height: 100%;
}

.options {
  padding: 1em;
  overflow-x: hidden;
  overflow-y: scroll;
  & > * {
    height: 2em;
  }

  h4 {
    height: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 0.25em;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    font-size: 0.8em;
    letter-spacing: 0.02em;
  }
}

// Label + checkbox on one row. Checked, the box takes the accent as a FILL like
// every other emphasis in the drawer; unchecked, its resting border is the
// native control's — an exception to "a fill, never a border", accepted
// because the owner asked for a real checkbox.
.check-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  font-size: 0.9em;
  cursor: pointer;

  input[type="checkbox"] {
    width: 1.1em;
    height: 1.1em;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
}

// A label + a compact segmented SingleSelect on ONE row (the Ring Reader
// recipe) — the component stacks vertically by default.
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  font-size: 0.9em;

  .segmented {
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
