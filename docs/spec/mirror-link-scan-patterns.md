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

Implemented on both handles: `TrajectoryHandle.replace(spec)`
(`app/orchestrator/controller.ts`) and `NodeTrajectory.replace(spec)`
(`controller-node.ts`). The contract lives in `docs/spec/controller.md`
(Replace): upload `spec` to a FREE table id while the old one runs, then swap
ATOMIC FIRST — one `START(new)` at the run's `t_start` (protocol 2.2.1, no
HOLD) — with the STOP(old) + START(new) pair, sent back to back, as the
fallback (older firmware, or a REJ "already running"). The id swaps under the
same handle, so listeners, the node's hold state and stats continue; the old
id stays routed for its grace. Period must match while running (throw
otherwise). From `ready`, a plain re-upload.

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

## Review round 4 (2026-10-23) — findings and decisions

Four reviews on 4b7f241 re-verified every round-3 fix (all hold) and found no
blockers. Fixed in round 4:

- **Identical-spec edits re-judge the windows:** in the Timed fallback a
  falling-END edit builds the same MCU spec; `replaceNow`'s early return now
  still refreshes the requested windows the mismatch checks read (the
  unequal-windows reason appears and clears without a replace).
- **Teardown reports a throwing scan stop** (not only the op chain's log).
- **Node `detach()` forgets the retired ids** (the next device may hand one
  out again).
- **Status line amber on a STALLED run:** `perf.trajectory.stalled` is true
  while no OK push has arrived for `NO_OK_PERIODS` (2) periods of an active
  run (the no-OK watchdog's condition, re-evaluated at the telemetry
  throttle; false again on the next OK push); the status line turns amber on
  it, not only when no push ever succeeded. The manual's "when the cameras
  stop answering the trigger" is then true.
- **Axis domain is the slider's:** `setAxis` folds an angle in
  (−180, −179.5) to −179.5, so the state never holds a value the slider
  cannot show (the readout never prints −180.0°, ArrowLeft never turns the
  axis the wrong way); the pane's read clamp stays as a guard.
- **Disabled RangeSlider never lights up on a click:** no tabindex while
  disabled (as the dual slider), focus/active rules guarded by
  `:not([disabled])`.
- **Firmware:** `Streams::claim()` seeds the trajectory drive position with
  the DAC's last written value (a START immediately followed by STOP/DELETE
  in one loop iteration no longer HOLDs a stale position); an Actuate under
  HOLD moves the hold position (it no longer snaps back at the next 1 Hz
  refresh — C4 checks past the refresh); a trajectory START is REJected
  while a legacy Trigger is pending ("A trigger is pending (legacy Trigger)
  — wait for its FIN"), the host classifies the text as a plain REJ; the
  harness exercises the `firstDrive` guard with START + MEMS reset in one
  burst; `Version.h` and `docs/architecture/serial-protocol.md` list the
  2.2.1 Actuate/Trigger/START refusals.
- **Docs:** manual's overrun remedy is "lower Scan Frequency" (a shorter
  window never clears it); the spec's swap fallback wording ("REJ 'already
  running'", not any REJ); `rig.md` triangle Timed note (unequal windows
  only); `core-streams.md` notes the hysteresis band (the brick's tolerance
  may differ from the formula after a live window change; round 3);
  contract comments (`shift` ±2°, `frame_rate` is a readback).

## Review round 5 (2026-10-23) — findings and decisions

Four reviews on 51c5532 re-verified every round-4 fix (all hold; mutation
checks confirmed the new harness checks catch what they claim). No blockers,
one should-fix (a vacuous test). Fixed in round 5:

- **Stall-clear republish** carries the clearing push's lateness (ordering).
- **Failed atomic swap, "run is over" branch:** STOPs every sibling too
  (one may be the table actually playing) before the DELETE; the decision
  table row says so.
- **Node detach test** pushes from the forgotten id while it is NOT current,
  so it fails without `retired.clear()`; the START-REJ classification test
  lists every text in `TRAJECTORY_START_REJ_TEXTS`.
- **Status line:** a run that never answered keeps its "not answering"
  sentence after two periods (stalled + `ok === 0`); a mismatch hover also
  names a stall.
- **`AXIS_SLIDER_RANGE`** is exported from `scan.ts` and shared by the
  session's `setAxis` fold and the pane.
