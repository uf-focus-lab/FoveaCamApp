<script setup lang="ts">
import ElementSize from "@lib/element-size";
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
} from "vue";
const props = defineProps({
  modelValue: {
    type: Number,
    default: null,
  },
  // Initial division ratio (0.0 - 1.0) if modelValue is not provided
  division: {
    type: Number,
    default: 0.5,
  },
  /** Smallest share of the width each pane may shrink to (0–1). A drag or a
   *  bound `modelValue` is clamped so neither pane collapses. */
  minWidthLeft: {
    type: Number,
    optional: true,
  },
  minWidthRight: {
    type: Number,
    optional: true,
  },
});
const emit = defineEmits(["update:modelValue"]);
const local_value = ref<number>(props.modelValue ?? props.division);
const division = computed({
  get() {
    return local_value.value;
  },
  set(val: number) {
    local_value.value = val;
    emit("update:modelValue", val);
  },
});
watch(
  () => props.modelValue,
  (val) => {
    if (val !== null) local_value.value = val;
  },
);
/** Clamp to [minLeft, 1 − minRight] (and to [0, 1]); an over-constrained pair
 *  splits the difference rather than pinning one pane shut. */
function clampDivision(val: number): number {
  const lo = Math.max(0, Math.min(1, props.minWidthLeft ?? 0));
  const hi = Math.min(1, Math.max(0, 1 - (props.minWidthRight ?? 0)));
  if (lo > hi) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, val));
}
watch(
  division,
  (val) => {
    const clamped = clampDivision(val);
    if (clamped !== val) division.value = clamped;
  },
  { immediate: true },
);
const container = useTemplateRef<HTMLDivElement>("container");
const size = new ElementSize(container);

const left = computed(() => size.width * division.value);
const right = computed(() => size.width - left.value);

const dragging = ref(false);
function onMouseMove(e: MouseEvent) {
  if (!(e.buttons & 1)) dragging.value = false;
  if (!dragging.value) return;
  division.value += e.movementX / size.width;
  requestAnimationFrame(ElementSize.notify);
}

onMounted(() => window.addEventListener("mousemove", onMouseMove));
onUnmounted(() => window.removeEventListener("mousemove", onMouseMove));
</script>

<template>
  <div class="horizontal-division" ref="container">
    <div
      class="container"
      style="left: 0"
      :style="{ width: left + 'px' }"
      v-show="left > 0"
    >
      <slot name="left"></slot>
    </div>
    <div
      class="divider"
      :style="{ left: left + 'px' }"
      @mousedown.left="dragging = true"
    ></div>
    <div
      class="container"
      style="right: 0"
      :style="{ width: right + 'px' }"
      v-show="right > 0"
    >
      <slot name="right"></slot>
    </div>
  </div>
</template>

<style scoped lang="scss">
.horizontal-division {
  position: relative;
  width: 100%;
  height: 100%;
}

.container,
.divider {
  position: absolute;
  top: 0;
  bottom: 0;
}

.container {
  z-index: 0;
}

.divider {
  z-index: 1;
  width: 8px;
  cursor: col-resize;

  &,
  &:after {
    transform: translateX(-50%);
  }

  &:hover:after {
    opacity: 0.4;
  }

  &:after {
    display: block;
    position: absolute;
    left: 50%;
    top: 0;
    bottom: 0;
    width: 2px;
    content: "";
    opacity: 0.2;
    transition: 0.1s;
    background-color: white;
  }
}

.container > * {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
}
</style>
