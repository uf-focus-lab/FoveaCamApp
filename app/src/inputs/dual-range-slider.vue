<script setup lang="ts">
// A two-thumb `range-slider`: the same track, infill (here BETWEEN the thumbs),
// cursor glyphs, label slot, keyboard and right-click-neutral conventions, for a
// `[start, end]` interval. The thumbs never cross and never come closer than
// `minGap`. A press grabs the NEARER thumb and drags it through a WINDOW
// listener (no pointer capture — RangeSlider's rule, so a release anywhere ends
// it); each thumb is its own tab stop, arrows step the focused one.
//
//   <DualRangeSlider v-model="window" :min="0" :max="0.95" :step="0.005" :min-gap="0.005"
//                    label="Exposure window" :value-text="(v) => ms(v)">
//     <span>Window</span><span>{{ readout }}</span>
//   </DualRangeSlider>
//
// The value math lives in `./dual-range` (unit-tested).
import { computed, ref, useTemplateRef, type PropType } from "vue";
import {
  moveThumb,
  nearestThumb,
  normalizePair,
  type Pair,
  type Thumb,
} from "./dual-range";

const props = defineProps({
  modelValue: {
    type: Array as unknown as PropType<Pair>,
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
  /** Keyboard increment (modifiers scale it by 0.1 each, as RangeSlider). */
  step: {
    type: Number,
    required: false,
    default: 1,
  },
  /** Smallest allowed `end − start`; the dragged thumb stops this far short of
   *  the other one. */
  minGap: {
    type: Number,
    required: false,
    default: 0,
  },
  /** Right-click reset target. UNDECLARED = no meaningful neutral: right-click
   *  reset is disabled (RangeSlider's rule — a stray context-click must never
   *  move a live hardware setting). */
  neutral: {
    type: Array as unknown as PropType<Pair | undefined>,
    required: false,
    default: undefined,
  },
  disabled: {
    type: Boolean,
    required: false,
    default: false,
  },
  color: {
    type: String,
    required: false,
    default: "currentColor",
  },
  /** Accessible name of the whole control (the `role="group"` root); each
   *  thumb is named `<label> start` / `<label> end`. */
  label: {
    type: String,
    required: false,
    default: undefined,
  },
  /** A thumb's human-readable value (its `aria-valuetext`, e.g. the ms
   *  readout); omitted, assistive tech reads the raw number. */
  valueText: {
    type: Function as PropType<(v: number) => string>,
    required: false,
    default: undefined,
  },
});
const emit = defineEmits<{ (e: "update:modelValue", v: Pair): void }>();
const element = useTemplateRef<HTMLDivElement>("el");
// Function refs, indexed by thumb: a `v-for` template-ref array does not
// guarantee source order.
const thumbs: (HTMLDivElement | null)[] = [null, null];
function bindThumb(i: number, el: unknown) {
  thumbs[i] = (el as HTMLDivElement | null) ?? null;
}

// `step` is the grid a gap-limited thumb lands on (`./dual-range`), so an
// emitted `end − start` is never a rounding error short of `minGap`.
const bounds = computed(() => ({
  min: props.min,
  max: props.max,
  minGap: props.minGap,
  step: Math.abs(props.step),
}));
/** The model as drawn — a stale out-of-range value never paints a thumb past
 *  the track. */
const pair = computed(() => normalizePair(props.modelValue, bounds.value));

function ratioOf(value: number) {
  const { min: l, max: r } = props;
  if (r === l) return 0.5;
  return (value - l) / (r - l);
}

const cursorStyles = computed(() =>
  pair.value.map((v) => ({ left: `${ratioOf(v) * 100}%` })),
);

const infillStyle = computed(() => {
  const [a, b] = pair.value.map(ratioOf);
  return {
    left: `${a * 100}%`,
    right: `${(1 - b) * 100}%`,
  };
});

function set(which: Thumb, value: number) {
  const next = moveThumb(pair.value, which, value, bounds.value);
  const cur = props.modelValue;
  if (next[0] !== cur[0] || next[1] !== cur[1]) emit("update:modelValue", next);
}

const active = ref<Thumb | null>(null);
function valueAt(e: MouseEvent): number | null {
  const el = element.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  return props.min + ratio * (props.max - props.min);
}

function trackUntilRelease(e: MouseEvent) {
  if (!(e.buttons & 1) || active.value === null) {
    active.value = null;
    window.removeEventListener("mousemove", trackUntilRelease);
    return;
  }
  const v = valueAt(e);
  if (v !== null) set(active.value, v);
}

function track(e: MouseEvent) {
  if (props.disabled || !(e.buttons & 1)) return;
  const v = valueAt(e);
  if (v === null) return;
  const which = nearestThumb(pair.value, v);
  active.value = which;
  // The root is not a tab stop (each thumb is): hand focus to the grabbed
  // thumb so the arrows continue where the pointer left off.
  e.preventDefault();
  thumbs[which]?.focus({ preventScroll: true });
  window.addEventListener("mousemove", trackUntilRelease);
  trackUntilRelease(e);
}

function resetToNeutral(e: MouseEvent) {
  e.preventDefault();
  if (props.disabled || props.neutral === undefined) return;
  emit("update:modelValue", normalizePair(props.neutral, bounds.value));
}

function handleKeydown(which: Thumb, e: KeyboardEvent) {
  if (props.disabled) return;
  const modifiers = [e.ctrlKey, e.metaKey, e.altKey, e.shiftKey];
  const scale = modifiers.reduce((a, b) => a * (b ? 0.1 : 1), 1);
  let dir: number;
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowDown":
      dir = -1;
      break;
    case "ArrowRight":
    case "ArrowUp":
      dir = 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  set(which, pair.value[which] + dir * scale * Math.abs(props.step));
}

const THUMB_LABELS = computed(() =>
  props.label
    ? [`${props.label} start`, `${props.label} end`]
    : ["Start", "End"],
);
/** Per-thumb ARIA bounds: each thumb's travel is limited by the other. */
const thumbAria = computed(() => {
  const [lo, hi] = pair.value;
  const gap = Math.max(0, props.minGap);
  return [
    { min: props.min, max: hi - gap, now: lo },
    { min: lo + gap, max: props.max, now: hi },
  ];
});
</script>

<template>
  <div
    ref="el"
    class="dual-range-slider"
    role="group"
    :aria-label="label"
    :style="{ color }"
    :aria-disabled="disabled || undefined"
    :class="{ dragging: active !== null }"
    @mousedown="track"
    @contextmenu="resetToNeutral"
    :disabled="disabled || undefined"
  >
    <div class="intent">
      <slot></slot>
      <div class="infill" :style="infillStyle"></div>
    </div>
    <div
      v-for="(s, i) in cursorStyles"
      :key="i"
      :ref="(el) => bindThumb(i, el)"
      class="cursor"
      :class="{ active: active === i }"
      role="slider"
      :style="s"
      :tabindex="disabled ? undefined : 0"
      :aria-label="THUMB_LABELS[i]"
      :aria-valuemin="thumbAria[i].min"
      :aria-valuemax="thumbAria[i].max"
      :aria-valuenow="thumbAria[i].now"
      :aria-valuetext="valueText?.(thumbAria[i].now)"
      :aria-disabled="disabled || undefined"
      @keydown="handleKeydown(i as Thumb, $event)"
    ></div>
  </div>
</template>

<style lang="scss" scoped>
// RangeSlider's look, verbatim where it applies: the same body, outline, label
// row, infill blend and cursor glyphs — only the focus ring moves from the
// root to whichever thumb holds it (`:focus-within`).
.dual-range-slider {
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
  // Never on a disabled slider: hover must not lift it back to full strength
  // (nor can it hold focus — its thumbs drop their tabindex while disabled).
  &:not([disabled]):hover,
  &.dragging,
  &:focus-within {
    opacity: 1;
  }
  &.dragging,
  &:focus-within {
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
    background-color: currentColor;
  }
  .infill {
    pointer-events: none;
    mix-blend-mode: exclusion;
  }
  .cursor {
    width: 0.2ch;
    transform: translateX(-50%);
    outline: none;
    // RangeSlider's rule: a press lands on the root, which picks the nearer
    // thumb and focuses it — a thumb is never a hit target of its own.
    pointer-events: none;
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
  // Hover shows both thumbs' glyphs dimmed; the thumb being dragged or holding
  // focus shows them at full strength, so the arrows' target is unambiguous.
  &:not([disabled]):hover .cursor,
  &.dragging .cursor,
  &:focus-within .cursor {
    &::before,
    &::after {
      opacity: 0.45;
      --offset: -1ch;
    }
  }
  .cursor.active,
  .cursor:focus {
    &::before,
    &::after {
      opacity: 1;
      --offset: -1ch;
    }
  }
}
</style>