- **Firmware `claim()`** flips the DAC owner and seeds the drive position
  inside one interrupt-free block (a strobe edge never pairs TRAJECTORY
  ownership with the previous run's position).
- **Harness:** a check for `noteReinit()` / the V_BIAS seed (MEMS reset +
  START + STOP in one burst → the refresh re-commits the bias, never 0 or
  the stream value); fixture misses under host load re-arm and retry
  instead of failing (firmware-fault checks stay strict); C1's keyframe
  timing check gets the same treatment / a round-trip-based margin.
- **Docs:** the spec's Axis-drag paragraph names the fold; the swap
  fallback applies "on REJ 'already running', and always below 2.2.1";
  v2.2.1 tags on the Actuate/Trigger/START refusals and the HOLD Actuate
  in both protocol docs; the manual's overrun row says one sweep; the
  `replace` doc's lead says atomic first.

## Review round 6 (2026-10-23) — findings and decisions

Four reviews on acbd07c. No blockers; no firmware or UI code defect. Fixed
in round 6:

- **Failed swap, routed new id (should-fix):** the session registers
  `TrajectoryReplaceError.replacement` in `specById` against the spec it
  carries — for the grace when `maybeLive` is false, open-ended while true
  (retired at the next landed swap or the run's end) — and in the Timed
  fallback skips the pre-swap exposure write-back while the new table may
  be live (the shorter exposure is safe under either table).
- **Controller tests:** the "run is over" branch is covered with siblings
  (every sibling STOPped; a sibling whose STOP failed stays reserved and a
  later `stop()` STOPs + DELETEs it); the `endRun` comment names every path
  that graces a sibling. The stall test pins the republished lateness.
- **Docs:** the manual's readout row says END-to-END; "scan center" rather
  than "crosshair" for the always-aims zone (under a vergence pan the
  crosshair sits off the center) — manual, spec and the overlay comment;
  `no ring` no longer lists "the scan is not running" (that reads `idle`);
  the spec's status `title` text covers the stalled-with-no-OK run and the
  stall sentence inside a mismatch hover; Ctrl-backtick rendered correctly.
- **Simulator harness (host/sim timing, not firmware):** decisions —
  (a) the swap instant is MEASURED: the swap START goes out with a
  `GET SYS_TIMESTAMP` in one burst, and a push that arrives before the ACK
  is a firmware fault only when the measured instant was inside the window
  (else a fixture miss) — this replaces C6a's post-ACK heuristic; (b) C5
  sends the swap only after this cycle's injected strobe rises have been
  seen, and a push whose exposure started at/after the swap instant is a
  fixture miss; (c) after a re-arm C6b reads a's push for the new cycle
  before polling, as the normal path does for cycle 1; (d) `Wire::recv()`
  QUEUES CMD_TRAJECTORY pushes instead of dropping them (`recvTrajectoryFrame`
  pops the queue first), with an explicit discard for C4's endless run and
  for re-arm-skipped cycles, and an empty-queue assertion before each swap;
  (e) the sim prints `stall <gap_us> <mcu_us>` when a loop gap exceeds 2 ms,
  and a timing/identity failure counts as a fixture miss only when a
  recorded stall at least as large as the violated margin overlaps the
  window — otherwise strict; the harness header says the sim needs a fair
  core share; (f) D1 takes the minimum pipelined time over 3 bursts;
  (g) re-arm diagnostics print cycle and phase separately, and running out
  of re-arms is a fixture failure of its own (no stage retry on top).
  Also done in that rework, for robustness under sustained starvation of the
  sim (accepted): (h) C3 and C5/C6 run on a 120 ms period (C3 was 20 ms,
  C5/C6 60 ms) — the DAC value at each fraction of the period is unchanged
  and every documented swap guarantee (crossing state by index, next-cycle
  rule, ENDED on spent cycles, HOLD seeds) is still exercised, but no longer
  at the short periods; (i) longer marker pulses (C3 20 ms, C5/C6 60 ms) so
  the strobe timeout falls ~22-25 ms after the strobe fall; (j) C4's fresh
  START leads by 200 ms with its handling instant measured, plus a check that
  the HOLD position is the DAC's; (k) `swapMark` is read after a drain (an
  unread wrap no longer reads as a phase reset); (l) C5 re-runs as a fixture
  miss when the swap was handled past b's marker phase (otherwise the
  by-index crossing state would go unexercised).

