# The rig

> Source of truth for constants: `app/lib/camera-config.ts`,
> `app/orchestrator/controller.ts`, `firmware/`.

## Cameras

Three GigE (Aravis) cameras: **L**/**R** foveal (behind the MEMS mirrors) and
**C** center wide. Roles map to serials in the camera config; the
orchestrator's registry leases them per-serial (Aravis is per-process
exclusive — `architecture/processes.md`).

- **Hardware triggering:** all three cameras — C included — are hardware
  triggerable on the V0.1 controller board (J_CAM0 = C, J_CAM1 = L, J_CAM2 =
  R). A `CMD_FRAME` with no camera mask still triggers only L and R; C is
  captured when the host asks for it.
- **GPIO wiring (V0.1):** all four FLIR GPIO lines (plus opto GND and GND)
  are cabled 1:1 on every camera. Triggering uses the **non-isolated** lines:
  **Line2** is the trigger input and **Line3** the ExposureActive strobe
  output (no opto edge lag, a real 3.3 V logic level both ways). The opto
  pair (Line0 in / Line1 out) stays cabled as a bench fallback only.
- **Strobe polarity:** `Board::STROBE_ACTIVE_LEVEL` (HIGH — ExposureActive
  with LineInverter off) is the one constant the firmware keys exposure
  start/finish on; if the bench shows the line inverted, that constant flips
  and nothing else. A strobe REJ reading `Strobe timeout: line stuck at
  active level` means the line never returned to idle — wrong polarity, or
  Line3 not set to ExposureActive. Not yet scope-verified on the bench.
- **Line3 / VAUX safety:** Line3 doubles as the camera's 8-24 V VAUX power
  input and a Teensy pin is 3.6 V abs. max. The controller pin on Line3 is
  an input from boot and is never driven (enforced at compile time in
  `firmware/src/Capture.cpp`). Never power a camera through VAUX on this
  board (`pcb/board/bringup.md` step 9).
- **Controller side:** `firmware/include/Board.h` `camera[]` entries are
  controller-directional — `trigger` (Teensy OUTPUT → camera Line2),
  `strobe` (Teensy INPUT_PULLUP ← camera Line3), plus the unused
  `opto_trigger` (→ Line0) / `opto_strobe` (← Line1).
- 12-bit readout formats are supported end-to-end in code (preview-safe
  option filtering); live A/B requires the full hardware rig.

## MEMS controller

Serial device (USB); protocol in `architecture/serial-protocol.md`. v2
firmware adds position streams + synced frame capture (FIN carries the
exposure-averaged mirror voltage). `verifyVersion()` decides v1/v2 at
connect; v2-only surfaces are gated on `v2Capable`.

## Bench flow

Firmware flashing + bench verification precede rig sessions (PlatformIO,
`firmware/`). Hardware verification runs the pre-flight and playbook passes,
exports profiler snapshots as the baseline, and works through the remaining
hardware-gated checks.
