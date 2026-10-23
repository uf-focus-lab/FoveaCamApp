# MirrorLink — developer behavior spec

Developer-facing behavior spec for the `mirror-link` app: a calibrated L/C/R triple
whose two fovea mirrors trace a fast periodic SCAN PATTERN — an ellipse (a circle at
ratio 1, a sinusoidal line at ratio 0) or a triangular out-and-back sweep — around a
hand-aimed center. The pattern runs on the MCU as an uploaded trajectory whose markers
trigger both fovea exposures at exact phases, the trigger pulse being the exposure
window. A free-running blinking source (known blink frequency) then renders as a dashed
stroke along the exposed stretch of the path in every fovea frame — the on/off pattern
along it IS the decoded signal. Manual-control's steering bench minus set-points, raster
capture, split fovea, and the center-tile views. Distinct from the user manual. Code
carries tight one-line pointers to these anchors.

## Targeting {#targeting}

The scan CENTER is always whatever `steer` last set: a wide-view drag pixel, converted
server-side via `undistort.angular` (= `conv.P2A.C(px, false)`) into the wide angular
frame (`A0`, radians). Uncalibrated → `A0 = {0,0}` and origin volts. There is no tracker
and no programmatic angle mode.

**One pose chain.** `anglesAt(offset)` solves the per-eye angles from the ONE center:

    ray   = A0 + pan + offset
    angles = inverseTriangulate(ray, baseline, vergeToDistance(verge, baseline), v_shift)

`A2V` per eye turns them into volts. At `offset = 0` this IS `followTarget`'s forward map
(`@lib/vergence`) — the auto-vergence loop's output and the scan ride the SAME chain, which
is why `scan_path` and every trajectory sample are the exact commanded path, never a
linearization (§actuation). `mirror-link-vergence.test.ts` pins both facts. The pattern's
center ray is `A0 + pan` — the same point the overlay geometry and the axis handle are
projected from (§scan-patterns).

**Where the DOF live.** `{pan, verge, v_shift}` come from the loop's integrators while
auto vergence is ENGAGED and from the drawer sliders while it is off (`pan` is 0 there).
Verge Distance sets the depth both eyes converge on (∞ at `verge = 0`); Vertical Shift is
the toe that raises L and lowers R. Both slider ranges ARE the corresponding controller's
saturation limits (`VERGE_MIN_DISTANCE_MM`, `VSHIFT_LIMIT_DEG` from `@lib/vergence/tuning`)
so the two authorities can never disagree. They move the pattern's centre, never its
shape, scanning or not.

### Auto vergence {#auto-vergence}

