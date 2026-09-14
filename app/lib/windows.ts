// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Window/app catalog — the single source of truth for the multi-window foundation,
// imported by the renderer, Electron main, vite.config.ts, and the window-manager
// tests. Must stay Vue-free and Node-free (pure data + string helpers). Window classes:
// welcome, app (exclusive), profiler, projection, viewer — taxonomy + exclusivity /
// welcome-count / lifecycle rules in the spec.
// spec: docs/spec/orchestrator-runtime.md#windows

export type WindowClass =
  | "welcome"
  | "app"
  | "profiler"
  | "projection"
  | "viewer"
  | "debug"
  | "config"
  | "telecanvas";

/** URL state params addressing a projection window's stream: the orchestrator
 *  session name and the frame-channel name within it (e.g. session=tracking,
 *  frame=C). */
export type ProjectionParams = { session: string; frame: string };

/** Query-string key carrying a window's stable instance id:
 *  minted by the window manager at spawn (`<appId|class>-<n>`, unique among
 *  live windows), read renderer-side via `@lib/url-state`'s `windowId()`.
 *  Riding the URL makes it stable across reloads and manifest restores (the
 *  manifest persists the full landing URL). The composition protocol keys
 *  `win/<windowId>/...` node namespaces + close-teardown on it. */
export const WINDOW_ID_PARAM = "win";

/** URL query keys pinning a profiler window to ONE orchestrator instance:
 *  the instance id it profiles into (`instance`) and that instance's human
 *  session name / app id (`session`, e.g. `manual-control`). Stamped at open by
 *  `WindowManager.openProfiler`, read renderer-side for the title bar + the
 *  connect broker's fail-closed routing. Immutable for the window's life — a
 *  profiler NEVER re-binds to a newer instance. */
export const PROFILER_INSTANCE_PARAM = "instance";
export const PROFILER_SESSION_PARAM = "session";

export interface AppMeta {
  /** Stable id — module directory name; also the entry HTML basename. */
  id: string;
  /** Human-readable window/launcher title. */
  title: string;
  /** Orchestrator session name this app activates (drain target). */
  session: string | null;
  /** Launcher grouping: Applications / Calibration / Utilities. */
  group: "application" | "calibration" | "utility";
  /** Dev-only app (excluded from production launcher + registry). */
  dev?: true;
  /** This app owns a `debug`-class sub-window (Debugger.vue) — AppWindow shows
   *  a title-bar toggle for it. Value = the tooltip label for the toggle. */
  debugWindow?: string;
}

type AppSpec = Omit<AppMeta, "id">;

export const APP_REGISTRY = {
  // --- applications ---------------------------------------------------
  "disparity-scope": {
    title: "Disparity Scope",
    session: "disparity-scope",
    group: "application",
    debugWindow: "Toggle template-match debugger",
  },
  "multi-fovea": {
    title: "Tracking - Multi",
    session: "multi-fovea",
    group: "application",
  },
  "split-tracking": {
    title: "Tracking - Split",
    session: "split-tracking",
    group: "application",
  },
  "manual-control": {
    title: "Manual Control",
    session: "manual-control",
    group: "application",
  },
  "mirror-link": {
    title: "MirrorLink",
    session: "mirror-link",
    group: "application",
  },
  "single-capture": {
    title: "Single Capture",
    session: "liveview",
    group: "application",
  },
  playground: {
    title: "Playground",
    session: null,
    group: "application",
    dev: true,
  },
  // --- calibration ------------------------------------------------------
  // Titles drop the "Calibrate" prefix — the GROUP heading says it (welcome
  // launcher + the Apps menu section).
  "calibrate-intrinsic": {
    title: "Intrinsic",
    session: "calibrate-intrinsic",
    group: "calibration",
  },
  "calibrate-extrinsic": {
    title: "Extrinsic",
    session: "calibrate-extrinsic",
    group: "calibration",
  },
  "calibrate-distortion": {
    title: "Distortion",
    session: "calibrate-distortion",
    group: "calibration",
  },
  "calibrate-drift": {
    title: "Drift",
    session: "calibrate-drift",
    group: "calibration",
  },
  // --- utilities ------------------------------------------------------
  "manage-cameras": {
    title: "Manage Cameras",
    session: "manage-cameras",
    group: "utility",
  },
} as const satisfies Record<string, AppSpec>;

export type AppId = keyof typeof APP_REGISTRY;

function appFromEntry(id: string, spec: AppSpec): AppMeta {
  return { id, ...spec };
}

