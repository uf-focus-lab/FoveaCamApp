<!-- -------------------------------------------------
Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Thin per-camera config view. Reads the live property snapshot from the
  manage-cameras session telemetry and routes every edit through a command; the
  orchestrator owns the camera and persists changes. No `core` access here.

  Three variants:
  - "single"  — full per-camera panel (the original view);
  - "linked"  — an L/R camera while the Fovea Pair link holds: preview + Role
                (editing Role is how you unlink) + read-only value rows;
  - "pair"    — the Fovea Pair panel: one set of controls writing to BOTH
                cameras (`setPair`/`setPairPixelFormat`), bound to the LEFT
                camera's snapshot as the representative readback, gated behind
                the unify prompt while the two configs diverge.

  Slider writes go through a local echo + rAF throttle (the disparity-scope
  `pidRef` pattern): at most one `set` per animation frame, latest value wins,
  and the knob follows the last written value instead of the ~1 Hz snapshot so
  an in-flight stale readout can't yank it mid-drag.
-->
<script setup lang="ts">
import {
  computed,
  onScopeDispose,
  ref,
  shallowRef,
  watch,
  type Directive,
  type WritableComputedRef,
} from "vue";
import StreamView from "@src/components/StreamView.vue";
import RangeSlider from "@src/inputs/range-slider.vue";
import { CAMERA_CONTROLS, TRIGGER_FRAME_MARGIN_US } from "@lib/camera-config";
import { bindField, usePipeFrame, type Session } from "@lib/orchestrator/client";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type {
  CameraView,
  ManageCamerasContract,
  Range,
  TriggerTestVerdict,
} from "./contract";

// Readout formatters from the shared control schema — the same source the
// orchestrator snapshot uses, so the displayed value can't drift from the wire.
const controlFmt: Record<string, (v: number) => string> = Object.fromEntries(
  CAMERA_CONTROLS.map((c) => [c.key, c.format]),
);

const {
  serial = "",
  session,
  variant = "single",
} = defineProps<{
  /** Camera serial ("single"/"linked" variants; the "pair" panel derives its
   *  representative serial from telemetry). */
  serial?: string;
  session: Session<ManageCamerasContract>;
  variant?: "single" | "linked" | "pair";
}>();

const pair = computed(() => (variant === "pair" ? session.telemetry.pair : null));
// The pair panel binds the LEFT camera's snapshot as its readback; both
// cameras receive every write and both linked columns show their own truth.
const camSerial = computed(() => pair.value?.left ?? serial);

const view = computed<CameraView | undefined>(
  () => session.telemetry.views[camSerial.value],
);

// Raw preview off the native `camera:<serial>` pipe. The pair panel has no
// preview (both live in the linked columns) — safe to decide at setup: a pair
// instance is a dedicated element (v-if), its variant never changes.
const framePayload =
  variant === "pair" ? shallowRef(null) : usePipeFrame(nodeId.convert(serial));

const field = <K extends keyof CameraView>(key: K) =>
  variant === "pair"
    ? bindField(session, view, key, "setPair", (key, value) => ({
        key: key as string,
        value,
      }))
    : bindField(session, view, key, "set", (key, value) => ({
        serial: camSerial.value,
        key,
        value,
      }));

const send = (key: string, value: number) =>
  variant === "pair"
    ? void session.call("setPair", { key, value })
    : void session.call("set", { serial: camSerial.value, key, value });

