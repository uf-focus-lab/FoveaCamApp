<!-- ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 --------------------------------------------------------- -->

<script setup lang="ts">
import { ref, computed, getCurrentInstance, useTemplateRef } from "vue";
import { pointerObscured } from "@lib/pointer-obscured";

export type Pos = { x: number; y: number };
/** Per-instance id for the slot clip (several pads share a document). */
const clipId = `posview-clip-${(getCurrentInstance()?.uid ?? 0).toString(36)}`;
const emit = defineEmits<{ (e: "select", v: Pos | null): void }>();
const canvas = useTemplateRef("canvas");

// INTERACTIVE only when a parent actually listens for `select` — four
// consumers use PosView as a pure display (disparity-scope, multi-fovea,
// profiler, extrinsic PRV), and an unconditional crosshair + mousedown-track
// there would be a false affordance / phantom drag.
// Declared emits don't appear in useAttrs(), so read the vnode props.
const interactive = computed(
  () => !!(getCurrentInstance()?.vnode.props as { onSelect?: unknown } | null)?.onSelect,
);

const props = defineProps<{
  pos: Pos;
  lim?: number;
  thickness?: number;
  fontSize?: number;
  color?: string;
  unit?: string;
}>();
const hover = ref(false);
const drag = ref(false);
const active = computed(() => hover.value || drag.value);
const color = computed(() => (active.value ? props.color || "white" : "gray"));
const lim = computed(() => props.lim || 200);
const fontSize = computed(() => props.fontSize || lim.value * 0.05);
const T = computed(() => props.thickness || fontSize.value * 0.1);
const unit = computed(() => props.unit || "V");
// Radius of the entire SVG canvas
const r = computed(() => lim.value + T.value + fontSize.value * 2);
// Radius of the position marker
const R = computed(() => T.value * 4);
const viewBox = computed(() => {
  const l = r.value;
  return [-l, -l, l * 2, l * 2];
});

const variables = computed(() => ({
  "--color": color.value,
  "--F": fontSize.value.toString(),
  "--T": T.value.toString(),
  "--R": R.value.toString(),
}));

function crossHair() {
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const l = lim.value;
  const r = R.value * 2;
  const { x, y } = props.pos;
  const t = T.value;
  const attrs = {
    stroke: color.value,
    "stroke-dasharray": `${t * 4} ${t * 4}`,
    "stroke-width": T.value,
  };
  if (y - r > -l) lines.push({ x1: x, y1: y - r, x2: x, y2: -l, ...attrs });
  if (y + r < l) lines.push({ x1: x, y1: y + r, x2: x, y2: +l, ...attrs });
  // Horizontal line: left segment
  if (x - r > -l) lines.push({ x1: x - r, y1: y, x2: -l, y2: y, ...attrs });
  // Horizontal line: right segment
  lines.push({ x1: x + r, y1: y, x2: +l, y2: y, ...attrs });
  return lines;
}

function dots() {
  const result: Pos[] = [];
  const l = lim.value;
  for (let i = -0.9; i <= 0.9; i += 0.1) {
    for (let j = -0.9; j <= 0.9; j += 0.1) {
      result.push({ x: i * l, y: j * l });
    }
  }
  return result;
}

function format(v: number, unit: string, radix: number = 1) {
  const s = Math.abs(v).toFixed(radix) + unit;
  if (v > 0) return "+" + s;
  if (v < 0) return "-" + s;
  return " " + s;
}

// Device-rate drag: `mousemove` is coalesced to the display refresh (~60 Hz),
// which capped the
// split-eye voltage drag at 60 wire updates/s; `pointerrawupdate` delivers at
// the device's polling rate (125 Hz–1 kHz) — the same MOVE_EVENT pattern
// FrameView uses. `mousemove` stays the fallback where unsupported.
const MOVE_EVENT = "onpointerrawupdate" in window ? "pointerrawupdate" : "mousemove";

