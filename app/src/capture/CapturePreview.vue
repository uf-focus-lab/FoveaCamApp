<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Shared capture-preview window body: the capture previews +
  SaveControls/SaveReport, parameterized by session name. A `debug`-class
  window (`kind: "capture"`) the camera icon toggles, mounted full-window by
  DebugWindow.

  The window is a PASSIVE viewer over ANY capturable app's session (the debugger
  pattern): the opener app window keeps the session active/leased; this window
  only reads the server-held capture resources (via the minimal `captureContract`
  — the WS telemetry stream carries every field regardless) and forwards save.
  `current_capture` is a per-window global, so constructing a `Capture` facade
  here does not collide with the app window's.

  The `session` prop is baked per-app by `debug-registry.ts` (the DebugWindow
  shell mounts this component without passing props, so the registry loader
  wraps it with the session name).
-->
<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useSession } from "@lib/orchestrator/client";
import { isEmpty } from "@lib/util";
import type { FramePayload } from "@lib/orchestrator/protocol";
import { captureContract } from "./contract";
import Capture from "./index";
import SaveControls from "./SaveControls.vue";
import SaveReport from "./SaveReport.vue";
import PreviewMeta from "./preview-meta/index.vue";
import PreviewImage from "./preview-image/index.vue";
import HorizontalDivision from "@src/layouts/HorizontalDivision.vue";

const props = defineProps<{ session: string }>();

// Passive subscription over the minimal capture contract — the opener app owns
// the active session; this window only pulls held resources + forwards save.
const session = useSession(captureContract, props.session, { passive: true });

// The renderer-side save-path/save facade (SavePath UI + current_capture
// registration). Capture DRIVING lives in the app window — this window is a
// passive VIEWER that pulls the node's held resources.
const cap = new Capture(session, props.session);

// ── DATA-SOURCE SEAM ───────────────────────────────────────────────────────
// Preview = the capture node's ACTUAL held resources: the resource list +
// metadata ride `telemetry.capture_meta` (the node's manifest), and each IMAGE
// is PULLED on demand via `getCapturePreview` (the node downconverts its real
// full-depth resource to 8-bit BGRA). Re-pulled whenever a capture/raster run
// republishes `capture_meta`.
function* entries() {
  const meta = session.telemetry.capture_meta;
  for (const name of Object.keys(meta)) yield { name, meta: meta[name] as any };
}

const hasMeta = (m: unknown): boolean =>
  Array.isArray(m) ? m.some((x) => !isEmpty(x)) : !isEmpty(m);
const meta_entries = computed(() =>
  [...entries()]
    .filter(({ meta }) => hasMeta(meta))
    .map(({ name, meta }) => [name, meta] as const),
);

// Pulled previews, keyed by resource name (an array for a raster/indexed
// resource, a single payload otherwise). Repopulated on every `capture_meta`
// change by querying the node — the byte-source of what will be saved.
type Preview = FramePayload | null;
const previews = shallowRef<Record<string, Preview | Preview[]>>({});

async function refreshPreviews(): Promise<void> {
  const meta = session.telemetry.capture_meta;
  const next: Record<string, Preview | Preview[]> = {};
  await Promise.all(
    Object.keys(meta).map(async (name) => {
      const m = meta[name];
      if (Array.isArray(m)) {
        next[name] = await Promise.all(
          m.map((_, i) => cap.getPreview(name, i)),
        );
      } else {
        next[name] = await cap.getPreview(name);
      }
    }),
  );
  previews.value = next;
}
watch(() => session.telemetry.capture_meta, () => void refreshPreviews(), {
  deep: true,
  immediate: true,
});

// Flattened tiles: an indexed (raster) resource fans out to one tile per
// set-point in ASCENDING set-point order, each titled to match its on-disk
// path (`left/03`, same pad rule as capture-node save()). Resource GROUPS keep
// the newest-first ordering; the fan-out is ascending within a group.
const image_entries = computed(() =>
  [...entries()]
    .map(({ name }) => [name, previews.value[name] ?? null] as const)
    .filter(([, image]) => !isEmpty(image))
    .toReversed()
    .flatMap(([name, image]) => {
      if (!Array.isArray(image)) return [{ key: name, title: name, image }];
      const pad = Math.max(2, image.length.toString().length);
      return image.flatMap((payload, i) =>
        isEmpty(payload)
          ? []
          : [
              {
                key: `${name}:${i}`,
                title: `${name}/${i.toString().padStart(pad, "0")}`,
                image: payload,
              },
            ],
      );
    }),
);
// ── END DATA-SOURCE SEAM ───────────────────────────────────────────────────

