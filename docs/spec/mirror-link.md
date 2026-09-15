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
server-side via `undistort.angular` into the wide angular frame (`A0`, radians).
Uncalibrated → `A0 = {0,0}` and origin volts. There is no tracker, no set-points, no
programmatic angle mode.

`centerAngles()` solves the per-eye angles from the ONE center:
`inverseTriangulate(A0, baseline, distance, radians(shift))` where
`distance = vergeToDistance(verge, baseline)` (∞ at `verge = 0`) — manual-control's own
pair of mirror controls, with the same meaning: Verge Distance sets the depth both eyes
converge on, Vertical Shift (degrees, ±0.5°, persisted) is the toe that raises L and lowers
R by `s`. `A2V` per eye turns angles into volts. Both apply identically whether or not the
scan is active — they move the ring's center, never its shape.

### Auto align {#auto-align}

Source: `align.ts` (pure, unit-tested). `autoAlign` re-aims both foveas at the emitter
from ONE frame per eye: it runs a single observe-only capture shot (stack 1 regardless of
`cap_stack`), pulls the two UNWARPED fovea previews, takes each frame's
`brightestSpot` (centroid of pixels ≥ 90 % of the peak; refused below an 8-bit peak of 32
or under 3 lit pixels), converts the spot to an angular offset against that eye's fovea
intrinsics at its CURRENT gaze (`deriveFoveaIntrinsics(und, a_eye, 1)`, pinhole
`atan((s − c)/f)`), and adds it to the eye's current angle. `solveAlignment` then inverts
the fixation model in closed form — `z = 2b / (tan aL.x − tan aR.x)`,
`x = z·tan aL.x − b`,
`angle.y = mean`, `shift = (aL.y − aR.y)/2`, diverging/parallel ⇒ ∞ — and the result is
APPLIED: the gaze ray becomes the scan center (`target`/`target_angle`), the crossing
distance becomes `verge` (via `distanceToVerge`, clamped 0–1; ∞ ⇒ 0) and the vertical
difference becomes `shift` (clamped to the slider range).

Refused with a reason on `telemetry.align` (and the title-bar tray) when there is no
leased/calibrated triple or capture helper (`not ready`), while the scan is ACTIVE
(`scan active` — the emitter must read as a point, not a ring), or when either eye shows
no spot (`no bright spot on L|R`). The last result stays on `telemetry.align` (reset on
idle) so the UI tooltip can show both spots and the applied delta.

RIG-GATED: the pixel→angle SIGN is `SPOT_TO_ANGLE_SIGN` in `align.ts`, defaulting to
`{+1, +1}` — the same pinhole convention split-tracking's `eyeJInv` uses. A mounting flip
shows up on the rig as the spot moving AWAY from the fovea center after an align; flipping
the axis there is the whole fix.

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
LIVE: a change while active takes effect on the next tick (amplitude) or re-applies the
exposure override (frequency, §exposure). The mirror's own low-pass response attenuates
the realized radius at higher frequencies — the commanded circle is exact, the physical
one is a rig measurement.

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
rate — deliberately NOT the homography-undistort bricks: a frame that integrates a full
revolution has no single mirror pose to warp against, and the un-warped ring is the
readout. While `ring_reader` is on AND the scan is running (and ONLY then — an off
feature leaves no phantom row, and an annotation asserts a decode of the CURRENT frame)
each carries the §reader annotations in FRAME px: the fitted circle (solid on a decode,
dim + dashed when only the fit succeeded), the LEADER arc in `--warn` (distinct from both
eye colors), and radial ticks at every field (long) and byte (short) boundary. The arc +
ticks stay mounted and fade rather than remount — a marginal emitter flips ok↔fail at
frame rate. Under it a fixed-height, START-aligned mono row reads the decoded text +
`px/chip` (emphasized), or `off` / `idle` / `reading…` / the failure reason (with the
last decode, muted); the full text, the hex and the reading direction ride its `title`.

The center view binds the intrinsic `undistort:<serial>` pipe (raw convert fallback
uncalibrated) and is the ONLY steering surface; no display worker, no
stereo/composite/heatmap bricks. Overlays on the center view, all in wide px:

