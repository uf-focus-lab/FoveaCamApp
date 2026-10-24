<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  One eye's ring debug strip. The worker packs every stage of the read into a
  mono8 image (polar rows, then the normalized profile, the binary ring and the
  segmentation marks); this draws the stage the operator picked. Canvas 2D, not
  SVG: the traces are ≥1500 points at pipe rate.
  spec: docs/spec/mirror-link.md#ring-views
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, useTemplateRef, watch } from "vue";
import type { FramePayload } from "@lib/orchestrator/protocol";
import type { RingReadout } from "@lib/ring-code";

const props = defineProps<{
  title: string;
  color: string;
  stage: "polar" | "binary" | "segments";
  payload: FramePayload | null | undefined;
  readout: RingReadout | null;
  /** Strips only flow while the scan runs (the strip is mounted only while
   *  the reader is on) — the empty state says which wait it is. */
  scanning: boolean;
}>();

const canvas = useTemplateRef<HTMLCanvasElement>("canvas");
/** Redraw at ~10 Hz — the strip arrives at pipe rate, the eye does not. */
const REDRAW_MS = 100;
let lastDraw = 0;
let pending: number | null = null;

/** The caption — the ring row's vocabulary (spec §views): `idle` while the
 *  scan is not running, `reading…` until its first strip + readout. */
const status = computed(() => {
  if (!props.scanning) return "idle";
  const r = props.readout;
  if (!props.payload || !r) return "reading…";
  return r.ok ? (r.text ?? "") : (r.reason ?? "");
});

/** Bumped per draw so a late `createImageBitmap` from a superseded frame
 *  cannot paint over a newer one. */
let generation = 0;

function draw(): void {
  const el = canvas.value;
  const payload = props.payload;
  const meta = props.readout?.strip;
  const gen = ++generation;
  if (!el) return;
  const ctx = el.getContext("2d");
  if (!ctx) return;
  if (!payload?.data || !meta) {
    ctx.clearRect(0, 0, el.width, el.height);
    return;
  }
  // Backing store = the strip's own column count: a narrower canvas would
  // nearest-neighbour away most of the ring.
  if (el.width !== meta.width) el.width = meta.width;
  const h = el.height;
  const w = el.width;
  ctx.clearRect(0, 0, w, h);
  const src = new Uint8Array(payload.data);
  const width = meta.width;
  const rows = meta.polarRows;
  const profRow = rows * width;
  const binRow = profRow + width;
  const segRow = binRow + width;
  const sx = w / width;

  if (props.stage === "polar") {
    const img = ctx.createImageData(width, rows);
    for (let i = 0; i < rows * width; i++) {
      const v = src[i];
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    // One bitmap blit, stretched over the rho axis only (theta →, rho ↓).
    void createImageBitmap(img).then((bmp) => {
      if (gen !== generation) return bmp.close(); // superseded mid-decode
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
    });
    return;
  }

  // Both trace stages draw the normalized profile filled from the baseline.
  ctx.fillStyle = props.color;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < width; i++)
    ctx.lineTo(i * sx, h - (src[profRow + i] / 255) * h);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  if (props.stage === "binary") {
    // The thresholded ring as a step trace over the profile.
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const y = src[binRow + i] ? h * 0.12 : h * 0.88;
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * sx, y);
    }
    ctx.stroke();
    return;
  }

  // segments: the leader span shaded, field edges full height, byte edges short.
  for (let i = 0; i < width; i++) {
    const mark = src[segRow + i];
    if (!mark) continue;
    const x = i * sx;
    if (mark === 192) {
      // Canvas takes no CSS vars — the literal --warn amber.
      ctx.fillStyle = "#fa0";
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, 0, Math.max(1, sx), h);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.strokeStyle = mark === 255 ? "#0af" : "#ccc";
    ctx.lineWidth = mark === 64 ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(x, mark === 64 ? h * 0.75 : 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

/** Throttled redraw: coalesce the pipe-rate arrivals into ~10 Hz. */
function schedule(): void {
  const now = performance.now();
  if (now - lastDraw >= REDRAW_MS) {
    lastDraw = now;
    draw();
    return;
  }
  if (pending !== null) return;
  pending = window.setTimeout(
    () => {
      pending = null;
      lastDraw = performance.now();
      draw();
    },
    REDRAW_MS - (now - lastDraw),
  );
}

watch(
  () =>
    [
      props.payload,
      props.stage,
      props.readout?.strip?.width,
      props.readout?.strip?.polarRows,
    ] as const,
  schedule,
  { immediate: true },
);

onBeforeUnmount(() => {
  if (pending !== null) window.clearTimeout(pending);
  pending = null;
});
</script>

<template>
  <div class="histogram">
    <div class="caption" :style="{ '--color': color }">
      <span class="name">{{ title }}</span>
      <span class="status" :title="status">{{ status }}</span>
    </div>
    <canvas ref="canvas" width="600" height="150" />
  </div>
</template>

<style scoped lang="scss">
.histogram {
  width: 100%;

  .caption {
    display: flex;
    justify-content: space-between;
    gap: 1ch;
    font-size: 0.75em;
    color: var(--color);
    line-height: 1.4em;

    .status {
      font-family: var(--font-mono);
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  canvas {
    display: block;
    width: 100%;
    // Layout-stable: the box never changes with the data.
    aspect-ratio: 4 / 1;
    height: auto;
    background: var(--bg-canvas);
    outline: 1px solid var(--border);
  }
}
</style>
