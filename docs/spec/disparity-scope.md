# Disparity-scope — developer behavior spec

Developer-facing behavior spec for the `disparity-scope` app session (auto-vergence).
Distinct from the user manual; this captures the state machine, gating semantics,
drag behavior, and precedence rules the code points here for. Code carries only
tight one-line pointers to these anchors.

Topology follows a split-node design. The session is a THIN main-thread coordinator: it
wires up the graph and forwards final results; it does not micro-manage frames.

## Pipeline topology {#topology}

On activate: `acquireTriple` (calibration), then advertise THREE undistort pipes and
compose the split pipeline out of GENERAL-PURPOSE nodes.

- **Undistort pipes.** C = INTRINSIC undistort. L/R = HOMOGRAPHY undistort, each fed
  `A2H∘V2A(volts)` by `startHomographyFeeder` (an empty ring passes frames through).
- **Slice nodes** on the C undistort (the fovea crop brick, reused), live-steered by
  `steerCrops` as target/zoom move: `slice/scope-strip` (target-centered match strip)
  and `slice/scope-tile` (display center tile).
- **Scale nodes** (the match kernel does NO resizing), retuned by
  `retuneScalers` on zoom/magnification/tuning change: the strip's `scale/match`
  (ratio = match scale `s`) and one `scale/scope-needle` per fovea (`dsize` =
  `foveaTileSize`).
- **Template-match workers** (`match/L`, `match/R`): each reads its pre-sized needle +
  the shared pre-sized strip. Results carry the strip frame's crop ORIGIN, so
  `origin + rectCenter/s` is an ABSOLUTE undistorted-wide position — no target or drag
  flag ever rides a worker.