const data_ready = computed(() => Object.keys(session.telemetry.capture_meta).length > 0);

// In-window capture trigger: apps without bespoke capture-driving UI
// (every app but manual-control) get a basic single-shot trigger here, so the
// camera icon → preview window is a complete capture→preview→save loop. The
// server refuses (typed error) while a recording is active — surfaced inline.
const captureBusy = computed(() => session.telemetry.captureBusy === true);
const capture_error = ref<string | null>(null);
async function triggerCapture() {
  if (captureBusy.value) return;
  capture_error.value = null;
  try {
    await cap.capture(); // fresh single-shot (unindexed)
  } catch (e) {
    capture_error.value = e instanceof Error ? e.message : String(e);
  }
}

const save_state = ref<Promise<void> | null>(null);

// Closing the window is the "exit": the server holds the resources until the
// next save/discard/run.
function close() {
  window.close();
}

function save(path: string, img_format: string) {
  if (save_state.value !== null) return;
  const p = cap.save(path, img_format);
  save_state.value = p;
  p.then(() => close());
}
</script>

<template>
  <div class="container">
    <div class="trigger-bar" v-if="save_state === null">
      <button :disabled="captureBusy" @click="triggerCapture">
        {{ captureBusy ? "Capturing…" : "Capture shot" }}
      </button>
      <span class="cap-error" v-if="capture_error">{{ capture_error }}</span>
    </div>
    <SaveControls
      style="height: 4rem"
      :capture="cap"
      @save="save"
      @exit="close"
      :data_ready="data_ready"
      :save_state="save_state !== null"
    />
    <HorizontalDivision
      :division="0.2"
      class="content"
      v-if="save_state === null"
    >
      <template #left>
        <div class="meta-container">
          <PreviewMeta
            v-for="[name, meta] of meta_entries"
            :key="name"
            :name="name"
            :meta="meta"
          />
        </div>
      </template>
      <template #right>
        <div class="frame-container">
          <PreviewImage
            v-for="tile of image_entries"
            :key="tile.key"
            :name="tile.title"
            :image="tile.image"
          />
        </div>
      </template>
    </HorizontalDivision>
    <SaveReport v-else :state="save_state" @exit="close" />
  </div>
</template>

<style scoped lang="scss">
.container {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
  background-color: var(--bg-chrome);
  .content {
    position: absolute;
    top: 4rem;
    left: 0;
    right: 0;
    bottom: 0;
  }
}

// Floating in-window capture trigger (non-invasive overlay — leaves the
// SaveControls/content absolute layout untouched).
.trigger-bar {
  position: absolute;
  right: 1.5rem;
  bottom: 1.5rem;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  button {
    padding: 0.5rem 1rem;
    font-size: 0.95rem;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .cap-error {
    color: var(--danger-text);
    font-size: 0.85rem;
    max-width: 20rem;
  }
}

.meta-container,
.frame-container {
  width: 100%;
  height: 100%;
}
.meta-container {
  overflow-x: hidden;
  overflow-y: scroll;
  padding: 0;
  & > * {
    width: 100%;
    margin: 0;
  }
}
// Responsive tile grid: each tile has a DEFINITE height (grid track width ×
// aspect-ratio), which FrameView's absolutely positioned canvas needs for its
// `max-height: 100%` to resolve. `min(22rem, 100%)` keeps a narrow pane from
// clipping a tile; `scrollbar-gutter` keeps the gutter from reflowing the grid.
.frame-container {
  padding: 2rem;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(22rem, 100%), 1fr));
  gap: 1.5rem;
  align-content: start;
  align-items: start;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;

  // FrameView reserves its hanging title row with an inline `margin-top`; the
  // margin is part of the grid item, so the row gap stays clear of it.
  & > * {
    width: 100%;
    aspect-ratio: 4 / 3;
    min-width: 0;
    min-height: 0;
  }

  & > * :deep(canvas.centered) {
    object-fit: contain;
  }
}
</style>
