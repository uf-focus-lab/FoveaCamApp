# Controller board V0.1 migration — decisions and status

> Design record for the firmware/core/app adaptation to the FoveaCam Duo
> Driver V0.1 board (`pcb/` submodule = uf-focus-lab/DuoController master,
> tag v0.1.2), done on branch `feat/controller-v0.1` (firmware/protocol
> version 2.2.0). The decisions below are binding; `firmware/include/Board.h`
> is the pin-level source of truth and `pcb/board/pins.h` the generated board
> map it mirrors. The last section is the bench checklist: what is verified
> only in the host simulator and still needs the real hardware.

## Goals (owner, 2026-10-21)

1. Firmware runs on the V0.1 board (new pin map, two SPI buses, enable
   sequencing, non-isolated camera lines, center camera cabled).
2. **Maximum bandwidth to the mirror DACs.** SPI reliability is no longer a
   design constraint (point-to-point buses over an unbroken plane).
3. **Non-opto-isolated GPIO for camera trigger and strobe.**
4. **Timestamped position streams** for ultra-precise motion control.
5. **No ACK-serialisation bottleneck** on the serial link: a command must not
   block the next one until its ACK arrives.
6. **MirrorLink:** the mirror runs a pre-calculated periodic trajectory and
   frames are triggered at exact phases of it, with minimal serial traffic
   (upload once, run on the MCU).
7. The center (wide) camera stays **free-running** in every session; only the
   Manage Cameras self-test exercises its trigger (owner, 2026-10-21).

## Decisions

### Pins and lines (`Board.h`)

| Function | Teensy pin | Note |
|---|---|---|
| DRV1 (left) CS / SCLK / MOSI | 2 / 3 / 4 | CS plain GPIO; SCLK=FlexIO1 D05, MOSI=D06 |
| DRV2 (right) CS / SCLK / MOSI | 9 / 12 / 11 | SCLK=FlexIO2 D01, MOSI=D02 |
| MEMS_EN (shared) | 6 | LOW through reset; raised last, dropped first |
| FCLK (shared) | 10 | PWM, 60x cut-off |
| CAM0 (C) L3 trig / L2 strobe | 16 / 18 | opto pair 17 / 19 unused |
| CAM1 (L) L3 trig / L2 strobe | 20 / 22 | opto pair 21 / 23 unused |
| CAM2 (R) L3 trig / L2 strobe | 5 / 14 | opto pair 13 / 15 unused; 13 is the LED |

- Trigger = camera **Line3** (Teensy OUTPUT). Strobe = camera **Line2**
  (Teensy INPUT, pull-up). Settled 2026-10-21 against FLIR's Blackfly S GPIO
  documentation: Line3 is the BFS's non-isolated INPUT-ONLY line (high
  2.6..3.6 V, also the VAUX power input) and Line2 is the bidirectional line
  whose output is OPEN DRAIN. The first draft had them the other way round,
  which no BFS can do. The VAUX hazard is an external supply on Line3, so the
  rig rule is "never power a camera through its GPIO cable"; the Teensy's
  3.3 V drive sits inside Line3's input window. Note that the generated
  firmware notes in `pcb/board/pins.h` still describe the opto pair as the
  trigger/strobe lines; the board wiring is the same either way, and
  `Board.h` is the authority for which lines the firmware uses.
- `Board::STROBE_ACTIVE_LEVEL = LOW`: with host `LineInverter=true` the
  open-drain Line2 output idles released and pulls the pulled-up line LOW
  while exposing (bench 2026-10-22; with `false` the BFS output is ON while
  idle, so the line reads as a permanent exposure). An unplugged or
  unprogrammed line reads released, so it fails as a clean strobe timeout. Capture keys every edge decision
  on this constant, never on a literal.