- **PID node** (`win/disparity-scope/pid`) — the app-specific JOIN. See [match join](#match-join).
- **Views.** Sliced/guide views ARE the slice pipes (renderer `usePipeFrame`). The
  L-vs-R difference AND anaglyph center views are a real two-input COMPOSITE brick
  (`stereo/composite`, mode retuned from `state.view`) on the two fovea undistort
  pipes. Only the per-side match heatmaps remain session frame channels. SGBM disparity
  + heatmap are separate bricks (`createStereoPipe` → `createHeatmapPipe`), PARKED until
  the renderer connects the heatmap pipe (no subscriber, no compute).

### Needle geometry — the too-small-needle defect {#needle-geometry}

The needle scaler's SOURCE is the RAW fovea CONVERT pipe, NOT the L/R homography-
undistort pipe. The homography warp lands the fovea view at WIDE pixel density (a
demagnified patch) — it has already divided by the magnification once. Feeding that to
the needle scaler (whose `foveaTileSize` dsize divides by magnification AGAIN)
demagnifies TWICE (~9× linear / 81× area too small vs the strip). The raw convert pipe
is the full fovea FOV at fovea-native resolution, so `foveaTileSize` is the SINGLE,
correct ÷magnification (matching `getFoveaTile` semantics). The warped pipes stay the
stereo/composite source (`warpedSources`) — those bricks WANT the wide-aligned warp.

Base-dims/zoom pairing (`needleGeometry`): a MEASURED magnification is a
fovea-px-per-center-px ratio → divide the FOVEA source dims; a NOMINAL zoom (window
knob or per-triple `zoom_override`, both rig-nominal FOV ratios) → divide the CENTER
dims (`W_c/z`). Pairing either zoom with the other width injects an uncorrected
foveaRes/centerRes factor. The FOVEA branch is taken ONLY when the measured tier
actually WINS the resolution order (decided by tier, not numeric identity).

## Match magnification — resolution order {#magnification}

The resolution order (`matchMagnification`):

    app-window zoom knob (state.zoom > 0)      — AUTHORITATIVE
      > per-triple zoom_override (> 0)          — the rig's stored optical zoom
        > calibration-MEASURED fovea↔wide ratio — extrinsic marker-quad ratio
          > 1                                    — degenerate but honest

`zoom === 0` is "Auto". Each tier must be finite and > 0 to be accepted; a degenerate
value falls through. The knob wins over everything when set, so a live override on the
window is never blocked by a stored triple value. This drives BOTH the tile/strip match
scale AND (via `Math.max(1, matchZoom())`) the sliced-view crop + tracker search sizing.

## Drag = parallel follow {#drag}

Pointer drag → the TRACKER's override (see [Chained tracker](#tracker)). Down/move call
`tk.override(p)`; the control step switches to DIRECT FOLLOW:

- Pointer-down RESETS pan/verge/v_shift, so BOTH eyes ride exactly ON the raw cursor
  ray — parallel, vergence at INFINITY, no residual corrections — with no PID stepping
  and NO match-score gate (the pure `followTarget`; the match-gated loop could never
  follow a drag onto unmatched content: the strip recenters on the dragged target, the
  foveas' actual gaze leaves the strip, both scores drop below `minScore`, control
  holds, the foveas never move).
- The pointer handler also pushes the follow volts synchronously so the drag doesn't
  lag a match tick, and refreshes the freeze window NOW (`dragging` reaches the join one
  match tick late — a drag started while frozen must servo immediately).
- The all-zero controller state equals the follow command, so on release the tracker
  RE-ARMS at the drag end and the PID resumes CONTINUOUSLY from the parallel pose (no
  seed — velocity-form integrator = command), then re-converges every DOF from scratch.
- `overridden` is SESSION-LOCAL (`dragging`) — nothing app-specific rides the reusable
  nodes. The join stamps it onto each projection.
- The PID node's own override slot stays for the generic `pidOverride` command; its
  seeded release (`seedFromOverride`) serves ONLY that path.

### Drag slew {#drag-slew}

Source: `drag-slew.ts`. Stepping the mirror pose directly to each pointer sample would
idle the serial link between pointer events while the governed stream has ~600–1000 Hz
capacity (the compose floor re-emits an IDENTICAL pose, which the MirrorSink gate dedupes
away). Slewing the commanded pose toward the latest pointer target with a short time
constant (τ = 8 ms) makes successive control ticks emit DIFFERING poses while the target
moves — the gate passes them at capacity — and epsilon-SNAPS to the exact target once
settled, quiet on a static target. Rides the VALUE only: the transport underneath is
untouched, so it cannot resurrect a suppressed JS stream. NOTE: manual-control duplicates
the same ~15-line function — keep constant/shape consistent.

## Freeze / convergence window {#freeze-window}

`frozen()`: while the auto-follow gate is armed (including the armed-but-hunting window
before the first lock and the hybrid's re-detect recovery) OR found results flow, the
convergence timeout does NOT apply. The timeout exists for
unattended pointer-set targets, not an active tracker. Otherwise `now() - windowStart >
timeout` (timeout 0 = never, the slider-MAX sentinel).

**Auto-vergence DISABLED** (disabled/held freeze the CORRECTIONS, never the tracker;
`autoVergenceDisabled()`):
`timeout = -1` (the slider-MIN sentinel, label "disabled") stops the control law from
stepping — status "auto off" — but a live tracker KEEPS its target, and while
`trackerActive` the foveas keep FOLLOWING it: controlStep's disabled branch returns
`slewToward(followVolts(state.target))` (slewed by construction; pure geometry, no
match-score gate, mirroring the drag behavior) through the frozen/manual DOF values.
Pointer drags and the manual DOF sliders still steer (manual control, not auto).

The same predicate carries the MANUAL HOLD latch, status "held": a `setPid` slider
write OR `pauseVergence(true)` (the drawer's pause button — the slider-write takeover
without a value change) calls `latchManualHold()` — `windowStart = -Infinity` (covers
timeout 0, which a plain expiry can't) and NOTHING else: the tracker stays armed and
following. The latch therefore survives tracker activity — `onTrack`/`markTrackerLost`
refresh the window ONLY when it is not `-Infinity` — and is cleared explicitly by: a
pointer drag (its controlStep ticks restart the window), the `tracker_enabled` off→on
toggle (the watch sets `windowStart = now()` before re-arming — onTrack can no longer
do it), `pauseVergence(false)` (resume — cancels a live tune first, takeover
semantics), or a `pidOverride` release. `vergence_paused` telemetry publishes the
latch on TRANSITIONS (direct latch paths + the volt-telemetry tick as catch-all;
latch-state var resets at idle) and drives the pause/play toggle; the held/auto-off
status carries a " · following" suffix while `trackerActive` (parked and
actively-following are visibly different states). `disengageAutoVergence` (tracker OFF for
real, honest toggle) is the AUTOTUNE-ONLY entry: tune experiments script the target, so
a live tracker would fight them. Under either state `reset_vergence` also PUSHES the
reconstructed all-zero pose (with a tracker following, the next tick slews
onto its target at zero corrections; without one the zeroed readout would otherwise
desync from the held mirrors). `windowStart` is refreshed on drag/track activity and
reset per activation (reset on activate is required: if the clocks initialize only at
session CREATION, a window re-entering long after boot is already past the timeout —
frozen before the first projection).

## Chained tracker {#tracker}

`createChainedHybridTracker` (NCC match+re-detect, the drop-in KCF successor) or GRAY-KCF
runs on its OWN native thread, chained on the C undistort brick's OwnedFrame tap
(latest-wins), so tracking latency no longer rides the disparity-matching budget.

- **Result routing** (`tracker-feed.ts`, pure reducer): OVERRIDDEN results (a drag
  pinned the tracker) are ALWAYS processed — the `armed()` gate does not apply. Normal
  results are gated by `armed()` (the JS-side auto-follow flag — native has NO disarm;
  released targets keep emitting, the gate ignores them until re-armed). Found →
  `onTrack`; miss → counted, and after `TRACKER_LOST_TOLERANCE` (10) CONSECUTIVE misses
  `onLost()` fires ONCE (counter resets).
- **Lost policy** (`onLost`): release auto-follow (JS gate), hold the last good target,
  restart the convergence window, set `tracker_lost` telemetry (drives the drawer Status
  "lost"; a stale "armed" beside a "frozen" vergence status reads as a contradiction).
- **Hot-swap** (`tracker-swap.ts`): the two factories share an
  IDENTICAL handle surface (same `TrackResult`/`arm/override/probe/release`/meter), so
  the session releases one and spins the other on the SAME source pipe + graph node id —
  no graph churn, no session restart, only a brief tracker-results gap. Sequencing:
  release → create → resume consume + re-pipe kcf→imm → re-arm IFF `wasArmed`. DEGRADE:
  a factory throw falls back to the prior running type and pins
  state to reality (`ok:false`); a fallback throw too → null tracker (pointer-only).
- **Deferred swap during drag**: a `tracker_type` change requested WHILE a drag is in
  flight is DEFERRED to drag end (safe: never re-plumb the tracker mid-gesture;
  pointer-up applies the pending swap and re-arms at the settled pose).

## Match join {#match-join}

Per-side match results land keyed L/R at the PID node. The vergence step runs when the
ARRIVING side COMPLETES a pair (its seq ≥ the other side's latest) — order-agnostic,
degrades to the slower side's rate. Each result is lifted out of scaled-strip space
(`/s` → full-res strip-local px) + the frame's forwarded crop origin → ABSOLUTE
undistorted-wide px. The projection's target is resolved at the strip frame's CAPTURE
epoch, not now — see [capture-epoch target](#capture-epoch-target).

**Once per pair** (kd explosion): the control step is gated on the PAIR seq
(the OLDER side's) advancing past the last stepped one. Un-gated, the law ran TWICE per
strip frame — each side's arrival re-paired with the other's held result — and the
second run's near-zero `dt` (worker-completion skew × sensitivity) turned the raw
derivative `Δe/dt` into an unbounded kick for ANY kd ≠ 0 (the un-slewed intra-frame
zigzag then fed back through compose feed-forward into real mirror motion). In steady
state the gate lands on the completing (second) arrival — both sides fresh; a genuinely
lagging partner still steers at the laggard's rate within the staleness bounds below.
The derivative itself is additionally LOW-PASSED in `@lib/pid` (α = dt/(dt + dTau),
default τ = 2 dt-units), which is time-consistent: a tiny-dt step contributes ~nothing.

**Partner staleness** (`match-join.ts`):
a stalled partner (dead worker / starved pipe) would otherwise freeze ONE eye's center
into the vergence law indefinitely while status reads "tracking". A partner beyond the AGE
(~300 ms) or SEQ-GAP (12 frames) bound is treated as LOST: hold the pose (skip the
control step — existing hold semantics) and surface "match stale". Corrupt clock ⇒ hold.

## Vergence control law & spaces {#control-law}

`stepVergence` (`vergence.ts`) — PURE geometry + control math. The loop integrates
physically-meaningful DOF and reconstructs both fovea poses symmetrically about the gaze
ray, rather than commanding four fovea pixel DOF independently (which lets the foveas
drift apart on noisy frames).

- **DOF.** `pan` = common-mode ray correction x/y (rad, a PID2D); `verge` = inverse-√depth
  parameter (0 ⇒ ∞); `v_shift` = vertical half-shift between the foveas (rad).
- **Error decomposition** (`dL = aT − aL`, `dR = aT − aR`): `pan = (dL+dR)/2`;
  `verge = aR.x − aL.x = 2b(1/Z − 1/z)`; `v_shift = (aR.y − aL.y)/2`. The `v_shift`
  sign is opposite the common-vertical (`pan.y`) one: `v_shift` drives the foveas in
  OPPOSITE vertical directions (`l.y = ray.y + v_shift`, `r.y = ray.y − v_shift`), so
  nulling the differential disparity needs the negated error or `v_shift` winds to its limit.
- **Input space**: projected centres arrive as UNDISTORTED wide-frame
  pixels, so they lift to angles via `P2A.C(px, false)` (already-undistorted linear
  pinhole map, not the raw-pixel default). Feeding back on
  the image-MATCHED position (not the calibration-predicted one) lets a constant
  extrinsic offset be absorbed by the loop instead of biasing convergence.
- **Hold** (returns null): either match below `minScore` (also rejects NaN) — the
  controllers are left untouched so a low-confidence frame neither integrates nor winds down.
- **dt.** Velocity (incremental) form, so effect scales with call rate; the caller
  supplies a rate-normalized `dt` to keep convergence wall-clock consistent across
  variable pipeline throughput.

### Capture-epoch target {#capture-epoch-target}

Tracker↔PID coupling fix 1 of 2. The
matched centers `aL/aR` come from a strip captured 2–4 frames ago; stepping against the
target AS OF NOW put phantom error ∝ target velocity × pipeline delay into the PID
during follow — motion the loop hadn't had time to act on AND that compose feed-forward
already leads (double-count). The join feeds `projection.target` = the target **as
of the matched frame's capture epoch**:

- **Ring.** The session keeps a `{t, target}` ring (`recordTarget`, host steady-clock
  ns, 256 entries ≈ >1 s) appended at EVERY `state.target` write — one `writeTarget`
  path covers tracker `onTrack`/`onDrag`, the pointer handler, and the lost-hold —
  seeded with the current target on activate, cleared on idle.
- **Epoch.** The strip frame's `deviceTimestamp` rides `TemplateMatchValues` verbatim
  (trusted-time: the camera owner stamps it pre-calibrated into the host `steadyNowNs`
  domain at `Frame` creation; every brick forwards it un-restamped), so the join needs
  no clock conversion.
- **Lookup** (`targetAtEpoch`, pure): the NEWEST sample with `t ≤ epoch` (a write
  applies from its stamp onward). Empty ring / missing epoch / epoch before coverage →
  the LIVE target — the out-of-range epoch an uncalibrated camera clock produces
  degrades exactly to the live-target behavior, never to an arbitrarily stale entry.
- **Scope.** ONLY the PID error decomposition moves to the epoch target. `pushVolts`'
  compose rebase keeps `pMeas` = the LIVE target (feed-forward leads from the live
  measurement paired with the imm predictions), and the drag re-affirm in `controlStep`'s
  overridden branch follows the LIVE target (a drag chases the pointer).

### Derivative on measurement {#derivative-on-measurement}

Coupling fix 2 of 2: with the derivative on `de/dt`, every tracker target update rode
`d(aT)/dt` straight into the output at tracker rate (setpoint kick — the low-pass
bounds it, doesn't remove it). `@lib/pid` gains `derivativeOn: "error" | "measurement"`
(default `"error"`, zero change for existing consumers): in measurement mode `step(e,
dt, m)` differentiates `−m` through the SAME low-pass filter, so Δe = −Δm dynamics are
identical at constant setpoint but a setpoint step contributes nothing. All three
vergence controllers run measurement mode; `stepVergence` decomposes the per-DOF
measurement so `error = setpoint − measurement` holds:

| DOF | setpoint | measurement | behavior change |
| --- | --- | --- | --- |
| pan | `aT` (moves during follow) | `(aL + aR)/2` | YES — target motion no longer kicks kd |
| verge | 0 (disparity nulled, constant) | `aL.x − aR.x` | none (constant setpoint ⇒ identical) |
| v_shift | 0 (constant) | `(aL.y − aR.y)/2` | none |

The once-per-pair gate, the filtered derivative, and the hold/disabled semantics above
still apply — the capture-epoch target and measurement-derivative layer on top of them.

### Seed space contract — the drag-release seam {#seed-space}

`seedVergence` reconstructs the `{pan, verge, v_shift}` state whose forward map reproduces
a pair of per-eye gaze ANGLES about the target ray — the exact algebraic inverse of the
forward reconstruction, so seeding a released PID node gives output continuity.

The inputs are ANGLES, not volts. The forward law
commands VOLTS via `A2V(reconstruct(...))`; recovering angles from an override VOLT pair
by inverting through `V2A` is LOSSY — `A2V` and `V2A` are independently fitted PER-EYE
regressions, so `V2A.L∘A2V.L ≠ V2A.R∘A2V.R`. A PARALLEL drag round-trips back as two
slightly DIFFERENT angles, which the reconstruction reads as genuine toe-in ⇒ a
FABRICATED verge/v_shift ⇒ the mirrors converge elsewhere the instant control resumes. So
a caller that KNOWS the commanded ray (the disparity drag path) passes it directly as
`gL = gR = ray`: `tanDiff` is exactly 0, verge/v_shift come out 0, and `A2V(ray)`
reproduces the pinned volts exactly. Only the generic volts-only override path (arbitrary
per-eye volts that genuinely encode a vergence) round-trips through `V2A`. `SEED_PARALLEL_EPS`
(1e-9) guards the `z = baseline/tanDiff` divide on the parallel case.

## Auto-tune {#autotune}

Two-stage gain auto-tune: relay first stage + CMA-ES joint polish, session-driven,
drawer-gated, NEVER automatic.
**Hardware-gated**: both stages are physical experiments (real optics in the loop);
everything below is code-complete + unit/simulation-tested but must be verified on the
hardware rig. Pure core: `relay-tune.ts`, `cma-es.ts`,
`step-cost.ts`, `autotune.ts` (the phase machine over injected hooks — throws
never cross into the session; every failure is a verdict/callback).

- **Entry** (`autotune` command, `{stage: "relay" | "full"}`): requires a
  calibrated triple (the `calibrated` telemetry flag — `ready` alone also
  covers the uncalibrated convert-fallback path), no drag, no generic
  override — refusals surface as a `failed` progress record, never an error.
  An armed/enabled tracker is NOT a refusal: starting a tune DISENGAGES it via
  `disengageAutoVergence`
  (toggle flips off honestly), the same takeover semantics as a Vergence
  Angles slider write. EXCEPTION: a start while a run is LIVE is ignored SILENTLY — a
  refusal record must never overwrite a non-terminal progress record (the
  double-click would flip the UI to "failed", re-enabling the buttons and
  hiding abort while the mirrors still wiggle). Starting enters the
  MANUAL-HOLD machinery (`disengageAutoVergence` — the `-Infinity` window
  latch), so normal stepping is out and compose feed-forward is down
  (`frozen()`); status reads "autotune".
- **Sampling** — the run consumes the SAME match-join projections the loop
  does: `runControl` routes each once-per-pair projection to `autotuneStep`
  instead of `controlStep` while a run is live (the normal path is untouched
  when no tune runs — the hold already stops stepping). Per-DOF errors are the
  `stepVergence` decomposition re-derived at the join output; samples below
  `min_score` are skipped (a persistent low-score stream FAILS the run closed,
  and an out-of-loop watchdog on the volt-telemetry timer FAILS a run whose
  feed died entirely — both are failures, not aborts: "aborted" is reserved
  for user action).
- **Clock**: tune time = `elapsed-ms × sensitivity` (captured at start), the
  loop's dt frame — relay Tu and the Tyreus–Luyben gains land in the same
  units the controllers integrate, and tuning durations scale with the loop's
  own timescale.
- **Relay stage** (per DOF: panX, panY, verge, v_shift): square wave about the
  current DOF value through the controller `.value` + follow-map push path
  (the setPid precedent). Safety envelope: start half-amplitude = 2 % of the
  DOF's physical range, escalation ×2 bounded ≤ 10 %, every command clamped to
  the range (the PID value setters clamp again), and the relay center is
  BIASED just inside a hard limit (the verge-at-∞ case) so the wave stays
  two-sided; a settle window per amplitude level re-references the error mean.
  Conclusion needs N consistent cycles (period + amplitude spread ≤ 35 %);
  Ku = 4d/(πa), Tu → Tyreus–Luyben. Per-DOF failure verdicts (no-oscillation /
  timeout / under-resolved period) keep that DOF's prior gains — pan takes the
  elementwise MIN of its two axes' triples (conservative).
- **Polish stage** (`full` only): CMA-ES over the 9-D gain vector in log10
  space, box-bounded ±1 decade around the relay seed, budget-capped. Each
  candidate: apply gains live (NOT persisted) → settle → scripted target step
  (alternating ±`stepPx` from the pre-tune target, through the normal
  `writeTarget` path so the capture-epoch semantics hold) → record the trace → cost =
  `stepCost(panX)` (ITAE + overshoot² + command total-variation, normalized by
  the observed peak — the transport-delay lead-in is harmless) + the other
  DOFs' regulation cost. The PRE-TUNE gains are evaluated first (the
  telemetry `baselineCost` anchor), then the relay seed, then CMA candidates;
  the final gains are the best MEASURED set (seed fallback).
- **Terminal** (done/failed/aborted): done persists the gains into
  `state.tuning` (server-side setState does NOT fire the watch — the session
  re-syncs the controllers explicitly); failure/abort restores the pre-tune
  tuning. Every path restores the pre-tune DOF pose + target, pushes the
  reconstructed pose, and stays in the HELD state ("held") — the user resumes
  control explicitly (drag / tracker re-enable), exactly the manual-hold
  contract above.
- **Interaction precedence** — any user takeover CANCELS the run (restore +
  held): pointer-down, a `setPid` slider write, `reset_vergence`, re-enabling
  the tracker, and a tuning write (which keeps the USER's tuning, only
  resyncing the live controllers). Idle teardown discards silently (epoch
  guard inerts stale callbacks; controllers resync from persisted tuning so
  candidate gains never leak into the next activation).
- **Telemetry**: one `autotune` progress record (phase relay/eval/done/
  failed/aborted, DOF + cycles, evals/budget, best + baseline cost, message,
  resulting gains) drives the drawer's Auto-Tune group; reset on idle.

## Actuation / native compose path {#actuation}

Push-model at the projection/PID result rate, via the native compose brick.

- **pushVolts** REBASEs the native compose brick from the pid command (~60 Hz):
  `{V_pid, p_meas, J}` where `J` is the per-eye 2×2 finite-difference (`J_EPS_PX = 1 px`)
  of `followVolts` around the measured target (JS owns calibration, the brick owns the
  per-tick `V = V_pid + J·(p_pred − p_meas)`). The brick emits the baseline FLOOR on
  every rebase.
- **Feed-forward gate** (`composeHealthy`): applied ONLY while control is healthy —
  actively tracking, not dragging, no generic override pinned, not frozen. Otherwise the
  compose node holds the `V_pid` baseline. No calibration for `J` ⇒ hold the baseline.
- **IMM predictor brick**: ALWAYS created while tracking is active (the signed per-triple
  `delay_compensation_ms` is a prediction OFFSET param, not a wire gate), so the imm node
  is always on the profiler graph. Free-runs at the global `prediction_rate_hz`
  (default 600, clamp 60..1000), live-applied via a store subscription; that rate is also
  the serial governor's REQUESTED ceiling.
- **kcf → imm** is a NATIVE PORT LINK (both endpoints
  native, no JS relay), re-established on every hot-swap (a fresh tracker's `track_out`
  must re-pipe into the SAME imm brick). **pid consumes RAW tracker results** (not imm
  predictions): the feed-forward pairs `V_pid` with the measured center it acted on; a
  predicted input would double-count the motion.
- **Transports.** The JS `posInput` is the FALLBACK (v1 firmware / no controller):
  `consumeComposeFallback` drains the compose volt iterator and drives it ONLY while no
  native sink is attached. When a v2 controller binds, the native position input attaches
  a mirror sink, the session pipes `compose.volt_out ══ sink.pos_in`, and the whole
  ~600 Hz path is native; the fallback loop idles as a flag check.
- **Volt telemetry** under the native path polls the sink's native history at the
  telemetry throttle (no per-push JS callback exists). The same timer drives Part 4
  SERIAL-LATENCY COMPENSATION: while `serial_latency_comp` is ON and RTT samples exist,
  the predictor's delay gains a measured one-way term
  (`delayMs = fixed + EMA(ackRttP50)/2`), re-applied only when it moves by >0.05 ms. OFF /
  no sink / no samples = the fixed lookahead exactly.
- **Mirror-history provenance**: while the native sink drives the
  mirrors, the JS `mirrorHistory` no longer sees this session's trajectory — the
  homography feeder reads the sink's NATIVE ring; falls back to the JS authority whenever
  the JS `posInput` path is driving.

## Teardown ordering {#teardown}

`disposers` is a `DisposerBag` (FIFO). Consumers dispose before producers: pipe
disconnects + tracker/imm/measureLink release, then scalers (chained on slices/undistorts)
→ slices (chained on the C source) → the undistort bricks + homography feeders. Retirers
are added AFTER the kernel inputs are connected so the producer teardown is deferred
after the consumer disconnects. Native port links pin both endpoints, so a link's
disposer runs FIRST (added after the brick disposers). Each stop-feeder runs BEFORE its
brick detaches. `idleSession`: finalize an in-flight recording FIRST (while cameras are
still leased), drain any in-flight capture shot, then close transports and
`disposers.dispose()`.

Load-bearing constraints kept at the code:
- `verge.setLimits(...)`, NOT a bare `.limits =`: the integral clamp aliases the
  construction-time array, so replacing `limits` alone leaves the velocity-form command
  clamped to the default-200 mm baseline range on other rigs.
- `A2P.C` in `onVolts` guards the UNDISTORT, not just the triple — it throws "Wide camera
  not calibrated" without it, fires on EVERY volts push, and an uncaught throw would kill
  the orchestrator on an uncalibrated rig.

## Trigger-sync mode {#trigger-sync}

> **Hardware-gated.** Requires protocol-v2 firmware AND the pending MEMS flash for CMD_FRAME;
> the GenICam trigger/strobe line names are unverified placeholders. Code-complete +
> unit-tested only — verify on the hardware rig.

Hardware-triggered L/R pair capture for the scope: both foveas switch to
FrameStart-triggered mode and a one-target `RoundRobinFrameScheduler` round-robins
CMD_FRAME on the session's native mirror-sink stream, so each L/R pair exposes
simultaneously at a settled mirror pose. Pure decisions live in the shared
`@lib/trigger-sync.ts` core (preconditions, rate window, failure line, op chain
— shared with manual-control) + the module's `trigger-sync.ts` (match-join pair
window/staleness) + `match-join.ts` (`pairEpochSkewed`); camera config in
`@orchestrator/camera-trigger` (rides `lease.reconfigure()`).

**Intent vs engagement.** `state.trigger_sync` is USER INTENT — persisted,
renderer-writable, latched. The session ENGAGES only when preconditions permit and
re-tries from the volt-telemetry tick (the preconditions are lazy/async), so a flip
before the controller connects, a controller detach mid-session, or a re-activation all
converge without user action. While intent is on but disengaged, telemetry
`trigger_blocked` carries the specific reason (`triggerBlockReason`, most-fundamental
first): no camera triple leased → no controller connected → controller firmware is not
v2-capable → native mirror stream not attached yet. Two more reasons come from outside
the precondition chain: "session is not active" (an ON-flip while the session is idle /
tearing down) and "engage failed: …" (`engageFailureReason` — the enable error's first
line, truncated, never the raw multi-line message). `trigger` (the engaged readout) is
non-null exactly while engaged; `trigger_blocked` is null when engaged or when intent
is off.

`trigger_blocked` publishes on TRANSITIONS only (the retry tick re-evaluates every
interval; the UI needs edges, not spam), and each new non-null reason is ALSO reported
to the title-bar error tray at the "warning" level (`report("trigger-sync", reason,
"warning")` — the diagnostics `ReportLevel` added for this): the drawer keeps only the
warn-tinted mode selector + a compact "free-run — waiting" status, the tray carries the
detail. Tray warnings coalesce BY SCOPE (one "trigger-sync" row tracking the latest
reason) — a flapping precondition or a varying engage-failure message must never flood
the 50-row ring, which is exactly the failing-rig case the tray exists for; errors keep
exact-match event coalescing and sort above warnings. The transition latch resets at
idle alongside the telemetry, so an identical reason after re-activation re-publishes
(and re-reports) instead of being suppressed.

**Engage sequence** (each step gates the next; a disengage/idle racing an in-flight
engage reverts it via an epoch counter):

1. `enableHardwareTrigger(leases.L)` then `.R` — any failure best-effort disables BOTH
   sides, publishes `trigger_blocked: "engage failed: …"`, and stays disengaged.
2. Budget = `pairTriggerBudget` over both fovea config docs (exposure-authoritative)
   + camera-reported readout floor + the triple's `settleTimeUs` — identical to
   multi-fovea's `deriveBudget`.
3. One-target scheduler `{stream: nativePos.streamId, cameras: [L,R], pulse:
   budget.pulseUs, settle_time, minIntervalMs: budget.minIntervalMs}` (built by the
   shared `frameRequestFromBudget`), requester = the active controller's `frame()`.
   The pulse is MICROSECONDS on the wire (`FrameArg.pulse`) — `budget.pulseUs` is the
   exposure µs verbatim, never scaled (a ×1000 sent 16.7 ms as 16.7 s, past the FIN
   timeout, and froze the feed). The scheduler's `completionTimeoutMs` is
   `max(1000, minIntervalMs × 3)` so a pulse legitimately longer than 1 s (e.g. a
   2 s exposure) does not FIN-time-out every frame, retry as duplicates, and wedge.
   FIN/reject/timeout counts feed the `trigger` telemetry at the volt-telemetry
   throttle; `hz` rolls on ≥1 s maturity windows (`TriggerRateWindow`) — held between
   rolls, null until the first window matures after (re-)engage, since a per-publish
   33 ms window quantizes the rate to 0 or ~30; `pulseMs` = `pulseUs / 1000`.
4. Both fovea config docs are subscribed — an exposure edit re-derives the budget and
   re-pushes the scheduler target live.

**Disengage** (intent off / controller detach / session idle): scheduler stop →
config-doc unsubscribe → best-effort `disableHardwareTrigger` on both leases →
telemetry `trigger: null`. On CONTROLLER DETACH the intent stays latched: cameras
return to free-run, `trigger_blocked` reads "controller detached", and the retry tick
re-engages when a v2 controller re-attaches.

**Passive fault gate.** A correctly-configured pair (TriggerMode On / Line3 /
RisingEdge, Line2 ExposureActive out — V0.1 board, `hardware/rig.md`) whose trigger
pulse never reaches the cameras' trigger inputs storms `REJ "Strobe timeout"` every ~pulse+5 ms with ZERO FINs and zero
exposures — a deterministic, firmware-named signature. `TriggerFaultDetector`
(`@lib/trigger-sync`) watches the scheduler outcomes: `TRIGGER_FAULT_STREAK` = 10
consecutive identical-reason failures (reject OR timeout) with no FIN in between trips
the gate (at the ~39 ms storm cadence, < 0.5 s). ANY FIN clears the streak (frames are
flowing); a reason change restarts it; `trip` returns the reason exactly ONCE so the
session acts once. On trip the session `report`s an ERROR — not a warning — naming the
firmware reason and the check (`triggerFaultMessage`, e.g. `hardware trigger fault:
every frame rejected ("Strobe timeout") — no camera exposures; check trigger wiring.
Restoring free-run.`), then DISENGAGES back to free-run (the serialized disengage, so
the cameras are restored and the views recover instead of freezing). `trigger_blocked`
carries the compact `triggerFaultBlocked` reason (the tray error holds the detail);
the disengage suppresses its own warning (`warn=false`) so the reason is not
triple-surfaced. NO-FLAP: the intent stays latched but a FAULT latch
(`triggerFaultLatched`) blocks the retry tick from re-engaging — a faulted engage must
not thrash the leases. The latch CLEARS on intent off→on (the user re-arms after
fixing the wiring) and on re-activation (`activateSession`); it is not cleared by a
bare disengage.

The ACTIVE counterpart lives in **manage-cameras** (`testTrigger`, no separate spec
file): the Fovea Pair panel's **Trigger** test fires a SOFTWARE trigger
(`enableSoftwareTrigger` — `TriggerSource=Software` + `camera.softwareTrigger()`) then,
if a controller is connected, ONE hardware pulse (`activeController().trigger(pulseUs)`
— CMD_TRIGGER, `Microseconds` on the wire, exposure-covering, never ×1000) on BOTH
fovea cameras, restoring free-run after each leg even on throw (retried once; a
still-failing restore reports at ERROR — frozen-preview class). Frame arrival is the
`camera/<serial>/convert` producer's native-probe output `count` diffed across the
trigger (monotonic since producer start). The BASELINE is captured only after the
counter holds still ~200 ms post-flip (bounded ~500 ms) — frames exposed pre-flip but
still in readout/convert would otherwise land after a naive baseline and credit a dead
trigger line; the post-fire wait is `max(1000, exposureMs × 2 + 500)` ms so a long
exposure cannot false-fail. A dead probe row (producer parked) verdicts
`"unavailable"`, never `"fail"`. Verdicts ride `trigger_test: { at, L, R }` telemetry
(reset on idle; the command holds a server-side in-flight latch); a software fail
indicts the camera/stream path, a software-pass + hardware-fail isolates the trigger
wiring — the same fault the passive gate trips at engage. The hardware leg proves the
trigger INPUT chain only (MCU→Line3→exposure→frame); the strobe RETURN line
(Line2→MCU) is only proven by a live CMD_FRAME engage.

**Teardown invariant.** `disableHardwareTrigger` rides `lease.reconfigure()`, so the
idle-path disengage is AWAITED at the top of `idleSession`, strictly BEFORE
`releaseLeases` — a released lease has no live handle to reconfigure, and a camera left
in trigger mode has a frozen free-run feed. The engage gate (`triggerEngageAllowed`)
closes at idle start and reopens on activate: the retry timer keeps ticking through the
teardown awaits, and a re-engage there would re-arm the triggers past the disengage.
ORDERING: engage and disengage both ride one FIFO op chain (`createTriggerOpChain`),
so their lease trigger reconfigures never interleave — a fast OFF→ON toggle otherwise
raced enables against in-flight disables (a disable landing last leaves a camera
untriggered while the session reports engaged), and the idle-path awaited disengage
also drains any engage queued ahead of it; preconditions are re-checked after the
chain is acquired. Backstop for the crash case (no idle ran):
`registry.ts registerShared` best-effort `clearTriggers()` on every fresh camera open,
so the next session never inherits trigger mode.

**Pair window + staleness while engaged** (free-run pairing is byte-identical — every
check gates on the engaged flag): before the once-per-pair seq gate, the join rejects
epoch-skewed pairs (`pairEpochSkewed`, status "pair skew"): both sides of a triggered
pair expose simultaneously, so their trusted-time `deviceTimestamp`s differ only by
trigger jitter, and HALF the trigger interval (`windowNs = minIntervalMs × 1e6 / 2`)
separates adjacent trigger slots unambiguously. Exactly-window pairs (inclusive bound);
latest-wins recovers a one-sided frame drop on the next arrival. The partner-staleness
AGE bound scales to the trigger cadence — `max(MATCH_STALE_MS, 4 × minIntervalMs)` —
since triggered pairs arrive at the scheduler interval, not the free-run frame rate;
the seq-gap bound is unchanged.

## Capture & recording {#capture}

capture-recorder-everywhere. Recording captures the raw L/C/R sensor streams
(advert-verbatim). Capture composes the stacked L/R + center-slice shot over the leased
triple; the degraded `rawTripleShot` writes raw stacks WITHOUT the fovea homography wrap
(the session tracks no per-shot pose to derive H) — stated in `capture_meta`. EXCLUSIVITY:
a recording is refused while a capture shot holds the shared raw pipes, and
vice versa; `busy()` refuses a mid-recording/mid-capture drain.
