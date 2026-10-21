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

### Timestamped and uploaded motion (v2.2.0)

The node does not route the protocol v2.2.0 surfaces yet: `StreamHandle.scheduleAt`
(CMD_SCHEDULE keyframes) and `Controller.uploadTrajectory` (CMD_TRAJECTORY, MirrorLink)
are `Controller`-level APIs (`docs/spec/serial-protocol.md#schedule`, `#trajectory`).
Caveat for a future integration: `mirrorHistory.record` runs only in `update()`, so
neither a scheduled keyframe nor a trajectory's MCU-side playback lands in mirror
history — a trajectory's per-frame mirror position comes from its `onFrame`
outcomes (exposure-averaged, trusted host-ns), and a running trajectory REJects the
node's stream UPDATEs.

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
`predictVolts` result; the v1 awaited `actuate()` path records the readback. Honesty note:
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