## Review round 7 (2026-10-23) — findings and decisions

Four reviews on ec68dc7. No blockers. Fixed in round 7:

- **Unconfirmed swap vs the identical-spec shortcut (should-fix):** after a
  possibly-live failed swap, an edit back to the running geometry built a
  spec identical to `runSpec` and the shortcut returned before any swap — the
  Timed camera kept the shorter exposure for good, the mismatch persisted and
  the sibling was never retired. Decision: the shortcut is suspended while a
  sibling may be live; `mismatch_reason` names the unconfirmed swap
  ("replacement swap unconfirmed — the mirror may run the previous edit",
  LAST in the reason order) and the Timed clamp check is suspended in that
  state (the camera deliberately differs from the running table); the
  failure warning says the mirror may run either edit. Manual and spec tables
  carry the row.
- **Failed pair swap retires siblings (contract gap):**
  `TrajectoryReplaceError.retiredSiblings` names the possibly-live siblings
  whose STOP landed on a failed STOP/START pair; the node moves their
  open-ended scoring entries to the grace and the session retires their
  `specById` entries. Tests at all three layers.
- **Wording:** an atomic START replaces whichever table plays; only the pair
  and `stop()` STOP siblings (session comments, `endRun`, spec §actuation,
  `controller.md` lifetime); "keeps its previous geometry" and the Timed
  write-back are qualified with the may-be-live exception (spec ×3, contract,
  `replaceNow` doc); the manual's crosshair is "where you aimed" (the scan
  center unless a vergence pan holds); the readout remedy is "make both
  windows end at the same point of their sweep"; the spec's ring row drops
  `off` (the row is mounted only while the reader is on); the brief's
  round-6 section records the harness rework's extra changes (h)-(l).
- **Simulator harness classification (firmware clean; mutation-tested):**
  a fixture-miss classification never makes a check pass (it re-runs), but
  it pointed the wrong way in both directions. Decisions — (a) C5's "a's
  capture did not start before the swap" is a STRICT check (the rises were
  observed before the send, so `t_trigger < t_exposure < tSwap` always holds
  on correct firmware; the branch only ever fired on a timestamp fault);
  (b) the stall excuse is classified by mismatch KIND: a repeated or
  backward (cycle, marker) or a wrong table id is always strict; a skipped
  cycle needs a stall ≥ ~P; a BUSY needs the inter-marker idle gap; an ENDED
  overtaking the last OK needs the end gap — for these two the stall time
  is SUMMED over the window from the due phase to the push's own phase, with
  margin = gap − 2 × the 2 ms report threshold (a late fire followed by a
  late completion is two stalls; a single-stall rule failed on correct
  firmware), which also refines round 6 (e); a STROBE_TIMEOUT keeps
  TIMEOUT_SLACK; `discardPushes` classifies each (cycle, marker) once and
  excuses only a capture push behind a later BUSY or a skipped `last`;
  (c) three strict checks that fail on correct firmware under starvation
  become stall-aware: C5's latch check requires a's value strictly and then
  re-arms when BOTH strobe fall lines precede b's first CH1_B word on stdout
  (deterministic order), else requires b's strictly; `discardPushes` keeps
  draining pushes with cycle ≤ `last` after one GET round trip (a BUSY(c)
  legitimately precedes OK(c−1)); C4 STOPs after >10 ramp words or 1 s of
  MCU time and drops the run's pushes once the MCU clock is 30 ms past the
  STOP; C4's fresh-START and reset-hold checks count DAC words from the
  reset's init word (`dac cs=LR 280001`, printed while the burst is handled)
  rather than from a mark taken before the burst; (d) `checkTimed` does TWO
  GET round trips before reading stalls (the first can be answered by the
  loop pass that sent the push), and the comments say so; (e) `checkRamp`'s
  "keeps advancing across the swap" uses the window `[tSwap, tSwap + P]` and
  compares b's first ch0 word against the last word before the swap; a
  missing wrap needs a skipped cycle, an extra wrap is strict; (f) C4's
  post-START sequence expects exactly OK(id 0, marker 0, cycle 0) then
  ENDED(cycle 1, `t_start + P`).

