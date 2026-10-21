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

## timestamped keyframes — CMD_SCHEDULE {#schedule}

**v2.2.0**, property nibble `0x0D`. For closed-loop control (disparity-scope PID,
tracking) where the host keeps computing targets but wants each one applied at an
exact MCU instant rather than on arrival.

Payload (`Packet::Command::Schedule`, packed, 26 bytes, `static_assert`ed):

| offset | field | type | meaning |
|---|---|---|---|
| 0 | `stream` | u8 | an existing `CMD_STREAM` id |
| 1 | `flags` | u8 | bit 0 `INTERPOLATE` |
| 2 | `t_apply` | u64 | MCU µs (`Global::time`, the `SYS_TIMESTAMP` domain) |
| 10 | `left` | MirrorPosition | 4 × u16 DAC words |
| 18 | `right` | MirrorPosition | 4 × u16 DAC words |

Semantics (`firmware/src/Streams.cpp`):

- Each stream owns a time-ordered keyframe ring, `Streams::SCHEDULE_DEPTH = 32`
  deep (stable insertion, so equal `t_apply` keeps arrival order; monotonic
  appends never shift).
- `Streams::tick()` (every `loop()`) pops every keyframe with `t_apply <= now`
  into the stream's target — latest wins. A **late** keyframe therefore applies on
  the next tick.
- While the ring's head keyframe carries `INTERPOLATE`, every tick writes the
  linear interpolation (per channel, round-to-nearest) between the **anchor** and
  the head into the target: the anchor is the previously applied keyframe (its
  `t_apply` and position) or — for a keyframe arriving into an EMPTY ring — the
  stream's current target at the arrival instant. The DAC is rewritten only when
  the interpolated word changes, so the ramp runs at DAC write rate.
- A keyframe **older than the last applied one** is dropped and counted; so is one
  arriving into a full ring. The cumulative counts are reported in a `WARN` LOG
  (rate-limited to one line per second) and readable firmware-side
  (`Streams::droppedStale()` / `droppedFull()`).
- `CMD_STREAM UPDATE` keeps meaning "now, latest wins" and **clears** the stream's
  ring (as do CREATE and TERMINATE). The schedule targets the stream, not the DAC:
  an inactive stream's target advances too and takes effect when it is activated.

Single-phase: ACK echoes the payload; `seq == 0` is fire-and-forget (silent —
drops are still counted). REJ reasons: `Cannot perform action: system is not
enabled`, `Unknown stream id`, `Schedule full (32 pending keyframes per stream)`,
`Keyframe older than the last applied one (dropped)`, `A trajectory owns the DAC
(STOP it first)`.

Host: `StreamHandle.scheduleAt(hostNs, pos, { interpolate })`
(`app/orchestrator/controller.ts`) converts host-steady ns to MCU µs through the
calibrated clock offset (`(hostNs - clockOffsetNs) / 1000`, rounded) and sends
fire-and-forget; gated on firmware `>= 2.2.0` (`v22Capable`).

## uploaded trajectories — CMD_TRAJECTORY {#trajectory}

**v2.2.0**, property nibble `0x0E`. The MirrorLink case: the mirror runs a
pre-computed periodic pattern and cameras trigger at exact phases of it. Upload
once, run on the MCU: steady state is zero bytes host→MCU and one small push
MCU→host per trigger.

### Wire layout

SET only, op-tagged and **variable size** (`Packet::Command::Trajectory`, not a
`FixedSizePacket`): byte 0 = op, byte 1 = table id, then the op's fixed fields.
Every op is single-phase; the ACK echoes the op's fixed header (DATA: without its
samples).

| op | struct (bytes) | fields after `op, id` |
|---|---|---|
| `BEGIN` 0 | `TrajectoryBegin` (9) | `u16 sample_count, u32 period_us, u8 flags` (`STEP` = 1) |
| `DATA` 1 | `TrajectoryData` (5) + n × 20 | `u16 first_index, u8 count`, then `count` × `TrajectorySample` |
| `MARK` 2 | `TrajectoryMark` (12) | `u8 marker, u32 t_offset_us, u8 cameras, u32 pulse_us` |
| `COMMIT` 3 | `TrajectoryRef` (2) | — |
| `START` 4 | `TrajectoryStart` (14) | `u64 t_start` (MCU µs, 0 = now), `u32 cycles` (0 = forever) |
| `STOP` 5 / `DELETE` 6 | `TrajectoryRef` (2) | — |

`TrajectorySample` = `u32 t_offset_us + MirrorPosition left + right` (20 bytes).
DATA chunks carry at most `Trajectory::CHUNK_SAMPLES = (COBS::MaxPacketSize − 4 −
5) / 20 = 12` samples, so a full chunk (249 bytes) fits one COBS frame.

