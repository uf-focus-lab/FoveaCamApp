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

`centerAngles()` solves the per-eye angles from the ONE center: `inverseTriangulate(A0,
baseline, distance)` where `distance = vergeToDistance(verge, baseline)` (∞ at `verge = 0`,
the same Verge Distance control as manual-control), then adds the per-eye FINE TRIMS —
`trim_lx/trim_ly/trim_rx/trim_ry` (degrees, ±0.5°, persisted state) — as radians on that
eye only. Trims are the fine-alignment control: after the coarse drag, the operator nudges
each fovea until the source sits at its frame center. `A2V` per eye turns angles into
volts. Trims apply identically whether or not the scan is active (they move the ring's
center, never its shape).

## Circular scan {#scan}

Source: `scan.ts` (pure, Vue-free, unit-tested).

At time `t` (ms since scan start) the scan OFFSET is
`o(t) = amp · (cos φ, sin φ)`, `φ = 2π · hz · t / 1000`, `amp = radians(scan_amp)`. The
offset is added to `A0` in the WIDE angular frame BEFORE `inverseTriangulate`, so both
eyes trace the same circle around the same scene point (the L/R convergence solution
follows the moving center; trims are added after). `scanOffset(tMs, hz, ampDeg)` is the
one geometry function; `scanAngles(A0, offset, baseline, distance, trims)` composes the
per-eye angles (the same function serves the idle pose with a zero offset).

Phase is derived from the pacer's WALL CLOCK (`performance.now() − t0`), never from a
tick counter — a late or coalesced tick lands at the correct phase instead of
accumulating drift. Zero amplitude degenerates to the idle pose.

Parameters (`scan_hz` 1–100 Hz, `scan_amp` 0–2°) are LIVE: a change while active takes
effect on the next tick (amplitude) or re-applies the exposure override (frequency,
§exposure). The mirror's own low-pass response attenuates the realized radius at higher
frequencies — the commanded circle is exact, the physical one is a rig measurement.

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
readout. While `ring_reader` is on AND the scan is running (and ONLY then — an off feature leaves no
phantom row, and an annotation asserts a decode of the CURRENT frame) each carries the
§reader annotations in FRAME px: the fitted circle (solid on a decode, dim + dashed when
only the fit succeeded), the LEADER arc in `--warn` (distinct from both eye colors), and
radial ticks at every field (long) and byte (short) boundary. The arc + ticks stay mounted
and fade rather than remount — a marginal emitter flips ok↔fail at frame rate. Under it a
fixed-height, START-aligned mono row reads the decoded text + `px/chip` (emphasized), or
`off` / `idle` / `reading…` / the failure reason (with the last decode, muted); the full
text, the hex and the reading direction ride its `title`. The center view binds the intrinsic `undistort:<serial>` pipe (raw convert
fallback uncalibrated) and is the ONLY steering surface; no display worker, no
stereo/composite/heatmap bricks. Overlays on the center view, all in wide px:

- the target dot at `telemetry.target` (center theme color),
- the scan ring — radius `telemetry.scan_px` (`|A2P.C(A0 + (amp, 0)) − A2P.C(A0)|`,
  0 uncalibrated) — dashed and faint while idle (a preview of the path), solid while
  active,
- per-eye markers at `L_PX`/`R_PX`, projected from the CENTER pose (`A2P.C ∘ V2A` of the
  offset-free volts, trims included), not the instantaneous scan pose — they show where
  each fovea is aimed, and separate as trims diverge. Hidden uncalibrated ({0,0}).

`telemetry.volt` IS the instantaneous commanded pose (the PosViews trace the circle at
the telemetry throttle — honest, and a cheap liveness cue). PosViews are read-only here
(no split).

Below the center tile: ONE button whose label swaps Start Scan / Stop Scan (fixed
min-width so the swap is layout-stable; label tracks `telemetry.scan`; disabled until
`ready` and while a start/stop round-trip is in flight; accent styling while active) and
a compact status span — the applied `hz · period · per-eye exposure` while active,
`idle` / `idle — refused` otherwise, warn-toned on `mismatch` or a refusal, with the
detail (and the blocked reason) in its `title` hover. The row is a PLAIN div, never a
`<label>`/ConfigEntry: a label would forward a status-span click to the button and
toggle the hardware override; the button's own explanation rides the ROW's `title`
(a disabled button suppresses hover). The drawer carries the alignment sliders (Verge
Distance + the four trims) left and Gain, the scan sliders (frequency, amplitude), the
Ring Reader toggle, and a Status row right — Gain leads the column because it is
session-wide, not scan-scoped.
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
per-frame fovea binding — a scanned frame has no single pose). Still capture is NOT
offered (no capture helper, no capture window). `busy()` refuses a mid-recording drain.

## Teardown ordering {#teardown}

Resource-scope defers, registered in REVERSE of the drain (LIFO): stop the pacer FIRST →
`stopScan` (exposure restore on the live leases) + the gain restore → `triple = null` /
`ready: false` → await the recording drain → dispose the ring node if one exists (worker →
wiring → its L/R pipes) → retire the C undistort producer + drop the serial taps → release
the leases LAST. The ring node's pipes are the session's ONLY pipe connections (the
renderer binds every view, the recorder node connects its own raw pipes).

## Rig pass {#rig}

Hardware-gated checks (`docs/hardware/rig.md`): the realized ring radius vs. `scan_amp`
across 5/20/50/100 Hz (mirror LPF roll-off), exposure readback equals the period on both
foveas, restore leaves Manage Cameras' values byte-identical, and the dashed-ring readout
of a known-frequency blinker.
