<script setup lang="ts">
import { computed, ref, useTemplateRef, type PropType } from "vue";

const props = defineProps({
  modelValue: {
    type: Number,
    required: true,
  },
  min: {
    type: Number,
    required: false,
    default: 0,
  },
  max: {
    type: Number,
    required: false,
    default: 100,
  },
  step: {
    type: Number,
    required: false,
    default: 1,
  },
  /** Right-click reset target + infill anchor. UNDECLARED = no meaningful
   *  neutral: right-click reset is disabled (a stray context-click on e.g. a
   *  live camera-exposure slider must not slam the hardware to range-min) and
   *  the infill anchors at `min`. */
  neutral: {
    type: Number,
    required: false,
    default: undefined,
  },
  disabled: {
    type: Boolean,
    required: false,
    default: false,
  },
  clamp: {
    type: Boolean,
    required: false,
    default: true,
  },
  color: {
    type: String,
    required: false,
    default: "currentColor",
  },
  /** Opt-in snap targets in model-value units. Mouse drags landing within
   *  0.5% of the min–max span lock to the detent exactly; keyboard steps and
   *  right-click reset are unaffected. Each detent draws a static tick. */
  detents: {
    type: Array as PropType<number[]>,
    required: false,
    default: undefined,
  },
});
const emit = defineEmits(["update:modelValue"]);
const element = useTemplateRef<HTMLLabelElement>("el");

function ratioOf(value: number) {
  const { min: l, max: r } = props;
  if (r === l) return 0.5;
  return (value - l) / (r - l);
}

const cursorStyle = computed(() => {
  return {
    left: `${ratioOf(props.modelValue) * 100}%`,
  };
});

const tickStyles = computed(() =>
  (props.detents ?? [])
    .map(ratioOf)
    .filter((r) => r >= 0 && r <= 1)
    .map((r) => ({ left: `${r * 100}%` })),
);

const infillStyle = computed(() => {
  const a = ratioOf(props.modelValue);
  const b = ratioOf(props.neutral ?? props.min);
  const l = Math.min(a, b);
  const r = Math.max(a, b);
  return {
    left: `${l * 100}%`,
    right: `${(1 - r) * 100}%`,
  };
});

function clamp(value: number) {
  if (!props.clamp) return value;
  const { min: l, max: r } = props;
  const [a, b] = [Math.min(l, r), Math.max(l, r)];
  return Math.max(a, Math.min(b, value));
}

const DETENT_SNAP_SPAN = 0.005;
function snap(value: number) {
  const detents = props.detents;
  if (!detents?.length) return value;
  let best = value;
  let bestDist = Math.abs(props.max - props.min) * DETENT_SNAP_SPAN;
  for (const d of detents) {
    const dist = Math.abs(value - d);
    if (dist <= bestDist) [best, bestDist] = [d, dist];
  }
  return best;
}

const drag = ref(false);
function trackUntilRelease(e: MouseEvent) {
  if (!(e.buttons & 1)) {
    drag.value = false;
    window.removeEventListener("mousemove", trackUntilRelease);
    return;
  }
  // Compute position
  const el = element.value;
  if (!el) return console.warn("No label element found");
  const { min: l, max: r } = props;
  const rect = el.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  emit("update:modelValue", snap(clamp(l + ratio * (r - l))));
}

function track(e: MouseEvent) {
  if (props.disabled) return;
  drag.value = true;
  window.addEventListener("mousemove", trackUntilRelease);
  trackUntilRelease(e);
}

function increment(delta: number) {
  const { modelValue, step, min: l, max: r } = props;
  delta *= Math.abs(step) * (Math.sign(r - l) || 1);
  emit("update:modelValue", clamp(modelValue + delta));
}

function resetToNeutral(e: MouseEvent) {
  e.preventDefault();
  if (props.disabled || props.neutral === undefined) return;
  emit("update:modelValue", clamp(props.neutral));
}

function handleKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  const modifiers = [e.ctrlKey, e.metaKey, e.altKey, e.shiftKey];
  const scale = modifiers.reduce((a, b) => a * (b ? 0.1 : 1), 1);
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowDown":
      e.preventDefault();
      increment(-1 * scale);
      break;
    case "ArrowRight":
    case "ArrowUp":
      e.preventDefault();
      increment(1 * scale);
      break;
  }
}
</script>

<template>
  <div
    ref="el"
    class="range-slider"
    role="slider"
    :style="{ color }"
    :tabindex="disabled ? undefined : 0"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="modelValue"
    :aria-disabled="disabled || undefined"
    @mousedown="track"
    @contextmenu="resetToNeutral"
    @keydown="handleKeydown"
    :disabled="disabled || undefined"
  >
    <div class="intent">
      <slot></slot>
      <div class="infill" :style="infillStyle"></div>
    </div>
    <div v-for="(t, i) in tickStyles" :key="i" class="detent" :style="t"></div>
    <div class="cursor" :style="cursorStyle"></div>
  </div>
</template>

<style lang="scss" scoped>
.range-slider {
  position: relative;
  width: 100%;
  height: 2em;
  border-radius: 4px;
  opacity: 0.8;
  background-color: var(--tint-2);
  outline: 1px solid var(--tint-4);
  cursor: ew-resize;
  user-select: none;
  margin-top: calc(1ch + 8px);
  margin-bottom: calc(1ch + 8px);
  // [disabled]: `:disabled` never matches a <div>, and Vue writes a false
  // boolean on a <div> as disabled="false" (which [disabled] WOULD match) —
  // so the template binds `disabled || undefined`: the attribute is present
  // only while disabled.
  &[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
    filter: grayscale(0.5);
  }
  // Never on a disabled slider: a click must not light it back up (it holds
  // no tabindex while disabled, and `:active` still matches a mousedown).
  &:not([disabled]):hover,
  &:not([disabled]):active,
  &:not([disabled]):focus {
    opacity: 1;
  }
  &:not([disabled]):active,
  &:not([disabled]):focus {
    outline: 2px solid var(--theme, var(--accent));
  }
  .intent {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 4px;
    overflow: hidden;
    padding: 0 1ch;
    pointer-events: none;
  }
  .infill,
  .cursor {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
    background-color: currentColor;
  }
  // Static detent ticks: 4px notches on the top/bottom edges only, so they
  // never collide with the slot labels.
  .detent {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    transform: translateX(-50%);
    pointer-events: none;
    opacity: 0.4;
    background: linear-gradient(
      currentColor 0 4px,
      transparent 4px calc(100% - 4px),
      currentColor calc(100% - 4px) 100%
    );
  }
  .cursor {
    width: 0.2ch;
    transform: translateX(-50%);
    // Triangles above and below the slider body (outside)
    &::before,
    &::after {
      content: "";
      position: absolute;
      display: block;
      width: 0;
      height: 0;
      background: none;
      border: 1ch solid transparent;
      left: -1ch;
      transition: 0.1s ease;
      opacity: 0;
      --offset: -2ch;
    }
    &::before {
      top: calc(var(--offset) - 4px);
      border-top-color: currentColor;
    }
    &::after {
      bottom: calc(var(--offset) - 4px);
      border-bottom-color: currentColor;
    }
  }
  &:not([disabled]):hover,
  &:not([disabled]):active,
  &:not([disabled]):focus {
    .cursor::before,
    .cursor::after {
      opacity: 1;
      --offset: -1ch;
    }
  }
  .infill {
    mix-blend-mode: exclusion;
  }
}
</style>
