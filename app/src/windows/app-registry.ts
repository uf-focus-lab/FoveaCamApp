// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// App id → module component loaders for the per-app window shell.
// Dynamic imports keep each entry's initial chunk lean (renderer entries MAY
// share chunks — only preloads must bundle standalone). Playground is dev-gated:
// under `import.meta.env.DEV ? … : {}` the
// production build constant-folds the branch away, so the playground module
// (the last renderer code importing `core` directly) never reaches a
// production bundle — the renderer stays zero-core.

import type { Component } from "vue";
import { APPS, APP_REGISTRY, type AppId, type AppMeta } from "@lib/windows";

type Loader = () => Promise<{ default: Component }>;

// The dev-gated app ids (marked `dev: true` in APP_REGISTRY) — derived from the
// registry so this can't drift if the dev set changes. These are spread in only
// under `import.meta.env.DEV` below; every OTHER (production) app MUST supply a
// loader, enforced at COMPILE TIME by the `satisfies` on `baseLoaders`.
type DevAppId = {
  [K in AppId]: (typeof APP_REGISTRY)[K] extends { dev: true } ? K : never;
}[AppId];

// EXHAUSTIVE loader map for every non-dev app: `satisfies Record<…, Loader>`
// makes a new app added to `APP_REGISTRY` without a loader here a vue-tsc error,
// instead of the silent RUNTIME "Missing app component loader" crash the window
// shell throws (line below) the first time that app's window opens.
const baseLoaders = {
  "disparity-scope": () => import("@modules/disparity-scope/index.vue"),
  "multi-fovea": () => import("@modules/multi-fovea/index.vue"),
  "split-tracking": () => import("@modules/split-tracking/index.vue"),
  "manual-control": () => import("@modules/manual-control/index.vue"),
  "mirror-link": () => import("@modules/mirror-link/index.vue"),
  "single-capture": () => import("@modules/single-capture/index.vue"),
  "manage-cameras": () => import("@modules/manage-cameras/index.vue"),
  "calibrate-intrinsic": () => import("@modules/calibrate-intrinsic/index.vue"),
  "calibrate-extrinsic": () => import("@modules/calibrate-extrinsic/index.vue"),
  "calibrate-distortion": () => import("@modules/calibrate-distortion/index.vue"),
  "calibrate-drift": () => import("@modules/calibrate-drift/index.vue"),
} satisfies Record<Exclude<AppId, DevAppId>, Loader>;

const appLoaders: Partial<Record<AppId, Loader>> = {
  ...baseLoaders,
  ...(import.meta.env.DEV
    ? { playground: () => import("@modules/playground/index.vue") }
    : {}),
};

export type AppRegistryEntry = AppMeta & { loader: Loader };

function entryFor(app: AppMeta): AppRegistryEntry {
  const loader = appLoaders[app.id as AppId];
  if (!loader) throw new Error(`Missing app component loader: ${app.id}`);
  return { ...app, loader };
}

export const appRegistry: Record<string, AppRegistryEntry> = Object.fromEntries(
  APPS.filter((a) => !a.dev || import.meta.env.DEV).map((a) => [a.id, entryFor(a)]),
);

export const launchableApps = Object.values(appRegistry);

export const appComponents: Record<string, Loader> = Object.fromEntries(
  Object.entries(appRegistry).map(([id, app]) => [id, app.loader]),
);
