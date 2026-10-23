# MirrorLink — developer behavior spec

Developer-facing behavior spec for the `mirror-link` app: a calibrated L/C/R triple
whose two fovea mirrors trace a fast CIRCULAR scan around a hand-aimed center while
each fovea's exposure spans exactly one revolution. A free-running blinking source
(known blink frequency) then renders as a dashed ring in every fovea frame — the
on/off pattern along the ring IS the decoded signal. Manual-control's steering bench
minus set-points, raster capture, split fovea, and the center-tile views. Distinct from
the user manual. Code carries tight one-line pointers to these anchors.

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
is why `scan_path` stays the exact commanded ring and why the orbit brick's Jacobian is a
finite difference of this one function (§actuation). `mirror-link-vergence.test.ts` pins
both facts.

**Where the DOF live.** `{pan, verge, v_shift}` come from the loop's integrators while
auto vergence is ENGAGED and from the drawer sliders while it is off (`pan` is 0 there).
Verge Distance sets the depth both eyes converge on (∞ at `verge = 0`); Vertical Shift is
the toe that raises L and lowers R. Both slider ranges ARE the corresponding controller's
saturation limits (`VERGE_MIN_DISTANCE_MM`, `VSHIFT_LIMIT_DEG` from `@lib/vergence/tuning`)
so the two authorities can never disagree. They move the ring's centre, never its shape,
scanning or not.

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

## Circular scan {#scan}

Source: `scan.ts` (pure, Vue-free, unit-tested).

At time `t` (ms since scan start) the scan OFFSET is
`o(t) = amp · (cos φ, sin φ)`, `φ = 2π · hz · t / 1000`, `amp = radians(scan_amp)`. The
offset is added to `A0` in the WIDE angular frame BEFORE `inverseTriangulate`, so both
eyes trace the same circle around the same scene point (the L/R convergence solution
follows the moving center; the vertical shift rides `inverseTriangulate` itself).
`scanOffset(tMs, hz, ampDeg)` is the one geometry function;
`scanAngles(A0, offset, baseline, distance, shiftRad)` composes the
per-eye angles (the same function serves the idle pose with a zero offset).

Phase is derived from the pacer's WALL CLOCK (`performance.now() − t0`), never from a
tick counter — a late or coalesced tick lands at the correct phase instead of
accumulating drift. Zero amplitude degenerates to the idle pose.

Parameters (`scan_hz` 1–100 Hz, default 10 — a 100 ms revolution; `scan_amp` 0–2°) are
LIVE: a change while active is pushed straight to the native generator (its phase
ACCUMULATES across the change, so the ring never steps) and, for frequency, re-applies the
exposure override (§exposure). The mirror's own low-pass response attenuates the realized
radius at higher frequencies — the commanded circle is exact, the physical one is a rig
measurement.

The commanded circle above is what `scan_path` draws and what the JS fallback pacer pushes.
The native generator emits the same circle LINEARIZED — `center + J · o` with `J` the
finite difference of this chain around offset 0 (§actuation) — exact to first order in the
offset.

## Scan lifecycle {#lifecycle}

`startScan`/`stopScan` are COMMANDS, not state — a scan is session-local intent that must
never auto-resume on re-entry (it overrides camera exposure). `telemetry.scan` is non-null
exactly while active and carries the applied timing (`hz`, `amp_deg`, `period_us`, per-eye
`exposure_us` + `frame_rate`). `startScan` resolves `false` when refused (no leased triple)
with the reason on `telemetry.scan_blocked`; `true` once BOTH foveas carry the exposure
override. Start/stop and the live frequency re-apply serialize on one FIFO op chain so a
fast toggle can't interleave an apply with an in-flight restore. Idle drains a `stopScan`
AFTER the pacer stops and BEFORE `triple` clears + `releaseLeases` — the restore rides
`lease.reconfigure` and needs the live lease (the manual-control trigger-sync ordering).

## Exposure override {#exposure}

Source: `exposure.ts` (pure over a `Camera`-shaped seam, unit-tested with a fake).

While active each fovea camera's timing is OVERRIDDEN so one frame integrates one
revolution: `exposure = 1e6 / hz` µs and `frame_rate = hz` (frame-rate enable forced on,
exposure-auto forced Off). The per-camera config docs are NOT touched — the override is
applied to the live handle only and the pre-scan values (`frame_rate_enable`,
`frame_rate`, `exposure_auto`, `exposure`) are snapshotted at start and restored on stop /
idle / re-apply, so Manage Cameras' persisted settings survive untouched.

Write-order invariant: every write stays inside the camera's LIVE range at the moment of
the write. A camera's exposure ceiling depends on its frame rate, so both apply and
restore write exposure TWICE — `exposure = clamp(target, exposure_range)` before the
frame-rate write (fits the old ceiling) and again after (fits the new one); `exposure_auto`
is written first on apply (Off) and last on restore. Frame rate clamps to
`frame_rate_range` — a camera slower than `hz` keeps its max rate with `exposure = period`
(dead time between frames, still one revolution per frame). If the applied exposure misses
the period by more than 2 % the `scan` telemetry flags `mismatch` and the reason lands in
the title-bar tray as a warning (`report("mirror-link", …, "warning")`). Apply L then R;
a failure on either restores whatever was applied and refuses the start.

