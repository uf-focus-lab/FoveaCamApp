# Controller & actuation nodes — behavior spec

Behavioral contracts for the MEMS controller thread node and its actuation model.
Source pointers are per section; the code carries only load-bearing invariants inline.

## Controller node {#controller-node}

Source: `app/orchestrator/controller-node.ts`

One long-lived singleton — the graph node id `nodeId.controller()` ("controller") —
created at orchestrator startup. It binds/unbinds the active `Controller` (serial
device) as the controller session connects/disconnects, so PID-node edges registered
before the device connects stay stable.

Native-free by construction: it takes injected FIN-sink seams and type-only
`Controller`/`FrameOutcome` imports, so sessions and vitest never pull the addon (same
idiom as `UndistortPipeSeam` / the scheduler's requester).

### Push actuation model (absorbs `startActuationLoop`)

`openPosition(name, { from, initial })` opens a position-stream input. Sessions push a
pose at their own natural cadence (kernel result / pointer / servo tick / paced timer);
the node transports it to the device:

- v2 firmware — each input maps 1:1 to an MCU `CMD_STREAM` (created lazily on first
  update against a live controller, `StreamUpdateGate`-gated fire-and-forget updates,
  terminated on close, recreated on a controller swap). Free-run DAC-follow is
  firmware-defined (CREATE drives).
- v1 firmware — ONE node-level paced loop awaits `actuate()` over the most-recent
  pushed pose (single-input assumption holds via app exclusivity today).

`update()` runs `predictVolts` + `mirrorHistory.record` (the ONE place for the
trusted-time trajectory) and returns the predicted volts synchronously — sessions use
the return for telemetry / homography feeders. Optional `onApplied(volts, actuateMs)`
delivers the v1 awaited readback. When no controller is bound the last predicted value
is returned (the mirror holds) and nothing is recorded.

### Scheduled inputs (v2.2.0 CMD_SCHEDULE) {#scheduled-inputs}

Sessions reach the protocol v2.2.0 surfaces through the node, never the raw
`Controller` (`docs/spec/serial-protocol.md#schedule`, `#trajectory`), so lifecycle,
mirror history and FIN routing keep one owner.

`input.updateAt(hostNs, pos, { interpolate })` is the timestamped sibling of `update()`:

- Routed to `StreamHandle.scheduleAt` when the bound controller is `v22Capable` and the
  input's MCU stream exists. Otherwise — v2.1 firmware, no stream yet (the first push
  creates it), a native input owns the wire, no controller — it falls back to `update()`
  (immediate) and counts it in `input.scheduleFallbacks`.
- Mirror history records the prediction at the SCHEDULED host time, because the history
  is "mirror position vs host time". A keyframe already due (`hostNs` ≤ now) applies on
  arrival and is recorded at send time. To make `mirrorAt` match the firmware:
  - Into an empty schedule (no recorded sample still in the future), a hold sample of
    the current position is recorded at now first. The firmware anchors an interpolated
    ramp at the arrival instant.
  - A step keyframe (no `interpolate`) also records the previous position at its own
    instant, so the history shows a step, not a ramp.
- Push keyframes in time order. One older than the newest recorded sample is still sent,
  but it is not recorded (the history ring is monotonic) and is counted.
- Ordering rule with `update()`: an immediate push SUPERSEDES pending keyframes, because
  the firmware clears the stream's ring on UPDATE.
  - Once the UPDATE has actually gone out (`StreamHandle.update()` returns true), the
    node drops every history sample newer than now (`MirrorHistory.truncateAfter`) and
    then records the pose at send time.
  - A gated or dropped UPDATE never reached the MCU. The schedule keeps running and its
    history stands.
  - When no recorded keyframe is still in the future, `update()` takes the unchanged
    legacy path: record at send time, then send.
- `c.pos` (`applyStreamedPos`) is not advanced for a future keyframe.

### Trajectory ownership (v2.2.0 CMD_TRAJECTORY, MirrorLink) {#trajectory-ownership}

`node.openTrajectory(spec, { name })` uploads `spec` (`Controller.uploadTrajectory`) and
resolves to the node's handle
`{ name, id, state, start(atHostNs?, cycles?), stop(), close(), onFrame(cb),
onStateChange(cb), reupload(), replace(spec) }`.

