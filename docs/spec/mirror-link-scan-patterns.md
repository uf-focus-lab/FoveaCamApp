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

## Review round 1 (2026-10-23) — findings and decisions

Four independent reviews (timing/protocol vs firmware, orchestrator lifecycle,
UI vs the request, native brick) on 9a5ed54. Decisions taken for the fix
round; the per-finding detail lives in the fix commits.

### Decisions

- **Sync means identical timing.** `tri_window_fall` mirrors
  `tri_window_rise`'s fractions. With an asymmetric window the two frames
  therefore expose opposite ends of the line (the rising frame the start of
  the sweep, the falling frame the end); the hover and the manual say so. The
  alternative ("same stretch", `fall = [1 − end, 1 − start]`) is one line to
  switch to if the owner prefers it.
- **The flip stays vertical**, as asked. The exact reversal of a falling sweep
  is a reflection across the line PERPENDICULAR to the scan axis through the
  center, which equals the vertical flip only for a vertical axis; the spec
  text that said "across the axis" was wrong and is corrected.
- **Anchors carry both exposure edges.** Which instant the Blackfly S stamps
  a frame with (exposure start or end) is not documented here. The flip brick
  matches a frame to the nearest of `tStart`/`tEnd` within the tolerance, so
  the match is right either way, and reports the signed skew of matched
  frames (`perf.trajectory.skew_us`) so the bench can see which edge it is.
- **Atomic trajectory swap in firmware (protocol 2.2.1).** `START {id = b,
  t_start, cycles}` while table `a` runs is ACCEPTED iff `b` is committed,
  `b.period == a.period` and `t_start == a.t_start` (exact µs): the firmware
  switches the playing table in place, keeping the phase clock and the
  marker crossing state (no HOLD, no push; a marker is never doubled, and
  one moved before the swap phase first fires next cycle). Any other START
  while running still REJs "already running". Host `replace` tries that first
  and falls back to STOP(a) + START(b) on REJ (older firmware). Pushes from
  an in-flight capture of the old table keep arriving after the swap, so the
  host keeps the old id routed for a grace period (max pulse + 5 ms + slack)
  and does not reuse it meanwhile.
- **Sensor readout is modelled.** `TriggerOverlap = ReadOut` is set (and
  restored) with the triggered timing; the trigger rate `1/T` must stay at or
  below each fovea's maximum frame rate (else `mismatch` with the reason); in
  the triangle the two exposures' end-to-end spacing must exceed the readout
  time (`1 / frame_rate_range.max`) or `mismatch` names it.
