<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Ring-code annotations for one fovea view, in FRAME px (the StreamView slot's
  SVG viewBox). A decoded frame draws the fitted circle solid, the LEADER arc in
  the warn accent (distinct from both eye colors), and radial ticks at every
  field (long) and byte (short) boundary; a circle that fit but did not decode
  draws dim and dashed. The arc + ticks stay MOUNTED and fade — a marginal
  emitter flips ok↔fail at frame rate, and remounting that structure strobes.
  spec: docs/spec/mirror-link.md#reader
-->
<script setup lang="ts">
import type { RingViewGeometry } from "./overlay";

defineProps<{ view: RingViewGeometry; color: string }>();
</script>

<template>
  <g v-if="view.circle">
    <circle
      :cx="view.circle.x"
      :cy="view.circle.y"
      :r="view.circle.r"
      fill="none"
      :stroke="color"
      :stroke-width="view.stroke"
      :stroke-dasharray="view.on ? undefined : view.stroke * 4"
      :opacity="view.on ? 1 : 0.35"
    />
    <g :opacity="view.on ? 1 : 0">
      <path
        :d="view.arc"
        fill="none"
        stroke="var(--warn)"
        :stroke-width="view.stroke * 2.5"
        stroke-linecap="round"
      />
      <line
        v-for="(t, i) in view.ticks"
        :key="i"
        :x1="t.x1"
        :y1="t.y1"
        :x2="t.x2"
        :y2="t.y2"
        stroke="var(--text-dim)"
        :stroke-width="view.stroke"
        :opacity="t.long ? 0.9 : 0.5"
      />
    </g>
  </g>
</template>