- **Gate.** It requires a bound `v22Capable` controller and rejects otherwise, like the
  v2 gate for streams. At most ONE trajectory is open: a second `openTrajectory` (even
  while the first is still uploading) is refused with an error and never queued. The
  firmware runs one at a time.
- **Enable lifecycle.** It shares the input bookkeeping. The node enables a disabled
  controller on open. It disables on the last close (position, native or trajectory)
  only if the node enabled the controller. A failed upload frees the slot.
- **States.**
  - `uploading` → `ready` ⇄ `running` → `detached` → `closed`.
  - `start()` enters `running` before START goes out. The run ends on a STOP ack, on
    the run-level `ENDED` push, or on `CANCELLED` (system disabled).
  - `start()` refuses while running, uploading, detached or closed.
- **Input holding.** While the trajectory is `running`, every position-input push
  (`update` / `updateAt`) is held locally. Nothing is sent (the firmware would REJ it)
  and nothing is recorded. The input returns its last predicted value.
  - When the run ends, each input re-takes the DAC with its latest pose: the held one,
    or its pre-run target. The node sends it as a FORCED UPDATE that bypasses the
    gate's dedupe, because the firmware HOLDs the trajectory's last position until the
    next stream write, even an identical one. The pose is recorded at send time.
  - START also drops any not-yet-due scheduled-keyframe history, since those keyframes
    no longer move the mirror.
  - Native inputs are not held. Their seq-0 UPDATEs are silently ignored by the
    firmware while the trajectory runs.
- **Reconnect.** On `unbindController`, or a `bindController` swap to another device,
  the handle goes `detached`. `onFrame` stops, `id` is null, and no wire traffic is
  sent (the table went with the device).
  - Re-upload is never automatic. A later bind reports
    `onStateChange("detached", { controllerAvailable })`, and the session decides
    whether to `reupload()` (same spec, back to `ready`) or `close()`.
- **Teardown.** `close()` STOPs a running trajectory and DELETEs the table. Both are
  best-effort: a dead device never throws out of `close()`. It then resumes the inputs,
  retires the graph input, and applies the disable-iff-we-enabled rule.
  - **Order matters for the idle pose.** The resume after STOP re-asserts each position
    input that is still OPEN. A session that closes its idle position input first and
    then stops (or closes) the trajectory leaves nothing to resume: the firmware HOLDs
    the trajectory's last position. A session that wants the mirror back at its idle
    input's pose (MirrorLink: the center) must stop the trajectory BEFORE closing that
    input. The node does not reorder this for the session.

**Replace (phase-continuous swap).** `replace(spec)` re-shapes the table without
stopping the scan. MirrorLink calls it on every steer drag or slider move, at most 10 Hz.

- **States.** It throws when the handle is `detached`, `closed` or `uploading`. From
  `ready` it is a plain re-upload: any period, and the handle stays `ready`. From
  `running` the period must match the current one, or it throws before anything is
  sent (stop, replace, start to change it). The state stays `running`: inputs stay held,
  nothing resumes, and the stats row and listeners carry over. The new spec is what a
  later `reupload()` sends and what lateness is scored against. `reuploads` in the
  stats row counts successful swaps since open.