## Review round 8 (2026-10-24) — findings and decisions

Fixed in round 8 (UI/docs lens first; the session and firmware/harness lenses follow below):

- **Mismatch hover on TriggerWidth cameras** printed "Applied exposure L 0.0
  ms · R 0.0 ms" (`exposure_us` is 0 by contract there). Decision: per eye,
  TriggerWidth prints "exposure = trigger pulse" (the window length), Timed
  prints the applied ms; the second figure is labelled "max frame rate" (it
  is the camera's readback limit). Spec §views wording follows.
- **A scan stopped mid-run read "idle — refused".** Decision: telemetry
  carries `scan_blocked_kind: "refused" | "stopped" | null` next to
  `scan_blocked`; the status line reads "idle — stopped" (warn) for an
  abort and "idle — refused" for a Start refusal; the restart-time clock
  check stops with "controller clock calibration lapsed — press Start once
  it recovers" (distinct from the Start refusal "controller clock not
  calibrated yet"). The spec §lifecycle and the manual list every stop
  reason: run ended / cancelled / controller disconnected, "scan restart
  failed: …", "exposure re-apply failed: …", "flip pipe rebuild failed: …",
  the lapsed clock on a Mode/Frequency change (the manual's lapsed row says
  such a change stops the scan until the clock recovers).
- **A latched refusal** stays until Start or Stop (no re-evaluation):
  the hover ends with "press Start to re-check" and the manual says so.
- **Ring rows:** the dead `off` branches go (the row and the strip are
  mounted only while the reader is on); one vocabulary on both — `idle`
  (scan not running) and `reading…` (waiting for a frame); the strip's
  strings are listed in spec §views.
- **Accessible names contain the visible labels:** the sync checkbox is
  named by its `<label>` ("Sync Windows"; the explanation moves to `title`),
  the mode selector is named "Mode".
- **Comment:** the Auto Vergence button comment matches its solid fills.
- **Manual:** "Make any change to the scan's aim or shape (even back to the
  same value)" settles an unconfirmed swap (gain / ring / PID edits do not).
- **Brief:** round 7's harness items (b)-(f) amended to what landed (summed
  stalls, both falls, init-word anchor, two round trips, wrap rule).
- **Session lens (round 8):** (1) **table capacity lockout (should-fix):**
  three unclear swap failures in a row reserve three possibly-live siblings;
  with the firmware's 4 tables the next replace throws "Trajectory capacity
  (4 tables) exceeded" and every later edit fails silently while `mismatch`
  says "unconfirmed" for good. Decision: a failed replace while
  `1 + siblingIds.size >= TRAJECTORY_MAX_TABLES` forces a stop → start of
  the CURRENT spec (`restartScanNow` gains a `force` flag; `closeTrajectory`
  STOPs and DELETEs every sibling) and reports "live edits exhausted the
  controller's tables — the scan restarts"; the manual's unconfirmed row says
  the app restarts the scan if it persists. (2) **one automatic settling
  replace per unconfirmed streak:** the failure branch calls
  `scheduleReplace()` (throttled) when `siblingIds.size > 0`, at most once
  per streak (flag cleared on a landed swap, `closeTrajectory`,
  `resetRunStats`, or a user edit), and never when
  `1 + siblingIds.size >= TRAJECTORY_MAX_TABLES − 1` (each unclear retry
  reserves another table; the capacity rule then applies). When
  `retiredSiblings` empties `siblingIds` (nothing may be live any more)
  while the Timed camera holds the shorter exposure, the failure branch
  re-grows the camera directly to the RUNNING table's pulse
  (`retimeIfNeeded(t, runRaw[0].pulseUs)`, safe: that table plays); a
  `timedStale()` guard (Timed and `appliedPulseUs ≠ runRaw[0].pulseUs`)
  suspends the clamp check and the identical-spec shortcut meanwhile, as
  does a pending `retimeAfter`. The controller's capacity refusal is a typed
  `TrajectoryCapacityError` (round 9). (3) `windows` /
  `exposure_us` carry the same may-be-live caveat as `amp_deg` (spec +
  contract). (4) Tests pin the reason ORDER (two reasons at once) and the
  "may run either the previous or the new edit" warning text.