function trackUntilRelease(e: MouseEvent) {
  if (!(e.buttons & 1)) return untrack();
  // Obscuration gate: a drag under
  // an overlaying element (drawer/dialog) pauses — skip the emit, keep the
  // drag alive (mouseup above still ends it; off-edge drags still clamp).
  if (pointerObscured(canvas.value, e)) return;
  // Compute position
  const el = canvas.value;
  if (!el) return console.warn("No SVG element found");
  const rect = el.getBoundingClientRect();
  const w = rect.width / 2;
  const h = rect.height / 2;
  const dx = e.clientX - (rect.left + w);
  const dy = e.clientY - (rect.top + h);
  const d = r.value; // SVG Canvas half size
  const l = lim.value; // Logical limit area half size
  const kx = d / w;
  const ky = d / h;
  function clamp(v: number) {
    if (v < -l) return -l;
    else if (v > l) return l;
    else return v;
  }
  const pos = { x: clamp(dx * kx), y: clamp(dy * ky) };
  emit("select", pos);
}

function untrack() {
  drag.value = false;
  window.removeEventListener(MOVE_EVENT, trackUntilRelease as EventListener);
  window.removeEventListener("mouseup", trackUntilRelease);
  emit("select", null);
}

function track(e: MouseEvent) {
  if (!interactive.value) return; // display-only consumer: no phantom drag
  drag.value = true;
  window.addEventListener(MOVE_EVENT, trackUntilRelease as EventListener);
  window.addEventListener("mouseup", trackUntilRelease);
  trackUntilRelease(e);
}
</script>

<template>
  <svg
    ref="canvas"
    :viewBox="viewBox.join(' ')"
    :style="variables"
    @mouseenter="hover = true"
    @mouseleave="hover = false"
  >
    <!-- Canvas Area -->
    <rect
      :x="-lim"
      :y="-lim"
      :width="lim * 2"
      :height="lim * 2"
      stroke="gray"
      :stroke-width="T"
      @mousedown="track"
      :style="{ pointerEvents: 'all', cursor: interactive ? 'crosshair' : 'default' }"
    />
    <!-- Decorations -->
    <circle
      v-for="({ x, y }, i) in dots()"
      :key="i"
      :cx="x"
      :cy="y"
      :r="T / 2"
      fill="white"
      opacity="0.4"
    />
    <!-- Slots: clipped to the pad so an overlay near the travel limit cannot
         paint over the readouts or spill past the viewport. -->
    <clipPath :id="clipId">
      <rect :x="-lim" :y="-lim" :width="lim * 2" :height="lim * 2" />
    </clipPath>
    <g :clip-path="`url(#${clipId})`">
      <slot></slot>
    </g>
    <!-- Dashed lines -->
    <line v-for="(line, i) in crossHair()" :key="i" v-bind="line" />
    <!-- Position text -->
    <g style="pointer-events: all">
      <text
        :x="pos.x"
        :y="-lim - fontSize"
        :font-size="fontSize"
        text-anchor="middle"
        dominant-baseline="central"
        fill="var(--color)"
      >
        {{ format(pos.x, unit) }}
      </text>
      <text
        :x="pos.x"
        :y="+lim + fontSize"
        :font-size="fontSize"
        text-anchor="middle"
        dominant-baseline="central"
        fill="var(--color)"
      >
        {{ format((100 * pos.x) / lim, "%") }}
      </text>
      <text
        :x="-pos.y"
        :y="-lim - fontSize"
        :font-size="fontSize"
        text-anchor="middle"
        dominant-baseline="central"
        fill="var(--color)"
        transform="rotate(-90)"
      >
        {{ format(pos.y, unit) }}
      </text>
      <text
        :x="+pos.y"
        :y="-lim - fontSize"
        :font-size="fontSize"
        text-anchor="middle"
        dominant-baseline="central"
        fill="var(--color)"
        transform="rotate(+90)"
      >
        {{ format((100 * pos.y) / lim, "%") }}
      </text>
    </g>
    <!-- Marker -->
    <circle
      :cx="pos.x"
      :cy="pos.y"
      :r="R"
      fill="var(--color)"
      stroke-width="1"
    />
    <!-- Top slot -->
    <slot name="top"></slot>
  </svg>
</template>

<style scoped lang="scss">
svg {
  font-family: var(--font-mono);
  --reactive-color: gray;

  &:hover,
  &:active {
    --reactive-color: var(--color);
  }

  user-select: none;
  pointer-events: none;
  & > text {
    pointer-events: all;
  }
}
</style>
