<!-- -------------------------------------------------
Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
This source code is licensed under the MIT license.
You may find the full license in project root directory.
--------------------------------------------------- -->
<!--
  Welcome window — the launcher shown whenever no app window is open: one button
  per app (each opens via the main-process window manager) plus a STATUS-ONLY
  panel (logo, connection status, live camera list). It holds NO hardware — its
  data comes from the persistent enumerate-only PROBE process, forwarded by main
  over the `probe:cameras` bridge event — so entering an app never drains it.
  spec: docs/spec/windows.md#window-manager
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { sortedCameras, welcomeStatus, type ProbeCamera } from "@lib/orchestrator/probe";
import Store from "@lib/store";
import { connectedTripleHash } from "@lib/calibration-data";
import { resolveNickname } from "@lib/calibration-records";
import { launchableApps } from "./app-registry";
import TitleBar from "../components/TitleBar.vue";
import { FontAwesomeIcon as Icon } from "@fortawesome/vue-fontawesome";
import {
  faCameraAlt,
  faCameraRotate,
  faCircleHalfStroke,
  faCompass,
  faCrosshairs,
  faFlagCheckered,
  faGears,
  faObjectGroup,
  faObjectUngroup,
  faRulerCombined,
  faSatelliteDish,
} from "./icons";

const titleBarHeight = ref(0);

// Live camera list from the enumerate-only probe (main → onProbeCameras). No
// orchestrator connection, no camera lease — just the plain enumerated list.
const cameras = ref<ProbeCamera[]>([]);
const probing = ref(false);
let disposeProbe: (() => void) | null = null;
onMounted(() => {
  disposeProbe = window.foveaBridge.onProbeCameras((list) => {
    cameras.value = list;
    probing.value = true; // first snapshot arrived — the probe is answering
  });
});
onUnmounted(() => disposeProbe?.());

const status = computed(() => welcomeStatus(cameras.value, probing.value));
const connected = computed(() => probing.value && cameras.value.length > 0);
const cameraList = computed(() => sortedCameras(cameras.value));

// Per-triple NICKNAME (calibration-records-v2): when the connected rig forms a
// complete L/C/R triple that has a nickname, show it. The store is main-backed,
// so SUBSCRIBE to the triple doc (Store.open, not a one-shot read) — a Settings
// nickname edit while Welcome is open must reflect live, not wait for the next
// camera-list change.
const rigNickname = ref<string | null>(null);
let nicknameDoc: { nickname?: string } | null = null;
watch(cameras, () => void refreshNickname(), { immediate: true });
async function refreshNickname() {
  const hash = await connectedTripleHash(cameras.value);
  if (!hash) {
    rigNickname.value = null;
    nicknameDoc = null;
    return;
  }
  // Subscribed reactive doc — cached per path, live-updated by main broadcasts.
  nicknameDoc = await Store.open<{ nickname?: string }>(["triples", hash]);
  const doc = nicknameDoc;
  watchEffect(() => {
    // Re-runs on any broadcast that touches the doc; guarded so a stale
    // watcher from a previous hash stops writing once the rig changes.
    if (nicknameDoc === doc) rigNickname.value = resolveNickname(hash, { [hash]: doc });
  });
}

// Launcher entries — dev-only apps hidden in production builds.
const applications = launchableApps.filter((a) => a.group === "application");
const calibration = launchableApps.filter((a) => a.group === "calibration");
const utilities = launchableApps.filter((a) => a.group === "utility");

const iconOf: Record<string, object> = {
  "disparity-scope": faCircleHalfStroke,
  "multi-fovea": faObjectGroup,
  "split-tracking": faCrosshairs,
  "manual-control": faCompass,
  "mirror-link": faSatelliteDish,
  "single-capture": faCameraAlt,
  playground: faObjectUngroup,
  "manage-cameras": faGears,
  "calibrate-intrinsic": faCameraAlt,
  "calibrate-extrinsic": faCameraRotate,
  "calibrate-distortion": faFlagCheckered,
  "calibrate-drift": faRulerCombined,
};

function open(appId: string) {
  window.foveaBridge.openAppWindow(appId);
}
function openConfig() {
  window.foveaBridge.openConfigWindow();
}
</script>

