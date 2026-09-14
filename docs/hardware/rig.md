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
- **Dashed-ring readout.** Point at a blinker of KNOWN frequency and confirm the
  on/off pattern along the ring matches it (count the dashes per revolution
  against `blink_hz / scan_hz`).
- **Decode a known message.** Drive the emitter with the ring-code frame
  (`docs/spec/ring-code.md`) for a known short string at a cycle equal to the
  scan period. Both fovea readouts must show that string, the fitted circle and
  leader arc must sit on the ring, and the measured `px/chip` must match
  `C / chips` (ring circumference over the frame's chip count). Walk the message
  length up until `below resolution` appears — that is the rig's real emitter
  budget; record it against the `C / (1.5·d)` prediction.

## Bench flow

Firmware flashing + bench verification precede rig sessions (PlatformIO,
`firmware/`). Hardware verification runs the pre-flight and playbook passes,
exports profiler snapshots as the baseline, and works through the remaining
hardware-gated checks.