- **Wire (`TrajectoryHandle.replace`, `controller.ts`).** The new spec is uploaded
  (BEGIN/DATA/MARK/COMMIT) to a FREE table id while the old one keeps running. Then
  the swap, ATOMIC FIRST:
  - **Atomic (firmware ≥ 2.2.1, `Controller.v221Capable`).** A single
    `START(new, t_start, cycles)` while the old table runs. The firmware accepts it iff
    the new table is committed, has the same period, and `t_start` equals the running
    table's recorded start to the µs; it then switches tables in place, keeping the
    phase clock and the marker crossing state (no HOLD, no push). A marker is never
    doubled; a marker the new spec moved BEFORE the swap phase first fires next cycle.
    It is attempted only when the run's anchor is exact: `start(atHostNs)`, or a "now"
    start after its first STOP/START pair has been ACKed. The pair sends the carried
    anchor explicitly, so the firmware's recorded `t_start` is that value from then on
    (`run.exact` becomes true). Before that, a "now" start's estimated anchor can never
    match, so its first replace goes straight to the pair.
  - **Fallback: the STOP/START pair.** On a REJ whose reason contains "already
    running" (the firmware did not take the atomic START: older semantics or a
    mismatch), and always below 2.2.1: `STOP(old)` and `START(new, t_start, cycles)`
    are written back to back, with no await between them, and both are awaited
    afterwards.
  - **Atomic START failures: REJ versus transport.** A REJ is the firmware's answer.
    The addon surfaces it as an `Error` carrying the firmware's reason text. A
    host-side failure (request timeout, the 30 s sweep of an unanswered request, an
    unexpected response, a decode error, a disconnect) carries some other message,
    and the device MAY have applied the START. `classifyTrajectoryStartError` counts a
    failure as a REJ only when its message is one of the firmware's START REJ texts
    (`firmware/src/Protocol.cpp` `Trajectory::SET`, `firmware/src/Trajectory.cpp`
    `start`, plus older firmware's unknown-packet REJ). Anything else counts as a
    transport failure. The handle then re-STARTs the OLD table at the carried
    `t_start` and `cycles`. That re-START is safe whichever table plays: if the new
    one took over, it is itself an atomic swap back (same period, same anchor). If
    neither plays, it joins the run in progress. If the old one still plays, the
    firmware REJects it "already running".

    | atomic `START(new)` | re-`START(old)` | outcome | `TrajectoryReplaceError` |
    |---|---|---|---|
    | ACK | — | swapped (`lastSwap = "atomic"`), `DELETE(old)` | — |
    | REJ "already running" | — | STOP/START pair (below) | per the pair |
    | any other REJ | — | nothing stopped; `DELETE(new)` and unroute it at once | `running: true` |
    | no REJ (transport) | ACK | the old table runs, phase-continuously. Serial order puts the lost `START(new)` before the re-START, so the new table is not live. It may have played briefly: its id is graced, then DELETEd | `running: true`, `replacement: { id, maybeLive: false }` |
    | no REJ (transport) | REJ "already running" | AMBIGUOUS: the old table (or, if `START(new)` is still pending on the device, soon the new one) is live. Nothing is queried and nothing is DELETEd. Both ids stay routed to the listener set; the new id stays reserved as a *sibling* with no grace deadline | `running: true`, `replacement: { id, maybeLive: true }` |
    | no REJ (transport) | fails otherwise | the run is over: best-effort `STOP(old)` and `DELETE(new)` (a DELETE halts a playing table), new id graced | `running: false` |

    A sibling is retired by the handle's next running swap. The atomic START works
    whichever of the two tables plays; the pair also STOPs each sibling. A plain
    re-upload retires it too. `stop()` STOPs the current table and every sibling;
    each sibling whose STOP is ACKed is graced and DELETEd. `dispose()` graces and
    DELETEs them.
  - `DELETE(old)` follows either way, best-effort. The handle's `id` getter then reads
    the new id, and `lastSwap` (`"atomic"` | `"stop-start"`, null before the first
    running swap; a plain re-upload leaves it) says which path landed. The listener
    set moves to the new id, and the new id's pushes reach it from START on.
- **Grace for the retired id.** Firmware STOP (and the atomic swap) only stops
  PLAYBACK. A marker capture already in flight finishes later and pushes with the OLD
  id, at the latest `pulse + STROBE_MARGIN_US` (5 ms, `firmware/src/Capture.cpp`)
  after its trigger. So after every swap the old id stays routed to the SAME listener
  set for `trajectoryGraceUs(old spec) = max(marker pulseUs) + 5 000 µs + 50 000 µs`
  (`app/orchestrator/trajectory-grace.ts`; 0 for a spec without markers, and no grace
  for a table that was never STARTed), measured on the host clock from the swap.
  - Inside the grace the id is not allocated to a new table: the next replace or
    upload takes the next free id. When every id is held or in grace, the allocation
    waits for the earliest grace to run out instead of failing at capacity.
  - Past the deadline a straggler for that id is dropped and the id is free again.
  - Only the listeners are kept: the run hook is not, so a retired id's run-level
    push never ends the current run.
  - `DELETE(old)` still goes out at once. The firmware's push for an in-flight
    capture carries the id copied into the capture request
    (`Capture.cpp finishActive` → `Trajectory::push`) and never looks the table up.
  - `dispose()` honors the grace too. The disposed handle's (now empty) listener set
    keeps the id for the grace, so a straggler reaches nobody, and in particular not
    the id's next owner.
  - **Per-id scoring in the node.** The node scores each OK push against the spec of
    the table that pushed it. It keeps one entry per retired id, so a second swap
    inside the first one's grace keeps both, each with its own deadline. The entries
    are set AT the swap: `TrajectoryHandle.replace(spec, { onSwap })` calls `onSwap`
    synchronously when the swap lands, with each retired id and the grace the
    controller applied. That is before `DELETE(old)` goes out and before `replace`
    resolves, so pushes in that window already score correctly. From that instant the
    new id scores against the new spec. Before it, any other id is the new table and
    scores against the in-flight spec. A handle without the hook is seen at resolve
    instead. A `TrajectoryReplaceError` with a `replacement` keeps that id scored
    against the replacement spec: for its grace, or, while it `maybeLive`, until the
    run ends.
- **Phase carry.** `t_start` and `cycles` are the run's original values. The firmware
  joins a past `t_start` in progress, so the mirror continues at the phase the old
  table was at. For `start(atHostNs)` that is the exact MCU value sent. A "now" start
  (`t_start = 0` on the wire) has no exact MCU instant, so the handle records the host
  clock at send time, converted to MCU µs. The carried phase is then approximate to
  the serial latency, and it relies on the calibrated clock offset.
- **Failures.** If the upload fails, the partial new table is DELETEd and its id
  freed. The old table keeps running and the error is rethrown. If `START(new)` of
  the pair is REJected after `STOP(old)` succeeded, the handle re-STARTs the old table
  at the same `t_start` and throws `TrajectoryReplaceError`. When that restart fails too, the
  error has `running: false`, and the node ends the run: inputs re-take the DAC. When
  `START(new)` of the pair failed without a REJ, the new table may have started, so
  its id is graced before the DELETE instead of being unrouted at once. The atomic
  START's failures follow the decision table above.
- **Concurrency.** On the controller handle, `start`, `stop` and `replace` run one at a
  time, in call order, on one chain. A replace issued while a `start()` still awaits
  its START ACK runs after it and sees the run, so it swaps the RUNNING table. Before,
  it took the not-running path and DELETEd the table being started. A `stop()`
  issued during a replace goes out after the swap. Only one replace may be queued or
  running per handle; a second call throws. `dispose()` marks the handle disposed and
  waits for the chain, and the ops still queued then refuse ("disposed"), so a replace
  queued before a dispose never uploads. The node-level `start()` → immediate
  `replace()` ordering is therefore safe. The node COALESCES: calls made while
  a swap is in flight collapse into one pending batch. The latest spec wins and is sent
  once the in-flight swap lands; intermediate specs are never uploaded, and every
  caller in the batch settles with that one swap. `stop()` waits for the in-flight swap
  and the batch pending ON ENTRY, then STOPs. A `replace()` issued after `stop()` was
  called, until it settles, is refused ("stopping"), like the session's pending-stop
  guard (`docs/spec/mirror-link.md`, Cancellation), so a steady stream of replaces
  cannot starve the STOP; once `stop()` resolved, a replace is a plain re-upload from
  `ready`. `close()` refuses every later `replace()` from the moment it is called
  ("closing"), rejects the pending batch, waits for the in-flight swap, then STOPs and
  DELETEs.

**FIN routing.**

- Every push reaches the handle's `onFrame`.
- An `OK` push is also forwarded to the registered FIN sinks (`onFin` → the anchor
  node). It goes as a `FrameOutcome` with `stream` = the trajectory id (the firmware's
  `result.stream`) and the extra `trajectory: { id, marker, cycle }` tag. Pairing and
  recording consume it unchanged, and a consumer that keys on stream ids tells the two
  sources apart by the tag.
- Non-OK statuses (`STROBE_TIMEOUT`, `BUSY`, `CANCELLED`, `ENDED`) go to `onFrame`
  only. They are logged at most once per status per second (`RateLimitedLog`).
- **History feeding.** Each OK push records its exposure-averaged position at its
  exposure host time (`tExposure`). While the MCU owns the DAC, that is the only
  trustworthy mirror position.

**Graph and telemetry.** While a trajectory is open:

- The graph shows a `controller/trajectory` node (kind `trajectory`) with an edge into
  `controller` on port `name`.
- `node.trajectorySnapshot()` (`TrajectoryStat`, published as the controller session's
  `trajectory` telemetry) reports:
  - id, state, running, period, marker count;
  - cycles seen, per-status push counts, last marker / cycle;
  - held pushes;
  - `reuploads` and `lastSwap` (`"atomic"` | `"stop-start"` | null), the kind of the
    last running swap;
  - `lastLatenessUs`, the lateness of the last OK push: `t_trigger` −
    (`t_start` + cycle·period + marker offset). It is exact only when `start(atHostNs)`
    named the instant (`latenessExact`). A "now" start uses the host's send-time
    estimate, so the figure includes the serial latency. The start instant is held in
    host ns under the offset in force at the start and re-based by the difference when
    a re-ping moves `Controller.clockOffsetNs`, so the figure never steps with it.
- `node.statsSnapshot()` adds the per-input hold/schedule counters.

### Enable lifecycle

Enable on first update against a live disabled controller (tracked `enabledByUs`);
disable on last close IFF we enabled it — never disable a controller the user enabled
via the title bar. A reconnect drops the streams and lazily recreates them; it NEVER
calls disable on a vanished/swapped controller. The hardware-quiescence invariant
(disable-on-disconnect in `sessions/controller.ts` + the janitor) is the sole owner of
that path, and this node must not bypass it.

### Native position input {#native-position-input}

A session pipes a native volts
producer (the compose brick's `volt_out`) into the sink's `pos_in` whenever one
attaches. Attach requires a bound v2 controller — the node creates the MCU stream
(ACK-backed) + native sink lazily on open or on a later `bindController`, and detaches
(sink released + stream TERMINATEd best-effort) on unbind/close. Enable/disable
lifecycle matches the JS inputs (enable on attach, disable iff we enabled when the last
input — JS or native — closes), so FW5 + hardware quiescence hold identically.

### Trigger capture

`startTriggerCapture` schedules round-robin `CMD_FRAME` (the pure, tested
`RoundRobinFrameScheduler`, `scheduler.ts`) and forwards each FIN outcome to the
registered FIN sinks (`onFin`) — the anchor enrichment node (`anchor-node.ts`). Per-frame
L/R pair matching is owned by the native root PairStream: the brick tolerance-matches raw
camera arrivals against the FIN anchor on its own thread. `sync.ts`
`matchPair`/`matchesExposure` remain as the pure-JS reference (unit tests keep them).

## PID node {#pid-node}

Source: `app/orchestrator/pid-node.ts`

A graph-visible PID controller node: control math that would otherwise run inline in a
module (e.g. disparity-scope's `stepVergence`) becomes a first-class node in the stream topology.
It consumes an upstream analysis result (e.g. the scope's projected fovea centers) and
produces a command for a downstream node (the MEMS `controller/<port>`). This is NOT
per-frame JS work — it runs scalar controllers at the upstream RESULT rate, so the
thin-coordinator rule holds: the node forwards a final result, it does not micro-manage
frames.

Two responsibilities beyond holding PIDs:

1. Topology — on creation it registers a `registerGraphWiring` entry (the graph-wiring
   shim) so the node + its scope→pid and pid→controller edges show in the profiler
   graph; `dispose()` retires it. `report()` returns the equivalent `NodeReport`.
2. Override — a renderer-driven slot (`usePidOverride` proxy → module command → here)
   that PINS the output. Semantics: while engaged, `step()` SKIPS the control fn
   and RESETS every named controller each tick (state held at zero, so windup can't
   accumulate behind the override); the output IS the override value. On `release()`
   the caller-supplied `seed(lastOverride)` reseeds the controllers from the last
   override — with the velocity-form integrator that gives output CONTINUITY (no jump),
   reproducing "resume control from where the drag left the mirrors".

## Homography feeder {#homography-feeder}

Source: `app/orchestrator/homography-feeder.ts`

While a triple session is active, each L/R homography undistort brick needs a steady
stream of `{hostNs, H}` samples in its native ParamRing so the undistort thread can warp
every frame with `H(mirrorAt(frameHostNs))`. This helper runs a modest fixed-rate timer
(~200 Hz — well under the ring's ~1 kHz design ceiling, dense enough that the ring's
linear interpolation between neighbors tracks the ~1 kHz actuation trajectory) that:

1. reads the newest mirror sample from the orchestrator-wide `mirrorHistory` (written by
   the controller node's update path),
2. derives H for its side via the injected `computeH` seam,
3. pushes it via `Aravis.pushHomography(pipeId, hostNs, h9)` with hostNs = the SAMPLE's
   time (not push time) — the brick matches frames against when the mirror was there.

`computeH` returning null = no push (empty history, uncalibrated rig, or a
deliberately-unwired v1 seam) — the brick meters `passthrough`. Everything is injected
(history/clock/push) so vitest drives the cadence with fake timers and never loads core.

## Prediction-compose reference {#compose-reference}

Source: `app/orchestrator/compose-node.ts`

The prediction-compose feed-forward math, kept as the JS CONFORMANCE REFERENCE. The
compose is the native `ComposeStream` brick (core/src/ComposeStream.cpp) piped imm →
compose → controller, and
its per-tick math must reproduce this function on the shared vectors
(docs/schema/codec/compose-vectors.json) — the same TS-reference pattern as
`@lib/imm-predictor` for the IMM brick.

The form is `V(t) = V_pid + J·(p_pred(t) − p_meas(t_pid))`. This reference expresses
`J·Δp` as the difference of a pixel→volt map evaluated at both points
(`predVolts − measVolts`) — for the LINEAR map the native brick receives (the session's
finite-difference Jacobian at `p_meas`), the two forms are identical, which is exactly what
the fixture pins.

## Serial-latency compensation {#serial-latency}

Source: `app/orchestrator/serial-latency.ts`

The per-triple `delay_compensation_ms` is a FIXED lookahead; the serial hop's contribution
varies with queue depth / host load. With the pressure sensors it becomes adaptive:
`serialLatencyMs = EMA(ackRttMs.p50) / 2` (one-way ≈ half the ACK round trip; EMA smoothing
so RTT jitter never whips the predictor). The disparity-scope session polls the estimate at
its stats throttle and pushes `imm.setParams({ delayMs: fixed + (enabled ? latency : 0) })`.
Gated by the GLOBAL `serial_latency_comp` config key (default OFF). Off / no controller / no
RTT samples yet = byte-identical fixed behavior. Vue-free (store-hub read/subscribe); the EMA
is a pure class, unit-tested.

## Anchor enrichment node {#anchor-node}

Source: `app/orchestrator/anchor-node.ts`

A JS, FIN-rate (low, loop-safe) middle node. Each completed controller exposure (FIN
`FrameOutcome`) becomes ONE stage-independent anchor — its exposure time + stream + the
enrichment attachments (exposure-averaged volts, the V2A angles, and the per-side homography
H) — pushed to EVERY registered pairing brick. One anchor source feeds all stages; the native
brick treats the attachments as an OPAQUE `Float64Array` payload and echoes it back in the
pair record, so the RECORDER (a downstream consumer) unpacks them JS-side. Native-free by
construction (same idiom as controller-node.ts): the pairing bricks are injected as a small
`PairAnchorSink` seam and the volts→angle→H math via the triple's `CoordinateConversions`, so
vitest drives it with a fake calibration and never loads the addon.

## Mirror history {#mirror-history}

Source: `app/orchestrator/mirror-history.ts`

Short memory of mirror positions vs host time. The fovea/L-R undistort homography needs the
mirror position AT THE FRAME'S (past) exposure time — commands are issued up to ~1 kHz while
frames arrive at ~60 fps, so the orchestrator keeps a small ring of `{hostNs, left, right}`
and answers `mirrorAt(hostNs)` with linear interpolation between the two neighbors. Writers
(controller-node.ts — the ONE trajectory place): every SENT position update records its
`predictVolts` result; the v1 awaited `actuate()` path records the readback; a scheduled
keyframe (`updateAt`) records at its apply time and an immediate update that supersedes
it truncates the not-yet-due samples (`truncateAfter`); a running uploaded trajectory's
OK pushes record their exposure-averaged position at `tExposure`
(see [scheduled inputs](#scheduled-inputs), [trajectory ownership](#trajectory-ownership)). Honesty note:
these are COMMANDS — the physical mirror follows with LPF group delay (~1.3 ms at the
120 Hz LPF) + settle; triggered captures should prefer the FIN exposure-averaged voltage when
present.

## Prediction-rate setting {#prediction-rate}

Source: `app/orchestrator/prediction-rate.ts`

The GLOBAL prediction-rate setting, orchestrator side: ONE app-wide key `prediction_rate_hz`
(default 600, clamped 60..1000) that drives the native IMM brick's free-running emit rate.
Edited from BOTH Settings → Global config AND the disparity-scope drawer slider — they write
the SAME `["config"]` document, so the session subscribes here and live-applies via
`imm.setParams({ rateHz })`. Vue-free (store-hub read/subscribe, mirroring anaglyph-style) —
imported by a session, so it must not pull `@lib/config` (Vue). The doc path, default, and
clamp bounds are the shared Vue-free `@lib/config-schema` constants (same ones `@lib/config`'s
AppConfig defaults consume), so the renderer and this reader can never drift.

## Controller clock sync {#clock-sync}

Source: `app/orchestrator/sessions/controller.ts` (`startControllerClockSync`),
`Controller.setClockOffsetNs` / `noteClockPingMissed` / `clockCalibrated`.

The MCU↔host offset is calibrated by the JS-driven `System.Timestamp` ping
(`pingControllerOffset`, 10 bracketed reads, min-filter). The controller session starts
the sync on connect and stops it on disconnect:

- One round at once, then one every `CLOCK_REPING_INTERVAL_MS` = 30 s, the cameras'
  re-latch cadence. Rounds never overlap.
- Each round is RACED against `CLOCK_PING_TIMEOUT_MS` = 3 s. Pre-v1.1 firmware REJects
  the unknown property with seq 0, which is dropped, so the read would otherwise hang
  until Device teardown.
- A landed round writes the `controller` calibration row (drift ppm vs the previous
  one) and swaps the offset in with `setClockOffsetNs`. The swap is atomic for outcomes
  decoded after it; FIN and push timestamps already surfaced keep the offset they were
  decoded with. A run anchor already sent to the MCU (`t_start`, MCU µs) is unaffected.
- **`Controller.clockOffsetNs`** is a read-only getter for the installed offset (host
  ns at MCU µs 0, `0n` before calibration). A consumer that holds a host-ns view of an
  MCU-anchored instant, such as MirrorLink's scan start for lateness, re-bases it by
  the difference after a re-ping. Pushes decoded after the swap use the new offset.
- **`Controller.clockCalibrated`** is true once a round landed. It turns false again
  after TWO consecutive missed rounds (timed out or failed; `noteClockPingMissed`).
  The last offset stays installed but is no longer vouched for. The next landed round
  restores it. A miss streak is reported once (`report("time-align", …)`), not every
  30 s.
- The session publishes it as `clockCalibrated` in the controller telemetry (false
  while disconnected) and republishes whenever it flips. MirrorLink refuses to scan
  while `activeController()?.clockCalibrated` is false: the scan's start instant and
  every marker timestamp ride this offset.

## Clock-metrics bridge {#clock-calibration}

Source: `app/orchestrator/clock-calibration.ts`

JS side of the clock-metrics channel. The hardware owner THREADS own calibration — initial at
device init + incremental drift every 30s, entirely native (ClockCalibration.cpp). There is
NO JS calibration driver (a second latch driver would race the owner thread on the
TimestampLatch device register); and no per-brick offset push (owner-applied dt makes every
surfaced timestamp trusted at the source). This module just BRIDGES the owner's pushed metrics
into the JS-side registry (`time-align.ts`) that feeds perfSnapshot.clocks / telemetry:
`Aravis.onClockMetrics` is the CallbackSlot channel — a lock-free armed flag native-side means
the owner threads skip the uv dispatch entirely until this registration happens.
