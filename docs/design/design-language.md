# FoveaCamApp — Design Language

> Reference of the renderer's de-facto design language — what the code
> actually does. Every inconsistency is cited `file:line`.

Context that shapes every judgement below: this is an **Electron control app run in a
dark-room lab rig**. Operators glance at it from a distance, in low ambient light, while
handling hardware. Glare control, glanceability, and *visible* error state matter more
than polish.

## Principles

1. **Realtime feedback**: interactive elements give INSTANT visual cues on
   hover/interaction. No perceptible lag between input and visual response.
2. **Snap over smooth**: transitions are kept minimal on the critical control
   path — state changes snap. A transition is allowed only when genuinely
   necessary (e.g. disambiguating what moved) or when the element is NOT on a
   critical control path (decorative/peripheral surfaces).
3. **Layout stability**: a component's CONTENT changing must not trigger
   layout reflow — reserve space (fixed/min dimensions, `ch`-sized numeric
   fields, visibility over conditional mount) so live telemetry, state badges,
   toggling controls, and appearing overlays never shift their neighbors.
4. **Icon-only title bars**: buttons in a window's title
   bar NEVER use text labels — always icon only, with a clear `title=`
   tooltip naming the action (the tooltip is the only label, so it must be
   explicit). The shared idiom is AppWindow's `icon-button` + the
   `app/src/windows/icons.ts` set — reuse/extend it; keep hit targets at
   the established size. Labeled controls elsewhere (panel headers, drawers,
   launcher) are unaffected.
5. **Borderless inline controls**: inline interactive
   elements — buttons, control shells, toggles, `<select>`s embedded in a bar
   or panel — carry **no always-visible border or outline** at rest.
   Interactivity reads as a **faint element background** (`--tint-2`) that
   darkens on hover and strengthens on active/pressed (`--tint-3`/`--tint-4`);
   in a dark theme the wash lightens rather than darkens. Two carve-outs stay:
   **`:focus-visible` outlines** (keyboard a11y — never removed) and **primary
   / destructive emphasis**, which is carried by a **solid fill**, not a border
   (e.g. a danger button is a filled red, not a red-bordered ghost).

---

## 1. Foundations (global)

| Aspect | Value | Source |
|---|---|---|
| Global font | `"Cascadia Code", "Courier New", Courier, monospace` | `app/src/index.css:2` |
| Global text color | `white` | `app/src/index.css:3` |
| App background | `#222` | `app/src/index.css:34` |
| Canvas/stream backdrop | `black` | `app/src/index.css:51` |
| Box model | `box-sizing: border-box` on `*` | `app/src/index.css:6` |
| Responsive width var | `--element-width` 40vw / 90vw at 800px breakpoint | `app/src/index.css:21-31` |

**The entire app is monospace.** There is no sans-serif surface, no type scale, and no
weight system beyond ad-hoc `font-weight: 600`. `index.css` is the *only* global stylesheet
(34 CSS files searched, one match) — there is **no tokens file, no theme file, no palette
module**. Color role definitions are the string constants in `@lib/camera-config`
(`THEME`) plus ~180 raw hex literals scattered across component `<style>` blocks.

### The only structured color system: L/C/R roles
`app/lib/camera-config.ts:20-24`
```
THEME = { L: "cyan", C: "orange", R: "greenyellow" }   // named CSS colors
ROLE  = { L: "Left Fovea", C: "Center Wide", R: "Right Fovea" }
```
Consumed by `Badge` / `CameraRole` and threaded into `StreamView`/`FrameView` via a
`theme` prop → `--theme` custom prop → `outline: 2px solid var(--theme, gray)`. This is the
one genuinely reusable, semantically-named color contract in the codebase. Its reach is
**partial** — see §7.

### CSS custom-property conventions (the whole set)
Only a handful of custom props exist, all component-local (no `:root` tokens):

| Prop | Meaning | Defined in |
|---|---|---|
| `--theme` | role/accent color for a component | `Badge.vue:12`, `FrameView.vue:208`, `calibrate-intrinsic/index.vue:284` |
| `--color` | active/reactive color (PosView, launcher buttons) | `PosView.vue:39`, `WelcomeWindow.vue:183`, `calibrate-extrinsic/index.vue:363` |
| `--reactive-color` | hover-driven color swap | `PosView.vue:216-220` |
| `--size`, `--offset`, `--opacity`, `--p` | geometry/animation locals | various |