- **Timed fallback gives every marker the same pulse** (marker 0's), so the
  firmware's per-marker strobe timeout matches the camera's single exposure.
- **Flip tolerance floor 1 ms**, capped at 0.45 × the marker spacing; when the
  floor exceeds the cap the windows are too close for reliable flipping at
  that frequency and `mismatch` names it.
- **No scan before the controller clock is calibrated**; the MCU↔host offset
  is re-pinged every 30 s like the cameras' (`sessions/controller.ts`).
- **Lifecycle:** a run ending (detached / ready) during an in-flight replace
  or start aborts the scan once the await settles; geometry/period changes
  during a start are reconciled at the commit point; the replace throttle
  keeps at most one queued op; every stop path reaches the camera restore
  (`try/finally`, best-effort per feature); START is never sent after a stop
  or teardown was requested; teardown stops the scan before closing the idle
  position input so the mirror returns to the center.
- **UI:** the axis handle is drawn and hit-tested at least 15 strokes from
  the center regardless of amplitude; the axis slider's range is
  [−179.5, 180]; ratio gets a detent at 0; `scan_path_closed` travels with
  the path; the disabled dual slider ignores pointer events.

## Review round 2 (2026-10-23) — findings and decisions

Four reviews on e8cae9b re-verified every round-1 fix (all resolved except as
noted) and found the following, fixed in round 2:

- **Regression:** `scan_path_closed` was never published — every ellipse drew
  with a gap. Published with the path.
- **Flip tolerance basis was wrong for two-edge anchors.** The brick matches
  either edge, so the ambiguity gap is between EDGES of different markers
  (next marker's start − previous marker's end, circularly), not between
  marker starts. The tolerance cap, the 1 ms floor comparison and the
  "windows too close" reason now use that edge gap, and the "late anchor →
  unmatched" claim holds only because the tolerance stays below it.
- **Timed fallback with unequal, unsynced triangle windows** could run the
  falling exposure (rising-window length) into the next rising marker. In
  Timed mode each marker is kept inside its own slope (`start = min(start,
  slopeEnd − pulse)`), and a would-be overrun is a `mismatch_reason`. The
  camera's maximum frame rate is read AFTER the triggered timing is applied
  (the pre-scan exposure caps it otherwise). A growing Timed exposure is
  written AFTER the table swap, a shrinking one before (the camera exposure
  must never exceed the MCU pulse plus its margin).
- **Spec bookkeeping on reused table ids:** ids alternate after their grace,
  so `specById` entries expire with the controller's grace rule and a
  reallocated id resolves to the pending spec.
- **Atomic START transport failure:** a non-REJ failure (timeout, lost ACK)
  may have swapped on the MCU; the host re-STARTs the old table at the
  carried `t_start` before reporting, and distinguishes REJ from transport
  errors. `replace` waits for an in-flight `start`/`stop`. A "now" start
  becomes atomic-capable after its first fallback START is ACKed.
- **Lifecycle:** the Timed pulse change made during a start is reconciled
  at the commit (`scheduleReplace` unconditionally); a replace queued before
  a stop/teardown no longer runs; a cancelled start no longer arms the
  cameras; a restart re-checks the run state and the clock; a clock lapse
  mid-scan is surfaced as a `mismatch_reason`, not a stop; a gain write
  queued during teardown is ignored; a failed replace after a Timed retime
  re-arms the retime.
- **UI:** the spoke, handle and hit test anchor on the published
  `scan_center_px` (the panned center), the handle encodes the axis even at
  amplitude 0, the pane shows that the Timed falling window takes the rising
  length, skew prints as "—" until a frame matched, hover wording, manual
  refusal and amber-reason lists, the still-capture contradiction, and the
  checkbox exception in the design language.
- **Simulator harness:** the C5 backstep check tolerated repeated DAC words
  (the 1 Hz refresh re-commits an unchanged value), and the C2/C3/C5 timing
  margins were tightened against host load; the firmware itself was clean.
  Host docs say "never doubled; a marker moved before the swap phase first
  fires next cycle" rather than "no missed marker". The BUSY-after-a-missed-
  strobe behaviour when the post-window gap is under 5 ms is documented.

## Review round 3 (2026-10-23) — findings and decisions

Four reviews on 98479ad re-verified every round-2 fix (all hold; one manual
table had drifted and is realigned at b2cbc14). Fixed in round 3:

- **Flip tolerance hysteresis.** The live rebuild rule "rebuild only when the
  new tolerance is smaller" left a tightened tolerance in force forever (a
  window dragged close and back kept a 450 µs tolerance below the 1 ms floor
  with `mismatch` cleared) and rebuilt the bricks on every throttled replace
  while a window grew. Decision: the bricks are rebuilt when the tolerance in
  force is UNSAFE or STALE — tighter when it exceeds the new cap (0.45 × edge
  gap, the no-mis-flip guarantee), wider when it is below the floor while the
  floor fits under the new cap, or below half the new tolerance. In between
  the bricks keep their value (`flip_tolerance_us` shows it). `tooClose`
  follows the rule, not the brick.
- **Teardown is exception-safe per step:** a throwing vergence stop or scan
  stop never skips the camera restore or the gain restore (try/finally per
  step, each failure reported); the ring-enable / ring-telemetry steps inside
  the scan stop are best-effort.
- **`scan.amp_deg` is the RUNNING amplitude** (held with the run's spec), not
  the edited one — a failed replace leaves it at the value the MCU plays.
- **Node `close()`/`stop()` vs late replaces:** a `replace()` issued after
  `close()` was requested is refused; `stop()` waits only for the in-flight
  swap and the batch pending on entry, never for replaces issued after it.
- **Simulator harness:** C3/C5/C6 position lower bound from the marker's DUE
  phase (`table(due) − 10`), not from `t_trigger` (read later, under a live
  clock); C6a re-checks the MCU time after the swap ACK and prints the first
  push's fields on failure; new C6c covers a swap during the ARMED window
  (keeps pre-positioning at b's phase 0) and a swap whose `cycles` is already
  spent (ENDED on the next tick, phase-0 hold).
- **Firmware:** `Streams::tick` never writes under TRAJECTORY ownership before
  the run's first `drive()` (a `touch()` landing between START and the first
  tick no longer re-drives a stale position); `firstDrive` lives with the rest
  of the DAC state in the anonymous namespace. `Command::Actuate` and the
  legacy `Command::Trigger` are REJected while a trajectory runs ("trajectory
  owns the DAC" / "trajectory owns the trigger lines"), like UPDATE/SCHEDULE.
- **Tests added for stated guarantees:** tighten-then-widen tolerance;
  teardown with a throwing step; dispose with an ambiguous sibling; a plain
  re-upload retiring a sibling; `createFlipPipe` un-advertising on attach
  failure; `buildFlips` all-or-nothing (second eye fails → first retired);
  close-then-replace refused; stop not starved by later replaces.
- **Docs/comments:** `#replace` in this brief points at `controller.md`
  (atomic first, pair as fallback); "no missed marker" wording in
  `controller.ts` / `contracts.ts`; `flip-pipe.ts` tolerance basis; the spec's
  readout row says "below the readout time (`SensorReadoutTime`, else
  `1 / frame_rate_range.max`)"; UI: sliders bind `disabled || undefined`
  (Vue wrote `disabled="false"` on a `<div>`, dimming every slider); the axis
  slider clamps a handle-dragged angle on read.
