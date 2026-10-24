# MirrorLink scan patterns — bench checklist

The hand-off from the `feat/MirrorLink` review loop to the bench. It says what
to build, what was and was not verified off-rig, and the order to exercise the
new behaviour on hardware. The full hardware-gated checks live in
[`rig.md` §MirrorLink scan pass](./rig.md#mirrorlink-scan-pass); the operator
view is [`docs/manual/mirror-link.md`](../manual/mirror-link.md); every design
decision and review finding is in
[`docs/spec/mirror-link-scan-patterns.md`](../spec/mirror-link-scan-patterns.md).

## What this branch changes on the wire and in the firmware

- Protocol **2.2.1** (`lib/Protocol/Version.h`): the atomic START swap
  (`START(b)` while `a` runs, same period and exact `t_start`), and three new
  refusals — `Command::Actuate` and the legacy `Command::Trigger` while a
  trajectory runs, and a trajectory START while a legacy Trigger is pending.
  An Actuate under HOLD now becomes the hold position.
- Capture: the trigger line is released on every exit of a marker capture;
  `Streams::claim()` never re-drives the previous run's position.
- The host falls back to the STOP/START pair on firmware 2.2.0 (a brief HOLD
  per live edit); the atomic swap needs 2.2.1 on the Teensy.

## Build and flash

Nothing below could run in the review environment: the Teensy toolchain
download was blocked, and the native addon needs Aravis + OpenCV. Build all
three locally, in this order.

1. **Firmware** — `cd firmware && pio run -t upload` (board `teensy40`,
   `platformio.ini`). Confirm the version the app sees: with 2.2.0 **Start
   Scan** works but `perf.trajectory.last_swap` reads `stop-start`; below
   2.2.0 Start is refused with "controller firmware >= 2.2.0 required".
2. **Native core** — `cd core && make` (also runs as `npm install`'s
   postinstall). The new `FlipStream` brick lives in `core/lib/Aravis/`; its
   hardware-free test is `core/test/54-flip-stream.ts`. Run the core test set
   once after the build (tests 47–52 drive the host simulator and now see its
   `stall` lines; 54 is the flip brick).
3. **App** — `npm run app`. `cd app && npx vitest run` and
   `npx vue-tsc --noEmit` are the fast checks (one pre-existing type error in
   `src/set-points/List.vue` is known).
4. **Simulator harness** (optional, no hardware) — `cd test/build && cmake ..
   && make -j4 && ./fw-sim-check`. It compiles the real firmware TUs and ends
   with `ALL OK` plus a line of stage retries / fixture re-arms / sim stalls.
   Give the sim a fair core share; a starved host is reported as a fixture
   miss, never as a firmware fault.

## Camera pre-flight

- Each fovea: trigger on **Line3** (input-only), strobe on **Line2**
  (`ExposureActive`, open-drain, `LineInverter = true` — bench-measured on
  the Blackfly S). Run the Manage Cameras Fovea Pair **Trigger** test first.
- Note every fovea's exposure, exposure mode, trigger activation, trigger
  overlap, frame rate, frame-rate enable, auto exposure, gain and auto gain:
  the scan must leave all of them byte-identical on stop and on leaving the
  app mid-scan.
- Does the model take `ExposureMode = TriggerWidth` with
  `TriggerActivation = LevelHigh`? If not, the app falls back to Timed and the
  status hover says "Timed fallback". Record which mode each eye took
  (`scan.exposure_mode`).

## Order of bench tests

Each step names the telemetry or string to watch. Stop as soon as a step
disagrees and keep the app's tray warnings and the controller log.

1. **Ellipse, defaults** (10 Hz, amplitude 0.5°, ratio 1, window 0–95 %).
   Start Scan → status `ellipse · 10.0 Hz · 100.0 ms · 0.0–95.0 ms`, hover shows
   `pushes.ok` climbing, `lateness_us` within tens of µs, `last_swap` null.
   Scope Line3/Line2 on one eye: strobe width = `pulse_us`, start =
   `t_offset_us` into the period.
2. **Live edits, no restart**: drag steer, amplitude, ratio, the axis handle
   and the window slider for a minute. No stutter, `pushes.timeout`/`busy`
   flat, `reuploads` ≤ 10/s, `last_swap` = `atomic` (2.2.1). Edits at the
   window's ends and ratio 0 (`line`) included.
3. **Period change**: Scan Frequency 10 → 20 Hz restarts the run (short pause,
   cameras keep their config, `trajectories` count +1 in the profiler).
4. **Triangle**: Mode → Triangle, axis 90°. Two frames per 2T; the falling
   frame arrives vertically flipped; `flipped` climbs on both eyes,
   `unmatched` ≈ 0, note `skew_us` per eye (≈ 0 or ≈ ±pulse — record which
   edge the camera stamps). Sync Windows off → edit the falling window alone.
   Squeeze the windows at high frequency until the amber reason reads
   "exposure windows too close for reliable flipping at this frequency"; the
   scan keeps running.
5. **Timed fallback** (a model without TriggerWidth, or force it by refusing
   the mode in Manage Cameras if the camera allows): both triangle markers
   carry the rising window's length; with Sync off the amber reason names
   unequal windows; the camera's exposure never exceeds the MCU pulse (scope
   the strobe fall against the trigger fall + 5 ms).
