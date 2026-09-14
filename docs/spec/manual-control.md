# Manual-control — developer behavior spec

Developer-facing behavior spec for the `manual-control` app: a calibrated L/C/R
triple + timer-paced actuation with NO KCF tracker. Distinct from the user manual.
Code carries tight one-line pointers to these anchors.

## Targeting {#targeting}

There is no tracker state machine — the target is ALWAYS whatever `steer` last set:
either a mouse-drag pixel (converted server-side via `undistort.angular`) or a
locally-held set-point's angle (radians the renderer computes from a selected set-point;
pure client-side data, no camera access). Angle mode carries optional per-point
distance/shift overrides. Any `steer` (wide-view drag OR programmatic set) REUNIFIES the
split (one rule, no special cases — both eyes return to the shared solution).

`targetVolts` solves L/R from the single steered angle via `inverseTriangulate → A2V`,
then applies the per-eye split override (override > unified; a null eye keeps the shared
solution). Uncalibrated → origin volts.

## Split fovea {#split}

Session-local, NOT persisted (re-entry starts unified). Normally both eyes share one
target. A drag on the L (or R) voltage `PosView` pins THAT eye to a directly-chosen
volt-space position; the other eye keeps following the unified solution ("holds its
current command" since nothing else moves it). Volt-space, so it works uncalibrated.
Release KEEPS the pin — the eye stays where dragged; only a wide-view drag or a set-point
reunifies (the renderer emits no clear on release). `split.ts` holds only the precedence
rule (`resolveVolts`, `splitFlags`, `isSplit`) so it is unit-testable without a session.

The per-eye wide-view footprint boxes are drawn from the per-eye L_PX/R_PX volt
projections (`A2P.C(V2A(volts))`), so the two boxes physically separate while split.
DEGRADE on uncalibrated rigs — `A2P.C` throws without an undistort; return {0,0} and let
the renderer hide the boxes.

## Drag slew {#drag-slew}

Source: `@lib/slew`. Re-pushing the RAW latest pointer target every tick would idle the
serial link: between pointer samples the pose is IDENTICAL, the StreamUpdateGate/MirrorSink
dedupes it, and the link runs only at the pointer sample rate despite ~600–1000 Hz of
governed capacity. Instead the 1 ms pacer keeps the last COMMANDED pose and slews it toward
the latest target with a first-order smoother
(τ = `SLEW_TAU_MS` = 8 ms) — during motion every tick yields a DISTINCT intermediate pose
the gate passes, so the wire runs at capacity with meaningful interpolation (smoother MEMS
motion). Within `SLEW_EPSILON_V` (0.005 V, just above the DAC LSB) it SNAPS to the exact
target once and goes quiet (identical poses dedupe). The first tick (or post-reset) commands
the target directly — never swoops in from a stale origin. NOTE: disparity-scope has a
parallel copy (`drag-slew.ts`) — keep the constant/shape consistent; a later dedup can hoist
both into @lib.

## Display worker & views {#views}

The center tile offers four views: `sliced | disparity | anaglyph | sgbm` (the
display-kernel `diff`/`depth` modes are not offered — `coerceView` maps a persisted `diff →
disparity`, `depth → sgbm` at the boundary). Only `sliced` still rides the shared `display`
vision-worker kernel; the other three are native pipes (the same bricks disparity-scope
uses), consumer-gated — the renderer connects the SELECTED pipe and the rest park.

- **sliced** — the magnified center crop, off the JS event loop in the `display` kernel. Main
  pushes `voltParams` (the fovea homographies `A2H∘V2A(volts)` + the depth Q-matrix at the
  current pose) + `sliceAtParam` (the undistorted center pixel the crop centers on) on each
  throttled volt/target update. The kernel ONLY serves this view (no `view`/depth params —
  it defaults to `sliced` and stays there).
- **disparity / anaglyph** — the COMPOSITE brick (`nodeId.stereo("manual-composite")`) over the
  L/R undistorted (homography-warped) sources: `disparity → difference`, `anaglyph → anaglyph`
  at the configured `anaglyph_style`. `syncCompositeMode(state.view)` retunes the mode on the
  `view` watch; the style is read at activate (`readAnaglyphStyle`) and live-subscribed
  (`subscribeAnaglyphStyle`), retuning iff a composite view is up.
- **sgbm** — the STEREO SGBM brick (`nodeId.stereo("manual")`, pinned `SIGNED_DISPARITY_WINDOW`)
  feeding a HEATMAP (`nodeId.heatmap(…, "view")`, pinned `SIGNED_DISPARITY_HEATMAP_RANGE`), over
  the same warped L/R sources.

The renderer binds each L/C/R main view to its own `camera/<serial>/undistort` pipe DIRECTLY
(C intrinsic, L/R homography — the mirror-pose-tracked warp), at pipe rate independent of the
kernel. The center-view bricks + the composite-style subscription are torn down on idle, before
the undistort producers they read retire (LIFO).

## Trigger-sync capture {#trigger-sync}

Hardware-gated — hardware-triggered capture requires the full camera + controller rig to verify.

Optional hardware-triggered L/R stereo pairs, ported from disparity-scope MINUS all pairing /
staleness (manual-control has no match-join). `state.trigger_sync` is USER INTENT (a plain
state binding; the server never refuses the write); ENGAGEMENT is a live state machine:

- **Preconditions** (`triggerBlockReason`, `@lib/trigger-sync`): a leased triple, a v2-capable
  controller, and the MCU position stream id (`posInput.streamId` — the JS `openPosition`
  input's lazily-created CMD_STREAM, null until the first v2 update lands). Any unmet reason
  surfaces on `telemetry.trigger_blocked`.
- **Engage** serializes on a FIFO op chain (`createTriggerOpChain`) so a fast OFF→ON toggle can't
  interleave enables with in-flight disables: `enableHardwareTrigger` L then R (revert-on-failure),
  an epoch guard against disengage-during-await, then a `RoundRobinFrameScheduler` with ONE target
  (`stream = posInput.streamId`, `cameras: ["L","R"]`, `pulse`/`settle_time`/`minIntervalMs` from
  `pairTriggerBudget` over the L/R exposure + settle + max-rate). Scheduler FIN/REJ/timeout feed the
  counters; a `TriggerRateWindow` gives the achieved Hz on ≥1 s maturity windows.
- **Telemetry** (`telemetry.trigger`, non-null exactly while engaged) publishes at the volt
  throttle. `trigger_blocked` is published on TRANSITIONS only + duplicated to the title-bar tray
  as a warning (`report("trigger-sync", …, "warning")`).
- **Retry & teardown**: while intent is on but not engaged, the pacer's throttled block retries
  engagement (preconditions are lazy). On idle / `trigger_sync` flip-off, the session fully
  disengages and reverts the hardware trigger — the disengage defer drains AFTER the pacer stops
  but BEFORE `triple` clears + `releaseLeases` (`disableHardwareTrigger` rides `lease.reconfigure`).

## Actuation {#actuation}

Push model: the SESSION owns the 1 ms pacer cadence.
Each tick slews toward `targetVolts`, pushes the pose, and uses the node's synchronous
predicted-volts return for the local mirror mirror + telemetry. `onApplied` supplies the
awaited round-trip ms on the v1 fallback (~0 on the v2 streaming path). Volt + pose telemetry
is throttled to `VOLT_TELEMETRY_INTERVAL_MS`.

## Capture & recording {#capture}

capture-recorder-everywhere. Capture is the shared `@orchestrator/capture-helper` (the
createCaptureNode wiring + the ON-DEMAND per-shot raw L/R advertise/connect + telemetry + the
recording-vs-capture exclusivity guard all live in the helper); manual-control is a CONSUMER
supplying its calibrated-triple snapshot (`captureSnapshot`: the calibration-derived transforms
+ per-resource metadata for the whole shot). Full fovea snapshot requires undistort — null
degrades the command to "Capture not ready".

The renderer drives the raster: it owns the set-points + steer, so it issues a per-shot
`capture({tag})` for each shot. `tag` present ⇒ a raster shot that ACCUMULATES
an indexed resource; `tag === 0`/absent starts a fresh accumulation. Resources are held by the
capture node; images are PULLED per resource via `getPreview`/`getCapturePreview`.

Recording flows entirely through the RECORDER NODE (`@orchestrator/recorder-node`) — one worker
thread FIFO-consuming the full-bit-depth `camera/<serial>/raw` pipes and hosting the mcap writer
in-worker (built on the shared `@orchestrator/recording-service`). Main only advertises the raw
pipes, creates/retires the node, and answers the per-frame metadata callback. Only the
L/R foveae carry a voltage binding (`resolveFoveaBinding`/`buildFoveaMeta`): FIN-bound frames
carry the exposure-averaged voltage + frame_id (`volt.source: fin-averaged`), free-run frames a
live snapshot (`live-snapshot`); both add the mirror angle + homography. The center channel skips
the per-frame notice. On finalize, main is notified (`recording:finished`) so the viewer
auto-opens the finished `.fovea`.

EXCLUSIVITY: a capture shot in flight holds the raw L/R pipes; starting a recording
would re-advertise the same ids and the shot's release would then retire the recording's
producers — so a recording is refused (false) while `capturing`. Between raster shots `capturing`
is false, so a recording CAN start there; the next capture shot is then refused by the helper's
guard. `busy()` refuses a mid-recording/mid-capture drain.

## Teardown ordering {#teardown}

The trickiest teardown in the fleet: a capture/recording pass may still be reading a stream (or
awaiting a one-shot center-pipe read) when the last subscriber leaves — it MUST fully drain BEFORE
the worker terminates + the pipes disconnect + the leases release. Resource-scope defers are
registered in REVERSE of the drain (LIFO): stop the pacer FIRST (stop pushing) → await the async
capture/recording drain (raw pipes release) → terminate the worker + disconnect pipes → release
the lease LAST. The undistort producer retirers are registered before the worker's defer so they
retire AFTER consumers disconnect. The worker holds its own Undistort independent of main's
`triple`, so it keeps posting for a capture waiting on the next processed-center tick.
