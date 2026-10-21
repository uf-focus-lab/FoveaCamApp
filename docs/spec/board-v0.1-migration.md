# Controller board V0.1 migration — design brief

> Working brief for the firmware/core/app adaptation to the FoveaCam Duo Driver
> V0.1 board (`pcb/` submodule = uf-focus-lab/DuoController master, tag
> v0.1.2). Decisions here are binding for every workstream until revised;
> `firmware/include/Board.h` is the pin-level source of truth and
> `pcb/board/pins.h` the generated board map it mirrors.

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

## Fixed decisions

### Pins and lines (`Board.h`)

| Function | Teensy pin | Note |
|---|---|---|
| DRV1 (left) CS / SCLK / MOSI | 2 / 3 / 4 | CS plain GPIO; SCLK=FlexIO1 D05, MOSI=D06 |
| DRV2 (right) CS / SCLK / MOSI | 9 / 12 / 11 | SCLK=FlexIO2 D01, MOSI=D02 |
| MEMS_EN (shared) | 6 | LOW through reset; raise last, drop first |
| FCLK (shared) | 10 | PWM, 60x cut-off |
| CAM0 (C) L2 trig / L3 strobe | 18 / 16 | opto pair 17 / 19 unused |
| CAM1 (L) L2 trig / L3 strobe | 22 / 20 | opto pair 21 / 23 unused |
| CAM2 (R) L2 trig / L3 strobe | 14 / 5 | opto pair 13 / 15 unused; 13 is the LED |

- Trigger = camera **Line2** (Teensy OUTPUT). Strobe = camera **Line3**
  (Teensy INPUT, pull-up). Line3 pins are inputs from boot and are never
  driven (VAUX safety, `pcb/board/pins.h`).
- `Board::STROBE_ACTIVE_LEVEL = HIGH` for the non-isolated ExposureActive
  output. Capture keys every edge decision on this constant, never on a
  literal. Bench verification pending; if the line turns out open-drain the
  constant flips, nothing else.
- Host (`app/orchestrator/camera-trigger.ts`) programs `TriggerSource=Line2`,
  `LineSelector=Line3, LineMode=Output, LineSource=ExposureActive`,
  `LineInverter=false`. The old opto defaults (Line0/Line1) remain selectable
  for a bench fallback, not the default.
- All three cameras are triggerable: `CAM_C` is a valid mask bit; the
  "no strobe cable" REJ goes away on firmware and in the core typings.
- No LED anywhere in firmware.

### MEMS bus and enable sequence

- Two buses, written **concurrently** (both mirrors' frames go out in the
  same time window), SCLK ≥ 10 MHz target (AD5664R max 50 MHz; the board
  recommends 10 MHz until measured, so make the clock a single build-time
  constant with 10 MHz default and headroom to 20+).
- Per position update send the minimum frames: 3× `WRITE_IREG` + 1×
  `APPLY_IREG` (write n, update all) per device, so the four channels of
  both mirrors change in the same instant. No stray delay bytes between
  frames; SYNC high between frames per the AD5664R.
- Pad control on SCLK/MOSI/CS: DSE 1..3, SRE slow, SPEED 0; FCLK DSE 1, SRE
  slow (IOMUXC SW_PAD_CTL via `portControlRegister(pin)`). FOVEA_HOST_SIM
  builds compile this away.
- Enable order (Mirrorcle guide p27): DAC init words (RESET, INT_REF,
  DAC_POWER, LDAC_SETUP), Vbias on all channels, FCLK running, **then**
  MEMS_EN HIGH. Disable in reverse: MEMS_EN LOW, bias to neutral, FCLK off.
  Today `Protocol.cpp` raises the rail first — fix it.
- The 1 Hz `MEMS::refresh()` re-assertion stays (cheap insurance) but must
  not disturb a scheduled position write.