6. **Stall**: pull one eye's trigger cable mid-scan. Within two periods the
   status line turns amber with "No exposure has completed for two scan
   periods — the cameras stopped answering the trigger"; `stalled` true;
   reconnect → clears on the next OK push.
7. **Controller loss**: unplug the controller mid-scan → `idle — stopped`,
   hover "controller disconnected — scan stopped"; cameras restored; mirrors
   centered on reconnect + Start.
8. **Clock lapse**: block the 30 s re-ping (hold the controller busy, or
   detach for > 60 s and reattach): amber "controller clock calibration
   lapsed"; a Mode/Frequency change then stops the scan with "controller clock
   calibration lapsed — press Start once it recovers".
9. **Capture + ring reader**: capture a frame in triangle mode; the saved
   falling-sweep image is UNFLIPPED (the view shows it flipped); the JSON
   carries `mirror_link.pattern` (mode, axis_deg, amp_deg, ratio, windows).
   `python3 scripts/ring-debug.py <image>` reproduces the app's verdict.
10. **Restore**: Stop Scan, then leave the app mid-scan with Gain moved.
    Compare the camera settings noted in pre-flight; the mirrors return to
    center.

## Failure-path checks (only if the link misbehaves)

These need an unreliable serial link (long cable, or a USB hub that drops
packets). Do not fake them on a good rig.

- A live edit whose swap ACK is lost → amber "replacement swap unconfirmed —
  the mirror may run the previous edit"; the app retries once by itself; any
  further aim/shape edit settles it. Three unclear swaps in a row → "live
  edits exhausted the controller's tables — restarting the scan" and a clean
  restart.
- `pushes.busy` > 0 with "trigger rate above the camera's maximum frame rate"
  means the frequency is above the camera's limit — expected, lower it.

## Known limits going to the bench

- The flip brick, the exposure override and the swap logic were validated
  against the host simulator and unit tests only; the Blackfly S's actual
  TriggerWidth behaviour, its Line2 strobe timing relative to the exposure,
  and the mirror's frequency roll-off are bench measurements still to take
  (`rig.md` §MirrorLink scan pass has the recording protocol).
- `perf.trajectory.skew_us` tells you which strobe edge the camera stamps;
  the flip brick matches either edge, so a constant ≈ ±pulse skew is fine, a
  drifting one is a clock problem.
- The harness passes clean on an idle host; under heavy host load it re-arms
  fixture windows rather than failing. Treat any plain `CHECK failed` that
  names a firmware fault as real and report it with the printed stall list.
