# MirrorLink scan patterns — design brief

> Working brief for the configurable scan patterns on branch `feat/MirrorLink`.
> Binding for every workstream until revised; when the work lands, the
> sections below fold into `docs/spec/mirror-link.md` (§scan-patterns,
> §actuation, §triangle-flip) and the brief shrinks to a status page.

## What the owner asked for (2026-10-23)

Replace the fixed circular scan with a configurable pattern, set in a dedicated
drawer pane:

1. **Elliptical scan.** A draggable main-axis (x-axis) direction, an amplitude
   slider and an x/y ratio slider; ratio 0 collapses the ellipse to a linear
   sinusoidal scan along the axis. A dual-head window slider sets the exposure
   window per period.
2. **Triangular scan.** The same draggable main axis with a single amplitude
   slider. The mirror sweeps out and back; the period is 2T, twice the base
   period from the scan-frequency slider, and the cameras trigger twice per
   2T. The second (falling-sweep) frame is vertically flipped before any
   consumer (UI or decoder) sees it. A dual-end slider sets the window on the
   rising slope and another the window on the falling slope; a `sync`
   checkbox, on by default, keeps the two identical.

Reviewers iterate on the result until nothing is flagged.

## Decisions

### Actuation moves to the MCU trajectory

The orbit brick (`OrbitStream`, a host-paced pose generator) cannot trigger a
camera at a phase: the MCU never knows the phase. The uploaded trajectory
(`CMD_TRAJECTORY`, protocol 2.2.0) was built for exactly this: the pattern
runs on the MCU, markers fire the camera triggers at exact phases through the
capture engine, and one 44-byte push per trigger comes back with trusted
timestamps. So:

- The session builds a `TrajectorySpec` from the pattern (samples through the
  EXACT chain `offset → inverseTriangulate + shift → A2V`, not a
  linearization) and runs it through `controllerNode().openTrajectory`
  (`docs/spec/controller.md#trajectory-ownership`). Idle centering keeps the
  JS `openPosition` input and its slew; while the trajectory runs the node
  holds position pushes and hands the DAC back on stop.
- A scan needs a bound firmware ≥ 2.2.0 controller; otherwise `startScan`
  refuses with that reason on `scan_blocked`. There is no JS pacer fallback
  for the scan any more (it could not trigger anyway).
- The orbit brick stays in core (tested, documented) but MirrorLink no longer
  creates it: `orbit_pace_hz`, the governor tuning and `perf.orbit` go.
  `perf.trajectory` replaces them (contract `TrajectoryTelemetry`).
- **Live geometry while scanning** (steer drag, verge/shift, amplitude, ratio,
  axis, windows): rebuild the spec and swap it in PHASE-CONTINUOUSLY with
  `NodeTrajectory.replace(spec)` (§replace), throttled to ≤ 10 Hz with the
  latest spec winning. A `scan_hz` or mode change while running changes the
  period: stop, rebuild, start.

### Patterns (`app/modules/mirror-link/scan.ts`, pure)

All offsets are radians in the WIDE angular frame, added to the center `A0`
before `inverseTriangulate`, as today. `θ = scan_axis_deg`, `a =
radians(scan_amp)`, `R(θ)` the rotation by θ (counter-clockwise, +x → +y).

- **Ellipse** (`scan_mode = "ellipse"`): period `T = 1/scan_hz`; at phase
  `φ ∈ [0,1)`: `o = R(θ) · (a cos 2πφ, (scan_ratio · a) sin 2πφ)`. Ratio 1 is
  the old circle; ratio 0 a line along the axis. Samples: 128 per period
  (linear interpolation on the MCU between them; 11 DATA chunks).
- **Triangle** (`scan_mode = "triangle"`): period `2T`; position along the
  axis is `−a` at `t = 0`, `+a` at `t = T`, back to `−a` at `2T`:
  `o = R(θ) · (s, 0)`. Samples: exactly TWO (`t = 0: −a`, `t = T: +a`); the
  MCU's linear interpolation, wrapping last → first across the period
  boundary, IS the triangle. `step` stays false.
- `SCAN_PATH_SAMPLES` points of the pattern through the exact chain feed
  `scan_path` (volts per eye) and, projected through `A2P.C`, `scan_path_px`
  (closed for the ellipse, open for ratio 0 and the triangle). The exposed
  portions are `scan_window_px` (one polyline per marker). `axis_handle_px`
  is `A2P.C(A0 + R(θ)·(a, 0))`.

### Exposure windows → markers (`scan.ts` + `exposure.ts`)

Each window `[w0, w1]` (fractions, `0 ≤ w0 < w1 ≤ WINDOW_MAX = 0.95`) is one
trajectory marker: `t_offset_us = slopeStart + w0 · T`, `pulse_us = (w1 − w0) ·
T`, cameras L|R.

- Ellipse: one marker, slope start 0.
- Triangle: marker 0 (rising) at `w0_rise · T`, marker 1 (falling) at
  `T + w0_fall · T`. `tri_window_sync` on → the falling window mirrors the
  rising one on every write (the session enforces it; the pane disables the
  falling slider while synced).
- The 0.95 cap keeps the trigger line released and the capture engine idle
  before the next marker (the firmware fires a marker only on an idle engine,
  else pushes BUSY) and leaves the camera its readout gap.

