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

## Views {#views}

The L/R main views bind the RAW convert pipes (`nodeId.convert(serial)`) directly, at pipe
rate — deliberately NOT the homography-undistort bricks: a frame that integrates a full
revolution has no single mirror pose to warp against, and the un-warped ring is the
readout. The center view binds the intrinsic `undistort:<serial>` pipe (raw convert
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
Distance + the four trims) left and the scan sliders (frequency, amplitude) + a Status
row right; every slider carries a one-sentence `title`. No explanatory text anywhere —
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
`stopScan` (exposure restore on the live leases) → `triple = null` / `ready: false` →
await the recording drain → retire the C undistort producer + drop the serial taps →
release the leases LAST. The session holds no pipe CONNECTIONS of its own (the renderer
binds every view, the recorder node connects its own raw pipes).

## Rig pass {#rig}

Hardware-gated checks (`docs/hardware/rig.md`): the realized ring radius vs. `scan_amp`
across 5/20/50/100 Hz (mirror LPF roll-off), exposure readback equals the period on both
foveas, restore leaves Manage Cameras' values byte-identical, and the dashed-ring readout
of a known-frequency blinker.
