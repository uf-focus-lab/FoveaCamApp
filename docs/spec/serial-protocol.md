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
entirely). Used by high-rate MirrorStream updates (multi-kHz — see
[rate limits](#rate-limits)); never queued behind an awaited request
([pipelining](#pipelining)).

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

## pipelining and in-flight limits {#pipelining}

**Short answer: no command waits for the previous command's ACK.** Requests are
pipelined: any number can be in flight, each one is matched to its response by
`Sequence`, and a seq-0 stream UPDATE is written at once, never behind an
unanswered request. That was already mostly true of the native transport before
board V0.1. What actually limited the link were rate floors, a stream "fairness"
deferral, and how a burst larger than the kernel queue failed. Each hop is
described below, with what was true before the V0.1 work and what is true now.
Symbols are named rather than given as line numbers, which drift.

### hop by hop

| Hop | Before (d238edd) | Now |
|---|---|---|
| JS `Controller` (`app/orchestrator/controller.ts`) `set`/`get`/`frame`/`StreamHandle.update` | Each call writes synchronously through the native `Device` and returns its promise. Nothing queues on an ACK. Only `ready` awaited its four config requests one by one, costing 4 RTT at connect. | Same, and `ready` writes disable, bias, LPF and log level back to back with `Promise.all`. Wire order is the call order, so Enable(false) still lands before Bias. |
| native `Device` (`core/src/Controller.cpp`) `DeviceObject::send` | Registers a `PendingRequest` (keyed by seq, with its own ACK/FIN futures), writes it, and returns. Nothing waits. | Unchanged in shape. `sequence()` now skips values still pending, because a 16-bit wrap could otherwise overwrite a parked two-phase or zombie entry and hand its late response to the new request. |
| shared `SerialWriteSeam` (same file) | One mutex held for one non-blocking `::write`, never across a wait. A short write was tailed, but the tail only flushed on the **next** write, so a lone request could sit half-sent until the 30 s sweep. A frame that could not start was dropped, and for a request the synchronous throw was **eaten**: the still-live `PendingRequest`'s destructor cleared the pending JS exception, so the caller got a bare `undefined`. Measured against the sim with the pre-change build: a 3000-request burst into a frozen device gave 860 promises and **2140 `undefined`**. | Two write policies. **Reliable** (ACK-backed requests): a full kernel queue appends the whole frame to the seam tail (`kTailCap` = 256 KB), and the rx thread polls `POLLOUT` while the tail is non-empty and drains it (`drainTail`). The same 3000-request burst now gives 3000 promises, all fulfilled in order. Past the cap, or on a hard fd error, the request's own promise **rejects** ("TX queue full"), so a failure is never silent. **LatestWins** (seq 0): a frame that cannot start is dropped and counted in `txSoftFail` (the governor's backoff signal). A LatestWins frame never overtakes a queued request. |
| rx thread `DeviceObject::rxLoop` / `handleRawPacket` | `poll` + `read` of 256 B chunks, COBS-decode, match by seq, then dispatch the settle task to the JS thread. Retirement happened after the dispatch, so `inFlight` could briefly count a settled request. | The entry is retired before the dispatch. The pending sweep runs on every wake (it limits itself to once per second) instead of only on idle timeouts. |
| POSIX fd (`core/src/Serial.cpp`) | `O_NONBLOCK`, raw 8N1, no `tcdrain`, one `write` per frame (no coalescing). `cfset*speed(115200)` was given the integer rather than `B115200`, which fails with EINVAL on Linux. That was harmless: see below. | `B<rate>` constants. Still no coalescing: each request is one URB, which is cheap on high-speed USB. |
| native MirrorSink gate (`MirrorSink::push`) | **Fairness reserve ON** (`fairnessMs` 5, `maxDeferMs` 100). While any request had been pending for 5–100 ms, every native stream UPDATE was dropped. In trigger-sync capture a two-phase `CMD_FRAME` waits exposure-long for its FIN almost continuously, so the mirror stream was starved behind it. Hard 1 ms floor (`kMinIntervalNs`), 1 kHz ceiling. | Reserve **OFF by default** (`fairnessMs` 0 means off) and still settable. On a FIFO, full-duplex link a request is already on the wire, or queued ahead of every later frame, when it becomes pending, so updates written after it cannot delay it or its response. The floor is now `minIntervalUs`, default 200; see [rate limits](#rate-limits). |
| firmware `loop()` (`firmware/src/Firmware.cpp`) | Each iteration drains every byte `Serial.available()` reports, and each handler (`Protocol.cpp`) answers synchronously from inside `handle()`. Stream UPDATEs only stage the target. `Streams::tick()` commits the latest one to the DAC once per iteration, so a burst coalesces and the last one wins. | Unchanged. Verified: see the tests below. |

### the in-flight limits that do exist

These limits are physical or firmware-level. None of them is an ACK wait in the
transport. Each is enforced by a fast REJ, not by blocking:

- **One Actuate, one Trigger in flight** (`HANDLE_SET(Command::Actuate)` /
  `(Command::Trigger)`, [two-phase](#two-phase)). An overlapping request is
  REJected.
- **CMD_FRAME**: at most one pending frame per stream ("Stream already has a
  pending frame request"), and 1 active + 8 queued in total (`Capture.cpp`
  `QUEUE_CAPACITY`). The host `RoundRobinFrameScheduler` (`scheduler.ts`) keeps
  to both: one request per stream (`activeStreams`), and `maxInFlight` ≤
  `FRAME_QUEUE_CAPACITY`. Requests on *other* properties are not affected by a
  pending frame.
- **v1 firmware only**: `ControllerNode.ensureV1Loop` (`controller-node.ts`)
  runs one awaited `actuate()` at a time, because v1 has no streams and
  REJects an overlapping Actuate. On v2 every input is a fire-and-forget
  stream.
- **Blocking firmware handlers**: `System::Enable` holds the loop for about
  1 ms (rail settle `delay(1)`) plus the MEMS init words; `System::Reset`
  SOFT/HARD waits 100 ms and then reboots. These run on connect, disconnect
  and recovery only.
- **Device→host back-pressure**: a firmware `Serial.write` stalls only if the
  host stops reading. The rx thread reads continuously.

### transport: USB CDC, not a UART

The Teensy 4.0 is a 480 Mbit/s high-speed USB CDC-ACM device. The "baud"
(115200 in `SerialOpen`, `Serial.begin(115200)`) is a no-op: bytes move at USB
speed. Nothing may assume UART timing such as 87 µs per byte at 115200. Never set
134 baud, which Teensy treats as "reboot to the bootloader". What a packet costs
is per-packet latency, not bits:

- **Wire size:** a CMD_STREAM UPDATE is 4 B header + 18 B payload, plus 1 B COBS
  overhead and a 0 delimiter, for **24 B**. A payload-less GET is 6 B, and a
  Timestamp ACK is 14 B. 5 kHz of UPDATEs is 120 KB/s, about 0.2 % of
  high-speed USB.
- **Host→MCU:** one bulk OUT transfer per `write` (512 B max packet),
  scheduled within one 125 µs microframe.
- **MCU→host:** Teensyduino's `usb_serial` coalesces TX until its flush
  timer (about 75 µs, `TRANSMIT_FLUSH_TIMEOUT`; not checked against the
  installed core), then the next IN token. A pipelined burst of responses
  shares USB packets.
- **RTT:** derived as about 0.15–0.5 ms on hardware. Not yet measured on the
  V0.1 rig; `Device.stats.ackRttMs` reports it live. In the simulator (pty, 50 µs
  loop sleep) it measures 0.16–0.28 ms.

### measured / derived per-packet cost

- **Host + sim, pipelined** (core test `51` §1): 128 GETs issued back to back take
  about 1.5–3.5 ms, against about 21–36 ms awaited one at a time. That is about
  12–25 µs per request of host and simulator handling, against one RTT each.
  `fw-sim-check` stage D (wire-level, no core addon): 128 GETs pipelined take
  about 1–4 ms against about 23 ms sequential. GETs issued behind a pending
  two-phase FRAME ACK about 0.2–0.4 ms later, while that FRAME's FIN arrives at
  about 60 ms.
- **Firmware per UPDATE** (derived for a 600 MHz Cortex-M7):
  - The byte loop costs 24 × `Serial.read()` at about 60–100 cycles each, so
    about 2.4–4 µs.
  - COBS RX, the XOR checksum, two small heap copies (`RX::pop`, `RawPacket`),
    `inflate` and `Streams::update` add about 0.5–1 µs.
  - That gives **about 3–5 µs per UPDATE packet**. A bulk `Serial.readBytes`
    would cut the byte loop several-fold; this is a possible firmware
    follow-up, not needed for the limits below.
- **DAC commit** (once per loop iteration, latest-wins):
  - Old bus: 9 words × 32 clocks at 2 MHz is 144 µs, so **about 150 µs**.
  - V0.1 (workstream A): 4 frames × 24 clocks per device, with both buses
    concurrent, is 96 clocks: **about 10 µs** at 10 MHz and about 5 µs at
    20 MHz.

### rate limits {#rate-limits}

The firmware loop can sustain one DAC-committed update per
`decode + commit + loop overhead`:

| DAC bus | per committed update | sustained ceiling |
|---|---|---|
| 2 MHz shared (old) | 4 + 150 + 1 µs | about 6.4 kHz |
| 2 × 10 MHz (V0.1 default) | 4 + 10 + 1 µs | **about 65 kHz** |
| 2 × 20 MHz | 4 + 5 + 1 µs | about 100 kHz |

Anything faster than the loop rate is not an overload: UPDATEs coalesce, and only
the newest target is committed. So the host-side floor protects loop *duty*, the
share of the MCU loop spent on updates, which sets the timing jitter of
`Capture::tick`, `Protocol::tick` and the strobe path:

- **Floor = 0.2 ms (5 kHz)**: `STREAM_MIN_UPDATE_INTERVAL_MS` (JS gate) and
  `GovernorParams::minIntervalUs = 200` (native gate). At the 10 MHz bus that is
  5 k × 15 µs ≈ **7.5 % duty**, half of what the old 1 kHz × 150 µs (15 %)
  cost. Even on the old bus, 5 kHz only coalesces. Tunable:
  `Controller.streamMinIntervalMs` is read live by the JS gate and handed to
  native sinks as `minIntervalUs` at creation, and `MirrorSink.setGovernor({
  minIntervalUs })` sets the native gate directly.
- **Governor** (`GovernorParams`): `ceilingHz` 5000 (= 1 / floor), `stepHz` 125
  (halving from the ceiling recovers in about 20 evaluations ≈ 2 s, as with the
  old 25 Hz step from 1 kHz). `floorHz` 60, `evalMs` 100, `outqLow`/`outqHigh`
  256/1024 B and `rttInflation` 2 are unchanged. It still halves on any
  `txSoftFail`, outq or RTT-inflation signal, which now includes Reliable
  request queueing, so it still protects the device under USB back-pressure.
  Its ceiling is not the bottleneck: the session lowers it to the producer's
  `prediction_rate_hz`.
- **What still caps the rate in practice:**
  - The producers. JS pacers tick on `setTimeout(1)`, so JS inputs run at
    ≤ 1 kHz.
  - The app's `prediction_rate_hz` clamp (60..1000, `app/lib/config-schema`)
    bounds the native IMM → compose → sink path.
  - Raising that clamp toward the 5 kHz floor is an app-level follow-up. The
    link and the firmware now allow it.

### tests

- `test/fw-sim-check.cpp` **stage D** (runnable, no addon): checks the firmware
  side of pipelining.
  - N requests are answered in seq order at about one RTT.
  - seq-0 UPDATEs interleaved with requests stay silent, and the last one wins.
  - Requests behind a pending two-phase FRAME are not held until its FIN.
- `core/test/51-serial-pipelining.ts` (core `Device` against the sim, which is
  frozen with SIGSTOP so in-flight counts are deterministic):
  - `stats.inFlight === N` while the sim is frozen, and all N resolve in seq
    order at about one RTT rather than N.
  - Fire-and-forget does not wait behind a pending GET or a two-phase FRAME.
  - A burst past the kernel queue queues (`stats.txQueuedBytes`) and drains
    with no follow-up write.
  - Overflow past the tail cap rejects; no request is lost.
- `core/test/46` §1 asserts that the reserve is off by default and checks the new
  defaults. §3 still exercises the opt-in reserve.
- `app/test/controller-pipelining.test.ts` checks the JS layer with every awaited
  request left unanswered.

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
  older firmware safely rejects `MEMS`.

## periodic MEMS config re-assertion {#mems-refresh}

While the system is enabled, `loop()` calls `Streams::housekeeping()` which — at
~1 Hz, cadenced off `Global::time` — re-sends the three IDEMPOTENT AD5664R setup
words (`DAC_POWER 0b1111`, `INT_REF_SETUP 1`, `LDAC_SETUP 0`) to BOTH mirrors via
`MEMS::refresh()`. It NEVER sends a RESET (that would zero the outputs) and NEVER a
value/bias write, so the mirror does not move — safe mid-capture. Each refresh
`touch()`es the active stream so targets re-commit within one tick. This converts a
corrupted-word DAC wedge from permanent into a ≤1 s glitch. No re-assertion
happens while disabled.

## disable {#disable}

`System::Disable` does NOT let streams survive. The MCU clock resets on the next
enable, invalidating any host-side clock-delta calibration anyway, so keeping stale
stream targets buys nothing. Disable cancels all in-flight/queued frame requests
(`Capture::cancelAll`), clears streams (`Streams::clear`), cancels pending
actuate/trigger, powers down MEMS, and drops the enable line.