<template>
  <div class="main" :style="{ top: titleBarHeight + 'px' }">
    <div class="preview-pane">
      <div class="preview">
        <div class="no-preview">
          <img src="/FoveaCam Duo Mini.png" style="max-width: 55%" />
        </div>
      </div>
      <div class="rig-name" v-if="rigNickname">{{ rigNickname }}</div>
      <div class="camera-list" v-if="cameraList.length > 0">
        <div class="camera" v-for="c in cameraList" :key="c.serial">
          <Icon :icon="faCameraAlt" class="cam-icon" />
          <span class="cam-role" v-if="c.role">{{ c.role }}</span>
          <span class="cam-name">{{ c.vendor }} {{ c.model }}</span>
          <span class="cam-serial">{{ c.serial }}</span>
        </div>
      </div>
      <div class="status-row">
        <span class="dot" :class="{ ok: connected }"></span>
        <span>{{ status }}</span>
      </div>
    </div>
    <div class="modules">
      <div class="group">
        <h2>Applications</h2>
        <button
          v-for="a in applications"
          :key="a.id"
          :style="{ '--color': a.dev ? '#f6f' : 'var(--accent-bright)' }"
          @click="open(a.id)"
        >
          <Icon :icon="iconOf[a.id]" /> {{ a.title }}
        </button>
      </div>
      <div class="group">
        <h2>Calibration</h2>
        <button
          v-for="a in calibration"
          :key="a.id"
          style="--color: var(--warn)"
          @click="open(a.id)"
        >
          <Icon :icon="iconOf[a.id]" /> {{ a.title }}
        </button>
      </div>
      <div class="group">
        <h2>Utilities</h2>
        <button
          v-for="a in utilities"
          :key="a.id"
          style="--color: var(--warn)"
          @click="open(a.id)"
        >
          <Icon :icon="iconOf[a.id]" /> {{ a.title }}
        </button>
        <button style="--color: var(--text-muted)" @click="openConfig">
          <Icon :icon="faGears" /> Settings
        </button>
      </div>
      <div style="flex-grow: 1"></div>
      <div class="footnote">Copyright © 2026 Yuxuan Zhang</div>
    </div>
  </div>
  <TitleBar title="FoveaCam Duo" @height="(h) => (titleBarHeight = h)" />
</template>

<style scoped lang="scss">
.main {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  * {
    user-select: none;
  }
}

.preview-pane {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-app);

  .preview {
    position: relative;
    flex-grow: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .no-preview {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2em;
  }

  .rig-name {
    padding: 0.6em 1em 0;
    color: var(--accent-bright);
    font-weight: 700;
    font-size: 1.05em;
    border-top: 1px solid var(--tint-2);

    & + .camera-list {
      border-top: none; // avoid a double divider under the rig name
    }
  }

  .camera-list {
    display: flex;
    flex-direction: column;
    gap: 0.25em;
    padding: 0.6em 1em;
    border-top: 1px solid var(--tint-2);

    .camera {
      display: flex;
      align-items: center;
      gap: 1ch;
      color: var(--text-dim);
      font-size: 0.9em;

      .cam-icon {
        color: var(--ok);
      }
      .cam-role {
        font-weight: bold;
        color: var(--accent-bright);
        min-width: 1.5ch;
      }
      .cam-serial {
        margin-left: auto;
        color: var(--text-disabled);
        font-variant-numeric: tabular-nums;
      }
    }
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 1ch;
    color: var(--text-dim);
    padding: 0.6em 1em;
    border-top: 1px solid var(--tint-2);
    font-size: 0.9em;

    .dot {
      width: 0.7em;
      height: 0.7em;
      border-radius: 50%;
      background: var(--danger);
      &.ok {
        background: var(--ok);
      }
    }
  }
}

.modules {
  background-color: var(--bg-panel-alt);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  min-width: 32ch;
  border-left: 1px solid var(--tint-4);
  overflow-y: auto;
  --color: white;

  .group {
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0;
    margin: 0.5rem 0;
    &:not(:first-child) {
      border-top: 1px solid var(--tint-4);
    }
    h2 {
      font-size: 1em;
      margin: 1rem 1.5rem;
      color: var(--text-dim);
      font-weight: bolder;
    }
  }

  button {
    font-size: 1.2em;
    padding: 0.5em 0.8em;
    background: none;
    border: none;
    color: var(--color);
    filter: saturate(0.6);
    cursor: pointer;
    min-width: 12ch;
    text-align: left;
    font-family: inherit;
    font-weight: 500;
    border-left: 0.8ch solid transparent;

    &:hover {
      filter: saturate(1);
      border-left: 0.8ch solid var(--color);
      background-color: var(--tint-1);
    }

    &:active {
      filter: saturate(1);
      border-left: 0.8ch solid var(--color);
      background-color: var(--tint-2);
    }
  }

  .footnote {
    color: var(--text-disabled);
    text-align: center;
    padding: 1em 0;
  }
}
</style>