- The host fw-sim must keep working: whatever bus driver replaces `SPIClass`
  gets a host shim that still emits `dac cs=<L|R|LR> <hex>` lines so
  `fw-sim-check`, `core/test/47`, `49`, `50` keep their contract (two buses
  may now emit two `cs=L`/`cs=R` lines where one `cs=LR` broadcast used to).

### Protocol: timestamped streams and uploaded trajectories

Two complementary mechanisms, both in the MCU `Global::time` µs clock domain
(same as `SYS_TIMESTAMP` / `FrameResult`, converted host-side through the
existing clock calibration). Version → **2.2.0** (backward-compatible
additions; old firmware REJects the unknown properties). Host gates on
`>= 2.2.0`.

**1. `CMD_SCHEDULE` (nibble `0x0D`) — real-time timestamped keyframes.**
For closed-loop control (disparity-scope PID, tracking) where the host keeps
computing targets but wants them applied at an exact instant rather than on
arrival. SET, fire-and-forget friendly (seq 0 → silent). Payload, packed:
`uint8_t stream; uint8_t flags; uint64_t t_apply; MirrorPosition left;
MirrorPosition right;` = 26 bytes. Firmware keeps a per-stream time-ordered
keyframe ring (depth ≥ 32); `Streams::tick()` applies the keyframe whose
`t_apply` ≤ now and, with `flags & INTERPOLATE`, linearly interpolates between
consecutive keyframes at DAC write rate. A late keyframe applies at once; one
older than the last applied is dropped and counted. Plain `CMD_STREAM UPDATE`
keeps meaning "now, latest wins" and clears the stream's schedule.

**2. `CMD_TRAJECTORY` (nibble `0x0E`) — uploaded periodic trajectory with
trigger markers (MirrorLink).** The mirror runs a pre-computed periodic
pattern and cameras are triggered at exact phases of it. Uploading once and
running on the MCU removes the per-sample serial traffic entirely: steady
state is zero bytes host→MCU and one small push MCU→host per trigger.

- SET ops in one packet type (`op` byte + union), ACK/REJ-backed:
  `BEGIN {id, sample_count, period_us, flags}` allocates a table;
  `DATA {id, first_index, n, samples[n]}` chunks (`sample = uint32 t_offset_us
  + MirrorPosition left + right`, 20 bytes; chunk size from
  `COBS::MaxPacketSize`); `MARK {id, marker_index, t_offset_us, cameras,
  pulse_us}` places a trigger inside the period (≥ 8 markers per table);
  `COMMIT {id}` validates (offsets monotonic and < period, every sample
  present) and seals; `START {id, t_start (0 = now), cycles (0 = forever)}`;
  `STOP {id}` (mirror holds its last position); `DELETE {id}`.
- Playback: at time `t`, cycle `k = (t - t_start) / period`, phase `φ = (t -
  t_start) mod period`; the DAC follows the table at φ (linear interpolation
  between samples by default — the whole point is smooth, fast motion; a
  flag selects step/hold). A marker fires its trigger when φ crosses its
  `t_offset_us`, once per cycle, through the Capture engine so strobe
  tracking, exposure-averaged positions and timeouts are the same code path
  as `CMD_FRAME`.
- Results are pushed, not request-bound: `SYN CMD_TRAJECTORY` with payload
  `TrajectoryFrame { uint8_t id; uint8_t marker; uint32_t cycle; FrameResult
  result; }` (the stream field of `FrameResult` carries the trajectory id's
  stream slot; `frame_id` stays the firmware-monotonic counter). A strobe
  timeout pushes the same packet with a `flags`/status byte marking it failed
  rather than a REJ (there is no request to reject).
- Capture engine seam: requests gain an `origin` (host seq vs. trajectory
  marker) and a completion sink, so `Capture.cpp` stays the single
  trigger/strobe state machine. Stream B owns `Capture.cpp` for the camera
  line work; stream C adds only this seam and coordinates by keeping it a
  small, additive change.