Push: `SYN CMD_TRAJECTORY`, seq 0, payload `TrajectoryFrame` (44 bytes):
`u8 id, u8 marker, u32 cycle, u8 status, FrameResult result`. `status`: `OK` 0,
`STROBE_TIMEOUT` 1, `BUSY` 2 (capture engine busy at the marker phase — no
trigger; `result.t_trigger` = the marker's due time), `CANCELLED` 3 (system
disabled), `ENDED` 4 (finite run done). Run-level pushes (`ENDED`, and `CANCELLED`
when the run itself is cut) use `marker = 0xFF` (`NO_MARKER`). `result` is the
CMD_FRAME FIN payload with `result.stream` = the trajectory id and `frame_id` the
firmware-monotonic counter shared with CMD_FRAME.

### Limits (`firmware/include/Trajectory.h`, one place)

`MAX_TABLES = 4` (ids 0..3), `MAX_SAMPLES = 4096` total across tables (pool in
Teensy DMAMEM, 80 KB, first-fit), `MAX_MARKERS = 8` per table.

### Semantics (`firmware/src/Trajectory.cpp`)

- `BEGIN` allocates (or re-allocates) table `id`; `DATA` fills indices while the
  table is loading; `MARK` places a marker (`cameras = 0` clears it; allowed until
  START); `COMMIT` validates — every index present, offsets strictly increasing and
  `< period` — and seals. Uploading another table while one runs is allowed.
- `START` claims the DAC (`Streams::Owner::TRAJECTORY`). Before `t_start` the
  mirror pre-positions at phase 0. Then at time `t`: `k = (t − t_start) / period`,
  `φ = (t − t_start) mod period`; the DAC follows the table at `φ` — linear
  interpolation between neighbouring samples (wrapping last → first across the
  period boundary), or step/hold with `STEP`. `t_start` in the past joins the run
  in progress (only future marker phases fire).
- A marker fires when `φ` crosses its `t_offset_us`, once per cycle (only the
  latest crossing per marker counts — a stalled loop never bursts a backlog),
  through the Capture engine: the same strobe tracking, exposure-averaged
  positions (start/finish latches see the trajectory-driven DAC) and
  `pulse + STROBE_MARGIN_US` timeout as CMD_FRAME. It needs an idle engine; a
  marker that finds a host CMD_FRAME in flight pushes `BUSY`.
- A finite run ends holding phase 0 and pushes `ENDED`. `STOP` holds the last
  position. After either, the mirror stays put (`Owner::HOLD`, surviving the
  1 Hz MEMS refresh) until the next stream write — UPDATE, an applied keyframe,
  a CREATE that takes the DAC, or a CMD_FRAME activation — takes the DAC back.
- While a trajectory runs (armed or playing) it owns the DAC: `CMD_STREAM UPDATE`
  and `CMD_SCHEDULE` are REJected (`A trajectory owns the DAC (STOP it first)`;
  silent for seq 0). `DELETE` stops a running table first; deleting a free id is a
  no-op ACK. `System::Enable(false)` halts the run (`CANCELLED` push) and cancels
  an in-flight marker capture (`CANCELLED`); uploaded tables survive.

REJ reasons: `Trajectory id out of range (max 4 tables)`, `Trajectory is running
(STOP it first)`, `Trajectory needs at least one sample`, `Trajectory too long (max
4096 samples total)`, `Trajectory period must be > 0`, `Unknown trajectory flags`,
`Trajectory pool full (max 4096 samples total; DELETE a table)`, `Unknown
trajectory id (BEGIN first)`, `Trajectory already committed (BEGIN again to
reload)`, `DATA chunk must carry 1..12 samples`, `DATA chunk past the end of the
table`, `Marker index out of range (max 8 markers per table)`, `Marker offset must
be < period`, `Marker pulse must be > 0`, `Unsupported camera mask for a marker`,
`Trajectory incomplete: every sample index must be uploaded`, `Sample offset must
be < period`, `Sample offsets must be strictly increasing`, `Trajectory not
committed (COMMIT first)`, `A trajectory is already running (STOP it first)`,
`Cannot perform action: system is not enabled` (START), plus the per-op length
checks (`Bad BEGIN length`, `Bad DATA length …`, …) and `Unknown trajectory
operation`.

Host: `Controller.uploadTrajectory({ samples, periodUs, markers, step })` →
`{ id, start(atHostNs?, cycles?), stop(), dispose(), onFrame(cb) }`
(`app/orchestrator/controller.ts`), gated on `>= 2.2.0`. Core delivers the pushes
through `Device.onPush(Protocol.Command.TrajectoryFrame, cb)` — the generic
non-LOG SYN dispatch in `core/src/Controller.cpp`.