Note the **`--theme` vs `--color` split for the same "accent color" idea** is itself an
inconsistency: `Badge` and the intrinsic buttons key off `--theme`; PosView, the extrinsic
buttons and the welcome launcher key off `--color`. A component can't be dropped next to
another and inherit its accent.

---

## 2. Palette (harvested)

~180 distinct hex literals; the frequency leaders are the neutral ramp. Grouped by the
*semantic role the code uses them for* — the multiple hexes per row are the core finding.

### Neutrals (structural) — reasonably coherent
| Role | Values seen | Where |
|---|---|---|
| Window/titlebar bg | `#111` | `TitleBar.vue:168`, `calibrate-intrinsic:319` |
| App/panel bg | `#222` | `index.css:34`, `NavBack.vue:41`, panels |
| Panel bg (alt) | `#1a1a1a`, `#161616` | `WelcomeWindow.vue:307`, `ErrorBoundary.vue:209` |
| Divider/border | `#333`, `#444`, `#666` | titlebar border `#222`, panel border `#333`, select outline `#666` |
| Muted text | `#666`, `#777`, `#888`, `#999`, `#aaa`, `#bbb`, `#ccc`, `#ddd` | pervasive — an 8-step grey text ramp with no names |
| Alpha whites | `#fff1`…`#fff8` | hover/border/overlay tints, pervasive |

The greys are *internally consistent enough* (`#111` chrome / `#222` surface / `#ccc`–`#eee`
text) that they read as an implicit ramp — they just have no names, so every file re-picks a
rung by eye.

### Accent / focus / interactive blue — **fragmented**
| Value | Where | Note |
|---|---|---|
| `#08c` | `TitleBar.vue:202` (active), `ConfigEntry.vue:54` (select focus), `calibrate-intrinsic:284` (primary button) | the closest thing to a "primary" |
| `#0af` | `SaveControls.vue:176`, `RecordControls.vue:132` (focus-within), `Sparkline` default `:22`, welcome launcher `:183` | second blue |
| `#08f` | scattered | third blue |
| `#00aaff` | `ViewerWindow.vue:112` | fourth blue (series palette) |
| `#3498db` / `#2980b9` | `ErrorBoundary.vue:150,153` | **foreign Flat-UI blue, used nowhere else** |

### Success / "done" / OK green — **fragmented (a standing vocabulary exists)**
| Value | Where |
|---|---|
| `#080` | `RecordControls.vue:184`, `SaveControls.vue:265`, `SnapshotOverlay.vue:138`, extrinsic capture button |
| `#0f0` | `disparity-scope:302`, `calibrate-intrinsic:166` (marker fills) |
| `#4caf50` | `ProgressMonitor.vue:107` (**the standing progress "done" color**) |
| `#8f8` | `RecordButton.vue:216` (fps ok) |
| `#575` | `RecordButton.vue:227` (drops-ok) |
| `#3a3` | `WelcomeWindow.vue:292` (connected dot) |
| `#36d16f` | `ViewerWindow.vue:112` (series) |

Seven greens for "good". There is a standing progress vocabulary
(dimmed→bright→green-done); ProgressMonitor implements it with `#4caf50`, but nothing else
in the app shares that green.

### Error / stop / danger red — **most fragmented**
| Value | Where |
|---|---|
| `#a00` | `RecordControls.vue:187`, `SaveControls.vue:267`, extrinsic delete button |
| `#f33` | `RecordButton.vue:154` (recording blink) |
| `#f66` | `RecordButton.vue:224`, extrinsic delete text `:399`, drops |
| `#f56` | `ProfilerWindow.vue:623,645`, `GraphPanel.vue:107` (alarm) |
| `red` (keyword) | `SaveControls.vue:178`, `RecordControls.vue:136` (invalid outline) |
| `#e74c3c` | `ErrorBoundary.vue:88,128,210` (**foreign Flat-UI red**) |
| `#c0392b` + `#ff9b8f` | `SessionStatus.vue:56-57` (**a third distinct error scheme**) |
| `#a33` | `WelcomeWindow.vue:290` (disconnected dot) |
| `#ff0` (yellow) | `SaveControls.vue:151`, `RecordControls.vue:150` (invalid-path text) |

