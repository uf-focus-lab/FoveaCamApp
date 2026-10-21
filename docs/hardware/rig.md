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
  | 1 | Line3, non-isolated (also VAUX in) | 16 / 20 / 5 | camera → Teensy (INPUT_PULLUP) | **strobe** (ExposureActive) |
  | 2 | Line0, opto input | 17 / 21 / 13 | Teensy → camera | bench fallback only |
  | 3 | Line2, non-isolated | 18 / 22 / 14 | Teensy → camera (OUTPUT) | **trigger** |
  | 4 | Line1, opto output (open collector) | 19 / 23 / 15 | camera → Teensy (INPUT_PULLUP) | bench fallback only |
  | 5 | opto GND | board GND | | |
  | 6 | GND | board GND | | |

  Pins 5 and 6 both landing on board GND is the board designer's reading of
  the FLIR pinout and is still marked TODO in `pcb/board/specs.md` §4.
  Check it against the FLIR GPIO diagram.
- **Camera programming (host):** `enableHardwareTrigger`
  (`app/orchestrator/camera-trigger.ts`) writes, in order:
  `LineSelector=Line2`, `LineMode=Input`; `TriggerSource=Line2` (Aravis also
  sets `TriggerMode=On`, `TriggerSelector=FrameStart`,
  `TriggerActivation=RisingEdge`); then `LineSelector=Line3`,
  `LineMode=Output`, `LineSource=ExposureActive`, `LineInverter=false`. The
  cameras do this themselves when a session engages, so a camera's saved
  config does not need to be set up by hand. A trigger source that the
  camera does not list in `trigger_source_options` is refused with the list
  it does offer. Caveat: `LineInverter` is a GenICam boolean, and the
  current native `setFeature` binding (`arv_camera_set_string`) can only
  write string and enumeration nodes. Until the binding gains a boolean
  writer, that write is best-effort and the camera default (`false`) has to
  hold. The engage diagnostics span records the live line state.
- **Polarity:** the non-isolated ExposureActive output on Line3 is read
  **active HIGH** (`LineInverter=false`, firmware
  `Board::STROBE_ACTIVE_LEVEL = HIGH`). It is not yet verified on the bench.
  Scope one camera's `J_CAMn` pin 1 during a triggered exposure before the
  first synced capture. If the line turns out to idle HIGH and pull LOW,
  change the firmware constant. Nothing on the host side changes. The
  strobe pin has a pull-up, so an unplugged cable or a camera whose Line3
  was never programmed reads HIGH, which looks like a permanent exposure
  rather than an idle line.
- **Line3 / VAUX safety:** Line3 is also the camera's 8–24 V auxiliary
  power input (VAUX), and on this board it is wired straight to a Teensy
  pin with a 3.6 V absolute maximum and no protection. **Never configure a
  camera to put VAUX on Line3**, and never power a camera through its GPIO
  cable. The only host configuration for Line3 is the 3.3 V ExposureActive
  output above. The firmware keeps the Line3 pins as inputs from boot and
  never drives them. Likewise, Line2 must stay an input on the camera
  (the host forces `LineMode=Input`), because the Teensy drives it. If the
  camera model offers a 3.3 V power output on Line2 (FLIR `V3_3Enable`),
  leave it off. Plug in the ground pins (5, 6) before any signal line, as
  FLIR warns.
- **Opto pair (bench fallback):** Line0/Line1 stay cabled but are not used.
  The opto output (Line1) is open-collector and can only pull LOW, so its
  ExposureActive reads **active LOW** at the Teensy. To use the pair,
  program the cameras with
  `enableHardwareTrigger(lease, { triggerSource: "Line0", lineSelector: "Line1", lineInverter: true })`
  (the inverted line idles LOW and reads HIGH during exposure, matching
  `STROBE_ACTIVE_LEVEL`), or build the firmware with
  `Board::OPTO_STROBE_ACTIVE_LEVEL`. The firmware must also pulse the opto
  trigger pins instead of Line2. The opto input wants the MCU pulse within
  its voltage spec and adds µs-scale edge lag. That lag does not matter at
  the ms-scale pulse widths `pairTriggerBudget` derives.
- **Controller side:** `firmware/include/Board.h` `camera[]` is indexed in
  the `Packet::Command` camera-mask bit order (0 = C, 1 = L, 2 = R). Its
  pin pairs are named from the controller's side: `trigger` (Teensy OUTPUT
  → camera Line2) and `strobe` (Teensy INPUT ← camera Line3), plus the unused
  `opto_trigger` (→ Line0) and `opto_strobe` (← Line1).
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
   it covers C too. Scope the Line3 strobe polarity before the first synced
   capture.
4. **Rig verification:** hardware verification runs the pre-flight and
   playbook passes, exports profiler snapshots as the baseline, and works
   through the remaining hardware-gated checks.