- **Firmware/harness lens (round 8):** the firmware is clean (checked:
  32-bit intermediates, the budget clamp with a shrinking swap, markers at
  offset 0 / P−1 / two at one offset, swap or STOP in a crossing tick, a
  strobe that never falls, disable mid-run). Harness decisions —
  (1) **C6a false failure (should-fix):** a sim preempted inside one loop
  pass after driving a pre-wrap word makes `before.back()` stale and the
  "ramp keeps advancing" check fails strictly on correct firmware
  (demonstrated by injection). `(void)mcuNow(wire)` precedes C6a's drain +
  `swapMark` so the drained words are the current phase's; the `drain()`
  comment says it sees every word emitted by then, not the DAC state at the
  request. (2) **Coverage gap (should-fix):** two firmware mutants survive —
  dropping the cycles-budget clamp (an offset-0 marker fires one extra
  capture at `t_start + cycles·P`) and dropping the `first` guard (an
  offset-0 marker never fires in cycle 0) — and no stage exercises any push
  status but OK / ENDED. New stage C7: a finite run (cycles = 2) with a
  marker at offset 0 → exactly OK(c0), OK(c1), ENDED; strobes disarmed →
  STROBE_TIMEOUT pushes with cycle identity and `t_exposure = 0`, and the
  next close marker BUSY with `t_trigger == due`; a host CMD_FRAME in flight
  at a marker phase → BUSY; Enable(false) mid-capture → marker CANCELLED
  then run CANCELLED (NO_MARKER). Both mutants must die. As landed: C7b is
  two runs (one marker, cycles = 3 → STROBE_TIMEOUT for cycles 1 and 2; then
  two markers close together, cycles = 2 → m1 BUSY ahead of m0's
  STROBE_TIMEOUT in cycles 0 and 1); C7c's host
  frame also FINs; C7d's CANCELLED arrives ahead of the enable ACK, then the
  system is re-enabled and streams 1 and 2 re-created (1 first, the active
  stream stage D expects); a START handled past `t_start` under a host stall
  is a fixture miss. (3) **Summed-stall
  excuse over-credits:** stalls during the exposure cannot delay anything,
  so BUSY/ENDED-first use the MEASURED lateness: the overtaken OK's
  `t_trigger − due` is L, and the excuse requires the longest stall reaching
  `due(c+1)` (or `tEnd`) to have started at or before `t_trigger(c) + FALL`
  (as landed in `overtakeExplained`: a STROBE_TIMEOUT capture's end is
  extended by the timeout; one adjacent stall chained right behind such a
  stall is accepted too — the pass that pumped the fall may be preempted
  before its `Trajectory::tick` — with the 2 ms report threshold of slack at
  each joint; an event inside the capture itself is explained; a BUSY for
  the expected crossing itself stays strict; `PushGaps` carries `fall`
  instead of idle gaps); `discardPushes` no longer sums over
  `[busyAt − P, busyAt]`. (4) **Two
  legitimate BUSY shapes** are classified: C5's in-flight read accepts a
  BUSY from the SUCCESSOR id for cycle ≥ sc+1 under the BUSY rule (a ≥ P
  stall from before a's fall); `discardPushes(untilLast)` gives a BUSY of
  `last+1` the BUSY rule, not the skipped-cycle check. (5) **C4's
  30-ms-after-STOP drop** gets one more `(void)mcuNow(wire)` after the wait
  loop (a capture in flight at STOP can push after an in-pass preemption).

## Review round 9 (2026-10-24) — findings and decisions

Orchestrator lens: capacity accounting is consistent across layers (a graced
id is waited for, never counted; the session's `1 + siblings` check mirrors
the controller's allocator); the forced restart runs inline on the op chain;
`closeTrajectory` settles every STOP/DELETE before the new allocation; no id
≥ 4 ever reaches the wire. Fixed: the controller throws a typed
`TrajectoryCapacityError` and the session matches it by class.

- **Session (should-fix, a safety regression from round 8):** the regrow
  target `runRaw[0].pulseUs` is the REQUESTED marker-0 window, not the pulse
  the running table's markers carry. The two differ when the windows change
  between the camera write and the spec build (start arms with `pulse0` then
  rebuilds after the arming awaits; a restart retimes with the first build
  then rebuilds). A reconciling replace that then fails without a
  possibly-live table re-grows the camera to the NEW, longer window while
  the OLD table plays — the camera exposure exceeds the MCU pulse, unflagged
  (reproduced). Decision: the session records `runPulseUs`, the Timed pulse
  the RUNNING table was built with, wherever `runSpec` is set (`runTrajectory`
  and a landed swap: the retimed `pulse0`, else `appliedPulseUs`), and uses it
  for `timedStale()`, the regrow target and the clamp check's `want0`; the
  "unequal windows" check keeps comparing the REQUESTED windows. The round-8
  brief sentence ("safe: that table plays") is corrected by this one. Test: the
  reproduced sequence keeps the camera at the running pulse and names the
  stale state.
- **Capacity restart that cannot restart:** `restartForCapacity` reports
  after `restartScanNow`'s checks, as an attempt ("… — restarting the scan"),
  and the lapsed-clock / "scan restart failed" stop reasons name the capacity
  restart as a cause everywhere (spec §lifecycle, contract, manual).
- **Test comment:** the settling-retry test says the landing replace is a
  user edit; a case where the automatic retry itself lands is added.
- **UI/docs lens, fixed:** manual layout statements (Auto Vergence in the
  drawer's SECOND column of four; PID sliders BELOW the button); manual
  unconfirmed row says "If further changes also fail to get through, the app
  restarts the scan" and drops its duplicate sentence; manual idle status
  line (the hover shows the latched reason; refused/stopped are amber; a
  latched block clears on Start); the run-ended-during-START refusal listed
  and worded as a refusal ("the controller ended the trajectory run before
  the scan started"); "Press Start to re-check." skipped when the reason
  already says how to recover; the Ring View selector named "Ring View"; the
  spec's identical-spec sentence points at the swap paragraph and names all
  three exceptions; the manual's capture section says falling-sweep frames
  are saved unflipped and lists the JSON `pattern` block; the reset button's
  resting border removed (Principle 5); the `fw-sim-check` header mentions
  the adjacent-stall allowance.
- **Firmware/harness lens (round 9):** the firmware delivers every C7
  behaviour `serial-protocol.md` promises (eight mutants killed strictly).
  Harness decisions — (1) C7c's "marker fired after the host frame
  completed — sim stall" guard is unreachable on correct firmware (every pass
  that pumps the frame's fall ticks the trajectory first, past the due time)
  and hid a mutant in which a marker WAITS behind a host frame instead of
  pushing BUSY: deleted; `expectPush` judges strictly. (2) C7d's
  `early.size() == 1` check runs AFTER the measured-instant fixture test (a
  ≥ 50 ms host stall before the burst legitimately yields {OK(c),
  CANCELLED(c+1)} before the ACK). (3) C3, C5, C6a and C6b START with the
  measured START + GET burst (`startAhead`, hoisted to the shared fixture
  scope); a START handled past `t_start` is a fixture miss, not "a skipped
  crossing". (4) C4's pending-Trigger START check sends Trigger + START in
  ONE burst (a ≥ 150 ms host stall between them let the Trigger FIN reach
  `trajectoryOp` first — seen under load), then reads Trigger ACK, START REJ,
  FIN in order. (5) C7b part ii places m1 AFTER m0's pulse and before its
  strobe timeout (M1 = 36 ms with a 24 ms pulse and 29 ms timeout) so the
  documented "a marker due within 5 ms of the previous window's end pushes
  BUSY" is pinned — the mutant dropping the marker-capture margin
  (`active.pulse + (fromMarker ? 0 : STROBE_MARGIN_US)`) passed the whole
  harness before. (6) `overtaken`'s "event inside the capture" excuse
  requires the reported lateness `t_trigger − due` to be explained by a
  recorded stall over `[due, t_trigger]` (margin L − 2 ms) before trusting
  `t_trigger`. (7) Docs: `serial-protocol.md` states the run-level field
  values (ENDED: cycle = cycles, `t_trigger = t_start + cycles·P`; run
  CANCELLED: cycle 0, `t_trigger` = the cut instant) and the wire order on
  disable (the marker's CANCELLED inside the handler ahead of the Enable ACK,
  the run's on the next pass); `Packet.h`'s field comments say stream and
  frame_id are set on STROBE_TIMEOUT and CANCELLED, BUSY's `t_trigger` is the
  due time, and CANCELLED is also run-level.