- Host (`app/orchestrator/camera-trigger.ts`) programs `TriggerSource=Line3`,
  `LineSelector=Line2, LineMode=Output, LineSource=ExposureActive`,
  `LineInverter=true` (through the binding's boolean setter). The opto pair
  (Line0/Line1) remains selectable for a bench fallback, not the default; its
  inverter polarity is unmeasured.
- All three cameras are triggerable: `CAM_C` is a valid mask bit; a mask of 0
  still means `CAM_L | CAM_R`, so sessions that do not ask for C never
  trigger it.
- No LED anywhere in firmware (pin 13 is a camera line).

### MEMS bus and enable sequence

- Two buses written **concurrently** by a lockstep GPIO bit-bang
  (`firmware/src/MEMS.cpp`, rationale in `MEMS-SPI.h`): one register store
  per lane per edge, so both mirrors' frames go out in the same time window
  and all eight outputs change on the same final edge.
- Clock: one constant, `MEMS::SPI::SCLK_HZ`, default 10 MHz, compile-time
  ceiling 25 MHz (AD5664R max 50 MHz; the board recommends 10 MHz until
  measured). Edges are scheduled off the cycle counter; interrupts are masked
  only for about 20 cycles around each edge (about 35 ns added to the strobe
  ISRs).
- Frames per update: 3x `WRITE_IREG` + 1x `APPLY_IREG` per device, SPI
  mode 1, SYNC low per 24-bit frame and high between frames, no delay bytes.
  Expected two-mirror update time about 10 µs at 10 MHz (about 150 µs on the
  old shared 2 MHz bus).
- Pad control on SCLK/MOSI/CS (DSE 2, slow slew, SPEED 0) and FCLK (DSE 1,
  slow slew), applied after `pinMode` so it sticks; compiled out under
  `FOVEA_HOST_SIM`.
- Enable order (Mirrorcle guide p27): DAC init words, Vbias on all channels,
  FCLK running, then MEMS_EN HIGH. Disable in reverse. The 1 Hz
  `MEMS::refresh()` re-assertion stays and never moves the mirror.
- The host simulator decodes the real bit-banged waveform back into
  `dac cs=<L|R|LR> <hex>` lines, so it checks the driver bit for bit.

### Protocol 2.2.0: timestamped keyframes and uploaded trajectories

Both in the MCU `Global::time` µs clock domain (same as `SYS_TIMESTAMP` /
`FrameResult`), converted host-side through the existing clock calibration.
Backward-compatible additions; old firmware REJects the unknown properties
and the host gates on `>= 2.2.0`. Full wire layouts and REJ reasons:
`docs/spec/serial-protocol.md#schedule` and `#trajectory`.

- **`CMD_SCHEDULE` (nibble `0x0D`)**: a 26-byte timestamped keyframe
  appended to an existing stream's 32-deep time-ordered ring. Applied when
  `t_apply <= now`; with the `INTERPOLATE` flag the firmware linearly
  interpolates between consecutive keyframes at DAC write rate. A plain
  `CMD_STREAM UPDATE` still means "now, latest wins" and clears the ring.
- **`CMD_TRAJECTORY` (nibble `0x0E`)**: upload once (BEGIN, chunked DATA at
  12 samples per COBS frame, MARK, COMMIT), then START / STOP / DELETE. Up
  to 4 tables, 4096 samples total, 8 trigger markers per table. The MCU plays
  the table periodically (linear interpolation wrapping across the period, or
  step/hold), fires markers through the same capture engine as `CMD_FRAME`,
  and pushes one 44-byte `TrajectoryFrame` (`id, marker, cycle, status,
  FrameResult`) per trigger as a `SYN`. Statuses: OK, STROBE_TIMEOUT, BUSY,
  CANCELLED, ENDED. A running trajectory owns the DAC: stream updates and
  keyframes are refused until STOP, and the mirror holds its last position
  afterwards until the next stream write.
- Host: `StreamHandle.scheduleAt`, `Controller.uploadTrajectory` (handle with
  `start`, `stop`, `dispose`, `onFrame`), and a generic `Device.onPush` in
  core for non-LOG pushes.

### Controller node routing (`docs/spec/controller.md`)

- Position inputs gain `updateAt(hostNs, pos, { interpolate })`, routed to
  `CMD_SCHEDULE` on 2.2 firmware with a counted immediate-update fallback.
  Mirror history records keyframes at their scheduled time; an immediate
  update that reaches the wire truncates pending history.
- `node.openTrajectory(spec, { name })` owns one trajectory at a time, shares
  the enable lifecycle with position inputs, holds position pushes while a
  run is active and resends the latest pose when it ends, detaches on
  controller unbind (re-upload is the session's call), and forwards OK pushes
  to the FIN sinks as tagged `FrameOutcome`s while feeding mirror history at
  exposure time.

### MirrorLink

A MirrorLink session never touches the raw `Controller`. It goes through the
controller node (`docs/spec/controller.md#trajectory-ownership`):

1. `const t = await controllerNode().openTrajectory({ samples, periodUs,
   markers, step }, { name: "mirrorlink" })`. This needs a bound v2.2
   controller. The node enables the mirrors if they are off and refuses a
   second open.
2. `controllerNode().onFin(...)` is usually already wired to the anchor node
   (the multi-fovea pattern). Every OK marker push arrives there as a
   `FrameOutcome` tagged `trajectory: { id, marker, cycle }`, so pairing and
   recording run unchanged. `t.onFrame(cb)` sees every push, including
   `STROBE_TIMEOUT` / `BUSY` / `ENDED`, for the session's own phase
   bookkeeping.
3. `await t.start(atHostNs, cycles)`. Pass an explicit host instant so the
   node's lateness telemetry is exact. Position inputs the session (or
   another) has open are held while the trajectory runs.
4. `await t.stop()` / `await t.close()` (close also DELETEs the table). On
   `onStateChange("detached", { controllerAvailable: true })` after a
   reconnect, call `t.reupload()` and `start` again. That re-upload is the
   session's decision, not automatic.

Mirror history is fed from the pushes (exposure-averaged position at
exposure time), so downstream homography/undistort consumers keep working
while the MCU owns the DAC.

### Serial link throughput (`docs/spec/serial-protocol.md#pipelining`)

- Teensy 4.0 USB CDC is a 480 Mbit/s high-speed link; the 115200 "baud" is
  a no-op on it. The budget is latency and per-packet overhead, not bits.
- The native `Device` already pipelined requests by sequence number. What
  actually throttled the link: a default "fairness reserve" that dropped
  every stream update while any request was pending (starving the mirror
  behind every two-phase frame), bursts larger than the kernel tty queue
  silently losing requests, and 1 ms rate floors in both JS and native code.
  All fixed: fairness off by default, a bounded TX tail queue with rejection
  instead of loss, host floor 0.2 ms (tunable), governor ceiling 5 kHz.
- The practical cap is now the producers: the app clamps `prediction_rate_hz`
  to 1000 Hz and JS pacers tick at 1 ms. Raising that is an app follow-up.

## Status

### Done on `feat/controller-v0.1`, verified without hardware

| Area | Verification |
|---|---|
| Board pin map, dual-bus DAC driver, enable order, pad control | Host simulator compiles the real firmware sources and decodes the bit-banged DAC waveform; `fw-sim-check` 16 stages pass |
| Non-isolated camera lines, polarity constant, center camera | `fw-sim-check` stages 8 and 9; `core/test/50` rewritten and un-quarantined; bench-verified 2026-10-22: LineInverter=true |
| Protocol 2.2.0 schedule + trajectory, firmware engines | `fw-sim-check` stages C1 to C4 (keyframe timing, interpolation, 10-cycle trajectory with marker pushes, hold/stop) |
| Serial pipelining and rate limits | `fw-sim-check` stage D; `core/test/52` |
| Core packet factories, `onPush`, boolean/integer camera feature setters | Written against the Aravis 0.8 / NAPI patterns; validated only on stub-linked builds |
| Host camera-line programming, controller node routing, telemetry | App suite 141 files, 1540 tests; process-boundary gates; VitePress docs build |
| Teensy core API names used by the new firmware | Checked against the PaulStoffregen/cores Teensy 4 headers: every macro exists, no trajectory op name collides |

### Pending: needs the bench or a full build machine

1. **Flash and compile on target.** PlatformIO's registry was unreachable from
   the development container, so no Teensy cross-compile has run. First build
   validates the DAC driver's inline asm and register types, the trajectory
   engine's `DMAMEM` placement, and whether `analogWrite` on the FCLK pin
   rewrites the pad register (if so, the FCLK drive setting is lost after
   `tone()`).
2. **Build the core addon** on a machine with Aravis and OpenCV; the new
   `Controller.cpp` (packet factories, `onPush`, TX tail queue) and
   `Camera.cpp` (boolean/integer setters) code is unbuilt there. Then run
   `core/test/47`, `49`, `50`, `51`, `52` against the simulator.
3. **Camera lines.** Line3 trigger at 3.3 V and Line2 strobe polarity
   bench-verified 2026-10-22 on one BFS-U3-16S2C (L port): host
   `LineInverter=true`, 20/20 FINs, trigger→exposure 14–16 µs. Still owed:
   the R and C ports, and the opto pair's polarity.
4. **DAC bus.** Scope SCLK on both buses at the 10 MHz default: rate, duty,
   bus-to-bus skew, ringing versus the pad drive setting. Confirm whether the
   Mirrorcle board ties the AD5664R LDAC pin low (then outputs update per
   frame rather than on the final APPLY; still correct, less simultaneous).
   Only then consider raising `MEMS::SPI::SCLK_HZ`.
5. **Enable sequence** on real drivers: MEMS_EN raised after DAC init, bias
   and FCLK; VDD at `J_SPI` pin 3 under load (>= 4.85 V).
6. **Strobe/trigger timing** on the rig: `STROBE_MARGIN_US` (5 ms) and the
   real Line3 input delay versus the opto path it replaces.
7. **Open items from the board repo** (`pcb/specs.md` §12): J_CAM pins 5/6
   both on board GND, fan selection, AD5664R timing limits from the ADI
   datasheet.

### Follow-ups, not blocking

- Raise the app's `prediction_rate_hz` clamp (1000 Hz) and JS pacer tick now
  that the DAC path sustains far more.
- Wire a MirrorLink session onto `controllerNode().openTrajectory` (the API is
  in place; no session uses it yet).
- Regenerate `pcb/board/pins.h` firmware notes in the DuoController repo to
  describe Line3 trigger / Line2 strobe.