- A running trajectory owns the DAC: `CMD_STREAM`/`CMD_SCHEDULE` targets are
  REJected (or ignored for seq 0) while one runs; `STOP` returns control.
- Sizing: Teensy 4.0 has 1 MB RAM; budget ≥ 4096 samples total (64 KB at
  16 B + 4 B offset) across ≤ 4 tables; make the constants `constexpr` in one
  place and REJ with a clear reason past them.
- Host (`app/orchestrator/controller.ts`): `uploadTrajectory({samples,
  periodUs, markers})` returning a handle with `start(atHostNs?, cycles?)`,
  `stop()`, `dispose()`, and an `onFrame(cb)` event fed by the SYN pushes
  (core `Device` must dispatch non-LOG SYN packets to a JS callback — check
  what exists for LOG and generalise). Also `StreamHandle.scheduleAt(hostNs,
  pos, {interpolate})` for mechanism 1.
- Docs: `docs/spec/serial-protocol.md`, `docs/architecture/serial-protocol.md`.

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

### Serial link throughput

- Teensy 4.0 USB CDC is a 480 Mbit/s high-speed link; the 115200 "baud" is
  a no-op on it. The budget is latency and per-packet overhead, not bits.
- Audit `core/src/Controller.cpp` `Device`: requests must be pipelined —
  many in flight, matched by `seq`, with no per-request await serialising
  the writer. Remove or justify any point where a write waits for a previous
  ACK. Fire-and-forget (seq 0) stream updates must never queue behind an
  awaited request.
- Revisit `STREAM_MIN_UPDATE_INTERVAL_MS = 1` and the AIMD governor
  defaults against the new DAC throughput; raise what the device can take,
  keep what protects the device loop.

## Workstreams (parallel, one worktree each)

| ID | Scope | Owns |
|---|---|---|
| A | MEMS dual-bus driver, pad control, enable sequence, sim shim | `firmware/include/MEMS*.h`, `firmware/src/MEMS.cpp`, enable/disable in `firmware/src/Protocol.cpp`, `test/fw-sim/shim/SPI.h`, `test/fw-sim/hal.cpp` SPI part, `firmware/platformio.ini` |
| B | Camera lines: non-iso trigger/strobe, polarity constant, center camera, sim strobe injection, tests | `firmware/src/Capture.cpp`, Trigger handler in `Protocol.cpp`, `test/fw-sim/main.cpp` strobe part, `core/test/50-strobe-polarity.ts`, `core/test/run.mjs`, `lib/Protocol/Packet.h` CAM_C comment, `core/dist/Controller/index.d.ts` camera typing |
| C | Timestamped keyframes + uploaded trajectories end to end | `lib/Protocol/*` (new properties + version), `firmware/include/Streams.h`, `firmware/src/Streams.cpp`, new `firmware/{include,src}/Trajectory.*`, new handlers in `Protocol.cpp`, dispatch rows in `Firmware.cpp` + sim `main.cpp`, additive origin/sink seam in `Capture.{h,cpp}`, `core/src/Controller.cpp` packet defs + SYN dispatch, `core/dist/Controller/index.d.ts`, `app/orchestrator/controller.ts` scheduleAt/uploadTrajectory, docs |
| D | Serial pipelining audit + fix, rate limits | `core/src/Controller.cpp` transport/pending path, `app/orchestrator/controller.ts` gate constants, `controller-node.ts` update path, `docs/spec/serial-protocol.md` section |
| E | Host camera-line config + hardware docs | `app/orchestrator/camera-trigger.ts` + tests, `docs/hardware/rig.md`, `docs/manual/manage-cameras.md`, `docs/architecture/serial-protocol.md` §5 |

Shared files touched by more than one stream (`Protocol.cpp`, `Firmware.cpp`,
sim `main.cpp`, `controller.ts`, `Controller.cpp`, `index.d.ts`): add, don't
reshape; keep edits local to your own handler/section so merges stay trivial.