- the target dot at `telemetry.target` (center theme color),
- the scan ring — radius `telemetry.scan_px` (`|A2P.C(A0 + (amp, 0)) − A2P.C(A0)|`,
  0 uncalibrated) — dashed and faint while idle (a preview of the path), solid while
  active,
- per-eye markers at `L_PX`/`R_PX`, projected from the CENTER pose (`A2P.C ∘ V2A` of the
  offset-free volts, shift included), not the instantaneous scan pose — they show where
  each fovea is aimed, and separate with the verge/shift. Hidden uncalibrated ({0,0}).

The PosViews draw the scan as a STATIC path with a stable crosshair: `telemetry.volt` is
the commanded pose while idle and the ring's CENTER while scanning (sampling the circle at
the 30 Hz telemetry throttle reads as random flicker, not motion), and
`telemetry.scan_path = { L, R }` carries the commanded circle in VOLT space —
`SCAN_PATH_SAMPLES` (48) points per eye through the pacer's own chain (offset →
`inverseTriangulate` + shift → `A2V`), which the renderer closes into a loop and draws with
`Line2D` (faint idle, solid while active). It is republished on every input that moves or
reshapes the ring (steer, `scan_amp`, `verge`, `baseline`, `shift`, auto align, activation) and
NEVER per tick; empty without a leased triple. PosViews are read-only here (no split).

Below the center tile: ONE button whose label swaps Start Scan / Stop Scan (the row is a
GRID with a fixed 9em first track, so neither the label nor the status text can move or
resize it; label tracks `telemetry.scan`; disabled until `ready`, dimmed in place while a
start/stop round-trip is in flight; solid `--accent` fill idle, solid `--danger` while
scanning — emphasis is a FILL, never a border, and both pairs clear AA) and
a compact status span — the applied `hz · period · per-eye exposure` while active,
`idle` / `idle — refused` otherwise, warn-toned on `mismatch` or a refusal, with the
detail (and the blocked reason) in its `title` hover. The row is a PLAIN div, never a
`<label>`/ConfigEntry: a label would forward a status-span click to the button and
toggle the hardware override; the button's own explanation rides the ROW's `title`
(a disabled button suppresses hover). The drawer carries the mirror controls (Verge
Distance, Vertical Shift, the Auto Align button) left and Gain, the scan sliders
(frequency, amplitude), the Ring Reader toggle, and a Status row right — Gain leads the
column because it is session-wide, not scan-scoped.
Every slider carries a one-sentence `title`. Gain alone declares NO `neutral` — a stray
right-click must never slam a live camera to range-min, and its `title` says so — and it
is disabled (readout `—`) until `ready` with a non-degenerate `gain_range`; its `v-model`
proxy CLAMPS on read and refuses writes while disabled. No explanatory text anywhere —
hover tooltips only.

## Actuation {#actuation}

Push model: the SESSION owns the 1 ms pacer (`startPacer`) on one `openPosition`
input. Idle: each tick slews the commanded pose toward `centerVolts()` with the shared
first-order smoother (`@lib/slew` — manual-control's `slew.ts` HOISTED, same constants;
disparity-scope's `drag-slew.ts` stays a parallel copy for now). Active: each tick
commands the scan pose DIRECTLY (no slew — a smoother would lag and shrink the circle);
on stop the slew resumes from the last scan pose, so the return to center is smooth.
Volt/pose telemetry is throttled to `VOLT_TELEMETRY_INTERVAL_MS`.

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
`stopScan` (exposure restore on the live leases) + the gain restore → `triple = null` /
`ready: false` → await the recording drain → dispose the ring node if one exists
(worker → wiring → its L/R pipes) → retire the C undistort producer + drop the serial
taps → release the leases LAST. The ring node's pipes are the session's ONLY pipe
connections (the renderer binds every view, the recorder node connects its own raw
pipes).

## Rig pass {#rig}

Hardware-gated checks (`docs/hardware/rig.md`): the realized ring radius vs. `scan_amp`
across 5/20/50/100 Hz (mirror LPF roll-off), exposure readback equals the period on both
foveas, restore leaves Manage Cameras' values byte-identical, and the dashed-ring readout
of a known-frequency blinker.
