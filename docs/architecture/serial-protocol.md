# MEMS controller serial protocol

> Source of truth: `app/orchestrator/controller.ts` (host-side `Controller`),
> `core/Controller` (native `Device` + `Protocol`), `firmware/` (MCU),
> `app/orchestrator/scheduler.ts` + `sync.ts` (synced capture),
> `app/orchestrator/controller-node.ts` (the position-stream push model).

## 1. Device model

The orchestrator's `controller` session owns the serial `Device`
(`core/Controller`); other sessions actuate the SAME device via the
module-level `activeController()` holder. Connection setup runs
`verifyVersion()` first — old firmware keeps `v2Capable` false and every v2
surface hard-requires it (v1 compatibility never throws on a version
mismatch, only on transport failure).

Every serial write is metered (`controller:<port>` → `packets`,
`metering.md` §4).

## 2. v1 surface

Request/ACK commands: `Enable`, config (`Bias`/`LPF`/`Log`), `Actuate`
(4-channel DAC vector per mirror; the ACK echoes the actuated channels,
decoded back to volts via `dac2volt`), `Trigger`, `Reset`.

`Reset` (`SYS_RESET`) types: `SOFT`/`HARD` reboot the MCU. **`MEMS`
(protocol v2.1.0)** is a targeted DAC recovery — re-inits the AD5664R DACs in
place (full re-init incl. RESET) without a reboot or an enable-rail cycle, then
re-commits the active stream's targets, so a wedged right-fovea mirror
recovers without dropping the session — the host's "recover mirror" button.
REJects while disabled. The firmware ALSO re-asserts the idempotent MEMS
config words at ~1 Hz on its own while enabled, turning a corrupted-word DAC
wedge into a ≤1 s glitch.

## 3. v2 surface — streams and synced frames