## Gain override {#gain}

Source: `gain.ts` (pure over a `Camera`-shaped seam, unit-tested with a fake).

ONE gain (dB) drives BOTH foveas, and it is SESSION-WIDE, not scan-scoped — aligning on a
dim source needs it before the scan. Same live-handle model as §exposure: written through
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
worker over the two RAW convert pipes (roles `L`/`R` — the same un-warped views the
operator reads), `meterName`/node id `win/mirror-link/ring`.

The reader is an OPTIONAL NODE, DEFAULT OFF (`state.ring_reader`) — it costs a worker
thread reading every fovea frame, so it exists only while asked for. `buildRingNode()`
connects the two pipes, registers the wiring (node + its two frame edges), and spawns the
worker with the live `enabled`; `disposeRingNode()` terminates the worker → unregisters the
wiring → disconnects the pipes, in that order, and resets `telemetry.ring` to
`{L: null, R: null}`. The `ring_reader` watch builds/disposes live (both directions
idempotent, both no-ops without a leased triple); activation builds it iff the state is
already on. The profiler therefore shows the node exactly while it exists.

Gated on the scan too: `enabled` is pushed via `sendParams` on every scan start/stop (and
at node creation), and a disabled kernel does NO pixel work — a frame that did not
integrate a revolution holds no ring.

`telemetry.ring = { L, R }` carries the per-eye `RingReadout` (null until that eye's first
result). A failure keeps the CURRENT reason AND the last successful read on `last`
(`ring-code.md` §error recovery), so a decoded value stays on screen while frames drop.
STOPPING THE SCAN clears it (as does a failed re-apply, disposing the node, and `idle()`):
the readout describes a frame that integrated a revolution, and free-running frames do
not.

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

The scan runs on a NATIVE brick, not the JS event loop. Any synchronous camera write (the
gain slider, an exposure re-apply) or allocation on the orchestrator loop stalls a JS pacer
for tens of ms, the mirrors hold, and the rig draws a straight chord across the ring. The
generator therefore lives on its own paced C++ thread — the compose brick's shape, applied
to a circle.