export const APPS: readonly AppMeta[] = Object.entries(APP_REGISTRY).map(
  ([id, spec]) => appFromEntry(id, spec),
);

export function appById(id: string): AppMeta | undefined {
  const spec = APP_REGISTRY[id as AppId];
  return spec ? appFromEntry(id, spec) : undefined;
}

/** Preload bundle a window class loads — a pure key mapped to a concrete file
 *  main-side (main.ts's options adapter), so this module stays Node-free.
 *  `renderer` = bridge + shm reader (`sandbox: false`); `profiler` = sandboxed
 *  bridge only; `viewer` = bridge + the standalone playback worker
 *  (`sandbox: false`; NO shm reader/orchestrator port). */
export type PreloadKind = "renderer" | "profiler" | "viewer";

/** Constructor size + minimums for a window class — Electron-agnostic; main.ts
 *  merges these into `BrowserWindowConstructorOptions`. */
export interface WindowSizeSpec {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
}

/**
 * One row of the window taxonomy — the single source of
 * truth every window consumer derives from: the renderer launcher, the main
 * window manager + its metadata→BrowserWindowOptions adapter, the manifest
 * restore planner, and the vite multi-entry build. Centralizing it means a new
 * window class can't silently miss an invariant (singleton status, exclusivity,
 * preload/sandbox mode, welcome-rule participation) across those files.
 */
export interface WindowSpec {
  /** Only ever one instance; a second open focuses the existing one (welcome,
   *  profiler). Distinct from `exclusive` — app is ≤ 1 via drain/switch. */
  singleton: boolean;
  /** Mutually exclusive over camera leases + the controller: at most one open,
   *  opening another drains then switches (app only). */
  exclusive: boolean;
  /** Participates in the welcome rule — welcome shows whenever zero of these
   *  are open (app only; utilities/projections/viewers don't count). */
  countsForWelcome: boolean;
  /** `WindowDescriptor` field that dedupes instances (viewer → one per file);
   *  omitted for 0..N classes with no dedupe. */
  dedupe?: "fileKey";
  /** What happens to a window of this class when its `owner` window closes:
   *  `cascade` = close with the owner (the debug drawer); `survive` = stay
   *  open (projection/viewer keep their frozen last frame). Ownerless windows
   *  ignore this. */
  onOwnerClose: "cascade" | "survive";
  /** Static entry HTML (relative to the renderer root). App windows derive a
   *  per-id entry instead — see `entryFor`. */
  entry?: string;
  preload: PreloadKind;
  sandbox: boolean;
  /** Base window title; app windows append the app's own title. */
  title: string;
  bounds: WindowSizeSpec;
}

