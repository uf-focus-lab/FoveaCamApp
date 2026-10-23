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
(`scan_window_px`, one polyline each, sampled at the path's density — the APPLIED windows:
in the Timed fallback the equal, slope-clamped pulses of §exposure-windows, republished
on their own whenever the applied exposure moves: arm, retime, disarm),
`scan_center_px = A2P.C(A0 + pan)` is the path's center, and `axis_handle_px =
A2P.C(A0 + pan + R(θ)·(max(a, ε), 0))` with `ε = AXIS_HANDLE_MIN_DEG = 0.01°` is the
draggable +amp end of the axis — at `max(a, ε)` so it encodes the axis direction even at
amplitude 0. `scan_path_closed` (true exactly for an ellipse with ratio > 0) says whether
the renderer closes `scan_path` / `scan_path_px`. Path, closing rule, windows, center and
handle go out in ONE telemetry patch, so the renderer never pairs a new path with an old
rule. Uncalibrated (no wide undistort) the px fields are empty / `{0,0}` (the overlay hides
the handle on it); `scan_path` and `scan_path_closed` are still published (no triple at
all: empty, `false`). All of them are republished on EVERY input that moves or reshapes
the pattern — `steer`, `setAxis`, `verge`, `shift`, `baseline`, a vergence write-back,
`scan_amp`, `scan_ratio`, `scan_axis_deg`, every window key, `tri_window_sync`,
`scan_mode`, `scan_hz`, activation — and never per tick.

**Axis drag.** `setAxis(px)` maps the pixel through `undistort.angular` and sets
`scan_axis_deg = axisDegFromPixelRay(A0 + pan, point)` — the direction from the center ray
to it, folded onto −179.5 below it (the slider's left end, §views). A pointer ON the center (a zero-length ray) or an uncalibrated triple keeps the
previous axis. The pane slider writes the state directly.

**Sanitizing.** Every pattern key is clamped by its watch and the clamped value written
back (`scan_amp` to `SCAN_AMP_RANGE` [0, 2] — non-finite → 0, `scan_ratio` to [0, 1],
`scan_axis_deg` normalized, every window through `clampWindow`, an unknown `scan_mode` →
`ellipse`), so the drawer never shows a value the scan does not run. Windows compare with
a float tolerance (`sameWindowValue`, 1e-9 per end), so a clamp's ULP nudge
(§exposure-windows) is never written back as a "change".

**Sync = identical timing.** With `tri_window_sync` on, the falling window takes the
rising window's FRACTIONS of its own sweep: both markers start `w0·T` into their slope and
pulse `(w1 − w0)·T`. The rising sweep runs −a → +a and the falling one +a → −a, so an
ASYMMETRIC window exposes OPPOSITE ends of the line on the two frames — `[0.05, 0.5]`
exposes the −a half on the rising frame and the +a half on the falling frame. (The
alternative, "the same stretch of the line", would be `fall = [1 − w1, 1 − w0]`; one line in
`activeWindows` should the owner prefer it.) A symmetric window (`w0 + w1 = 1`, the default
`[0.05, 0.95]`) exposes the same stretch either way.

## Scan lifecycle {#lifecycle}

`startScan`/`stopScan` are COMMANDS, not state — a scan is session-local intent that must
never auto-resume on re-entry (it reprograms the cameras). `telemetry.scan` is non-null
exactly while active (§exposure-windows has its shape). Every transition below
serializes on ONE FIFO op chain (`queueScanOp`) — start, stop, the period restart, every
live re-upload and the gain writes — so a fast toggle can never interleave a camera apply
with an in-flight restore, nor a re-upload with a restart.

**Start** — refused, with the reason on `telemetry.scan_blocked` and `false` returned:
without a leased triple (`no camera triple leased`), without a bound controller (`no
controller connected`), on firmware below 2.2.0 (`controller firmware >= 2.2.0
required` — there is no JS fallback any more; it could not trigger anyway), or before the
controller's MCU↔host clock is calibrated (`controller clock not calibrated yet` —
`Controller.clockCalibrated`: true after the first offset ping, false again after two
missed 30 s re-pings; every trusted timestamp the scan uses — marker pushes, flip anchors,
lateness — rides that offset). A start that was cancelled while it sat queued (a
`stopScan` or teardown requested meanwhile, see Cancellation) returns `false` right there,
before any camera is touched. Otherwise, in order: ARM both foveas, L then R (snapshot the
timing → `enableHardwareTrigger(lease)` → `applyTriggeredTiming`, then — in the SAME
`lease.reconfigure`, after the triggered timing — `readTimingLimits`: the maximum frame
rate and the readout time for the rate / readout checks, §exposure-windows); build the
spec (§actuation — AFTER arming, so a Timed fallback's equal pulses are in it); open the
trajectory (`controllerNode().openTrajectory(spec,
{ name: "mirror-link" })`); subscribe its pushes and state; build the flip pipes in
triangle mode (§triangle-flip) BEFORE the first trigger; START at an EXPLICIT host instant
`hostNowNs() + 20 ms` (so lateness is exact and `replace` carries the phase). A failure at
any step undoes what was done (close the table, retire the flips, and — in a `finally` —
disarm the cameras) and refuses with `exposure override failed: …` or `trajectory start
failed: …`. An idle / re-lease while awaiting undoes silently.

**Cancellation.** START is never sent after a stop or a teardown was requested. A
`stopScan` command bumps a pending-stop count BEFORE it queues its op (the op clears it
when it runs, so a start commanded after the stop proceeds normally); teardown clears
`scanAllowed`. Both are checked BEFORE arming (a hit returns before any camera write),
after arming and again RIGHT BEFORE `traj.start`: a hit undoes the start quietly (no
`scan_blocked`), and a period restart caught by it takes the stop path instead. A live
`replace` op that was queued before the stop / teardown request runs as a no-op
(`replaceNow` returns while `!scanAllowed || stopsPending > 0`), and a gain write queued
after teardown began is ignored (§gain).

**Commit.** After the START await the session re-checks, then commits: a run that is no
longer `running` (a run-level CANCELLED push or a detach during the await — the state
listener ignores the run until the commit) is undone and refused with the run-end reason.
Only then `scanActive` turns true and `scan` publishes. Edits that landed while the start
awaited (the watches do not re-upload or restart an inactive scan) are reconciled right
there: `buildScan()` against the started spec — a new mode or period queues the restart;
otherwise a `replace` is scheduled UNCONDITIONALLY (a Timed pulse-only edit builds a spec
identical to the running one, because the markers carry the APPLIED exposure — only
`replaceNow` re-times the camera for it; a true no-op is skipped there).

**Clock lapse mid-scan.** `Controller.clockCalibrated` turning false while the scan runs
(two missed re-pings) does NOT stop it — the MCU's phase is its own — but every timestamp
the session scores rides the stale offset, so `scan.mismatch_reason` gains `controller
clock calibration lapsed`, re-evaluated at the telemetry throttle and cleared when the
next ping lands.

**Stop** — `scanActive` off (the pacer resumes the idle slew), the pending re-upload
dropped, the table STOPped and closed (the node re-takes the DAC for the position input),
the flip pipes retired (`flipPipes` → null), then — in a `finally`, so a throw in any
earlier step (a native detach, a broker call) never skips it — per eye
`disableHardwareTrigger` and the timing restore (best-effort PER FEATURE; what did not land
is reported once as "camera timing restore incomplete: …"), `scan` → null.

**Run end.** A run that ENDS UNDER the session — the node reports the table `detached`
(controller unbound/swapped) or back to `ready` (the MCU ended or cancelled it) — runs the
same stop and publishes the reason on `scan_blocked` (`controller disconnected — scan
stopped` / `the controller ended the trajectory run — scan stopped`) plus a tray warning.
The state listener acts on every such transition except the `ready` a failed `replace`
causes itself; instead, once ANY replace settles (success or failure, whatever the error
type — a dead device throws a plain `Controller not connected`) and at the end of a period
restart, `traj.state !== "running"` aborts the scan; a replace that threw with the run
gone reports `live trajectory re-upload ended the run: …`.

**Period change** — `scan_hz` or `scan_mode` while active changes the trajectory period,
which `replace` cannot swap: the op chain FIRST re-checks the run — a table that is no
longer `running` (a detach whose notice is still queued behind the restart) aborts with
the run-end reason, and an uncalibrated controller clock aborts with `controller clock not
calibrated` — then stops + closes the table, rebuilds, opens and starts a new one (new
explicit instant), keeping the camera config (the trigger mode is not re-armed; only a
Timed exposure is re-written, and only for a new marker-0 pulse) and rebuilding the flip
pipes when the mode or their tolerance changes. The run's counters keep counting (only a
fresh `startScan` resets them).

Idle drains a `stopScan` FIRST — before the pacer stops and the idle position input
closes, so the node's `resumeInputs` hands the DAC back to that input and the mirror
returns to the center — and BEFORE `triple` clears + `releaseLeases` — the restore rides
`lease.reconfigure` and needs the live lease (the manual-control trigger-sync ordering;
§teardown).

## Exposure windows {#exposure-windows}

Source: `scan.ts` (windows → markers) + `exposure.ts` (camera timing; pure over a
`Camera`-shaped seam, unit-tested with a fake — `mirror-link-exposure.test.ts`).

**Windows.** Each window `[w0, w1]` is a fraction of its SLOPE (`T`), clamped by
`clampWindow` to `0 ≤ w0 < w1 ≤ WINDOW_MAX = 0.95` with `w1 − w0 ≥ WINDOW_MIN = 0.005`
(the pane's step; an inverted pair is swapped, a too-short one grows its end — or its start
at the cap). The growth is float-safe: `(a + 0.005) − a` lands a hair below 0.005 for most
grid starts, so the moved end is nudged outward one ULP at a time until `w1 − w0 >=
WINDOW_MIN` holds exactly (the pane's `gapEdge` rule), and the result passes its own check
(pinned over every 0.005-grid position). The cap keeps the trigger line released and the capture engine idle before
the next marker (the firmware fires a marker only on an idle engine, else pushes BUSY) and
leaves the camera its readout gap. `activeWindows(mode, state)` picks them in marker order:
the ellipse's `scan_window`; the triangle's `tri_window_rise` and — while
`tri_window_sync` is on, whatever the state holds — the rising window again for the fall.

**Markers.** `windowMarkers` turns window `k` into one trajectory marker,
`t_offset_us = slopeStart_k + round(w0·T)`, `pulse_us = round(w1·T) − round(w0·T)`, cameras
L|R: the ellipse's ONE marker at slope start 0; the triangle's marker 0 (rising) at
`w0_rise·T` and marker 1 (falling) at `T + w0_fall·T`. Every window ends before the next
marker by construction (in TriggerWidth; the Timed fallback's equal pulses are placed by
`timedWindowMarkers`, below).

**Sync.** The session ENFORCES it (the pane only disables the falling slider): while
`tri_window_sync` is on every `tri_window_rise` write is copied into `tri_window_fall`
(`s.setState`), a `tri_window_fall` write snaps back to the rising value, and turning sync
on copies rise → fall once.

**Camera timing.** Cameras take the window as `ExposureMode = TriggerWidth`: the trigger
pulse IS the exposure, so the two triangle windows may differ and no exposure is written
per frame. Per fovea, on the lease's safe path, the per-camera config docs untouched:

1. `snapshotTiming` (reads only, before the trigger write — `arv_camera_set_trigger`
   resets TriggerActivation): `frame_rate_enable`, `frame_rate`, `exposure_auto`,
   `exposure`, and the `ExposureMode` / `TriggerActivation` / `TriggerOverlap` nodes (null
   when the model lacks one — the restore then skips it).
2. `enableHardwareTrigger(lease)` (TriggerSource Line3, strobe on Line2 as ExposureActive
   with the branch's measured `LineInverter = true`; `camera-trigger.ts`). A failed
   `LineInverter` write is reported as a warning, not a refusal.
3. `applyTriggeredTiming(cam, { pulseUs, preferTriggerWidth })`: `exposure_auto = Off`,
   frame-rate enable OFF (the trigger paces the frames; with the limit off the exposure
   ceiling only widens), then `TriggerWidth` + `TriggerActivation = LevelHigh` — or the
   **Timed fallback** when the model refuses either: `ExposureMode = Timed`,
   `TriggerActivation = RisingEdge`, `exposure = clamp(pulse of marker 0,
   exposure_range)` (min and max, read at the write). Neither mode → throws (refused).
   Either mode then sets `TriggerOverlap = ReadOut` where the model has the node (skipped
   silently otherwise, and a refused entry is not a failure): the next trigger may start an
   exposure while the previous frame is still being read out, so the sensor needs its
   readout time only between exposure ENDS.

ONE mode for both eyes: when one eye falls back to Timed the other is re-applied as Timed,
so both expose the same window.

**Timed pulses.** The Timed camera takes ONE exposure for every trigger, so the spec gives
EVERY marker the same pulse — marker 0's APPLIED exposure (the longer eye's, should a clamp
differ) — and the firmware's per-marker strobe timeout matches what the camera exposes (a
shorter falling pulse would time out on a longer exposure). With unequal, unsynced
triangle windows the falling marker would then expose the RISING window's length from its
own start, which can run past its slope into the next rising trigger, so
`timedWindowMarkers` keeps each marker inside its slope: `tOffset = max(slopeStart,
min(slopeStart + w0·T, slopeStart + WINDOW_MAX·T − pulse))` (the start moves earlier,
never before the slope start). A pulse that STILL overruns the next marker's start
(circularly — only a pulse longer than `WINDOW_MAX·T`, e.g. a camera minimum exposure
above it) is clamped to end there and `mismatch_reason` names `Timed exposure would run
into the next trigger`. The drawn `scan_window_px` and `scan.windows` show those applied,
clamped pulses. In TriggerWidth nothing is written and each marker keeps its own pulse.

**Timed retime ordering.** The camera's exposure must never exceed the MCU pulse plus the
firmware's 5 ms strobe margin. A live window change that moves the marker-0 pulse in Timed
mode therefore re-writes a SHRINKING exposure BEFORE the swap (the running table's longer
pulses cover it) and a GROWING one AFTER the swap (the swapped-in table carries the
predicted exposure — the pulse clamped to each eye's `exposure_range`; should the camera
take another value, the next replace swaps the markers onto it). A swap that fails after a
pre-swap write writes the previous exposure back, so camera and running table agree again.

**Restore** (`restoreTiming`, after `disableHardwareTrigger`): `ExposureMode` first (so a
Timed exposure is writable again; the generic feature write when the typed setter refuses
the saved entry), `TriggerActivation`, `TriggerOverlap`, the two-sided exposure write
around the frame rate (the ceiling moves with the rate), `exposure_auto` LAST. Every write
runs in its own `try` — one refused node never skips the rest — and the failures come back
as lines the session reports once.

**Feasibility checks** (against each fovea's `readTimingLimits` — read in the arming
`reconfigure` AFTER `applyTriggeredTiming`, because the pre-scan exposure caps
`frame_rate_range.max`; re-read on every Timed retime. The scan still runs, `mismatch`
says why it cannot run as asked):

- **Trigger rate.** Each camera triggers once per sweep T in both patterns, so `1/T`
  above EITHER fovea's maximum frame rate is a mismatch.
- **Readout.** In the triangle the two exposures' END-TO-END spacings — `T·(1 + w1f − w1r)`
  (rising end → falling end) and `T·(1 + w1r − w1f)` (falling end → next rising end),
  `minExposureEndSpacingUs` — must both reach the readout time of the slower fovea:
  GenICam `SensorReadoutTime` (µs) when readable (best-effort: it is an IFloat on the
  Blackfly S, which the string API may refuse; the integer read is tried next), else
  `1 / frame_rate_range.max` (`readoutSpacingUs`). (For the ellipse the spacing is T,
  which the rate check covers.) `WINDOW_MAX` stays 0.95: the readout limit is the
  camera's, so it is checked, not baked into the cap.

**Telemetry.** `ScanTelemetry` = `mode`, `hz`, `amp_deg` (the RUNNING amplitude, held
with the run's spec — a failed re-upload leaves it at the value the MCU plays), `period_us`
(T or 2T), `windows`
(`{ t_offset_us, pulse_us }` per marker, as the MCU runs them — republished after every
re-upload / restart), `exposure_mode` (`TriggerWidth`, or `Timed` when either eye fell
back), the per-eye applied `exposure_us` (0 in TriggerWidth) and readback `frame_rate`,
`mismatch`, and `mismatch_reason` — one sentence, the reasons joined with "; " in this
order, null without a mismatch:

| Reason | When |
|---|---|
| `Timed exposure clamped to the camera's exposure range` | Timed: an applied exposure more than 2 % off the requested marker-0 pulse |
| `unequal windows: Timed exposure gives both the rising window's length` | Timed: the requested windows differ in length (every marker carries marker 0's pulse) |
| `Timed exposure would run into the next trigger` | Timed: the equal pulse overruns the next marker's start even from its slope start (clamped there) |
| `trigger rate above the camera's maximum frame rate` | `1/T` > either fovea's maximum frame rate |
| `exposures closer than the sensor readout` | triangle: an end-to-end spacing below the readout time (`SensorReadoutTime`, else `1 / frame_rate_range.max`) |
| `exposure windows too close for reliable flipping at this frequency` | triangle: the flip tolerance floor exceeds its cap (§triangle-flip) |
| `controller clock calibration lapsed` | the controller clock went uncalibrated mid-scan (§lifecycle; no stop) |

A mismatch warns once until it clears (`report("mirror-link", "the cameras cannot take
the exposure windows as asked: <reason>…", "warning")`).

**Ground truth.** OK marker pushes ARE the exposure record. `STROBE_TIMEOUT`, `BUSY` and the
rest count into `perf.trajectory.pushes` (§actuation); a run with NO OK push for two
periods (measured from the start instant, or the last OK push) sets
`perf.trajectory.stalled` while it lasts (the status line's amber, §views) and warns ONCE per run, naming
the timeout/busy counts and the BUSY-after-a-missed-strobe case: a missed strobe holds the
capture engine for the pulse plus the 5 ms strobe margin, so when the gap after the window
is under 5 ms it is still busy at the next trigger, which pushes `BUSY` ("a missed strobe
keeps the capture engine busy past the next trigger when the gap after the window is
under 5 ms").

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
slot (after the pacer stops, before `triple` clears): exposure timing FIRST, then gain. A
gain write queued once teardown began is ignored (it would land after the restore and
leave the override on the released camera): gain writes are allowed from the lease until
the teardown drain starts.

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
- the scan PATH — `telemetry.scan_path_px` as one SVG path, CLOSED iff
  `telemetry.scan_path_closed` (the ellipse with `scan_ratio > 0`; OPEN for the line and
  the triangle) — the flag is published WITH the path, so the renderer never pairs an old
  path with a new mode's rule and never derives it from `state` — dashed and faint
  while idle (a preview), solid while active; on top of it each `telemetry.scan_window_px`
  polyline (one per marker: the EXPOSED stretch) at twice the stroke and full opacity,
  dashed with the path while idle. Empty uncalibrated, nothing drawn,
- the AXIS HANDLE — a spoke (one stroke) from the scan CENTER to the DRAWN handle and a
  filled dot of radius `stroke · 3` (`AXIS_HANDLE_DOT`) there. The center is
  `telemetry.scan_center_px` — the panned path center the trajectory and `setAxis` use,
  which differs from `target` while the vergence loop holds a pan — falling back to
  `telemetry.target` only on its `{0,0}` uncalibrated sentinel (`overlay.ts#scanCenterOf`);
  the spoke, the handle ray and the hit test's center exclusion all anchor there, while
  the crosshair stays at `target`. The handle only sets the axis DIRECTION
  (`axis_handle_px` always encodes it, even at amplitude 0), so its distance need not be
  the amplitude: it is drawn at
  `center + unit(axis_handle_px − center) · max(|axis_handle_px − center|, 15 · stroke)`
  (`AXIS_HANDLE_MIN_DIST`, `overlay.ts#axisHandleAt`) — at the +amp end of the main axis,
  or further out along it at a small amplitude, so its grab zone never covers the
  center. Hidden on the `{0,0}` uncalibrated sentinel and when `axis_handle_px`
  coincides with the center (no direction; the overlay stays telemetry-driven and never
  falls back to `state.scan_axis_deg`). A handle pushed off the frame edge (a large
  amplitude, a center near the edge) is not clamped back in and so cannot be grabbed;
  the Axis slider remains. Hit rule: the
  FIRST cursor event of a drag (the press; the StreamView cursor is already in wide frame
  px) within `stroke · 6` (`AXIS_HANDLE_HIT`) of the DRAWN handle, and NOT nearer the
  scan center than that same radius, starts an AXIS drag — every cursor event of that
  drag calls `setAxis(px)` and none calls `steer`, until release; any other press (the
  scan center always) steers as before. Both are sent per cursor event, fire-and-forget,
  identically (the session coalesces the trajectory re-upload, §actuation). Affordance:
  a grab / grabbing pointer over the hit zone / during the drag, the handle's opacity
  0.75 → 1 over the hit zone and during the drag, and the dot × 1.3 during the drag,
- per-eye markers at `L_PX`/`R_PX`, projected from the CENTER pose (`A2P.C ∘ V2A` of the
  offset-free volts, shift included), not the instantaneous scan pose — they show where
  each fovea is aimed, and separate with the verge/shift. Hidden uncalibrated ({0,0}).

The PosViews draw the scan as a STATIC path with a stable crosshair: `telemetry.volt` is
the commanded pose while idle and the path's CENTER while scanning (sampling the path at
the 30 Hz telemetry throttle reads as random flicker, not motion), and
`telemetry.scan_path = { L, R }` carries the commanded path in VOLT space —
`SCAN_PATH_SAMPLES` points per eye through the trajectory's own chain (offset →
`inverseTriangulate` + shift → `A2V`), which the renderer closes into a loop iff
`telemetry.scan_path_closed` (the center view's rule), drawn with `Line2D` (faint idle,
solid while active). It is republished on
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
`perf.trajectory.pushes` show failures and no OK push, on `perf.trajectory.stalled` (no
OK push for two periods — a trigger that stops answering mid-run, after good exposures;
the `title` then says no exposure has completed for two scan periods), or on a refusal. The `title`
carries, on a mismatch, the NEUTRAL lead-in "Exposure mismatch — " (not every reason is a
camera limit: the flip-spacing one is the windows' own geometry) followed by
`ScanTelemetry.mismatch_reason` with no second colon — or, with no reason, "the cameras
cannot take the requested window" (ellipse) / "windows" (triangle) — then the `Timed`
fallback note and the applied per-eye exposure / frame rate; then the `perf.trajectory`
bookkeeping (pushes ok / timeout / busy / other, last lateness, live re-uploads, and in
triangle mode flipped / unmatched / `skew_us` per eye — "—" for an eye whose `flipped`
count is 0, so a never-matched eye does not read as a perfect 0 µs — and
`flip_tolerance_us`) — or, idle, what Start would run (its period computed
from `1000 / scan_hz`, doubled for the triangle, then rounded — never from the rounded
readout), or the blocked reason. The row is a PLAIN div, never a
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
`scan_axis_deg`, −179.5..180°, step 0.5, neutral 0, readout `+12.5°`, its hover naming
the center-view handle as the other way to set it (the left end is −179.5, not −180: the
session normalizes −180 to 180, which would make the thumb jump to the right edge; `setAxis`
folds a handle-dragged angle in (−180, −179.5) to −179.5 — a 0.5° fold at the seam — so
the state never holds a value the slider cannot show; the slider's v-model still clamps on
read, as a guard for a direct state write); **Amplitude** — `scan_amp`, 0..2°, step
0.01, neutral 0.5 (moved here from the right column). Then per mode — Ellipse:
**Ratio** (`scan_ratio`, 0..1, step 0.01, neutral 1, readout `1.00`, `line` at 0, a
`detents: [0]` so a drag can land on the line exactly) and **Exposure Window**
(`scan_window`); Triangle: **Rising Window** (`tri_window_rise`), **Falling Window**
(`tri_window_fall`) and **Sync Windows** (`tri_window_sync`, a real `<input
type="checkbox">`, checked by default — the owner asked for a checkbox, so it is the one
boolean in the drawer that is not an Off | On `SingleSelect`; checked it fills with
`--accent`, unchecked its resting border is the native control's — the accepted exception
to design-language principle 5). Sync means identical
TIMING: the falling window takes the rising window's fractions, each counted from the
start of its own sweep, so an asymmetric window exposes opposite ends of the line on the
two frames; the Sync hover and the synced Falling Window hover both say so. The window controls are
`app/src/inputs/dual-range-slider.vue` (model `[start, end]`, 0..`WINDOW_MAX` = 0.95,
step and `minGap` 0.005, neutral = the contract default), read out as `start–end ms` of
the base period `T = 1/scan_hz` — of the period for the ellipse, of each sweep for the
triangle. While synced the falling slider is DISABLED and paints the rising values (its
proxy reads `tri_window_rise` and refuses writes; the session mirrors the state). On the
`Timed` exposure fallback (`index.vue` passes the pane `timed` =
`telemetry.scan?.exposure_mode === "Timed"`) every marker exposes for the RISING window's
length, so in triangle mode the Falling Window readout gains a `(timed: rising length)`
cue and its hover explains it (the falling frame exposes that long from its start, moved
earlier if it would overrun the sweep); the pane shows nothing more — the windows
actually applied are on the status line. The
dual slider is RangeSlider's twin: the same body, infill (between the thumbs, exclusion
blend), label slot (two `<span>`s), cursor glyphs; a press grabs the NEARER thumb and
drags it through a WINDOW `mousemove` listener (no pointer capture), the dragged thumb
stopping at the range ends and `minGap` short of the other (never pushing it) — a thumb
stopped by the gap lands on the `step` grid and is nudged outward by ULPs so `end −
start >= minGap` holds in floating point (the session's `clampWindow` never rewrites a
pane value); each thumb is its own tab stop and the arrows step it by `step` (×0.1 per
modifier); right-click resets to `neutral` only when one is declared. The thumbs are
`pointer-events: none` (the root takes the press, as RangeSlider's cursor). While
disabled the thumbs drop their `tabindex`, pointer and keyboard input are ignored and
hover does not lift the disabled opacity. ARIA: the `role="group"` root carries the
`label` prop as its name (`Exposure window` / `Rising window` / `Falling window`), each
`role="slider"` thumb `<label> start` / `<label> end` and an `aria-valuetext` from the
`valueText` prop (the pane passes the ms readout). Its value math is
`app/src/inputs/dual-range.ts` (unit-tested).

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
window from `windowMarkers`, `cameras: ["L", "R"]`; `step: false`. In the Timed fallback
every marker carries marker 0's applied exposure as its pulse (§exposure-windows).

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
100 ms (counted from when the op is QUEUED), the spec built when the op RUNS on the chain,
so the latest geometry wins, and at most ONE replace op queued at a time — while one waits,
further edits only mark it pending (it builds the latest spec when it runs), so a replace
slower than the throttle never stacks an op per steer event (the node coalesces in-flight
swaps too; the throttle keeps the wire sane). An identical spec is skipped. A replace that
throws with the run still going keeps the previous geometry (one warning per run); a run
that is not `running` once the replace settles — `TrajectoryReplaceError.running ===
false`, a detach, a plain error from a dead device — stops the scan (§lifecycle). A period
change is never a replace — §lifecycle restarts the run.

**The swap** (controller side: [controller §trajectory-ownership](./controller.md#trajectory-ownership)).
`replace` uploads the new table to a free id while the old one runs, then tries the ATOMIC
swap first — firmware 2.2.1 accepts `START {id = new, t_start = the run's exact t_start}`
while the old table runs and switches tables in place, keeping the phase clock and the
marker crossing state (no HOLD, no push; a marker is never doubled, and a marker moved
before the swap phase first fires next cycle) — and falls back to the
back-to-back STOP(old) + START(new, same `t_start`) pair on a REJ "already running", and
always on firmware below 2.2.1 (no atomic START is attempted there), so the new table joins the run's phase either way; any other REJ swaps
nothing (the old table keeps running, the replace fails `running: true` — the decision
table in controller.md); `perf.trajectory.last_swap` says which landed.
An in-flight capture of the OLD table keeps pushing after the swap, so the host keeps the
retired id routed to the same listeners for a grace (max pulse + 5 ms + slack,
`trajectoryGraceUs`) and does not reuse it meanwhile — after it, the id is free again, so
ids ALTERNATE across swaps. The session therefore scores every push — lateness and the
flip anchor's pulse — by `f.trajectoryId` against the spec THAT table ran: when a swap
lands the old id's entry is stamped `until = hostNow + trajectoryGraceUs(old spec)` and
used only until then; an expired entry is ignored, so mid-swap a reallocated id — like a
not-yet-seen one — resolves to the in-flight spec.

**`perf.trajectory`** (`TrajectoryTelemetry`, published with `perf` at the
`VOLT_TELEMETRY_INTERVAL_MS` throttle; counters reset per scan): `running` (scan active and
the table running), `pushes` by status (`ok` / `timeout` = STROBE_TIMEOUT / `busy` / `other`
— run-level ENDED/CANCELLED and UNKNOWN), `lateness_us` of the last OK push against the
EXPLICIT start (`tTrigger − (t_start + cycle·period + marker offset)`, exact because the
session always starts at an explicit instant; scored against the spec of the table that
pushed — in host-steady ns under the controller's CURRENT MCU→host offset: when the 30 s
re-ping moves the offset, the session re-bases the run's start instant by the same
difference before scoring, so `lateness_us` does not step), `reuploads` (successful replaces this scan), `last_swap` (`atomic` /
`stop-start` / null, from the node's trajectory row), and from the flip bricks
(§triangle-flip; 0 in ellipse mode) `flipped` / `unmatched` per eye — accumulated across
brick rebuilds within one scan — the matched frames' mean `skew_us` per eye and the
`flip_tolerance_us` in force, and `stalled` — true while the scan is active and no OK push
has arrived for `NO_OK_PERIODS` (2) periods (measured from the start instant or the last
OK push: the no-OK watchdog's condition, §exposure-windows), re-evaluated at the throttle
and republished with it; false again on the next OK push (published at once) and at run
start. `telemetry.volt` is the commanded pose while idle and the
pattern's CENTER while
scanning; `perf.actuateMs` / `perf.tickGapMs` keep their meaning for the idle path.

## Triangle flip {#triangle-flip}

The triangle exposes one frame on the rising sweep (marker 0) and one on the falling sweep
(marker 1); the falling frame is VERTICALLY flipped (rows reversed) before any consumer —
the L/R views and the ring reader — sees it. The vertical flip is what was asked for, and
it stays. For the record: the geometrically exact reversal of a falling sweep is a
reflection across the line PERPENDICULAR to the scan axis through the center (it maps the
+a end onto the −a end and leaves the cross-axis alone); the vertical flip equals it only
for a VERTICAL scan axis (θ = ±90°). At any other axis the flipped falling frame is a
mirror image of the rising one about a different line — a later refinement, not this
change.

**Bricks.** While the triangle scan runs on a leased triple the session builds ONE native
`FlipStream` per eye ([core-streams §flip-stream](./core-streams.md#flip-stream)) through
`createFlipPipe(flipSeam, nodeId.convert(serial), sourceSpec, nodeId.flip(serial),
{ toleranceNs, anchorFrom: trajectoryNodeId() })`: the pipe
`camera/<serial>/convert/flip` is advertised with the SOURCE pipe's own spec BEFORE the
brick attaches (a failed attach un-advertises it again). `sourceSpec` is the broker's own
record of the advertised convert pipe (`broker.connect(id).spec`, connected just long
enough to read it); `cameraPipeSpec(camera)` — the shape the convert pipe is advertised
with — is the fallback when that connect fails. The session registers NO graph rows for the
bricks: `Topology.report()` reports each as a native kind-`flip` row with its `frame` input
from the convert pipe and — through `anchorFrom` — its `anchor` input from the trajectory
node `controller/trajectory`; their meters come from core's `flipProbeAll()` probe, already
registered by the orchestrator. Then `state.flipPipes = { L, R }` (a `s.setState`, like
`undistortPipe`) and an existing ring reader is rebuilt on the flip pipes. In ellipse mode
nothing is built and nothing is copied. Without an injected flip seam the triangle scans
unflipped, with one warning.

**Anchors.** Every OK marker push becomes `{ tStart: f.tExposure, tEnd: f.tExposure +
pulse_us·1000, flip: marker === 1 }` — BOTH exposure edges, `pulse_us` that marker's in the
spec of the table that pushed it (§actuation: scored by `f.trajectoryId`) — pushed to both
bricks FIRST and synchronously in the push callback — no await, no other work before it.
Failed pushes (timeout, busy) exposed no frame and push nothing. Both edges because which
instant the Blackfly S stamps a frame with (exposure start or end) is not documented here:
the brick matches either.

**Matching.** The brick flips a frame iff the anchor with an EDGE nearest its timestamp,
within `toleranceNs`, is marked `flip` (PairStream's rule over `tStart`/`tEnd`; owner-applied
trusted host-ns on both sides), and reports the matched frames' mean signed (frame stamp −
matched edge) per probe as `matchedSkewNs` → `perf.trajectory.skew_us` per eye (kept from
the last probe that matched anything). Near 0: the camera stamps the edge it matched; near
±pulse: the other one; anything else is a clock-alignment problem — the bench reads it.
Because the brick matches EITHER edge, the ambiguity that matters is the gap between the
EDGES of markers of different flip — the next marker's start minus the previous marker's
end, circularly (`minFlipEdgeGapUs`; with the default `[0.05, 0.95]` windows it is
`0.1 T`, not the `T` between the marker starts), computed from the markers as the MCU runs
them (`flipEdges`). The tolerance (`flipToleranceUs`, scan.ts) is `0.4 · min(T, edge
gap)`, FLOORED at 1 ms (room for the host↔camera clock alignment) and CAPPED at
`0.45 · edge gap`. The cap is the guarantee: below half the gap, the two flip classes'
match bands never meet, so a frame stamped within the tolerance of ITS marker's edge is
more than the tolerance from every edge of the other flip — it can never be mis-flipped,
and if its own anchor is late it is unmatched (passes unflipped) instead. A frame stamped
farther than the tolerance from its own edge has no such guarantee. When the floor
exceeds the cap — an edge gap under ~2.2 ms (the defaults at 100 Hz: a 1 ms gap) — the
cap is used and `scan.mismatch` names "exposure windows too close for reliable flipping at
this frequency"; the scan still runs. `perf.trajectory.flip_tolerance_us` shows the value in force. The
brick takes it at attach, so a restart with a new sweep time rebuilds the bricks. A live
window change rebuilds them only when the tolerance in force is UNSAFE or STALE
(`flipRebuildNeeded`, scan.ts): tighter when it exceeds the new cap (`0.45 · edge gap`),
wider when it is below the 1 ms floor while the floor fits under the new cap (windows
dragged close and apart again), or below half the new tolerance. In between the bricks
keep their value — `flip_tolerance_us` shows it — so dragging a window does not rebind
the views and restart the ring worker on every throttled replace; the "too close"
mismatch follows the rule for the new windows, not the brick. `flipped` / `unmatched` ACCUMULATE
across such rebuilds within one scan (a retired brick's final counters fold into the
run's); only a new `startScan` resets them.

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
each brick is probed one last time and detaches + un-advertises, and — outside the teardown
drain — the reader re-binds the raw pipes. Every step is best-effort (failures reported
once as "flip pipe retire incomplete: …"), so a stop always reaches the camera restore. The
RAW capture / recording pipes are never flipped (§capture).

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

Resource-scope defers, registered in REVERSE of the drain (LIFO): `scanAllowed` off (no
queued start may arm or START any more) and `stopScan` FIRST, on the live leases and while
the idle position input is still open (STOP + close the trajectory — the node's
`resumeInputs` hands the DAC back to that input, so the mirror returns to the center →
retire the flip pipes, `flipPipes` → null → `disableHardwareTrigger` + the timing restore
per eye, §lifecycle) + the gain restore → stop the pacer and close the JS position input →
`triple = null` / `ready: false` → await
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

Hardware-gated checks (`docs/hardware/rig.md` "MirrorLink scan pass"):

- **Path.** The realized path vs. `scan_amp` / `scan_ratio` / `scan_axis_deg` across
  5/20/50/100 Hz (mirror LPF roll-off); ratio 0 traces a line along the axis; dragging the
  axis handle turns the path about the center.
- **Trigger rate.** At a `scan_hz` above a fovea's maximum frame rate `scan.mismatch_reason`
  reads "trigger rate above the camera's maximum frame rate" — and BUSY / missing frames
  agree.
- **Exposure window.** On a scope, the strobe (ExposureActive) width matches each marker's
  `pulse_us` (TriggerWidth) and starts `t_offset_us` into the period; the exposed stretch
  matches `scan_window_px`. Timed fallback: both triangle markers carry the same pulse.
- **Both triangle frames.** Rising and falling frames alternate, two per 2T period
  (`scan_hz` frames/s per eye); the
  falling one is VERTICALLY flipped on the views (upright for a vertical scan axis — see
  §triangle-flip for other axes), `unmatched` near zero, and `perf.trajectory.skew_us`
  near 0 or near ±pulse (which edge the camera stamps — record it).
- **Timing.** `perf.trajectory.lateness_us` within tens of µs; restore leaves Manage
  Cameras' values byte-identical (ExposureMode / TriggerActivation / TriggerOverlap
  included).
- **Replace continuity.** A live steer / slider / axis drag while scanning moves the path
  without a visible stutter (a marker is never doubled; one moved before the swap phase
  first fires next cycle); `perf.trajectory.last_swap` reads
  `atomic` on firmware 2.2.1 (`stop-start` on 2.2.0).
- **Teardown.** Leaving the app mid-scan returns the mirrors to the center pose.