- **CMD_STREAM** — a named, continuously-updatable mirror-position target
  (64 slots, `Streams::CAPACITY`). CREATE/TERMINATE are ACK-backed;
  **UPDATE is fire-and-forget** (seq=0, no response, multi-kHz-safe).
  Host-side `StreamHandle.update()` suppresses identical targets and enforces
  a min interval (default 0.2 ms, the live `Controller.streamMinIntervalMs`;
  the native sink's `minIntervalUs`) — derivation in
  `docs/spec/serial-protocol.md#rate-limits`. Requests are pipelined (many in
  flight, matched by seq; nothing waits for a previous ACK —
  `docs/spec/serial-protocol.md#pipelining`).
- **CMD_FRAME** — a triggered capture request on a stream. Two-phase:
  `.accepted` resolves on ACK (queue position; rejects on REJ), the request
  itself resolves on **FIN** carrying `frame_id`, MCU trigger/exposure
  timestamps, and the **exposure-AVERAGED mirror voltage** (sampled at
  exposure start AND finish) — the authoritative frame↔voltage binding the
  recorder stores (`recorder.md` §1). `sync.ts` pairs L/R FINs by timestamp.
- **FW5 (firmware constraint):** never mix awaited `Actuate` writes with an
  active stream — `Streams::snapshot()` would report the stream target
  rather than the DAC's actual state. A control loop owns its stream
  exclusively while running.
- **CMD_SCHEDULE (protocol v2.2.0)** — timestamped keyframes on an existing
  stream: `StreamHandle.scheduleAt(hostNs, pos, { interpolate })` converts the
  host-steady instant to the MCU clock through the controller's calibrated
  offset (the inverse of the FIN decode) and sends it fire-and-forget. The
  firmware applies each keyframe at its MCU time from a 32-deep per-stream ring,
  optionally ramping linearly between keyframes at DAC write rate, so serial
  jitter no longer lands in the motion. `update()` still means "now, latest
  wins" and clears pending keyframes. Spec: `docs/spec/serial-protocol.md#schedule`.
- **CMD_TRAJECTORY (protocol v2.2.0) — MirrorLink.** For a periodic motion
  with captures at fixed phases, even timestamped streaming wastes the link:
  every sample crosses the wire, and each frame needs its own CMD_FRAME round
  trip whose trigger instant still depends on host scheduling.
  `Controller.uploadTrajectory({ samples, periodUs, markers })` uploads the
  table once (ACK-backed, 12-sample DATA chunks pipelined) and the MCU plays it
  back on its own clock: the DAC follows the table at phase `(t − t_start) mod
  period` and each marker fires the cameras through the same capture engine as
  CMD_FRAME (strobe tracking, exposure-averaged positions, timeout) when the
  phase crosses it. Results come back as pushes (`SYN CMD_TRAJECTORY` →
  `Device.onPush` → `handle.onFrame`, decoded like `FrameOutcome`), so the
  steady state is zero bytes host→MCU and one small push per trigger. A running
  trajectory owns the DAC (stream UPDATE / SCHEDULE are refused); `stop()`
  holds the last position until the next stream write. Spec:
  `docs/spec/serial-protocol.md#trajectory`.
- Both v2.2.0 surfaces are gated on firmware `>= 2.2.0`
  (`Controller.v22Capable`); older firmware REJects the unknown properties.

## 4. The actuation path (controller node, push model)

The singleton **controller node**
(`app/orchestrator/controller-node.ts`) owns the actuation path: each
hot-actuating session calls
`node.openPosition(name, { from, initial })` and PUSHES target poses at its
own natural cadence (kernel result / pointer / servo tick). On v2 firmware
each open position input maps 1:1 to a CMD_STREAM (created on first update,
`StreamUpdateGate`-dedup'd fire-and-forget `update()` per push — no awaited
round-trip caps the rate — publishing **locally predicted** volts via
`Controller.predictVolts(pos)`, the exact `channels()`→`dac2volt` math the
Actuate ACK would echo; the MCU stream holds position between pushes). On v1
it runs one internal paced awaited `actuate()` loop over the latest pushed
pose. Enable lifecycle: enable on first open if disabled, disable on last
close iff the node enabled it; streams drop + lazily recreate on controller
reconnect. `update()` also records the predicted trajectory into
mirror-history (the single trusted-time writer). Prediction accuracy (vs a
sampled readback) and FW5 coexistence with CMD_FRAME require verification on
the full hardware rig.

## 5. Hardware triggering

All three cameras are hardware-triggerable on the V0.1 controller board
(`docs/hardware/rig.md` §Cameras): each camera's GPIO cable lands on a
`J_CAMn` socket, the MCU drives the trigger on camera **Line2** and reads
the ExposureActive strobe back on camera **Line3** (active HIGH,
`Board::STROBE_ACTIVE_LEVEL`). The opto pair (Line0/Line1) stays cabled as
a bench fallback only.

- **Camera mask.** `CMD_FRAME`'s `cameras` bitmask follows the
  `firmware/include/Board.h` `camera[]` order: `CAM_C` = 1, `CAM_L` = 2,
  `CAM_R` = 4. `CAM_C` is a valid bit. The host always sends an explicit
  mask, because an absent mask is NAPI-encoded as 0 rather than the
  firmware default. The trigger-sync and multi-fovea sessions send
  `["L", "R"]` (for trigger-sync, the `PAIR_CAMERAS` default of
  `frameRequestFromBudget`). Adding
  C is the calling session's choice: it also has to put C into trigger
  mode and budget the pulse on C's exposure. `CMD_TRIGGER` (the bare pulse
  the Manage Cameras trigger test uses) pulses every camera's trigger line.
- **Camera side.** The MCU only pulses lines. Each triggered camera has to
  be switched into FrameStart-triggered mode with its strobe output
  programmed, through `enableHardwareTrigger`
  (`app/orchestrator/camera-trigger.ts`): `LineSelector=Line2`,
  `LineMode=Input`; `TriggerSource=Line2`; `LineSelector=Line3`,
  `LineMode=Output`, `LineSource=ExposureActive`, `LineInverter=false`.
  `disableHardwareTrigger` returns it to free-run and leaves the line
  config in place. Never put a camera in the mask before its trigger is
  enabled. A camera that is not in trigger mode does not expose on the
  pulse. Its strobe then follows free-run exposures (the Line3 config is
  still in place), or reads as active all the time: an unprogrammed Line3
  is an input, so the Teensy pull-up holds it HIGH. Either way, the FIN
  does not describe a triggered exposure.

Wire-level framing — packet layout, seq/ACK/REJ/FIN encoding, CRC — lives in
`core/src/Controller.cpp` and `firmware/include/`.