export const WINDOWS: Record<WindowClass, WindowSpec> = {
  welcome: {
    singleton: true,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    entry: "windows/welcome.html",
    // Live annotated previews need the shm reader.
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo",
    bounds: { width: 1100, height: 720, minWidth: 800, minHeight: 560 },
  },
  app: {
    // ≤ 1 at a time via `exclusive` (drain/switch), not the singleton-focus path.
    singleton: false,
    exclusive: true,
    countsForWelcome: true,
    onOwnerClose: "survive",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo",
    bounds: { width: 1200, height: 900, minWidth: 800, minHeight: 600 },
  },
  profiler: {
    // 0..N — one per orchestrator instance (not a singleton): a profiler pins to
    // the app instance alive when it was opened; opening the chart icon for the
    // same live instance re-focuses its existing profiler, a NEW app + a new
    // profiler is a second window (WindowManager.openProfiler keys by instance).
    singleton: false,
    exclusive: false,
    countsForWelcome: false,
    // SURVIVE: the profiler outlives its instance's death — it stays
    // open with its accumulated graphs/meters/logs frozen and inspectable, and
    // is NEVER re-attached to a newer instance.
    onOwnerClose: "survive",
    entry: "windows/profiler.html",
    // Sandboxed, bridge-only — no shm reader (stats over the bridge).
    preload: "profiler",
    sandbox: true,
    title: "FoveaCam Duo — Profiler",
    bounds: { width: 720, height: 800 },
  },
  projection: {
    singleton: false,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    entry: "windows/projection.html",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo — Projection",
    bounds: { width: 960, height: 640, minWidth: 320, minHeight: 240 },
  },
  viewer: {
    singleton: false,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    dedupe: "fileKey",
    entry: "windows/viewer.html",
    // Standalone playback: the dedicated viewer preload spawns the
    // in-window worker (MCAP read + decode) — no shm reader, no orchestrator.
    preload: "viewer",
    sandbox: false,
    title: "FoveaCam Duo — Viewer",
    bounds: { width: 1100, height: 760, minWidth: 640, minHeight: 420 },
  },
  debug: {
    // A module's own debugger sub-window (mounts the module's
    // `Debugger.vue` full-window; disparity-scope is its first real user — a
    // vertical stack of the match strip + per-side correlation heatmaps).
    // Owner-bound — closes with its opener app. Projection-style: renderer
    // preload (shm reader), passive subscriber (never drains/switches the app,
    // never counts for welcome).
    singleton: false,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "cascade",
    entry: "windows/debug.html",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo — Debugger",
    bounds: { width: 1080, height: 640, minWidth: 480, minHeight: 320 },
  },
  config: {
    // App-wide Settings window (Cmd+, / "Settings…" menu). SINGLETON like
    // welcome — a second open focuses the existing one. Not exclusive and not
    // counted for welcome (it's a utility overlay, never a hardware holder). It
    // reads/writes config through the store client, so it uses the standard
    // renderer preload (bridge + orchestrator connect); its unbound connect
    // routes to the live app instance when one exists — sharing that instance's
    // store-hub so edits apply LIVE across windows — else to a lightweight
    // non-hardware "settings" instance main forks to serve the store.
    singleton: true,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    entry: "windows/config.html",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo — Settings",
    bounds: { width: 760, height: 680, minWidth: 560, minHeight: 440 },
  },
  telecanvas: {
    // TeleCanvas window (standalone dual-mode module) — the live projection
    // preview + mode switch + client URL / host status. SINGLETON like config:
    // a second open focuses the existing one. Not exclusive, not counted for
    // welcome (a utility overlay, never a hardware holder). It reads/writes
    // config through the store client, so it uses the standard renderer preload;
    // its unbound connect routes to the live app instance (shared store-hub →
    // live cross-window apply) or the non-hardware "settings" instance main forks
    // (same store-backing path as the config window).
    singleton: true,
    exclusive: false,
    countsForWelcome: false,
    onOwnerClose: "survive",
    entry: "windows/telecanvas.html",
    preload: "renderer",
    sandbox: false,
    title: "FoveaCam Duo — TeleCanvas",
    bounds: { width: 720, height: 640, minWidth: 480, minHeight: 360 },
  },
};

/**
 * Entry HTML path (relative to the vite root / renderer dist root) for a
 * window class. Every app gets its own entry URL + HTML;
 * the singleton/utility classes carry a static entry in `WINDOWS`.
 */
export function entryFor(cls: WindowClass, appId?: string): string {
  if (cls === "app") {
    const app = appId && appById(appId);
    if (!app) throw new Error(`Unknown app id: ${appId}`);
    return `windows/${app.id}.html`;
  }
  return WINDOWS[cls].entry!;
}

/** Every entry HTML the renderer build must emit (vite multi-entry input): the
 *  static class entries from `WINDOWS` plus one per app. */
export function allEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [cls, spec] of Object.entries(WINDOWS))
    if (spec.entry) entries[cls] = spec.entry;
  for (const id of Object.keys(APP_REGISTRY))
    entries[id] = `windows/${id}.html`;
  return entries;
}

/** Document (pre-mount OS) title for a generated entry HTML, keyed by the
 *  `allEntries()` key (window-class name for the static classes, app id for
 *  app windows). Consumed by the `foveaWindowEntries` vite plugin so the
 *  registry is the single source for titles too. The live TitleBar /
 *  BrowserWindow title governs once the Vue app mounts — this is only what the
 *  OS shows before boot. App titles derive from `APP_REGISTRY` uniformly. */
export function entryTitle(key: string): string {
  const cls = WINDOWS[key as WindowClass];
  if (cls?.entry) return cls.title;
  const app = appById(key);
  if (app) return `FoveaCam Duo — ${app.title}`;
  throw new Error(`Unknown window entry key: ${key}`);
}

/** Derive the app id back out of an app-window entry URL/pathname (the app
 *  entries all share one generated boot script — `src/windows/boot-entry.ts`
 *  dispatches on the entry key). */
export function appIdFromPathname(pathname: string): string | null {
  const m = /(?:^|\/)windows\/([\w-]+)\.html$/.exec(pathname);
  if (!m) return null;
  const id = m[1];
  if (
    id === "welcome" ||
    id === "profiler" ||
    id === "projection" ||
    id === "viewer"
  )
    return null;
  return appById(id)?.id ?? null;
}