// Echo releases on CONFIRMATION — the readout within EPS (0.5% of the slider
// span, below a visible knob jump) of the write; the hard cap only covers a
// write the camera clamped or quantized past EPS. Cap > one snapshot period,
// so a clean confirm normally lands first.
const ECHO_EPS_SPAN = 0.005;
const ECHO_MAX_MS = 1200;
function echoNum(
  live: () => number,
  span: () => number,
  write: (v: number) => void,
) {
  const echo = ref<number | null>(null);
  let cap: ReturnType<typeof setTimeout> | undefined;
  let pending: number | null = null;
  let scheduled = 0;
  const flush = () => {
    scheduled = 0;
    if (pending === null) return;
    const v = pending;
    pending = null;
    write(v);
  };
  watch(live, (v) => {
    if (echo.value === null) return;
    if (Math.abs(v - echo.value) < ECHO_EPS_SPAN * span()) {
      echo.value = null;
      clearTimeout(cap);
    }
  });
  onScopeDispose(() => {
    clearTimeout(cap);
    cancelAnimationFrame(scheduled);
    flush(); // the final drag value must land even on unmount mid-drag
  });
  return computed<number>({
    get: () => echo.value ?? live(),
    set: (v) => {
      echo.value = v;
      clearTimeout(cap);
      cap = setTimeout(() => (echo.value = null), ECHO_MAX_MS);
      pending = v;
      if (!scheduled) scheduled = requestAnimationFrame(flush);
    },
  });
}

const spanOf = (r?: Range) => (r ? r.max - r.min : 0);
const clampTo = (v: number, r?: Range) =>
  r ? Math.min(Math.max(v, r.min), r.max) : v;
const inRange = (v: number, r?: Range) => !!r && v >= r.min && v <= r.max;

// log10(us)
function logExp(us: number) {
  return Math.log10(us);
}
logExp.inverse = (v: number) => Math.pow(10, v);

type ModeOption = { value: string | boolean | undefined; label: string };
type Control = {
  key: string;
  label: string;
  available: () => boolean;
  mode: { model: WritableComputedRef<any>; options: ModeOption[]; title: string };
  manual: () => boolean;
  slider: WritableComputedRef<number>;
  min: () => number;
  max: () => number;
  step: number;
  detents: () => number[] | undefined;
  readout: () => string;
  /** Units the click-to-type input accepts (= the readout's units). */
  editUnits: string;
  editValue: () => number;
  commit: (value: number) => void;
};

const AUTO_OPTIONS: ModeOption[] = [
  { value: "Off", label: "Manual" },
  { value: "Once", label: "Auto (once)" },
  { value: "Continuous", label: "Auto (cont.)" },
];

const FLICKER_HZ = [50, 60, 100, 120];

const frameRate: Control = {
  key: "frame_rate",
  label: "Frame Rate",
  available: () => !!view.value?.frame_rate_available,
  mode: {
    model: field("frame_rate_enable"),
    options: [
      { value: true, label: "Manual" },
      { value: false, label: "Auto" },
    ],
    title: "Manual: the slider sets the rate; Auto: the camera free-runs",
  },
  manual: () => !!view.value?.frame_rate_enable,
  slider: echoNum(
    () => view.value?.frame_rate ?? 0,
    () => spanOf(view.value?.frame_rate_range),
    (v) => send("frame_rate", v),
  ),
  min: () => view.value?.frame_rate_range.min ?? 0,
  max: () => view.value?.frame_rate_range.max ?? 0,
  step: 1,
  detents: () =>
    FLICKER_HZ.filter((hz) => inRange(hz, view.value?.frame_rate_range)),
  readout: () => controlFmt.frame_rate(view.value?.frame_rate ?? 0),
  editUnits: "FPS",
  editValue: () => view.value?.frame_rate ?? 0,
  commit: (v) => {
    frameRate.slider.value = clampTo(v, view.value?.frame_rate_range);
  },
};

// Anti-flicker detents: exposure = a mains half-period rejects 100/120 Hz
// light flicker. Detents are in the SLIDER's model units — log10(µs) — so
// 1/60 s enters as log10(1e6 / 60). Round decades (1 ms, 10 ms, …) ride along.
const flickerUs = FLICKER_HZ.map((hz) => 1e6 / hz);
function exposureDetents(): number[] {
  const r = view.value?.exposure_range;
  if (!r || r.max <= r.min) return [];
  const us = flickerUs.filter((v) => inRange(v, r));
  for (let k = Math.ceil(logExp(Math.max(r.min, 1))); 10 ** k <= r.max; k++)
    if (10 ** k >= r.min) us.push(10 ** k);
  return [...new Set(us)].map(logExp);
}