Cameras take the window as **`ExposureMode = TriggerWidth`**: the trigger
pulse IS the exposure, so the two triangle windows may differ and no exposure
value is written per frame. Programming per fovea, through
`lease.reconfigure` (snapshot before, restore verbatim after, Manage Cameras'
docs untouched — the existing `exposure.ts` discipline):
`enableHardwareTrigger(lease)` (TriggerSource Line3, strobe on Line2 with the
branch's measured `LineInverter = true`), `TriggerActivation = LevelHigh`,
`ExposureMode = TriggerWidth`, `ExposureAuto = Off`, frame-rate enable off.
Fallback when the model offers no `TriggerWidth`: `ExposureMode = Timed`,
`TriggerActivation = RisingEdge`, `exposure = pulse of marker 0` (two-sided
clamp as today); unequal triangle windows then set `mismatch`. `ScanTelemetry`
reports `mode`, `period_us` (T or 2T), `windows`, `exposure_mode`, the
per-eye applied values and `mismatch`.

Marker pushes with status OK are the exposure ground truth; `STROBE_TIMEOUT`
and `BUSY` count in `perf.trajectory.pushes`, and a run with no OK push for
two periods surfaces a warning through `report("mirror-link", …)` like the old
exposure mismatch did.

### Triangle flip (`FlipStream` brick + `app/orchestrator/flip-pipe.ts`)

The falling-sweep frame is VERTICALLY flipped (rows reversed) before any
consumer sees it. A native chained brick on each fovea convert pipe,
`camera/<serial>/convert/flip` (`nodeId.convert(serial) + "/flip"`), copies
frames through and flips those whose timestamp matches an anchor marked
`flip`. Anchors are the OK marker pushes: `{ tExposure, flip: marker === 1 }`,
pushed at FIN rate by the session through `FlipHandle.pushAnchor`. Matching is
PairStream's rule: nearest anchor within `toleranceNs` (the session passes
`0.4 · T`), else pass through unflipped and count `unmatched`. Timestamps are
in the owner-applied trusted host-ns domain on both sides, like every other
pairing in the app.

The flip pipes exist only in triangle mode while the triple is leased:
`state.flipPipes = { L, R }` names them; the L/R views and the ring reader
bind them instead of the raw convert pipes while set, and `null` restores the
raw binding. In ellipse mode nothing is built and nothing is copied.

Note for the record: a flip about the horizontal axis is what was asked for.
For a scan axis far from vertical the geometrically exact reversal would be a
reflection across the axis; that is a later refinement, not this change.

### Pane and overlay (`index.vue`, new `ScanPatternPane.vue`,
`app/src/inputs/dual-range-slider.vue`)

- A **fourth drawer column**, "Scan Pattern", between the vergence column and
  the gain/ring/status column: mode (`SingleSelect` Ellipse | Triangle), Axis
  (slider, degrees, with a hint that the handle on the center view drags it),
  Amplitude, then per mode: Ellipse → Ratio slider + Window dual slider;
  Triangle → Rising Window dual slider, Falling Window dual slider (disabled
  and mirroring while synced), Sync checkbox. Every control has a one-sentence
  `title`; readouts in ms where a window is shown. Scan Frequency stays in the
  right column (it is the base period both modes share).
- `dual-range-slider.vue`: a two-thumb slider with the same look, keyboard
  and right-click-neutral conventions as `range-slider.vue`; model
  `[number, number]`, `min`/`max`/`step`, a `minGap`, thumbs cannot cross.
- Center view overlay: `scan_path_px` replaces the circle (dim dashed idle,
  solid active; `scan_window_px` segments drawn emphasized on top), plus the
  **axis handle** at `axis_handle_px` (a small filled circle on the +amp end
  with a short line from the center). Pointer-down inside the handle's hit
  radius starts an AXIS drag (`setAxis(px)` per move, throttled like steer)
  instead of a steer; elsewhere the view steers as today.
- PosViews draw `scan_path` as an open or closed polyline per mode.

### `replace` {#replace}

`TrajectoryHandle.replace(spec)` (`app/orchestrator/controller.ts`) and
`NodeTrajectory.replace(spec)` (`controller-node.ts`), both stubbed to throw
until implemented: upload `spec` to a FREE table id (BEGIN/DATA/MARK/COMMIT
while the old one runs — the firmware allows uploading while running), STOP
the old table, START the new one at the old run's `t_start` (the firmware
joins a past `t_start` in progress, so the phase carries over), DELETE the
old table, swap the id under the same handle so listeners, the node's hold
state and stats continue. Period must match while running (throw otherwise).
From `ready`, a plain re-upload. Gap on the wire: the STOP/START pair, sent
back to back.

## Workstreams (parallel, one worktree each)

| ID | Scope | Owns |
|---|---|---|
| H | `FlipStream` native brick + NAPI + typings + seam injection | `core/lib/Aravis/FlipStream.{h,cpp}`, `core/addon.cpp`, `core/src/Pipe.cpp` (attach/detach registry, as scale), `core/dist/Aravis/index.d.ts`, `app/orchestrator/index.ts` (flip seam into the mirror-link session), `docs/spec/core-streams.md#flip-stream`, a `core/test/54-flip-stream.ts` |
| I | `replace` on both trajectory handles + tests + controller spec | `app/orchestrator/controller.ts` (`replace` impl), `app/orchestrator/controller-node.ts` (`replace` impl), `app/test/controller-trajectory.test.ts`, `app/test/controller-node-trajectory.test.ts`, `docs/spec/controller.md` |
| J | Patterns, windows, triggered exposure, session actuation + flip wiring + telemetry | `app/modules/mirror-link/{scan,exposure,session}.ts`, their tests, `docs/spec/mirror-link.md` |
| K | Pane, dual slider, overlay + axis drag, PosView paths, manual | `app/src/inputs/dual-range-slider.vue`, `app/modules/mirror-link/{index.vue,ScanPatternPane.vue}`, `docs/manual/mirror-link.md` |

Shared: `contract.ts` (done here; J and K consume it, additive edits only
with a note), `flip-pipe.ts` (done here; H implements the seam, J consumes
the helper).