### Warning / amber
`#fa0` (welcome/viewer/profiler accents, `theme="#fa0"` multi-fovea), `#ffb000`,
`#ff7a35` — a loose amber cluster, less contended than green/red.

### Series / categorical palettes (multiple, unrelated)
- `ViewerWindow.vue:112`: `#00aaff, #ffb000, #36d16f, #ff5b8a, …`
- `multi-fovea/index.vue:45`: `#ffb000, …`
- `@lib/swatch.ts`: `rainbow(brightness)` HSL generator (`light_rainbow`/`dark_rainbow`)

> **Code-adjacent bug spotted (report only, read-only):** `app/lib/swatch.ts:24` —
> `` `hsl(270, 100${bri}%` `` is malformed (missing `%,` and closing paren; interpolates
> brightness into the wrong slot). The 7th rainbow swatch is a broken color string.

---

## 3. Typography & iconography

- **Font:** monospace everywhere. Global `Cascadia Code` stack. But the stack is
  **re-declared as a raw string literal** in at least 6 places instead of inheriting:
  `StreamView.vue:293`, `FrameView.vue:481`, `PosView.vue:215`, plus `font-family: monospace`
  (13×) and `font-family: inherit` (13×) as a third convention. `ErrorBoundary.vue` uses a
  *different* stack — `"Consolas", "Monaco", "Courier New", monospace` (`:130,217`).
- **Sizes:** all relative (`em`/`rem`), no scale. Recurring: overlay/label `0.8em`,
  titlebar `fontSize = height * 0.4` (`TitleBar.vue:84`), headings `1.4rem`/`2rem` ad hoc.
- **Monospace telemetry:** records/overlays/matrices lean on `white-space: pre` +
  `padEnd` column alignment (`FrameView.vue:200-201`, StreamView overlay, `Matrix.vue`,
  RecordButton tooltip). This is a genuine, consistent idiom: **aligned monospace tables for
  live numbers.**
- **Iconography — three parallel systems:**
  1. **FontAwesome** (`@fortawesome/vue-fontawesome`): `faCircle`, `faXmark`, `faSave`,
     `faTrash`, `faExpand`, `faCamera`, `faTelevision`, `faChartLine` — the "real" icon set,
     used in title bars, record/save controls, stream expand.
  2. **Hand-rolled inline SVG**: `NavBack.vue` arrow, `ErrorBoundary.vue` warning circle,
     `Loading.vue` 7-dot spinner, PosView crosshair.
  3. **HTML entities / glyphs**: ProgressMonitor `&#10003;` (✓ done), `&#9203;` (⏳ pending),
     `&times;` dismiss (`ProgressMonitor.vue:26,33,34`); TitleBar connector `-`.
- **Badges/labels:** `Badge.vue` is the one badge primitive (outline + optional `solid`
  fill, `--theme` color). `CameraRole` wraps it for L/C/R. Everything else hand-rolls chips
  (record-chip `calibrate-intrinsic:340`, stream-name cells, etc.).

---

## 4. Spacing & layout

- **Unit soup, but with a dominant idiom:** horizontal rhythm is overwhelmingly `ch`
  (monospace-column-aware — `0.5ch`, `1ch`, `0.8ch` for gaps/padding), vertical rhythm is
  `em`/`rem`. Widths use `ch` for text fields (`min-width: 40ch`), `vw` for panels
  (`max(30vw, 20ch)`). This `ch`-first convention is actually a *strength* for a monospace
  app and is fairly consistent.
- **The dominant app layout: split view.** Nearly every calibrate/control module renders a
  `.view` with a **left stream area (`#111`) + right control panel (`#222`, `border-left:
  2px solid #333`, `padding: 1rem`)**: `calibrate-intrinsic:306-361`, mirrored in
  `disparity-scope`, `calibrate-drift`, `calibrate-extrinsic`, `manage-cameras/CameraConfig`,
  `manual-control`. **Each module re-implements this `.view/.left/.right` CSS locally** — it
  is a de-facto layout component that was never extracted.
- **`HorizontalDivision`** (`app/src/layouts/`) is the one real layout primitive, a
  draggable splitter, used by `playground` and `manual-control` (and nested). Most modules
  ignore it and use a plain flex `.view`.
- **Scroll containers:** `overflow-y: scroll` (forces a track even when unneeded) appears in
  records lists (`calibrate-extrinsic:384`) alongside `overflow-y: auto` elsewhere — mixed.
