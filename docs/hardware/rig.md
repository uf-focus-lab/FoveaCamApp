# The rig

> Source of truth for constants: `app/lib/camera-config.ts`,
> `app/orchestrator/controller.ts`, `firmware/`.

## Cameras

Three GigE (Aravis) cameras: **L**/**R** foveal (behind the MEMS mirrors) and
**C** center wide. Roles map to serials in the camera config; the
orchestrator's registry leases them per-serial (Aravis is per-process
exclusive — `architecture/processes.md`).

- **Hardware triggering:** only L and R are cabled for hardware trigger. The
  center camera's CAM0 port is reserved on the controller board but no cable
  currently fits (camera-side connector size constraint) — recoverable with a
  slimmer cable. Until then C free-runs.
- **GPIO wiring (L/R):** ONLY the opto-isolated pins + opto-GND are
  physically cabled — the non-isolated lines float. On the FLIR line map
  that is **Line0** (opto input — the trigger) and **Line1** (opto output —
  the ExposureActive strobe), which is exactly what
  `@orchestrator/camera-trigger` programs by default; a non-isolated line
  name can never work on this rig. Note the opto input wants the MCU pulse
  within its voltage spec and adds µs-scale edge lag — irrelevant at the
  ms-scale pulse widths `pairTriggerBudget` derives.
- **Controller side:** `firmware/include/Board.h` `camera[]` pairs are
  controller-directional — `trigger` (Teensy OUTPUT → camera Line0),
  `strobe` (Teensy INPUT ← camera Line1).
- 12-bit readout formats are supported end-to-end in code (preview-safe
  option filtering); live A/B requires the full hardware rig.

## MEMS controller

Serial device (USB); protocol in `architecture/serial-protocol.md`. v2
firmware adds position streams + synced frame capture (FIN carries the
exposure-averaged mirror voltage). `verifyVersion()` decides v1/v2 at
connect; v2-only surfaces are gated on `v2Capable`.

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

## Bench flow

Firmware flashing + bench verification precede rig sessions (PlatformIO,
`firmware/`). Hardware verification runs the pre-flight and playbook passes,
exports profiler snapshots as the baseline, and works through the remaining
hardware-gated checks.