const exposure: Control = {
  key: "exposure",
  label: "Exposure",
  available: () => !!view.value?.exposure_auto_available,
  mode: {
    model: field("exposure_auto"),
    options: AUTO_OPTIONS,
    title:
      "Manual: the slider sets exposure; Auto lets the camera meter it (once or continuously)",
  },
  manual: () => view.value?.exposure_auto === "Off",
  // Integer µs: anti-flicker detents like 1/60 s =
  // 16666.7 µs must land exactly, not at 16700 µs.
  slider: echoNum(
    () => logExp(view.value?.exposure ?? 1),
    () =>
      logExp(view.value?.exposure_range.max ?? 1) -
      logExp(view.value?.exposure_range.min ?? 1),
    (v) => send("exposure", Math.round(logExp.inverse(v))),
  ),
  min: () => logExp(view.value?.exposure_range.min ?? 1),
  max: () => logExp(view.value?.exposure_range.max ?? 1),
  step: 0.001,
  detents: exposureDetents,
  readout: () => controlFmt.exposure(view.value?.exposure ?? 0),
  editUnits: "ms",
  editValue: () => (view.value?.exposure ?? 0) / 1000,
  commit: (ms) => {
    exposure.slider.value = logExp(
      clampTo(ms * 1000, view.value?.exposure_range),
    );
  },
};

function dbControl(
  key: "gain" | "black_level",
  label: string,
  availableKey: "gain_auto_available" | "black_level_available",
): Control {
  const range = () => view.value?.[`${key}_range`];
  const ctl: Control = {
    key,
    label,
    available: () => !!view.value?.[availableKey],
    mode: {
      model: field(`${key}_auto`),
      options: AUTO_OPTIONS,
      title: `Manual: the slider sets ${label.toLowerCase()}; Auto lets the camera set it (once or continuously)`,
    },
    manual: () => view.value?.[`${key}_auto`] === "Off",
    slider: echoNum(
      () => view.value?.[key] ?? 0,
      () => spanOf(range()),
      (v) => send(key, v),
    ),
    min: () => range()?.min ?? 0,
    max: () => range()?.max ?? 0,
    step: 0.001,
    detents: () => undefined,
    readout: () => controlFmt[key](view.value?.[key] ?? 0),
    editUnits: "dB",
    editValue: () => view.value?.[key] ?? 0,
    commit: (v) => {
      ctl.slider.value = clampTo(v, range());
    },
  };
  return ctl;
}

const controls: Control[] = [
  frameRate,
  exposure,
  dbControl("gain", "Gain", "gain_auto_available"),
  dbControl("black_level", "Black Level", "black_level_available"),
];

// The pair panel edits everything EXCEPT frame rate: per-camera frame_rate is
// meaningless for the hardware-triggered foveas — the trigger cadence derives
// from exposure (see the Trigger Budget row).
const editControls = computed<Control[]>(() =>
  variant === "pair" ? controls.filter((c) => c.key !== "frame_rate") : controls,
);

const role = field("role");

const formatBusy = ref(false);
async function changePixelFormat(format: string) {
  if (formatBusy.value || format === view.value?.pixel_format) return;
  formatBusy.value = true;
  try {
    if (variant === "pair") await session.call("setPairPixelFormat", { format });
    else await session.call("setPixelFormat", { serial: camSerial.value, format });
  } finally {
    formatBusy.value = false;
  }
}

function reset() {
  void session.call("reset", { serial: camSerial.value });
}

// --- Fovea Pair extras ------------------------------------------------------

const divergent = computed(() => pair.value?.divergent ?? []);

const KEY_LABELS: Record<string, string> = { pixel_format: "Pixel Format" };
for (const c of CAMERA_CONTROLS) {
  KEY_LABELS[c.key] = c.label;
  if (c.autoKey) KEY_LABELS[c.autoKey] = `${c.label} mode`;
}
const divergentLabels = computed(() =>
  divergent.value.map((k) => KEY_LABELS[k] ?? k).join(", "),
);

