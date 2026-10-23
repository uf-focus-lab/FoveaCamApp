# The rig

> Source of truth for constants: `app/lib/camera-config.ts`,
> `app/orchestrator/camera-trigger.ts`, `app/orchestrator/controller.ts`,
> `firmware/` (pin map: `firmware/include/Board.h`), and the controller
> board in `pcb/` (V0.1: `pcb/board/specs.md`, generated pin map
> `pcb/board/pins.h`).

## Cameras

Three FLIR Blackfly S GigE (Aravis) cameras: **L**/**R** foveal (behind the
MEMS mirrors) and **C** center wide. Roles map to serials in the camera
config; the orchestrator's registry leases them per-serial (Aravis is
per-process exclusive — `architecture/processes.md`).

- **Hardware triggering:** all three cameras are cabled and can be
  hardware-triggered on the V0.1 controller board. Each session picks which
  ones it triggers. Trigger-sync (disparity-scope, manual-control) and
  multi-fovea trigger the **L/R pair** only, so C free-runs in them. The
  Manage Cameras trigger test also checks C when a camera holds the Wide
  Angle role.
- **GPIO wiring:** every camera's 6-pin GPIO cable (Hirose HR10) plugs pin
  for pin into a JST PH 6-pin side-entry socket `J_CAMn` on the board's
  south edge: `J_CAM0` = C, `J_CAM1` = L, `J_CAM2` = R. All four lines are
  cabled (`pcb/board/specs.md` §4):

  | `J_CAMn` pin | Camera line | Teensy pin C / L / R | Direction | Use |
  |---|---|---|---|---|
  | 1 | Line3, non-isolated INPUT only, 2.6–3.6 V high (also VAUX in) | 16 / 20 / 5 | Teensy → camera (OUTPUT, 3.3 V) | **trigger** |
  | 2 | Line0, opto input | 17 / 21 / 13 | Teensy → camera | bench fallback only |
  | 3 | Line2, non-isolated bidirectional, open-drain output | 18 / 22 / 14 | camera → Teensy (INPUT_PULLUP) | **strobe** (ExposureActive) |
  | 4 | Line1, opto output (open collector) | 19 / 23 / 15 | camera → Teensy (INPUT_PULLUP) | bench fallback only |
  | 5 | opto GND | board GND | | |
  | 6 | GND | board GND | | |

  Pins 5 and 6 both landing on board GND is the board designer's reading of
  the FLIR pinout and is still marked TODO in `pcb/board/specs.md` §4.
  Check it against the FLIR GPIO diagram. Line roles follow FLIR's Blackfly S
  GPIO documentation (2026-10-21): Line3 has no output mode, so it is the
  trigger; Line2's output is open drain, so it is the strobe.
- **Camera programming (host):** `enableHardwareTrigger`
  (`app/orchestrator/camera-trigger.ts`) writes, in order:
  `TriggerSource=Line3` (Aravis also sets `TriggerMode=On`,
  `TriggerSelector=FrameStart`, `TriggerActivation=RisingEdge`; Line3 is
  input-only, so nothing to force); then `LineSelector=Line2`,
  `LineMode=Output`, `LineSource=ExposureActive`, `LineInverter=true`. The
  cameras do this themselves when a session engages, so a camera's saved
  config does not need to be set up by hand. A trigger source that the
  camera does not list in `trigger_source_options` is refused with the list
  it does offer. `LineInverter` is a GenICam boolean, which the string
  `setFeature` binding (`arv_camera_set_string`) cannot write, so it is now
  written through the binding's `setFeatureBool` (`arv_camera_set_boolean`;
  `getFeatureBool`, `setFeatureInt` and `getFeatureInt` cover the other
  non-string nodes); a failure of that write is reported, not thrown. The
  engage diagnostics span records the live line state.
- **Polarity:** the Line2 ExposureActive output is open drain. With
  `LineInverter=true` it idles released and pulls low while the camera
  exposes, so at the Teensy's pull-up it reads **active LOW** (firmware
  `Board::STROBE_ACTIVE_LEVEL = LOW`); with `false` the output is ON (LOW)
  while idle. An unplugged cable or a camera whose Line2 was never programmed
  reads idle and fails as a plain `Strobe timeout`. A REJ reading `Strobe
  timeout: line stuck at active level` means the line never returned to idle:
  `LineInverter` left off, or Line2 held low for another reason.
  Bench-verified 2026-10-22 on one BFS-U3-16S2C (L port): 20/20 FINs,
  trigger→exposure 14–16 µs. The opto pair's (Line0/Line1) polarity is
  unmeasured (`playground/trigger-bench.ts --lines Line0,Line1 --inverter
  <x>`).
- **Line3 / VAUX safety:** Line3 is also the camera's 8–24 V auxiliary
  power input (VAUX), and on this board it is wired straight to a Teensy
  pin with a 3.6 V absolute maximum and no protection. The Teensy's own
  3.3 V trigger drive sits inside Line3's 2.6–3.6 V input window and is
  safe; the hazard is an external supply on that net. **Never power a
  camera through its GPIO cable** on this rig. If the camera model offers a
  3.3 V power output on Line2 (FLIR `V3_3Enable`), leave it off: the Teensy
  reads that line. Plug in the ground pins (5, 6) before any signal line,
  as FLIR warns.
- **Opto pair (bench fallback):** Line0/Line1 stay cabled but are not used.
  The opto output (Line1) is open-collector and has the same active-LOW
  shape as Line2, so
  `enableHardwareTrigger(lease, { triggerSource: "Line0", lineSelector: "Line1" })`
  matches `STROBE_ACTIVE_LEVEL` as is; the firmware would also have to
  pulse the opto trigger pins (`Board::camera[].opto_trigger`) instead of
  Line3, which the V0.1 build does not. The opto input wants the MCU pulse
  within its voltage spec and adds µs-scale edge lag. That lag does not
  matter at the ms-scale pulse widths `pairTriggerBudget` derives.
- **Controller side:** `firmware/include/Board.h` `camera[]` is indexed in
  the `Packet::Command` camera-mask bit order (0 = C, 1 = L, 2 = R). Its
  pin pairs are named from the controller's side: `trigger` (Teensy OUTPUT
  → camera Line3) and `strobe` (Teensy INPUT_PULLUP ← camera Line2), plus
  the unused `opto_trigger` (→ Line0) and `opto_strobe` (← Line1).
- 12-bit readout formats are supported end-to-end in code (preview-safe
  option filtering); live A/B requires the full hardware rig.

## MEMS controller

The **FoveaCam Duo Driver board V0.1** (`pcb/`, submodule
uf-focus-lab/DuoController, tag v0.1.2) is a Teensy 4.0 carrier with no
active parts besides the Teensy. Board numbers are in
`pcb/board/specs.md`, the decisions in `pcb/specs.md`, and the generated
pin map in `pcb/board/pins.h`, which `firmware/include/Board.h` mirrors.

- **Mirror drivers:** two Mirrorcle digital-input drivers (AD5664R DAC),
  **one point-to-point SPI bus each**, over an unbroken ground plane:

  | Driver | Port | CS / SCLK / MOSI | Peripheral |
  |---|---|---|---|
  | DRV1, left fovea mirror | `J_SPI1` (west) | 2 / 3 / 4 | FlexIO1 |
  | DRV2, right fovea mirror | `J_SPI2` (east) | 9 / 12 / 11 | FlexIO2 |

  The ports are 2x5 1.27 mm headers in the Mirrorcle pin order (Samtec
  FFSD cable). CS is a plain GPIO. The board recommends a 10 MHz SCLK
  maximum until it is measured.
- **Shared enable and filter clock:** one `MEMS_EN` (pin 6, held LOW by
  the MCU through reset) and one `FCLK` (pin 10, PWM at 60× the filter
  cut-off) feed both drivers. Enable order (Mirrorcle guide p27): DAC init,
  Vbias on all channels, FCLK running, then `MEMS_EN` HIGH; disable in
  reverse. No GPIO is left for a per-driver enable.
- **Fan outputs:** three 5 V outputs on JST PH 2-pin sockets (pin 1 +5V,
  pin 2 GND): `J_PWR1` and `J_PWR2` beside the DAC ports, `J_PWR3` at the
  north edge. They are **outputs only**: never feed power into them.
- **UARTs:** `J_UART1` (Serial1, RX1 0 / TX1 1) and `J_UART2` (Serial2,
  RX2 7 / TX2 8), JST PH 5-pin: 1 +5V, 2 +3V3, 3 GND, 4 RX, 5 TX, 3.3 V
  logic. A 2-pin fan plug also fits a UART header if shifted, which puts
  +5V onto 3V3/GND/RX, so check before plugging a fan in.
- **Power budget** (`pcb/specs.md` §4): +5V comes **only** from the
  Teensy's USB (VIN joined to VUSB on the Teensy). On a USB 2.0 port
  (500 mA; USB 3.x 900 mA), the Teensy takes about 100 mA (not yet
  measured) and the two drivers 2 × 38 mA enabled, plus a 100 mA start-up
  pulse each. That leaves about **300 mA for all fans** (about 700 mA on
  USB 3.x), so plan on **≤ 100 mA per fan socket including start-up
  surge** on USB 2.0. The drivers need VDD 4.85–5.2 V and shut down on
  their own below it, which looks like a mirror freeze. Measure VDD at
  `J_SPI` pin 3 under load (open item). The four optional 22 µF capacitor
  footprints are not fitted by default, because they exceed the USB 2.0
  inrush limit.
- **No status LED:** pin 13 (the Teensy LED) is camera R's opto trigger
  line.

Host link: a USB serial device (Teensy USB CDC; the baud setting has no
effect). The protocol is in `architecture/serial-protocol.md`. v2 firmware
adds position streams and synced frame capture (FIN carries the
exposure-averaged mirror voltage). `verifyVersion()` decides v1/v2 at
connect, and v2-only surfaces are gated on `v2Capable`.

### MEMS bus

- **Buses:** the V0.1 board gives each Mirrorcle driver (AD5664R DAC) its own
  point-to-point bus — left `Board::dac[0]` (CS 2, SCLK 3, MOSI 4), right
  `Board::dac[1]` (CS 9, SCLK 12, MOSI 11); no MISO. Firmware bit-bangs both
  in lockstep from the cycle counter (`firmware/src/MEMS.cpp`): one GPIO
  toggle store per bus per edge, left and right stores back to back, so both
  mirrors' frames go out in the same window. SPI mode 1, 24-bit frames, SYNC
  low for the frame and high for one half period between frames.
- **Clock:** `MEMS::SPI::SCLK_HZ` in `firmware/include/MEMS-SPI.h`, a single
  build-time constant — 10 MHz default (board recommendation until the
  cables are measured), compile-time ceiling 25 MHz; above ~20 MHz the edge
  loop itself is the limit and the clock runs slower than asked, never
  faster. Pads: SCLK/MOSI/CS DSE 2, slow slew; FCLK DSE 1, slow slew
  (`Board::padSetup()`).
- **Frames per update:** per mirror 3× `WRITE_IREG` (channels A, B, D) + 1×
  `APPLY_IREG` (channel C, write and update all), both mirrors concurrently,
  so all eight outputs change on the same final SCLK edge.
- **Update rate (expected, not yet measured):** 2.4 µs per frame at 10 MHz →
  ~9.7 µs on the wire per two-mirror update, ~12 µs per `MEMS::apply()` call
  including the edge-mask precompute → ~80 kHz ceiling (V0.0 shared bus:
  ~150 µs, ~6.7 kHz). At 20 MHz ~5 µs on the wire if the loop keeps up.
  Scope SCLK on both J_SPI ports to confirm the clock and the SYNC timing.
- **Interrupt cost:** IRQs are masked only for ~20 cycles around each edge
  (~35 ns worst-case added strobe-ISR latency at 600 MHz); an ISR between
  edges just stretches that SCLK phase.
- **Enable order:** DAC init + V_BIAS, FCLK on, then MEMS_EN (pin 6) HIGH;
  disable drops MEMS_EN first, then bias, then FCLK off.

## MirrorLink scan pass

Hardware-gated checks for the `mirror-link` app (spec
`docs/spec/mirror-link.md` §rig) — all need the full rig:

- **Ring radius vs. amplitude across frequency.** With a point source in
  view, scan at 5 / 20 / 50 / 100 Hz at a fixed `scan_amp` and measure the
  REALIZED ring radius in each fovea frame. The commanded circle is exact; the
  mirror's own low-pass response attenuates the realized radius as frequency
  rises. Record the roll-off curve — it is the usable-frequency budget.
- **Exposure readback equals the period.** On both foveas, read back the live
  exposure while scanning and confirm it matches `1e6 / hz` µs (the `scan`
  telemetry's `mismatch` flag must stay clear). A camera whose max frame rate is
  below `hz` should show its max rate with `exposure = period`.
- **Restore leaves Manage Cameras byte-identical.** Note each fovea's exposure /
  frame rate / frame-rate-enable / auto-exposure AND gain / auto-gain before
  scanning; stop the scan (and separately, leave the app mid-scan with the Gain
  slider moved) and confirm every value came back unchanged. Gain is
  session-wide, so its restore is only exercised on leaving the app.
- **Chord test — the scan must survive a camera write.** With the scan running
  on a point source, drag the **Gain** slider through its whole range and change
  `scan_hz` (which rewrites both foveas' exposure). The ring must stay CLOSED —
  a straight chord across it means a camera write is still stalling the
  generator. `telemetry.perf.orbit.rateHz` must hold at ~1 kHz with
  `orbit.native` true throughout, even while `perf.tickGapMs.max` spikes (that
  spike is the JS loop, which no longer drives the mirrors).
- **Hexagon test — pose density over time.** Scan a point source at 10 Hz for
  5 minutes and watch the shape AND the **Status** line's `· <n>/s` suffix. The
  ring must stay round: a rotating hexagon/polygon means the mirror sink's AIMD
  governor has backed off (6 vertices ⇒ ~60 poses/s). Confirm
  `telemetry.perf.orbit.governor.state` stays `steady` at
  `effectiveRateHz` ≈ 1000 and `backoffs` does not climb; a `backoff` state with
  rising `softFails`/`outq` is a genuine link problem, a `backoff` with both at
  zero means the policy (floor 500 Hz, RTT inflation 8×) needs another look.
  Also compare `emitHz` vs `sinkHz` — if BOTH are low the generator thread is
  being starved (macOS timer coalescing), not the link.
- **Dashed-ring readout.** Point at a blinker of KNOWN frequency and confirm the
  on/off pattern along the ring matches it (count the dashes per revolution
  against `blink_hz / scan_hz`).
- **Auto vergence convergence.** With the scan STOPPED and a textured target in
  both fovea views, press Auto Vergence: the status must reach `tracking` and
  Verge Distance / Vertical Shift must settle within a second or two (the same
  loop and the same gains as Disparity Scope — compare them side by side if it
  misbehaves). Then start the scan and confirm the status reads
  `paused: scanning`, the ring stays put, and stopping the scan resumes
  `tracking` from the same values. Finally press Stop Vergence and confirm the
  mirrors do NOT move and the two sliders hold what the loop reached.
- **Capture a ring frame.** With the emitter running, press the capture button and
  save. Confirm both fovea images show the un-straightened ring, and that the
  `.json` beside them carries a `mirror_link` block with the scan timing and the
  reader's per-eye circle/reason. `python3 scripts/ring-debug.py <image>` must
  reproduce the app's verdict on that frame — that is the offline-debugging loop.
- **Decode a known message.** Drive the emitter with the ring-code frame
  (`docs/spec/ring-code.md`) for a known short string at a cycle equal to the
  scan period. Both fovea readouts must show that string, the fitted circle and
  leader arc must sit on the ring, and the measured `px/chip` must match
  `C / chips` (ring circumference over the frame's chip count). Walk the message
  length up until `below resolution` appears — that is the rig's real emitter
  budget; record it against the `C / (1.5·d)` prediction.

## Bench flow

1. **Board bring-up:** work through `pcb/board/bringup.md`, the generated
   checklist: rail isolation on the bare board, continuity from every
   connector pin to its Teensy pin, then power-up. Flash the V0.1 firmware
   (PlatformIO, `firmware/`) **before** fitting the Teensy, since the V0.1
   pin map differs from V0.0 on almost every pin. V0.0 XH cables do not fit
   the V0.1 PH sockets.
2. **Drivers:** connect DRV1 to `J_SPI1`, check it powers from +5V, then
   DRV2 to `J_SPI2`, and measure VDD under load.
3. **Cameras:** connect each GPIO cable to its `J_CAMn` (grounds first;
   observe the Line3/VAUX rule above). In Manage Cameras, assign roles and
   run the Fovea Pair **Trigger** test. With a Wide Angle camera assigned,
   it covers C too. Scope the Line2 strobe polarity before the first synced
   capture.
4. **Rig verification:** hardware verification runs the pre-flight and
   playbook passes, exports profiler snapshots as the baseline, and works
   through the remaining hardware-gated checks.
