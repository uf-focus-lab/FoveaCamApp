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

Only the L/R cameras are hardware-triggerable on the current rig — the
center camera's GPIO port is reserved on the board but uncabled
(camera-side connector size; recoverable with a slimmer cable —
`docs/hardware/rig.md`).

Wire-level framing — packet layout, seq/ACK/REJ/FIN encoding, CRC — lives in
`core/src/Controller.cpp` and `firmware/include/`.