// Unify runs seconds when pixel formats differ (two sequential reconfigure
// flows) — the buttons must show it and refuse re-entry.
const unifyBusy = ref(false);
async function unify(source: string) {
  if (unifyBusy.value) return;
  unifyBusy.value = true;
  try {
    await session.call("unifyPair", { source });
  } finally {
    unifyBusy.value = false;
  }
}

const budgetText = computed(() => {
  const b = pair.value?.budget;
  if (!b) return "";
  const expUs = Math.max(b.exposureUsL, b.exposureUsR);
  // Name the BINDING term inline: the frame period is
  // max(exposure, camera readout floor) — attribute the rate honestly.
  const frameUs = b.minIntervalMs * 1000 - TRIGGER_FRAME_MARGIN_US;
  const term =
    frameUs > expUs + 1
      ? `readout floor ${(frameUs / 1000).toFixed(2)} ms`
      : `exposure ${(expUs / 1000).toFixed(2)} ms`;
  return `Max trigger rate ≈ ${b.maxRateHz.toFixed(1)} Hz (${term} + margins)`;
});
const budgetTitle = computed(() => {
  const b = pair.value?.budget;
  if (!b) return "";
  return (
    `Trigger pulse covers the slower eye's exposure (${(b.pulseUs / 1000).toFixed(2)} ms). ` +
    `The minimum interval between triggers (${b.minIntervalMs.toFixed(2)} ms) adds the camera-reported ` +
    `readout floor and a fixed ${(TRIGGER_FRAME_MARGIN_US / 1000).toFixed(1)} ms overhead margin. ` +
    `The per-triple settle hold (Settings) adds on top when a tracking app drives the trigger.`
  );
});

// --- Trigger self-test (§Trigger test) --------------------------------------
const triggerTest = computed(() =>
  variant === "pair" ? session.telemetry.trigger_test : null,
);
const testing = ref(false);
async function runTriggerTest() {
  if (testing.value || formatBusy.value || unifyBusy.value) return;
  testing.value = true;
  try {
    await session.call("testTrigger", undefined);
  } finally {
    testing.value = false;
  }
}