The SAME fovea-into-wide template-match loop Disparity Scope runs — one control law, one
tuning surface, one set of hold semantics, hoisted to `@lib/vergence/` so neither app
imports across module boundaries. Read
[disparity-scope §match-join](./disparity-scope.md#match-join) and
[§control-law](./disparity-scope.md#control-law) (with
[§capture-epoch-target](./disparity-scope.md#capture-epoch-target),
[§derivative-on-measurement](./disparity-scope.md#derivative-on-measurement) and
[§seed-space](./disparity-scope.md#seed-space)) for the law itself; only the differences
are spelled out here.

**Nodes** (all under `win/mirror-link`, built on ENGAGE and disposed on disengage — the
ring-reader's on-demand shape, not disparity-scope's always-on one):

| node | what |
| --- | --- |
| `camera/<C>/undistort/slice/vergence-strip` | target-centred match strip off the C undistort, re-steered on every `steer` |
| `…/slice/vergence-strip/scale/match` | the strip at the match scale `s` |
| `camera/<L\|R>/convert/scale/vergence-needle` | each RAW fovea at `foveaTileSize` |
| `win/mirror-link/match/L`, `…/R` | the two template-match workers |
| `win/mirror-link/pid` | the join + the three DOF controllers |

The needle source is the RAW convert pipe, never a homography-undistorted one
([§needle-geometry](./disparity-scope.md#needle-geometry)) — which is why this app needs no
homography pipes at all (disparity-scope's exist for its stereo/composite views, not for
the match).

**Magnification.** No zoom knob here, so the resolution order starts one tier down: the
triple's stored `zoom_override`, then the calibration-measured fovea↔wide ratio, then 1
([§magnification](./disparity-scope.md#magnification)).

**Holds.** `hold: match low score` and `hold: match stale` are the shared ones. The one
app-specific hold is `paused: scanning`: while the scan runs each fovea frame is a RING,
not the dot the needle was cut from, so a step would servo on noise — the integrators keep
their values and the loop resumes the moment the scan stops. Engagement is allowed at any
time, scanning or not.

**Seams with the sliders.** On ENGAGE the controllers are seeded with `seedVergence` from
the current commanded ANGLES (never a volts round-trip —
[§seed-space](./disparity-scope.md#seed-space)); with `pan = 0` and the sliders as the only
authority, that reconstruction reproduces the held pose exactly. While engaged the
integrated `verge`/`v_shift` are mirrored into `state.verge`/`state.shift` at ~10 Hz so the
sliders show the result. A MANUAL slider write (one that differs from the mirror) re-seeds
that one controller; a `steer` re-references the loop by resetting `pan` to 0 (the new ray
is the new intent) and re-steering the strip. On DISENGAGE the mirror is flushed and `pan`
— which has no slider — folds into `target`/`target_angle`, so the disengaged chain
reproduces the engaged pose bit-for-bit and the mirrors hold.

**Telemetry.** `vergence_status` (`off` / `tracking` / `paused: scanning` / `hold: …` /
`no calibration`), `vergence_blocked` (the refusal reason, the `scan_blocked` shape — the
status reads `off — refused` with it in the hover, not only a tray toast), and
`match_left`/`match_right` as `{rect, score}` in ABSOLUTE wide px, which the wide view draws
as hollow per-eye markers while engaged: a `hold: match low score` then SHOWS what was
matched instead of leaving it inferred. The per-side correlation HEATMAPS are not emitted —
this app has no debugger window, so computing them would be wasted work — and no frame size
is published: the wide pipe payload already carries it.

## Ring views {#ring-views}

`state.ring_view` (`off` | `polar` | `binary` | `segments`, default `off`, persisted)
selects a per-eye histogram of the reader's own intermediates, drawn in the CENTER column
of the main view, directly under the scan row — the column is shorter than L/R by their
PosViews, and the rings belong under the wide tile they were measured from. The strips
take the tile's own width (4:1, so 7.5vw each at a 30vw tile), and the stage selector sits
on its own layout-stable row above them. The ring worker builds a DEBUG STRIP only while
it is not `off` (pushed with `enabled` via `sendParams`), so the views cost nothing when
closed.

The strip is ONE mono8 session frame per eye (`ring-L`, `ring-R`), width = the ANGULAR
sample count `n` — the arc-domain rows are mapped back through the same arc→angle table the
overlay uses, so every row lines up column-for-column. Rows, top to bottom: the polar image
(`polarRows`, normalized to its own p1/p99), the envelope-normalized profile, the binary
ring, and a segmentation row (0 none · 64 byte edge · 128 field edge · 192 leader span ·
255 data start). `telemetry.ring.<eye>.strip` carries `{ polarRows, width, rows }` — the
renderer needs no other agreement. Each strip is a FRESH buffer (the worker transfers
emitted frames). Frames flow only while the ring node exists AND the scan runs; otherwise
the canvas is empty and the caption says why.

## Scan patterns {#scan-patterns}

Source: `scan.ts` (pure, Vue-free, unit-tested — `mirror-link-scan.test.ts`).

Every offset is radians in the WIDE angular frame, added to the center ray `A0 + pan`
BEFORE `inverseTriangulate` (§targeting), so both eyes trace the same pattern around the
same scene point. `θ = scan_axis_deg` (normalized into (−180, 180]), `a =
radians(scan_amp)`, `R(θ)` the counter-clockwise rotation (+x → +y), `T = 1/scan_hz` the
BASE period — one ellipse revolution, one triangle sweep.

- **Ellipse** (`scan_mode = "ellipse"`): period `T`; at phase `φ ∈ [0,1)`
  `o = R(θ) · (a cos 2πφ, r · a sin 2πφ)`, `r = scan_ratio` ∈ [0, 1]. Ratio 1 is the old
  circle (pinned by test), ratio 0 a sinusoidal line along the axis.
- **Triangle** (`scan_mode = "triangle"`): period `2T`; `o = R(θ) · (s(φ), 0)` with `s` the
  −a → +a → −a triangle (−a at `t = 0`, +a at `t = T`). The ratio is ignored.

`patternOffset(mode, φ, θ, amp, ratio)` is the one geometry function; `patternPeriodUs`
gives the MCU period in WHOLE µs (`sweepUs(hz) = round(1e6/hz)`, the triangle exactly twice
it, so its second marker sits on the same grid). `patternSamples` turns a pattern into
trajectory samples: the ellipse as 128 samples at `tOffsetUs = round(k·P/128)`, each offset
at the phase of its OWN rounded time (the MCU clock and the geometry agree exactly); the
triangle as exactly TWO — `t = 0: −a`, `t = T: +a` — because the MCU's linear interpolation,
wrapping last → first across the period boundary, IS the triangle (`step` stays false).
`scanAngles(A0, offset, baseline, distance, shiftRad)` composes the per-eye angles (zero
offset = the idle pose). Zero amplitude degenerates to the idle pose in both modes.

**Drawn geometry.** `patternPath` gives `SCAN_PATH_SAMPLES` (48) points for drawing: the
ellipse as a closed loop, a ratio-0 ellipse and the triangle as the OPEN segment −a → +a
along the axis. Through the exact chain they become `scan_path` (volts per eye, clamped to
the controller envelope like every commanded pose) and, projected with `A2P.C` of the
center ray, `scan_path_px`. `windowPaths` gives the EXPOSED stretch per marker
(`scan_window_px`, one polyline each, sampled at the path's density), and
`axis_handle_px = A2P.C(A0 + pan + R(θ)·(a, 0))` is the draggable +amp end of the axis.
Uncalibrated (no wide undistort) the three px fields are empty / `{0,0}` (the overlay hides
the handle on it); `scan_path` is still published. All four are republished on EVERY input
that moves or reshapes the pattern — `steer`, `setAxis`, `verge`, `shift`, `baseline`, a
vergence write-back, `scan_amp`, `scan_ratio`, `scan_axis_deg`, every window key,
`tri_window_sync`, `scan_mode`, `scan_hz`, activation — and never per tick.

**Axis drag.** `setAxis(px)` maps the pixel through `undistort.angular` and sets
`scan_axis_deg = axisDegFromPixelRay(A0 + pan, point)` — the direction from the center ray
to it. A pointer ON the center (a zero-length ray) or an uncalibrated triple keeps the
previous axis. The pane slider writes the state directly.

**Sanitizing.** Every pattern key is clamped by its watch and the clamped value written
back (`scan_ratio` to [0, 1], `scan_axis_deg` normalized, every window through
`clampWindow`, an unknown `scan_mode` → `ellipse`), so the drawer never shows a value the
scan does not run.

## Scan lifecycle {#lifecycle}

`startScan`/`stopScan` are COMMANDS, not state — a scan is session-local intent that must
never auto-resume on re-entry (it reprograms the cameras). `telemetry.scan` is non-null
exactly while active (§exposure-windows has its shape). Every transition below
serializes on ONE FIFO op chain (`queueScanOp`) — start, stop, the period restart, every
live re-upload and the gain writes — so a fast toggle can never interleave a camera apply
with an in-flight restore, nor a re-upload with a restart.

**Start** — refused, with the reason on `telemetry.scan_blocked` and `false` returned:
without a leased triple (`no camera triple leased`), without a bound controller (`no
controller connected`), or on firmware below 2.2.0 (`controller firmware >= 2.2.0
required` — there is no JS fallback any more; it could not trigger anyway). Otherwise, in
order: build the spec (§actuation); ARM both foveas, L then R (snapshot the timing →
`enableHardwareTrigger(lease)` → `applyTriggeredTiming`, §exposure-windows); open the
trajectory (`controllerNode().openTrajectory(spec, { name: "mirror-link" })`); subscribe
its pushes and state; build the flip pipes in triangle mode (§triangle-flip) BEFORE the
first trigger; START at an EXPLICIT host instant `hostNowNs() + 20 ms` (so lateness is
exact and `replace` carries the phase). A failure at any step undoes what was done
(close the table, retire the flips, disarm the cameras) and refuses with
`exposure override failed: …` or `trajectory start failed: …`. An idle / re-lease while
awaiting undoes silently. Only then `scanActive` turns true and `scan` publishes.

**Stop** — `scanActive` off (the pacer resumes the idle slew), the pending re-upload
dropped, the table STOPped and closed (the node re-takes the DAC for the position input),
the flip pipes retired (`flipPipes` → null), then per eye `disableHardwareTrigger` and the
verbatim timing restore, `scan` → null. A run that ENDS UNDER the session — the node
reports the table `detached` (controller unbound/swapped) or back to `ready` (the MCU
ended or cancelled it), or a `replace` throws a `TrajectoryReplaceError` with
`running: false` — runs the same stop and publishes the reason on `scan_blocked` plus a
tray warning.

**Period change** — `scan_hz` or `scan_mode` while active changes the trajectory period,
which `replace` cannot swap: the op chain stops + closes the table, rebuilds, opens and
starts a new one (new explicit instant), keeping the camera config (the trigger mode is
not re-armed; only a Timed exposure is re-written, and only for a new marker-0 pulse) and
rebuilding the flip pipes when the mode or their tolerance changes.

Idle drains a `stopScan` AFTER the pacer stops and BEFORE `triple` clears +
`releaseLeases` — the restore rides `lease.reconfigure` and needs the live lease (the
manual-control trigger-sync ordering; §teardown).

## Exposure windows {#exposure-windows}

Source: `scan.ts` (windows → markers) + `exposure.ts` (camera timing; pure over a
`Camera`-shaped seam, unit-tested with a fake — `mirror-link-exposure.test.ts`).

**Windows.** Each window `[w0, w1]` is a fraction of its SLOPE (`T`), clamped by
`clampWindow` to `0 ≤ w0 < w1 ≤ WINDOW_MAX = 0.95` with `w1 − w0 ≥ WINDOW_MIN = 0.005`
(the pane's step; an inverted pair is swapped, a too-short one grows its end — or its start
at the cap). The cap keeps the trigger line released and the capture engine idle before
the next marker (the firmware fires a marker only on an idle engine, else pushes BUSY) and
leaves the camera its readout gap. `activeWindows(mode, state)` picks them in marker order:
the ellipse's `scan_window`; the triangle's `tri_window_rise` and — while
`tri_window_sync` is on, whatever the state holds — the rising window again for the fall.

**Markers.** `windowMarkers` turns window `k` into one trajectory marker,
`t_offset_us = slopeStart_k + round(w0·T)`, `pulse_us = round(w1·T) − round(w0·T)`, cameras
L|R: the ellipse's ONE marker at slope start 0; the triangle's marker 0 (rising) at
`w0_rise·T` and marker 1 (falling) at `T + w0_fall·T`. Every window ends before the next
marker by construction.

**Sync.** The session ENFORCES it (the pane only disables the falling slider): while
`tri_window_sync` is on every `tri_window_rise` write is copied into `tri_window_fall`
(`s.setState`), a `tri_window_fall` write snaps back to the rising value, and turning sync
on copies rise → fall once.

**Camera timing.** Cameras take the window as `ExposureMode = TriggerWidth`: the trigger
pulse IS the exposure, so the two triangle windows may differ and no exposure is written
per frame. Per fovea, on the lease's safe path, the per-camera config docs untouched:

1. `snapshotTiming` (reads only, before the trigger write — `arv_camera_set_trigger`
   resets TriggerActivation): `frame_rate_enable`, `frame_rate`, `exposure_auto`,
   `exposure`, and the `ExposureMode` / `TriggerActivation` nodes (null when the model
   lacks one — the restore then skips it).
2. `enableHardwareTrigger(lease)` (TriggerSource Line3, strobe on Line2 as ExposureActive
   with the branch's measured `LineInverter = true`; `camera-trigger.ts`). A failed
   `LineInverter` write is reported as a warning, not a refusal.
3. `applyTriggeredTiming(cam, { pulseUs, preferTriggerWidth })`: `exposure_auto = Off`,
   frame-rate enable OFF (the trigger paces the frames; with the limit off the exposure
   ceiling only widens), then `TriggerWidth` + `TriggerActivation = LevelHigh` — or the
   **Timed fallback** when the model refuses either: `ExposureMode = Timed`,
   `TriggerActivation = RisingEdge`, `exposure = clamp(pulse of marker 0,
   exposure_range)` (min and max, read at the write). Neither mode → throws (refused).

ONE mode for both eyes: when one eye falls back to Timed the other is re-applied as Timed,
so both expose the same window. A live window change in Timed mode re-writes the exposure
when the marker-0 pulse moved (after the re-upload landed); in TriggerWidth nothing is
written. **Restore** (`restoreTiming`, after `disableHardwareTrigger`): `ExposureMode`
first (so a Timed exposure is writable again; the generic feature write when the typed
setter refuses the saved entry), `TriggerActivation`, the two-sided exposure write around
the frame rate (the ceiling moves with the rate), `exposure_auto` LAST.

**Telemetry.** `ScanTelemetry` = `mode`, `hz`, `amp_deg`, `period_us` (T or 2T), `windows`
(`{ t_offset_us, pulse_us }` per marker, as the MCU runs them — republished after every
re-upload / restart), `exposure_mode` (`TriggerWidth`, or `Timed` when either eye fell
back), the per-eye applied `exposure_us` (0 in TriggerWidth) and readback `frame_rate`, and
`mismatch` — Timed only: an applied exposure more than 2 % off the marker-0 pulse, or
triangle windows of unequal length (one exposure cannot take both). A mismatch warns once
until it clears (`report("mirror-link", …, "warning")`).

**Ground truth.** OK marker pushes ARE the exposure record. `STROBE_TIMEOUT`, `BUSY` and the
rest count into `perf.trajectory.pushes` (§actuation); a run with NO OK push for two
periods (measured from the start instant, or the last OK push) warns ONCE per run, naming
the timeout/busy counts.

## Gain override {#gain}

Source: `gain.ts` (pure over a `Camera`-shaped seam, unit-tested with a fake).

ONE gain (dB) drives BOTH foveas, and it is SESSION-WIDE, not scan-scoped — aligning on a
dim source needs it before the scan. Same live-handle model as §exposure-windows: written through
`lease.reconfigure`, the per-camera config docs NEVER touched, `gain_auto` forced Off while
overridden. `telemetry.gain_range` is the INTERSECTION of the two cameras' `gain_range`s
(`{0,0}` until leased, and for a DISJOINT pair — no common value, so no slider rather than
a bound one camera would reject).

At activation both eyes' `gain`/`gain_auto` are snapshotted (a model with no `gain_auto`
node records the value alone and skips that write on restore) and the range published. A
null `state.gain` (first entry) is SEEDED from the L camera's live `gain`, read on its own
and with NO camera write; a carried-over value is applied to both eyes, clamped to the
shared range, and the clamped value is written back to `state.gain` so the readout never
shows a gain the hardware did not take. The
`gain` watch rides the SAME FIFO op chain as the exposure ops so a slider drag can never
interleave with an apply/restore on the same lease. Teardown restores in the drain's scan
slot (after the pacer stops, before `triple` clears): exposure timing FIRST, then gain.

## Ring reader {#reader}

The point of the scan: each fovea frame carries the emitter's blinking pattern as a ring,
and the `ring` vision kernel (`ring-code.md` §reader) decodes it per frame, per eye. ONE
worker over the two fovea pipes (roles `L`/`R` — the same un-warped views the operator
reads): the RAW convert pipes, or the §triangle-flip FLIP pipes while they exist (the reader
is rebuilt on every flip transition, both directions, so it decodes the upright frame),
`meterName`/node id `win/mirror-link/ring`.

The reader is an OPTIONAL NODE, DEFAULT OFF (`state.ring_reader`) — it costs a worker
thread reading every fovea frame, so it exists only while asked for. `buildRingNode()`
connects the two pipes, registers the wiring (node + its two frame edges), and spawns the
worker with the live `enabled`; `disposeRingNode()` terminates the worker → unregisters the
wiring → disconnects the pipes, in that order, and resets `telemetry.ring` to
`{L: null, R: null}`. The `ring_reader` watch builds/disposes live (both directions
idempotent, both no-ops without a leased triple); activation builds it iff the state is
already on. The profiler therefore shows the node exactly while it exists.

Gated on the scan too: `enabled` is pushed via `sendParams` on every scan start/stop (and
at node creation), and a disabled kernel does NO pixel work — an un-scanned frame holds no
pattern.

`telemetry.ring = { L, R }` carries the per-eye `RingReadout` (null until that eye's first
result). A failure keeps the CURRENT reason AND the last successful read on `last`
(`ring-code.md` §error recovery), so a decoded value stays on screen while frames drop.
STOPPING THE SCAN clears it (as does a run the controller ended, disposing the node, and
`idle()`): the readout describes a frame exposed along the scan path, and free-running
frames are not.

## Views {#views}

The L/R main views bind the RAW convert pipes (`nodeId.convert(serial)`) directly, at pipe
rate — deliberately NOT the homography-undistort bricks: a frame that integrates a scan
window has no single mirror pose to warp against, and the un-warped path is the
readout. While `state.flipPipes.L/R` is set (triangle mode, §triangle-flip) each view
binds that FLIP pipe instead, so the falling-sweep frame arrives upright; `null` restores
the raw binding (the renderer reads the state, never builds the pipe). While `ring_reader` is on AND the scan is running (and ONLY then — an off
feature leaves no phantom row, and an annotation asserts a decode of the CURRENT frame)
each carries the §reader annotations in FRAME px: the fitted circle (solid on a decode,
dim + dashed when only the fit succeeded), the LEADER arc in `--warn` (distinct from both
eye colors), and radial ticks at every field (long) and byte (short) boundary. The arc +
ticks stay mounted and fade rather than remount — a marginal emitter flips ok↔fail at
frame rate. Under it a fixed-height, START-aligned mono row reads the decoded text +
`px/chip` (emphasized), or `off` / `idle` / `reading…` / the failure reason (with the
last decode, muted); the full text, the hex and the reading direction ride its `title`.
Below the center tile's scan row sit the §ring-views stage selector and the two strips.

The center view binds the intrinsic `undistort:<serial>` pipe (raw convert fallback
uncalibrated) and is the ONLY steering surface; no display worker, no
stereo/composite/heatmap bricks. Overlays on the center view, all in wide px:

- the target dot at `telemetry.target` (center theme color),
- the scan PATH — `telemetry.scan_path_px` as one SVG path, CLOSED for the ellipse with
  `scan_ratio > 0`, OPEN for the line (ratio 0) and the triangle — dashed and faint
  while idle (a preview), solid while active; on top of it each `telemetry.scan_window_px`
  polyline (one per marker: the EXPOSED stretch) at twice the stroke and full opacity,
  dashed with the path while idle. Empty uncalibrated, nothing drawn,
- the AXIS HANDLE — a spoke (one stroke) from `telemetry.target` to
  `telemetry.axis_handle_px` (the +amp end of the main axis) and a filled dot of radius
  `stroke · 3` there; hidden on the `{0,0}` uncalibrated sentinel. Hit rule: the FIRST
  cursor event of a drag (the press; the StreamView cursor is already in wide frame px)
  within `stroke · 6` of the handle starts an AXIS drag — every cursor event of that drag
  calls `setAxis(px)` and none calls `steer`, until release; any other press steers as
  before. Both are sent per cursor event, fire-and-forget, identically (the session
  coalesces the trajectory re-upload, §actuation). A grab / grabbing pointer over the
  hit zone / during the drag is the only affordance,
- per-eye markers at `L_PX`/`R_PX`, projected from the CENTER pose (`A2P.C ∘ V2A` of the
  offset-free volts, shift included), not the instantaneous scan pose — they show where
  each fovea is aimed, and separate with the verge/shift. Hidden uncalibrated ({0,0}).

The PosViews draw the scan as a STATIC path with a stable crosshair: `telemetry.volt` is
the commanded pose while idle and the path's CENTER while scanning (sampling the path at
the 30 Hz telemetry throttle reads as random flicker, not motion), and
`telemetry.scan_path = { L, R }` carries the commanded path in VOLT space —
`SCAN_PATH_SAMPLES` points per eye through the trajectory's own chain (offset →
`inverseTriangulate` + shift → `A2V`), which the renderer closes into a loop for the
ellipse with `scan_ratio > 0` and leaves open for the line and the triangle (the center
view's rule), drawn with `Line2D` (faint idle, solid while active). It is republished on
every input that moves or reshapes the path (steer, `setAxis`, every pattern key,
`verge`, `baseline`, `shift`, a vergence step's write-back, activation) and
NEVER per tick; empty without a leased triple. PosViews are read-only here (no split).

Below the center tile: ONE button whose label swaps Start Scan / Stop Scan (the row is a
GRID with a fixed 9em first track, so neither the label nor the status text can move or
resize it; label tracks `telemetry.scan`; disabled until `ready`, dimmed in place while a
start/stop round-trip is in flight; solid `--accent` fill idle, solid `--danger` while
scanning — emphasis is a FILL, never a border, and both pairs clear AA) and
a compact status span — `mode · hz · period · windows` while active (the period is the
TRAJECTORY period, T or 2T; each `ScanTelemetry.windows` entry as `start–end` ms within
it, joined by `+`; a trailing `· timed` on the `Timed` exposure fallback), `idle` /
`idle — refused` otherwise. Warn-toned on `mismatch`, on a run whose
`perf.trajectory.pushes` show failures and no OK push, or on a refusal. The `title`
carries the exposure mode with the applied per-eye exposure / frame rate on a mismatch,
then the `perf.trajectory` bookkeeping (pushes ok / timeout / busy / other, last
lateness, live re-uploads, and in triangle mode flipped / unmatched per eye) — or, idle,
what Start would run, or the blocked reason. The row is a PLAIN div, never a
`<label>`/ConfigEntry: a label would forward a status-span click to the button and
toggle the hardware override; the button's own explanation rides the ROW's `title`
(a disabled button suppresses hover). The drawer carries FOUR columns (nested
`HorizontalDivision`s, ≈ 0.20 / 0.23 / 0.27 / 0.30 — the two right columns carry the
longest strings: the window readouts, the frequency readout and the status line): the
mirror controls (Verge Distance, Vertical Shift); the vergence loop — the Auto Vergence
toggle with its status FIRST (the thing you press and the thing you read, above the knobs
that tune them), then the SHARED tuning block (Pan / Depth / Vertical PID groups, each
with a one-line hover on its heading and a `faArrowRotateLeft` reset, plus Min Match
Score) — the SAME groups, keys, defaults, ranges, per-term hovers and reset glyph as
Disparity Scope's, out of `@lib/vergence/tuning`; the **Scan Pattern** pane
(`ScanPatternPane.vue`, below); and Gain, Scan Frequency (the BASE period both modes
share — its hover says the triangle's period is twice it), the Ring Reader toggle and a
Status row, Gain leading because it is session-wide, not scan-scoped. The §ring-views
strips are NOT in the drawer — they live under the center tile.

The Scan Pattern pane writes the session's `state` proxy directly, like every drawer
control (the session rebuilds the trajectory and, while active, swaps it in, §actuation).
Rows, top to bottom: a `SCAN PATTERN` group heading; **Mode** — a two-option horizontal
`SingleSelect` (Ellipse | Triangle) on `scan_mode`; **Axis** — RangeSlider on
`scan_axis_deg`, −180..180°, step 0.5, neutral 0, readout `+12.5°`, its hover naming the
center-view handle as the other way to set it; **Amplitude** — `scan_amp`, 0..2°, step
0.01, neutral 0.5 (moved here from the right column). Then per mode — Ellipse:
**Ratio** (`scan_ratio`, 0..1, step 0.01, neutral 1, readout `1.00`, `line` at 0) and
**Exposure Window** (`scan_window`); Triangle: **Rising Window** (`tri_window_rise`),
**Falling Window** (`tri_window_fall`) and **Sync Windows** (`tri_window_sync`, an Off | On
`SingleSelect` — the drawer's boolean idiom, as Ring Reader). The window controls are
`app/src/inputs/dual-range-slider.vue` (model `[start, end]`, 0..`WINDOW_MAX` = 0.95,
step and `minGap` 0.005, neutral = the contract default), read out as `start–end ms` of
the base period `T = 1/scan_hz` — of the period for the ellipse, of each sweep for the
triangle. While synced the falling slider is DISABLED and paints the rising values (its
proxy reads `tri_window_rise` and refuses writes; the session mirrors the state). The
dual slider is RangeSlider's twin: the same body, infill (between the thumbs, exclusion
blend), label slot (two `<span>`s), cursor glyphs; a press grabs the NEARER thumb and
drags it through a WINDOW `mousemove` listener (no pointer capture), the dragged thumb
stopping at the range ends and `minGap` short of the other (never pushing it); each thumb
is its own tab stop and the arrows step it by `step` (×0.1 per modifier); right-click
resets to `neutral` only when one is declared. Its value math is `app/src/inputs/
dual-range.ts` (unit-tested).

One STATUS vocabulary across the drawer, scan and vergence alike: `muted` = nothing
running, `ok` = healthy, `warn` = the operator must look, with a `dim` modifier on `ok` for
a deliberate, expected pause (`paused: scanning`). The Verge/Shift sliders are never
DISABLED while the loop drives them — they read as loop-owned (`--accent-bright`) and a
drag hands the loop a new starting point; `holdDof` suspends the write-back for the length
of the drag so a fully-controlled slider cannot be yanked out from under the pointer, and
the release re-seeds both controllers from the final values. The release is caught on
WINDOW `pointerup`/`pointercancel`, not on the wrapper: RangeSlider tracks its drag through
a window listener and never captures the pointer, so a release outside the slider would
otherwise leave the hold latched. The disengage flush forces the write-back past the hold,
so a stuck hold can never make the pose jump.
Every slider carries a one-sentence `title`. Gain alone declares NO `neutral` — a stray
right-click must never slam a live camera to range-min, and its `title` says so — and it
is disabled (readout `—`) until `ready` with a non-degenerate `gain_range`; its `v-model`
proxy CLAMPS on read and refuses writes while disabled. No explanatory text anywhere —
hover tooltips only.

## Actuation {#actuation}

The scan runs on the MCU, not on any host loop: the controller node's ONE uploaded
trajectory (`CMD_TRAJECTORY`, protocol 2.2.0 —
[controller §trajectory-ownership](./controller.md#trajectory-ownership)). The MCU
interpolates the samples, fires the markers through its capture engine at exact phases, and
pushes one 44-byte frame per trigger with trusted timestamps. A synchronous camera write or
an allocation on the orchestrator loop can no longer bend the path. (The native
`OrbitStream` brick that used to generate a host-paced circle stays in core,
[core-streams §orbit-stream](./core-streams.md#orbit-stream), but MirrorLink no longer
creates it — no orbit seam, no native position input, no sink governor, no
`orbit_pace_hz`.)

**The spec.** `buildScan()` turns the current state into a `TrajectorySpec`:
`periodUs = patternPeriodUs(mode, hz)`; every `patternSamples` offset through the EXACT
chain — `voltsFor(anglesAt(offset))`, clamped to the controller's envelope like every
commanded pose, never a linearization — as `{ tOffsetUs, left, right }`; one marker per
window from `windowMarkers`, `cameras: ["L", "R"]`; `step: false`.

**Idle.** The JS `openPosition("mirror-link")` input and its 1 ms pacer remain for the IDLE
center pose: each tick slews the commanded pose toward `centerVolts()` with the shared
first-order smoother (`@lib/slew`). While the trajectory runs the node HOLDS every
position push and hands the DAC back on stop; the pacer does not even push then (gated on
`scanActive`), and on stop the slew resumes from the last idle pose. The tick keeps its
1 ms cadence because its gap IS the loop-stall meter (`perf.tickGapMs`).

**Live geometry → `replace`.** Every input that reshapes the pattern without changing its
period — `steer`, `verge`/`shift`/`baseline`, a vergence write-back, `scan_amp`,
`scan_ratio`, `scan_axis_deg`, the windows, `setAxis` — rides `publishScanGeometry()`, which
while scanning arms a throttle timer: at most ONE `NodeTrajectory.replace(spec)` per
100 ms, the spec built when the op RUNS on the chain, so the latest geometry wins (the node
coalesces in-flight swaps too; the throttle keeps the wire sane). An identical spec is
skipped. `replace` swaps tables phase-continuously (the new table joins the old run's
`t_start`), so the mirror keeps sweeping and pushes keep flowing on the same handle. A
replace that throws with the run still going keeps the previous geometry (one warning per
run); one that ended the run (`TrajectoryReplaceError.running === false`) stops the scan
(§lifecycle). A period change is never a replace — §lifecycle restarts the run.

**`perf.trajectory`** (`TrajectoryTelemetry`, published with `perf` at the
`VOLT_TELEMETRY_INTERVAL_MS` throttle; counters reset per scan): `running` (scan active and
the table running), `pushes` by status (`ok` / `timeout` = STROBE_TIMEOUT / `busy` / `other`
— run-level ENDED/CANCELLED and UNKNOWN), `lateness_us` of the last OK push against the
EXPLICIT start (`tTrigger − (t_start + cycle·period + marker offset)`, exact because the
session always starts at an explicit instant), `reuploads` (successful replaces this
scan), and the flip bricks' `flipped` / `unmatched` per eye (§triangle-flip; 0 in ellipse
mode). `telemetry.volt` is the commanded pose while idle and the pattern's CENTER while
scanning; `perf.actuateMs` / `perf.tickGapMs` keep their meaning for the idle path.

## Triangle flip {#triangle-flip}

The triangle exposes one frame on the rising sweep (marker 0) and one on the falling sweep
(marker 1); the falling frame is VERTICALLY flipped (rows reversed) before any consumer —
the L/R views and the ring reader — sees it. (A flip about the horizontal axis is what was
asked for; for an axis far from vertical the geometrically exact reversal would be a
reflection across the scan axis — a later refinement.)

**Bricks.** While the triangle scan runs on a leased triple the session builds ONE native
`FlipStream` per eye ([core-streams §flip-stream](./core-streams.md#flip-stream)) through
`createFlipPipe(flipSeam, nodeId.convert(serial), cameraPipeSpec(camera),
nodeId.flip(serial), { toleranceNs })`: the pipe `camera/<serial>/convert/flip` is
advertised with the convert pipe's own spec (`cameraPipeSpec` — the one place that shape is
decided) BEFORE the brick attaches. The two rows are registered as graph wiring (kind
`flip`, owner `win/mirror-link`, edges from the convert pipe and from the trajectory node
`controller/trajectory` as the `anchor` port); their meters come from core's
`flipProbeAll()` probe, already registered by the orchestrator. Then `state.flipPipes =
{ L, R }` (a `s.setState`, like `undistortPipe`) and an existing ring reader is rebuilt on
the flip pipes. In ellipse mode nothing is built and nothing is copied. Without an injected
flip seam the triangle scans unflipped, with one warning.

**Anchors.** Every OK marker push becomes `{ tExposure, flip: marker === 1 }`, pushed to
both bricks FIRST and synchronously in the push callback — no await, no other work before
it. Failed pushes (timeout, busy) exposed no frame and push nothing.

**Matching.** The brick flips a frame iff the NEAREST anchor within `toleranceNs` of its
timestamp is marked `flip` (PairStream's rule; owner-applied trusted host-ns on both sides).
The tolerance is `0.4 · min(T, closest circular marker spacing)` — the brief's `0.4·T` at
the default windows, tighter when the windows bring the two markers close, so a frame whose
own anchor is late can never match the neighbouring marker (and a rising frame never
flips). The brick takes it at attach, so a restart with a new sweep time rebuilds the
bricks, and a live window change that would leave the tolerance too wide rebuilds them
tighter (a wider spacing keeps them — the nearest anchor wins anyway).

**Late anchors.** The brick NEVER holds a frame back: a frame it processes before its
marker push arrived passes through UNFLIPPED and counts as `unmatched`. Normally the push
(sent when the strobe falls, at exposure end) beats the frame (readout + USB transfer), but
not under load — hence the synchronous anchor push. `perf.trajectory.flipped` /
`.unmatched` carry the bricks' counters (probed at the telemetry throttle), and when the
unmatched share of `flipped + unmatched` over the last two periods (at least 500 ms, and
at least 8 frames) exceeds 5 % the session warns ONCE per run: "falling-sweep frames
arriving before their marker push — they are shown unflipped".

**Retire** (stop, a switch to the ellipse, idle) runs consumers first: `flipPipes` → null
(the views fall back to the raw convert pipes), the ring reader lets go of the flip pipes,
the wiring rows drop, each brick detaches + un-advertises, and — outside the teardown
drain — the reader re-binds the raw pipes. The RAW capture / recording pipes are never
flipped (§capture).

## Recording {#recording}

capture-recorder-everywhere: the title-bar record button writes the raw L/C/R streams
through the shared `@orchestrator/raw-recording` facility (`recorder/mirror-link`; no
per-frame fovea binding — a scanned frame has no single pose). `busy()` refuses a
mid-recording drain.

## Capture {#capture}

The offline debugging path: the title-bar capture button (or `Cmd/Ctrl-S`) runs ONE shot
through the shared `@orchestrator/capture-helper` (`capture/mirror-link`), holding
full-depth stacked L/R foveae + the undistorted center, and the preview sub-window saves
them as `<resource>.<png|tiff>` (BGR, 16-bit for the foveae) + `<resource>.json`.

`stackCount` is `state.cap_stack` (default 1 — one window IS the frame; no slider).
The homographies are IDENTITY and the rect is the whole center frame: a frame exposed along
the scan path has no single mirror pose to warp against, and the UNWARPED frame is exactly
what the analyzer reads. Every resource's metadata carries a `mirror_link` block — `scan`
(the applied timing, null when idle), `pattern` (`mode`, `axis_deg`, `amp_deg`, `ratio`,
`windows` — what the trajectory is built from), `ring` (the last per-eye readout: fitted
circle, chip arc, reason), `shift`, `verge`, `baseline`, `target_angle`, and the
center-pose volts/angles/`A2H` matrices for reference — so a saved frame explains itself.
The capture reads the RAW pipes, which the §triangle-flip bricks do NOT touch: a
falling-sweep frame is stored as the camera saw it (rows NOT reversed), and the same holds
for the raw recording. `scripts/ring-debug.py <image>` reads both.

OBSERVE-ONLY — no camera write, no allocation on the shot path. Nothing in a shot calls
`lease.reconfigure` or any camera setter (the native `attachRawPipe` subscribes to the
camera's EXISTING `Arv::Stream`), so the exposure override is untouched. The raw L/R pipes
are PRE-ACQUIRED at activation with `CAPTURE_RING_DEPTH`: `rawPipes.acquire` on a 0→1
transition advertises the pipe — allocating a depth × full-depth-frame SHM ring — and runs
the native attach, both synchronous on the orchestrator loop that also delivers the
trajectory pushes and the flip anchors (§triangle-flip). Per shot that cost would stall the
loop for tens of ms and late anchors would leave falling frames unflipped; pre-acquired, a
shot only bumps the refcount and opens the consumer gate. The producers stay parked until then, so this costs nothing while idle.
`telemetry.perf.tickGapMs` meters the pacer's own tick interval, so any remaining stall on
the orchestrator loop is visible on the rig instead of inferred.

Exclusivity, as everywhere: a capture in flight refuses `startRecording`, a recording
refuses a shot, and `busy()` names either. The drain awaits an in-flight capture before the
recording drain and the lease release.

## Teardown ordering {#teardown}

Resource-scope defers, registered in REVERSE of the drain (LIFO): stop the pacer FIRST and
close the JS position input → `stopScan` on the live leases (STOP + close the trajectory →
retire the flip pipes, `flipPipes` → null → `disableHardwareTrigger` + the verbatim timing
restore per eye, §lifecycle) + the gain restore → `triple = null` / `ready: false` → await
the recording drain → dispose the vergence loop if engaged (both match workers → the pid
node → wiring → its pipe connections → the needle/strip scale and slice producers) →
dispose the ring node if one exists (worker → wiring → its L/R pipes) → retire the C
undistort producer + drop the serial taps → release the leases LAST. During the drain the
flip retire does NOT rebuild the ring reader on the raw pipes (the reader is disposed a few
steps later anyway); a `stopScan` command does. The ring node's and the vergence loop's
pipes are the session's ONLY pipe connections (the renderer binds every view, the recorder
node connects its own raw pipes). Disengaging the loop FLUSHES its integrated
`verge`/`v_shift` into the sliders and folds `pan` into the target ray first, so the pose
the mirrors hold is bit-identical across the transition (§auto-vergence).

## Rig pass {#rig}

Hardware-gated checks (`docs/hardware/rig.md`): the realized path vs. `scan_amp` /
`scan_ratio` / `scan_axis_deg` across 5/20/50/100 Hz (mirror LPF roll-off), the exposed
stretch matching `scan_window_px` (TriggerWidth: the strobe width equals each marker's
`pulse_us`), `perf.trajectory.lateness_us` staying within tens of µs, restore leaving
Manage Cameras' values byte-identical (ExposureMode / TriggerActivation included), the
dashed readout of a known-frequency blinker in both modes, the triangle's falling frame
arriving upright on the views with `unmatched` near zero, and a live steer / slider drag
through a sweep while scanning: the path must move without a visible stutter (the
phase-continuous `replace`).
