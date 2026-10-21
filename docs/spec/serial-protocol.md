# serial protocol — firmware handler behavior

The wire format (COBS framing, packet header byte layout, Method/Property tables,
`Sequence` semantics) is the CONTRACT and lives at `lib/Protocol/Protocol.h` +
`lib/Protocol/Packet.h` — that is the authoritative source, not this file. This
spec records the FIRMWARE-side runtime behavior in `firmware/src/Protocol.cpp`
that isn't visible from the wire headers. Version history: `lib/Protocol/Version.h`.
The code carries `// spec:` pointers.

## fire-and-forget {#fire-and-forget}

`Sequence == 0` marks a fire-and-forget request: the firmware performs the action
but sends NO ACK/FIN/REJ. `Protocol::send()` short-circuits on `seq == 0` (only
applies to responses routed through that helper — LOG SYN pushes bypass it
entirely). Used by high-rate MirrorStream updates (~1kHz).

## two-phase actuate/trigger {#two-phase}

`Command::Actuate` and `Command::Trigger` are two-phase: an immediate ACK, then a
FIN after a timed delay, instead of blocking in `delayMicroseconds()`.
`Protocol::tick()` (called from `loop()` alongside `Streams::tick()` /
`Capture::tick()`) advances the completion timers and emits the FIN when
`now >= due`. Only ONE of each may be in-flight at a time — an overlapping second
request is REJected instead of silently queued (it matches the physical constraint
that a second request cannot arrive until the first's delay elapses). Callers
wanting overlap use `CMD_STREAM`.

Pending actions are cancelled (REJected) on `System::Disable`.

## clock semantics {#clock}

The MCU clock (`Global::time`, wraparound-corrected uint64 µs) is the same clock
that stamps `FrameResult` `t_trigger` / `t_exposure`. Every clock mutation is
EXPLICIT:

- `System::Enable` (v1.1): enabling does NOT reset `Global::time`. An implicit
  reset here would silently invalidate the host's controller clock calibration on
  every enable, breaking the "timestamps between nodes are always trusted"
  invariant.
- `System::Timestamp SET` is the ONLY clock reset (`Global::time.reset(payload)`,
  normally 0). After it, any host-side offset calibration is invalidated and must
  be re-run.
- `System::Timestamp GET` is the calibration ping: it stamps the clock FIRST, at
  packet parse/handle time (`handle()` dispatches synchronously as the request
  leaves the COBS decoder), never at reply-serialization time, so the reading's
  jitter stays at the serial-latency floor.

## reset / DAC recovery {#reset}

`System::Reset` (`SYS_RESET`) carries a one-byte `Type`:

- `SOFT` (0) / `HARD` (1): reboot the MCU. Single-phase — ACK, a 100 ms grace
  delay, then the reset (breakpoint / `_reboot_Teensyduino_`). No FIN.
- `MEMS` (2), **v2.1.0**: targeted DAC recovery for the right-fovea freeze. Re-runs
  the full `MEMS::enable()` re-init — **intentionally including the AD5664R software
  RESET** — to unwedge a DAC latched into power-down, but does NOT cycle the
  `Board::enable` rail or clear the stream table, so the live session survives.
  Afterwards `Streams::touch()` marks the active stream dirty and the next
  `Streams::tick()` re-commits the current targets. Single-phase ACK (echoes
  the type). **REJects** if the system is not enabled. Unknown types REJ, so an
  older firmware safely rejects `MEMS`. The re-init train is unchanged
  (`0x280001`, `0x380001`, `0x20000F`, `0x300000`, bias `WRITE_UPDATE_DAC`
  all-channels); since the V0.1 board each word goes out on BOTH DAC buses in
  the same lockstep frame, and the re-commit is the normal position update
  (per mirror 3× `WRITE_IREG` A/B/D + 1× `APPLY_IREG` C — see
  `hardware/rig.md` § MEMS bus).

## periodic MEMS config re-assertion {#mems-refresh}

While the system is enabled, `loop()` calls `Streams::housekeeping()` which — at
~1 Hz, cadenced off `Global::time` — re-sends the three IDEMPOTENT AD5664R setup
words (`DAC_POWER 0b1111`, `INT_REF_SETUP 1`, `LDAC_SETUP 0`) to BOTH mirrors via
`MEMS::refresh()` — the same word on both DAC buses in lockstep, 3 frames
(~7.3 µs at the default 10 MHz SCLK). It NEVER sends a RESET (that would zero the outputs) and NEVER a
value/bias write, so the mirror does not move — safe mid-capture. Each refresh
`touch()`es the active stream so targets re-commit within one tick. This converts a
corrupted-word DAC wedge from permanent into a ≤1 s glitch. No re-assertion
happens while disabled.

## disable {#disable}

`System::Disable` does NOT let streams survive. The MCU clock resets on the next
enable, invalidating any host-side clock-delta calibration anyway, so keeping stale
stream targets buys nothing. Disable cancels all in-flight/queued frame requests
(`Capture::cancelAll`), clears streams (`Streams::clear`), cancels pending
actuate/trigger, then powers down in the reverse of the enable order (Mirrorcle
guide p27/p31): drops the driver enable line (MEMS_EN) first, parks the DACs at
V_BIAS, and stops FCLK. Enable runs DAC init + V_BIAS, starts FCLK, and raises
MEMS_EN last.

## camera lines and strobe polarity {#camera-lines}

`CMD_FRAME` (and the legacy `CMD_TRIGGER`) drive the cameras through
`Board::camera[]` (`firmware/include/Board.h`, V0.1 board). Index `i` is
`CameraMask` bit `1 << i`: 0 = C, 1 = L, 2 = R.

- **Lines.** All four FLIR GPIO lines are cabled on all three cameras.
  Triggering uses the non-isolated pair: `trigger` (Teensy OUTPUT) drives
  camera **Line2**, asserted HIGH for `pulse` µs; `strobe` (Teensy
  `INPUT_PULLUP`) reads camera **Line3**, which the host programs as
  `ExposureActive`. The opto pair (`opto_trigger` → Line0, `opto_strobe` ←
  Line1) stays cabled but is never driven or read by Capture.
- **Polarity.** `Board::STROBE_ACTIVE_LEVEL` (HIGH for the non-isolated
  ExposureActive output, host `LineInverter=false`) is the level `strobe`
  reads while the camera exposes. Capture keys every edge on it: exposure
  start = line becomes asserted (latches `t_exposure` + the start position),
  exposure finish = line becomes released (latches the finish position). A
  request FINs once every requested camera has been asserted and released
  again. Changing the polarity means changing that one constant
  (`OPTO_STROBE_ACTIVE_LEVEL = LOW` documents the opto shape); nothing on the
  wire changes.
- **Timeout.** No complete assert/release within `pulse + 5 ms` → REJ with a
  reason starting `Strobe timeout`. If a requested line still reads asserted
  at that point the reason says `line stuck at active level` — the signature
  of a polarity mismatch or a camera whose Line3 is not set to
  ExposureActive (the pull-up then holds the line HIGH).
- **Camera mask.** `cameras` may be any non-empty subset of `CAM_C | CAM_L |
  CAM_R`; `0` means `CAM_L | CAM_R` (pre-V0.1 behavior: C is captured only
  when asked for). Other bits REJ (`Invalid camera mask`). Strobe ISRs run on
  all three cameras; edges from a camera outside the request are ignored.
- **Line3 safety.** Line3 is also the camera's 8-24 V VAUX power input and a
  Teensy pin is 3.6 V abs. max: `strobe` is an input from boot and is never
  written (`Capture.cpp` static-asserts that `strobe` and the opto pins are
  not output Pins, and `Board::Pin::write()` cannot compile on an input).
  Never power a camera through VAUX on this board.