**The brick.** `orbitSeam.create(nodeId.win("mirror-link", "orbit"))` builds an
`OrbitStream` (docs/spec/core-streams.md#orbit-stream) at activation; its `volt_out` pipes
into the controller's native `pos_in` through `openNativePosition("mirror-link", …)`
(`onAttach` pipes, `onDetach` releases the link — the sink comes and goes with the v2
controller). Registered wiring carries the NODE row only; the volt link reports its own
`→ controller` edge (the compose brick's precedent). The brick's own meter folds onto the
node badge through `registerNativeProbe`.

**What JS pushes.** Only the LINEARIZATION, never a per-tick pose:

- `setPose({ centerL, centerR, jL, jR })` on every input that moves or reshapes the ring
  (steer, verge, shift, baseline, a vergence step, activation) — it rides
  `publishScanGeometry()`, which those inputs already call. `centerL`/`centerR` are
  `centerVolts()`; `jL`/`jR` are the row-major 2×2 finite difference of
  `voltsFor(anglesAt(offset))` around offset 0 (±1e-3 rad), i.e. volts per radian.
- `setOrbit({ ampRad, hz, paceHz, enabled })` on scan start/stop and on a live
  `scan_amp`/`scan_hz`/`orbit_pace_hz` change.

**What the brick commands.** `v = slew(center) + J · amp · (cos φ, sin φ)` per eye at
1 kHz. The emitted circle is therefore the LINEARIZED chain — exact to first order in the
offset, which at a 2° maximum radius is well inside the mirror's own response. `scan_path`
telemetry stays the exact chain (offset → `inverseTriangulate` + shift → `A2V` → clamp), so
the drawn ring remains the ground truth for the geometry.

**Fallback.** The JS `openPosition` input + 1 ms pacer remain for a v1 controller / no
controller at all: idle slews the commanded pose toward `centerVolts()` with the shared
first-order smoother (`@lib/slew` — manual-control's `slew.ts` HOISTED, same constants;
disparity-scope's `drag-slew.ts` stays a parallel copy for now), active commands the scan
pose DIRECTLY (no slew — a smoother would lag and shrink the circle), and on stop the slew
resumes from the last scan pose. While the brick owns the wire (`nativeEngaged()`) this
path pushes only the CENTER pose and only every 10 ms — the pacer itself keeps ticking at
1 ms because its gap IS the stall meter.

**Pose density and the sink governor.** What the mirror actually traces is
`sinkHz / scan_hz` poses per revolution — `sinkHz` being what survives the native
MirrorSink's 1 ms gate AND its AIMD governor, not what the brick emits. The mirror's own
~120 Hz low-pass (τ ≈ 1.3 ms) smooths the steps between poses only while the update
interval is well under that τ: at 1 kHz (1 ms) the steps blur into a circle; at 60 Hz
(17 ms) each pose is a visible vertex. The compose path's governor defaults — halve on ANY
pressure signal, floor 60 Hz, RTT inflation gate 2× — are right for a latency-sensitive
tracker and wrong here: 60 poses/s at a 10 Hz scan is a HEXAGON, and the +25 Hz/100 ms
climb makes it come and go. So on attach the session sets

```
sink.setGovernor({ ceilingHz: state.orbit_pace_hz, floorHz: 500, rttInflation: 8,
                   enabled: true })
```

— genuine link overload (soft fails, outq above HIGH) still backs off, but never below
500 Hz, which is still a 50-gon at 10 Hz and a 5-gon only past 100 Hz (the top of the
`scan_hz` range, where the mirror's own roll-off dominates anyway). A busy MCU's inflated
ACK RTT is not overload of the UPDATE path, so the inflation gate is widened 2× → 8×.

`state.orbit_pace_hz` (default 1000, clamped 200–1000 by the brick) is the generator's tick
rate AND the governor's ceiling — no slider, a config/rig knob for a link that cannot carry
1 kHz. Lowering it does not change the geometry (the phase accumulates with the measured
`dt`), only the pose density.

`telemetry.perf.orbit` reports `{ native, emitHz, sinkHz, governor: { state,
effectiveRateHz, backoffs, softFails, outq } }` — both rates differenced across 1 s probe
windows (the meters report lifetime averages, which would hide a live stall), `emitHz` off
the brick's thread meter, `sinkHz` off `MirrorSink.probe().written`, and the governor block
off that same probe plus the `Device.stats` sensors the profiler's Serial-pressure block
already reads. `emitHz` holding at ~1 kHz while `tickGapMs.max` spikes is the brick doing
its job; `sinkHz` far below `emitHz` is the link throttling. The scan status line appends
`· <sinkHz>/s` and turns warn below 20 poses per revolution, its tooltip naming WHICH rate
is low and the governor's state/backoff count. Volt/pose telemetry is throttled to
`VOLT_TELEMETRY_INTERVAL_MS`.

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

`stackCount` is `state.cap_stack` (default 1 — one revolution IS the frame; no slider).
The homographies are IDENTITY and the rect is the whole center frame: a frame that
integrated a revolution has no single mirror pose to warp against, and the UNWARPED ring is
exactly what the analyzer reads. Every resource's metadata carries a `mirror_link` block —
`scan` (the applied timing, null when idle), `ring` (the last per-eye readout: fitted
circle, chip arc, reason), `shift`, `verge`, `baseline`, `target_angle`, and the
center-pose volts/angles/`A2H` matrices for reference — so a saved frame explains itself.
`scripts/ring-debug.py <image>` reads both.

OBSERVE-ONLY — no camera write, no allocation on the shot path. Nothing in a shot calls
`lease.reconfigure` or any camera setter (the native `attachRawPipe` subscribes to the
camera's EXISTING `Arv::Stream`), so the exposure override is untouched. The raw L/R pipes
are PRE-ACQUIRED at activation with `CAPTURE_RING_DEPTH`: `rawPipes.acquire` on a 0→1
transition advertises the pipe — allocating a depth × full-depth-frame SHM ring — and runs
the native attach, both synchronous on the orchestrator loop that also runs the 1 ms pacer.
Per shot that cost would stall the pacer for tens of ms and the mirror would draw a
straight CHORD across the ring; pre-acquired, a shot only bumps the refcount and opens the
consumer gate. The producers stay parked until then, so this costs nothing while idle.
`telemetry.perf.tickGapMs` meters the pacer's own tick interval, so any remaining stall is
visible on the rig instead of inferred from the ring.

Exclusivity, as everywhere: a capture in flight refuses `startRecording`, a recording
refuses a shot, and `busy()` names either. The drain awaits an in-flight capture before the
recording drain and the lease release.

## Teardown ordering {#teardown}

Resource-scope defers, registered in REVERSE of the drain (LIFO): stop the pacer FIRST →
release the volt link → close the native position input → release the orbit brick →
`stopScan` (exposure restore on the live leases) + the gain restore → `triple = null` /
`ready: false` → await the recording drain → dispose the vergence loop if engaged (both
match workers → the pid node → wiring → its pipe connections → the needle/strip scale and
slice producers) → dispose the ring node if one exists (worker → wiring → its L/R pipes) →
retire the C undistort producer + drop the serial taps → release the leases LAST. The ring
node's and the vergence loop's pipes are the session's ONLY pipe connections (the renderer
binds every view, the recorder node connects its own raw pipes). Disengaging the loop
FLUSHES its integrated `verge`/`v_shift` into the sliders and folds `pan` into the target
ray first, so the pose the mirrors hold is bit-identical across the transition
(§auto-vergence).

## Rig pass {#rig}

Hardware-gated checks (`docs/hardware/rig.md`): the realized ring radius vs. `scan_amp`
across 5/20/50/100 Hz (mirror LPF roll-off), exposure readback equals the period on both
foveas, restore leaves Manage Cameras' values byte-identical, the dashed-ring readout of a
known-frequency blinker, and the CHORD test — drag the gain slider (and re-apply the
exposure) through a whole sweep while scanning: the ring must stay closed.