- **`ConfigEntry`** is the standard row primitive: `label` with
  `justify-content: space-between`, hover/focus-within underline (`#fff4`/`#fff8`), and
  deep-styled `input`/`select`/`button` children. It's the closest thing to a form system.

---

## 5. Component catalog

Reusable set under `app/src/components/**` (+ inputs/layouts/record/capture). "Theming hook"
= how a caller recolors it.

| Component | Role | Props / slots | Theming hook | Notes / duplication |
|---|---|---|---|---|
| `StreamView` | live payload → canvas + overlay + expand | `payload, theme, title, footnote, overlay, inspector, projectable` | `theme`→`--theme` outline | wraps `FrameView`; forwards all slots; projection button implicit — the displayed payload carries its stream address (`StreamPayload.source`) |
| `FrameView` | Mat → canvas render, drag/mouse, projection btn | `mat, theme, title, footnote, projection` | `theme`→`--theme` | **carries orphaned `.no-stream`/`.stream-info` CSS** that StreamView also duplicates (dead in both) |
| `FrameOverlay` / `Overlay` | glass overlay panel + title-bar overlay host | slot; `Overlay` exports an `overlay` singleton ref | — | overlay-toggle button styling mirrored ad hoc |
| `ConfigEntry` | labeled form row | slot; deep-styles input/select/button | `#08c` focus | the de-facto form primitive |
| `Badge` | pill label | `color, solid`, slot | `--theme` (default `gray`) | **only badge primitive** |
| `CameraRole` | L/C/R badge | `role` | via `THEME[role]` | thin wrapper over Badge |
| `RangeSelect` / `range-slider` (inputs) | numeric range input | — | — | two range widgets (`components/RangeSelect` + `inputs/range-slider`) |
| `dual-range-slider` (inputs) | two-thumb `[start, end]` interval input | `modelValue, min, max, step, minGap, neutral, disabled, color, label, valueText`; label slot | `color` (infill + glyphs), `--theme`/`--accent` focus outline | `range-slider`'s twin (same body, infill, glyphs, keyboard, right-click-neutral); value math in `inputs/dual-range.ts`; first user MirrorLink's Scan Pattern pane |
| `Matrix` | numeric matrix table | `mat, round` | `#ccc`/`#eee` borders (hardcoded) | monospace right-aligned cells |
| `PosView` | 2D XY pad (voltage/angle), drag | `pos, color, unit, lim` | `--color` (active) / gray (idle) | drag surface pattern |
| `NavBack` | back arrow bar | slot; `back` event | `#fff3` hover | hand-rolled button + SVG |
| `TitleBar` | window chrome + actions slot + overlay host | `title, subtitle, homeButton` | `#111`/`#333`/`#08c` | fullscreen-aware; drag regions |
| `ProgressMonitor` | spin-up step overlay | `items`; `close` event | dimmed/bright/`#4caf50` | **the standing progress vocabulary lives here only** |
| `RecordButton` + `RecordControls` | record toggle + destination popup | via `current_recording` | `#080`/`#a00` action buttons | `button.action` CSS **duplicated verbatim** with `SaveControls` |
| `SaveControls` + `SaveReport` (capture) | save destination + report | `capture` | `#080`/`#a00`, `#0af` focus | see above duplication |
| `SessionStatus` | session `status.error` banner | `name` | `#c0392b` scheme | **its own error palette** |
| `ErrorBoundary` | crash catcher (component errors) | slot | `#e74c3c`/`#3498db` | **foreign Flat-UI palette; only crash surface** |
| `Loading` | full-window spinner + action label | `setAction()` singleton | `#222` bg | 7-dot SVG spinner |
| `Sparkline` | inline trend line | `values, max, color` | `color` default `#0af` | canvas |
| `Controller`, `Drawer`, `InlineSelect`, `Line2D`, `FrameCursor`, `MarkerTargetInputs`, `RemoteCanvas`(+`Teleport`,`Splash`) | misc app-specific | — | — | RemoteCanvas = projection teleport |
| `graphics/*` (`Checker`, `CrossHair`, `Marker`, `StereoFrameGuide`) | SVG frame annotations | — | — | overlay glyphs on streams |
| Window shells: `AppWindow`, `DebugWindow`, `ProjectionWindow`, `ViewerWindow`, `WelcomeWindow`, `ProfilerWindow` | per-class chrome | `appId`/`session`/`kind` | — | see §6 |