type TriggerReadout = { text: string; tone: "muted" | "ok" | "danger"; title: string };
const testedAt = (at: number) =>
  ` Tested ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
const triggerReadout = computed<TriggerReadout>(() => {
  if (testing.value)
    return {
      text: "testing…",
      tone: "muted",
      title:
        "Firing a software then hardware trigger on both fovea cameras (and the Wide Angle camera, if assigned).",
    };
  const r = triggerTest.value;
  if (!r)
    return {
      text: "untested",
      tone: "muted",
      title:
        "Run the trigger self-test to verify the camera→frame path (software) and the hardware trigger wiring.",
    };
  const token = (v: TriggerTestVerdict): string | null =>
    v.sw === "unavailable"
      ? "no probe"
      : v.sw === "fail"
        ? "camera"
        : v.hw === "fail"
          ? "wiring"
          : null;
  // The center camera joins when one holds the Wide Angle role (V0.1 cables it).
  const tested = (["L", "R", "C"] as const).flatMap((side) => {
    const v = r[side];
    return v ? [{ side, v }] : [];
  });
  const who = r.C ? "All three cameras" : "Both fovea cameras";
  const issues: string[] = [];
  let anyFail = false;
  for (const { side, v } of tested) {
    const t = token(v);
    if (t) issues.push(`${side}: ${t}`);
    if (t === "camera" || t === "wiring") anyFail = true;
  }
  if (issues.length)
    return {
      text: issues.join(" · "),
      tone: anyFail ? "danger" : "muted",
      title:
        "camera = the software trigger produced no frame (camera or stream path). " +
        "wiring = software passed but the hardware pulse produced no frame — check that camera's J_CAM cable (trigger on camera Line2). " +
        "no probe = the frame probe is unavailable (camera pipe parked) — not a failure; re-run with the preview open." +
        testedAt(r.at),
    };
  const allHw = tested.every(({ v }) => v.hw === "ok");
  return allHw
    ? {
        text: r.C ? "OK · sw+hw trigger · L R C" : "OK · sw+hw trigger",
        tone: "ok",
        title:
          `${who} produced a frame from a software AND a hardware trigger — the trigger input chain is healthy. ` +
          "The strobe-return line (camera Line3) is only proven by a live trigger-sync engage." +
          testedAt(r.at),
      }
    : {
        text: r.C ? "OK · sw trigger · L R C" : "OK · sw trigger",
        tone: "ok",
        title:
          `${who} produced a frame from a software trigger; the hardware leg was skipped (no controller connected).` +
          testedAt(r.at),
      };
});

// Click-to-type readout: the input replaces the value span in the same box
// (layout-stable). Enter/blur commit, Escape cancels.
const editing = ref<string | null>(null);
const draft = ref("");
const vFocus: Directive<HTMLInputElement> = {
  mounted: (el) => {
    el.focus();
    el.select();
  },
};
function beginEdit(c: Control) {
  if (!c.manual()) return;
  editing.value = c.key;
  draft.value = String(Number(c.editValue().toFixed(3)));
}
// Keyboard exits (Enter/Esc) hand focus back to the slider root so arrow-key
// flow continues; a blur commit doesn't — the user deliberately left.
function refocusSlider(e?: Event) {
  (e?.target as HTMLElement | null)
    ?.closest<HTMLElement>(".range-slider")
    ?.focus();
}
function commitEdit(c: Control, e?: Event) {
  if (editing.value !== c.key) return;
  editing.value = null;
  const n = Number(draft.value);
  if (draft.value.trim() !== "" && Number.isFinite(n)) c.commit(n);
  refocusSlider(e);
}
function cancelEdit(e?: Event) {
  editing.value = null;
  refocusSlider(e);
}
</script>

<template>
  <div class="view">
    <StreamView
      v-if="variant !== 'pair'"
      class="stream"
      :title="view?.description"
      :payload="framePayload"
      width="100%"
      theme="white"
    />
    <header v-if="variant === 'pair'" class="pair-heading">
      <h3>Fovea Pair</h3>
      <p
        class="hint"
        title="Both fovea cameras share one config: every edit here applies to the left and right camera together, and is saved into both cameras' configs. Change either camera's Role to unlink."
      >
        L {{ pair?.left }} · R {{ pair?.right }}
      </p>
    </header>

    <!-- Linked L/R column: read-only values + Role (editing Role unlinks). -->
    <div v-if="variant === 'linked' && view" class="options">
      <h4>
        <span>Role</span>
        <select
          v-model="role"
          class="inline"
          title="Tell the stereo and tracking apps which position this camera occupies; changing it unlinks the Fovea Pair"
        >
          <option :value="undefined">[ NONE ]</option>
          <option value="L">Fovea Left</option>
          <option value="C">Wide Angle</option>
          <option value="R">Fovea Right</option>
        </select>
      </h4>
      <dl class="readouts" title="Read-only — edit exposure, gain, black level, and pixel format in the Fovea Pair panel. Change Role to unlink.">
        <template v-if="view.pixel_format">
          <dt>Pixel Format</dt>
          <dd>{{ view.pixel_format }}</dd>
        </template>
        <template v-for="c in controls" :key="c.key">
          <template v-if="c.available()">
            <dt>{{ c.label }}</dt>
            <dd>{{ c.readout() }}{{ c.manual() ? "" : " (auto)" }}</dd>
          </template>
        </template>
      </dl>
    </div>

    <div v-else-if="view" class="options">
      <h4 v-if="variant !== 'pair'">
        <span>Role</span>
        <select
          v-model="role"
          class="inline"
          title="Tell the stereo and tracking apps which position this camera occupies. Assigning both Fovea Left and Fovea Right links those two cameras into the Fovea Pair panel."
        >
          <option :value="undefined">[ NONE ]</option>
          <option value="L">Fovea Left</option>
          <option value="C">Wide Angle</option>
          <option value="R">Fovea Right</option>
        </select>
      </h4>
      <!-- Divergent pair: explicit unify choice before any linked edit. -->
      <template v-if="variant === 'pair' && divergent.length">
        <p class="hint diverge" title="Nothing is overwritten until you pick a side.">Configs differ: {{ divergentLabels }}.</p>
        <div class="unify">
          <button
            :disabled="unifyBusy"
            title="Copy the left camera's settings onto the right camera"
            @click="unify(pair!.left)"
          >
            {{ unifyBusy ? "Unifying…" : "Use Left's" }}
          </button>
          <button
            :disabled="unifyBusy"
            title="Copy the right camera's settings onto the left camera"
            @click="unify(pair!.right)"
          >
            {{ unifyBusy ? "Unifying…" : "Use Right's" }}
          </button>
        </div>
      </template>
      <template v-else>
      <template v-if="view.pixel_format_options?.length">
        <h4>
          <span>Pixel Format</span>
          <select
            class="inline"
            :value="view.pixel_format"
            :disabled="formatBusy"
            title="Sensor readout format; changing it briefly pauses the preview. 12-bit packed (e.g. BayerRG12p) reads full sensor depth to cut debayer quantization noise."
            @change="
              changePixelFormat(($event.target as HTMLSelectElement).value)
            "
          >
            <option
              v-for="fmt in view.pixel_format_options"
              :key="fmt"
              :value="fmt"
            >
              {{ fmt }}
            </option>
          </select>
        </h4>
      </template>
      <template v-for="c in editControls" :key="c.key">
        <template v-if="c.available()">
          <h4>
            <span>{{ c.label }}</span>
            <select
              v-model="c.mode.model.value"
              class="inline"
              :title="c.mode.title"
              :aria-label="`${c.label} mode`"
            >
              <option
                v-for="o in c.mode.options"
                :key="String(o.value)"
                :value="o.value"
              >
                {{ o.label }}
              </option>
            </select>
          </h4>
          <RangeSlider
            v-model="c.slider.value"
            :min="c.min()"
            :max="c.max()"
            :step="c.step"
            :detents="c.detents()"
            :disabled="!c.manual()"
          >
            <span>{{ c.label }}</span>
            <!-- keydown.stop: arrow keys must edit the TEXT, not bubble to the
                 slider root's handler (which would move the camera value under
                 the caret). -->
            <input
              v-if="editing === c.key"
              v-focus
              v-model="draft"
              class="value"
              :title="`Exact value in ${c.editUnits}; Enter commits, Esc cancels`"
              @mousedown.stop
              @keydown.stop
              @keydown.enter="commitEdit(c, $event)"
              @keydown.esc="cancelEdit($event)"
              @blur="commitEdit(c)"
            />
            <span
              v-else
              class="value"
              :class="{ editable: c.manual() }"
              :title="c.manual() ? 'Click to type an exact value' : undefined"
              @mousedown.stop
              @click="beginEdit(c)"
            >
              {{ c.readout() }}
            </span>
          </RangeSlider>
        </template>
      </template>
      <template v-if="variant === 'pair' && pair?.budget">
        <h4><span>Trigger Budget</span></h4>
        <p class="hint budget" :title="budgetTitle">{{ budgetText }}</p>
      </template>
      <template v-if="variant === 'pair' && pair">
        <h4><span>Trigger</span></h4>
        <div class="trigger-test">
          <button
            class="test-btn"
            :disabled="testing || formatBusy || unifyBusy"
            title="Fires a real software then hardware trigger on both fovea cameras (and the Wide Angle camera, if assigned) and checks a frame arrives. Briefly pauses the previews."
            @click="runTriggerTest"
          >
            test
          </button>
          <span
            class="verdict"
            :class="triggerReadout.tone"
            :title="triggerReadout.title"
          >
            {{ triggerReadout.text }}
          </span>
        </div>
      </template>
      <button
        v-if="variant === 'single'"
        class="reset-config"
        title="Reset this camera to auto (run once), clear its role, and erase its saved configuration"
        @click="reset"
      >
        Reset Config
      </button>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.view {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 1em;
}

// Drawer-standard column idiom (disparity-scope drawer): h4 header row =
// group name + inline mode select; controls below; spacing over borders.
.options {
  h4 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0.75em 0 0.25em;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    font-size: 0.8em;
    letter-spacing: 0.02em;

    &:first-child {
      margin-top: 0;
    }
  }

  select.inline {
    font: inherit;
    text-transform: none;
    letter-spacing: 0;
    color: inherit;
    background: var(--tint-1);
    border: 1px solid var(--tint-4);
    border-radius: 4px;
    padding: 0.1em 0.6em;
    cursor: pointer;

    &:hover {
      background: var(--tint-3);
    }
    &:focus {
      outline: 1px solid var(--accent);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
}

// Readout / inline editor share one right-aligned box inside the slider slot
// so swapping them never reflows the row.
.value {
  min-width: 11ch;
  box-sizing: border-box;
  text-align: right;
  pointer-events: auto;
}
span.value.editable {
  cursor: text;
}
input.value {
  width: 11ch;
  height: 1.6em;
  font: inherit;
  color: inherit;
  background: var(--tint-1);
  border: 1px solid var(--tint-3);
  border-radius: 4px;
  padding: 0 0.4ch;
}

.reset-config {
  display: block;
  margin: 1.25em 0 0 auto;
  cursor: pointer;
  font: inherit;
  font-size: 0.8em;
  padding: 0.2em 1ch;
  border-radius: 4px;
  color: var(--danger-text);
  border: 1px solid var(--danger-strong);
  background: none;
  opacity: 0.8;

  &:hover {
    opacity: 1;
    background: var(--danger-bg);
  }
  &:active {
    background: var(--danger-bg);
    filter: brightness(1.4);
  }
}

.hint {
  margin: 0.5em 0 0;
  font-size: 0.8em;
  opacity: 0.6;
}

.pair-heading {
  h3 {
    margin: 0;
    font-size: 1em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .hint {
    margin-top: 0.25em;
  }
}

// Linked-column read-only rows: same visual weight as a slider readout.
.readouts {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.35em 1ch;
  margin: 0;

  dt {
    opacity: 0.7;
  }
  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
}

.hint.diverge {
  color: var(--danger-text);
  opacity: 0.9;
}

.unify {
  display: flex;
  gap: 1ch;
  margin-top: 0.5em;

  button {
    flex: 1;
    cursor: pointer;
    font: inherit;
    font-size: 0.8em;
    padding: 0.3em 1ch;
    border-radius: 4px;
    color: inherit;
    border: 1px solid var(--tint-4);
    background: var(--tint-1);

    &:hover {
      background: var(--tint-3);
    }
  }
}

.hint.budget {
  cursor: help;
  font-variant-numeric: tabular-nums;
}

.unify button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.trigger-test {
  display: flex;
  align-items: center;
  gap: 1ch;

  .test-btn {
    cursor: pointer;
    font: inherit;
    font-size: 0.8em;
    padding: 0.2em 1.2ch;
    border-radius: 4px;
    color: inherit;
    border: 1px solid var(--tint-4);
    background: var(--tint-1);

    &:hover {
      background: var(--tint-3);
    }
    &:disabled {
      cursor: wait;
      opacity: 0.6;
    }
  }

  .verdict {
    font-size: 0.8em;
    font-variant-numeric: tabular-nums;
    cursor: help;

    &.muted {
      opacity: 0.6;
    }
    &.ok {
      color: var(--ok);
    }
    &.danger {
      color: var(--danger-text);
    }
  }
}
</style>
