// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// (kind, session) → module-owned component registry.
// The `debug` window class is a generic host that mounts a MODULE-OWNED
// component full-window; a module opts in purely by registering a loader here
// (no window-framework changes). The component owns its own passive
// contract/pipe subscriptions — the window shell is contract-agnostic.
//
// `kind` lets ONE session own more than one such window at a time:
//   - `debugger`       — the module's `Debugger.vue` (e.g. disparity-scope's
//                        match strip + correlation heatmaps)
//   - `capture`        — the module's capture-preview component (previews +
//                        SaveControls/SaveReport)
// The window dedupe key is `debug:<session>:<kind>` (see WindowManager.
// toggleDebug), so a session's debugger and capture-preview windows coexist.

import { defineComponent, h, type Component } from "vue";

type Loader = () => Promise<{ default: Component }>;

// Session-baked capture-preview loader:
// the shared `@src/capture/CapturePreview.vue` is parameterized by a `session`
// prop, but the DebugWindow shell mounts the resolved component WITHOUT passing
// props (it stays contract-agnostic). So the registry bakes the session name in
// per app — a tiny wrapper that renders the shared preview with its `session`.
function capturePreviewFor(session: string): Loader {
  return async () => {
    const { default: CapturePreview } = await import("@src/capture/CapturePreview.vue");
    return {
      default: defineComponent({
        name: `CapturePreview-${session}`,
        setup: () => () => h(CapturePreview, { session }),
      }),
    };
  };
}

/** Every app that composes the capture helper — registers a
 *  `(session, "capture")` preview window, so AppWindow's camera icon toggles it. */
const CAPTURE_SESSIONS = [
  "manual-control",
  "mirror-link",
  "multi-fovea",
  "disparity-scope",
  "calibrate-drift",
  "calibrate-distortion",
  "calibrate-extrinsic",
  "calibrate-intrinsic",
] as const;

/** The module-component kinds a `debug`-class window can host. Add a new kind
 *  here + a `<kind>Title` entry below + a per-session loader in `registries`. */
export type DebugKind = "debugger" | "capture";

const registries: Record<DebugKind, Record<string, Loader>> = {
  debugger: {
    "disparity-scope": () => import("@modules/disparity-scope/Debugger.vue"),
  },
  // Capture-preview windows: the SHARED preview component, session-baked per app.
  capture: Object.fromEntries(
    CAPTURE_SESSIONS.map((session) => [session, capturePreviewFor(session)]),
  ) as Record<string, Loader>,
};

/** The `debug`-window TitleBar caption for each kind (the session name rides as
 *  the subtitle). */
const titles: Record<DebugKind, string> = {
  debugger: "Debugger",
  capture: "Capture",
};

/** Normalize a raw URL/bridge `kind` string to a known kind (defaults to the
 *  original debugger kind so pre-kind callers keep working). */
export function asDebugKind(kind: string | undefined | null): DebugKind {
  return kind === "capture" ? "capture" : "debugger";
}

export function debugLoaderFor(kind: DebugKind, session: string): Loader | null {
  return registries[kind]?.[session] ?? null;
}

export function debugKindTitle(kind: DebugKind): string {
  return titles[kind];
}