**Where modules hand-roll what a component already provides:**
- Buttons: at least **8 independent button implementations** (see §8) — no `<Button>` exists.
- The left/right split view (§4) — no `<SplitView>` exists; ~6 copies.
- Record chips / list rows — hand-rolled instead of `Badge` (`calibrate-intrinsic:340`,
  `calibrate-extrinsic` records list).

---

## 6. Window classes & chrome

| Class | Shell | Chrome | Bg | Distinguishing |
|---|---|---|---|---|
| App | `AppWindow.vue` | `TitleBar` with actions (RecordButton, capture, RemoteCanvas, profiler, Controller); `home-button` title | `#222` | hosts `SessionStatus` + `ProgressMonitor` + `ErrorBoundary` |
| Debug | `DebugWindow.vue` | `TitleBar` **no actions**, no home button | `#222` | thin; `.notice #888` empty state |
| Projection | `ProjectionWindow.vue` | minimal | black | fullscreen stream |
| Viewer | `ViewerWindow.vue` | own chrome | dark | recording playback, own series palette |
| Welcome | `WelcomeWindow.vue` | launcher grid, connection dot (`#3a3`/`#a33`) | `#222`/`#1a1a1a` | app launcher cards keyed `--color` `#0af`(prod)/`#f6f`(dev) |
| Profiler | `ProfilerWindow.vue` | `TitleBar` + `SnapshotOverlay` | dark | graphs, `#fa0`/`#f56` alarm colors |

Title-bar **icon buttons** are re-implemented in `AppWindow.vue:155-175` (`.icon-button`)
with a comment saying it *mirrors* `Overlay.vue`'s `.overlay-toggle` — i.e. copy-to-match,
not shared.

---

## 7. Interaction & state patterns (inventory)

- **Hover-reveal controls** (consistent idiom): ProgressMonitor `×` hidden until overlay
  hover (`ProgressMonitor.vue:71,80`); StreamView/FrameView outline + title-color only on
  container hover (`FrameView.vue:427,471`); expand button `opacity 0.5→1` on hover
  (`:408`); record tooltip only while recording+hover (`RecordButton.vue:83`). Good for
  glare reduction; **also means clickable things are invisible until hovered**.
- **Disabled state:** dominant convention `opacity: 0.5` + `cursor: not-allowed`
  (RecordButton, SaveControls, AppWindow icon-button). But calibrate buttons instead go
  **transparent bg + `#666` outline/text** (`calibrate-intrinsic:297-302`) and extrinsic uses
  `opacity 0.5 + saturate(0.2)` (`:373-376`). Three disabled looks.
- **Focus state:** `outline: 1px solid #08c` (ConfigEntry) vs `1px solid #0af`
  (Save/RecordControls) vs browser default elsewhere. No global `:focus-visible` policy.
- **Active/pressed:** `outline: 2px solid #08c` (TitleBar), `transform: scale(0.98)`
  (ErrorBoundary), `filter: brightness(1.2)` (action buttons), `background: #fff2`
  (ConfigEntry). Four idioms.
- **Drag surfaces:** `PosView` (XY pad, `mousedown`→window `mousemove` until release);
  `FrameView` (`pointerrawupdate` for high-rate MEMS, `FrameView.vue:263`);
  `HorizontalDivision` splitter; TitleBar `-webkit-app-region: drag` strips.
- **Keyboard accelerators:** Cmd/Ctrl-R → recorder trigger (`RecordButton.vue:20-48`);
  Cmd/Ctrl-S → toggle capture window (`AppWindow.vue:80-85`); Enter → start/save in
  Record/SaveControls; Esc → overlay dismiss (via Overlay host). No central keymap or
  discoverability surface.
- **Live telemetry readouts:** aligned monospace tables (RecordButton tooltip, StreamView
  inspector overlay Ctrl+Shift+I, Matrix, Sparkline). Consistent and good.
- **Progress/spinners — three implementations:** ProgressMonitor CSS border-spinner
  (`:121`), `Loading.vue` 7-dot SVG spinner, record-blink keyframe (`RecordButton.vue:164`).

