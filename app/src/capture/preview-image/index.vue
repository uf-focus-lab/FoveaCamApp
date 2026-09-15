<script setup lang="ts">
import { computed } from "vue";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { payloadToMat } from "@lib/orchestrator/client";
import { isEmpty } from "@lib/util";
import FrameView from "@src/components/FrameView.vue";

const props = defineProps<{
  name: string;
  image: FramePayload | Empty;
}>();

const image = computed(() =>
  isEmpty(props.image) ? props.image : payloadToMat(props.image),
);
</script>

<template>
  <!-- The tile owns the box and hands FrameView an EXPLICIT size. FrameView
       only sizes itself inline when BOTH props are given; without them its root
       is sized by whatever cascade reaches it, its canvas falls back to the
       global `.container canvas { width: 100%; height: auto }` in index.css,
       and a full-resolution capture paints at intrinsic size — the tiles then
       pile up. `1.6em` is the same em FrameView reserves for its hanging title
       row (it resolves against FrameView's own font-size, not 16px), so the two
       are exactly complementary inside the tile's aspect-ratio height. -->
  <div class="tile">
    <FrameView
      v-if="!isEmpty(image)"
      :title="name"
      :mat="image"
      width="100%"
      height="calc(100% - 1.6em)"
    />
  </div>
</template>

<style scoped lang="scss">
// The grid item: a DEFINITE box of its own (never inherited from a parent's
// scoped rule), clipped so an oversize canvas can never spill over a neighbour.
.tile {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  min-height: 12rem;
  overflow: hidden;

  // Beat the GLOBAL `.container canvas { width: 100%; height: auto }`
  // (index.css) without `!important`, so FrameView's own inline px sizing still
  // wins: the canvas fits its box and keeps its aspect.
  :deep(.container canvas) {
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    margin: 0;
  }
}
</style>