### State-color vocabulary (the standing one + drift)
Standing progress vocab: **pending = dimmed (`#777`) → active = bright
(`#eee`) → done = green (`#4caf50`)** (`ProgressMonitor.vue:98-108`). Elsewhere the same
three-state idea is expressed with different colors: idle-gray→active-`--color`
(PosView `:25`), disabled-dim→enabled-bright, connected `#3a3`/disconnected `#a33` (welcome).
The *concept* is consistent; the *palette* is not.

### Error surfacing — three disconnected surfaces (the crux)
1. `SessionStatus.vue` — renders `status.error` as a red banner (`#c0392b`), `role="alert"`.
   Only shows if a session sets `.error`.
2. `ErrorBoundary.vue` — catches **Vue component render errors** only, full-screen Flat-UI
   panel with stack trace + "Try Again".
3. **A process/orchestrator crash shows nothing** — no boundary catches an orchestrator-side
   death; the app just goes blank/stale.

---

## 8. Explicit inconsistency list (cited)

**Semantic-color drift (same role, different hex):**
1. **Error red = 8 values:** `#a00` (`RecordControls.vue:187`), `#f33`
   (`RecordButton.vue:154`), `#f66` (`RecordButton.vue:224`), `#f56`
   (`ProfilerWindow.vue:623`), `red` (`SaveControls.vue:178`), `#e74c3c`
   (`ErrorBoundary.vue:88`), `#c0392b` (`SessionStatus.vue:56`), `#a33`
   (`WelcomeWindow.vue:290`).
2. **Success green = 7 values:** `#080`, `#0f0`, `#4caf50`, `#8f8`, `#575`, `#3a3`, `#36d16f`
   (cites in §2).
3. **Accent/focus blue = 5 values:** `#08c`, `#0af`, `#08f`, `#00aaff`, `#3498db`
   (cites in §2).
4. **Invalid-input signalled two ways at once:** red outline **and** yellow `#ff0` text
   (`SaveControls.vue:151,178`; `RecordControls.vue:136,150`) — yellow usually means
   *warning*, not *invalid*.

**★ MOST DAMNING — `ErrorBoundary.vue` uses a palette that appears nowhere else in the app.**
The Flat-UI set `#e74c3c` / `#3498db` / `#2980b9` / `#c0392b` (`ErrorBoundary.vue:88,150,153`)
and a *different monospace font stack* (`:130,217`) mean the **one surface an operator sees
when something has broken** looks like it belongs to a different application — in a dark lab
this is exactly the moment the UI must read as "ours, and this is bad." Compounded by
`SessionStatus` inventing yet a *third* error scheme (`#c0392b`/`#ff9b8f`), the app has no
recognizable "error" identity.

**Duplicated component logic:**
5. `button.action { .green #080 / .red #a00 }` is **copy-pasted** between
   `RecordControls.vue:171-196` and `SaveControls.vue:254-280` (near-identical).
6. Left/right split-view CSS re-implemented per module (`calibrate-intrinsic:306-361` and
   ≥5 peers) — no shared `SplitView`.
7. Title-bar icon-button CSS re-implemented in `AppWindow.vue:155` with a comment admitting
   it mirrors `Overlay.vue`'s `.overlay-toggle`.
8. ≥8 independent `<button>` styles: ConfigEntry deep-button, NavBack, RecordControls/
   SaveControls `.action`, ProgressMonitor `.dismiss`, ErrorBoundary `.primary`,
   RecordButton `.record-toggle`, FrameView `.fullscreen`, TitleBar `.home-button`,
   calibrate-intrinsic/extrinsic module buttons. **No `<Button>` component exists.**

**Token / convention drift:**
9. Accent custom-prop named `--theme` in some components, `--color` in others (§1) — breaks
   drop-in inheritance.
10. Font stack re-declared as a literal string (`StreamView.vue:293`, `FrameView.vue:481`,
    `PosView.vue:215`) and a *different* stack in `ErrorBoundary.vue` — no font token.
11. Three disabled-state looks, four active-state looks, two focus-ring colors (§7).

**Dead / orphaned style:**
12. `StreamView.vue:258-274` carries `.no-stream` / `.stream-info` / `.no-stream-text` CSS
    for markup that lives in `FrameView` under **different** class names (`.no-frame`), so
    both the StreamView copy and the FrameView original are partly dead/duplicated.

**Code-adjacent bug (report only):**
13. `app/lib/swatch.ts:24` malformed `hsl()` string (§2).
