# Multi-fovea — developer behavior spec

Developer-facing behavior spec for the `multi-fovea` app (N interleaved foveas over
one shared center stream). Distinct from the user manual. Code carries tight
one-line pointers to these anchors.

## Topology {#topology}

Tracking runs on the native multi-KCF thread (`createMultiTracker`: one free-running
thread, batched per-frame results, fused undistort — results in UNDISTORTED
coordinates when calibrated). The session consumes the batch iterator into the
runtime's policy half (`MultiFoveaRuntime`: arm/disarm churn, lost tolerance, steering,
controller streams) and drives each slot's composed fovea crop node (`setFoveaRect` per
tick — frame-bound origin rides the pipe, v4). The RENDERER composes the per-target
fovea nodes itself (camera-rooted, refcounted, auto-unref on window close) and binds
them via `usePipeFrame`. Nothing multi-fovea does touches the JS event loop per frame.

- `scheduler` (RoundRobinFrameScheduler) + `runtime` are session-level singletons. Each
  activation leases the triple, advertises the center intrinsic-undistort pipe + the L/R
  mirror-steered homography-undistort bricks (fed `H(mirrorAt(t))` at ~200 Hz), spins the
  multi-KCF thread, and — on drain — releases the tracker (closing its iterator), stops
  the scheduler, disposes the runtime, and releases the lease LAST (resource scope, FIFO).
- The round-robin scheduler is inert without a v2-capable controller: `createStream`
  returns null when `!v2Capable` → empty targets → `pump()` has nothing to issue. It must
  still `start()` or its `running` flag never flips and no CMD_FRAME is ever issued once a
  v2-capable controller is present.

### Runtime policy half {#runtime}

`MultiFoveaRuntime` is the session-side policy: slot bookkeeping, arm/disarm churn (slot
index = tracker target id), lost-tolerance (the native thread emits `ok:false` liberally;
tolerance absorbs it), steering, pose math via deps, controller-stream sync, telemetry.
Staleness is intrinsic to the native thread; there are no per-slot JS KCF busy-drop or
generation guards. `arm()` on a LIVE id RE-INITS that target (the steer-while-armed path;
the learned filter resets, inherent).

**Lost-release scheduler resync**: when a slot exceeds `lostTolerance`, `releaseSlot`
TERMINATEs its MCU stream. The round-robin scheduler is resynced to the surviving live
streams immediately — otherwise a dead stream id would stay in rotation and every pass
would issue a CMD_FRAME against it (firmware REJ / wasted turn) until the next full
`setTargets`. `syncSchedulerTargets` is the single spelling of the live target list
(stream-sync and lost-release converge there).

## Targets, presets, and pose {#targets}

Up to `MAX_MULTI_FOVEA_TARGETS` (8) slots. Two kinds:

- **Image-space KCF target** (`preset: null`): the native tracker follows an image point.
  `placeTarget` sets `center` and CLEARS any preset (KCF resumes).
- **Angle-space PRESET** (`preset: {pan, tilt}` deg): a STATIC fovea — the mirror parks at
  that fixed angle, NO KCF runs (`armed` stays false → excluded from `onTrackResults`), but
  the round-robin still interleaves it exactly like a KCF target. `targetPose` maps the
  preset angle through the existing per-eye A2V (both eyes at the same angle, vergence at
  infinity); the fovea crop centers on `projectAngle`'s wide-camera pixel (falls back to the
  slot center when uncalibrated). The demo opens with two interleaved presets (±5°) so the
  app needs no manual setup.

**Preset-angle clamp** (`clampPresetAngle`, `PRESET_ANGLE_LIMIT_DEG` = 10°): the A2V
polynomial has no domain guard and the DAC assert THROWS rather than clamps, so every preset
entry point (server-side, not just the UI) clamps to a safe symmetric range or an unbounded
input could over-drive the mirror / error the frame. Tune to the mirror's real safe
deflection on the hardware rig.

## Trigger settle hold {#settle}

`settle_time_us` is pushed into EVERY CMD_FRAME. The firmware applies it only on a stream
SWITCH (mirror moved), then runs the normal exposure — independent of pulse, not subtracted;
0 = no hold. Initialized from the active triple's `settle_time_us` at activation; the drawer
slider overrides it LIVE for the running session. A Settings-page edit is picked up at the
NEXT activation only (config-store docs are per-instance — a cross-instance live push is
intentionally out of scope).

## Pairing wiring {#pairing}

Pairing nodes are always-running with the trigger topology, but active only in trigger mode
(in free-run the anchor pool is empty and both bricks idle; recording still works,
descriptors without pair provenance).

- **Root pair brick**: joins the L/R CONVERT taps against FIN anchors, tolerance-match ONCE.
- **Downstream exact brick**: joins the two homography-undistort outputs on the carried
  deviceTimestamps, fed RESOLVED anchors from the root's records (never re-stamp trusted
  time).
- **Paired-SGBM disparity node** (stereo-paired-inputs): composed over the `pair/undistort`
  stage, ON-DEMAND (parked with no consumer taps nothing). Same signed −256…+255 window as
  disparity-scope (foveated gaze makes disparity SIGNED). Degrades silently if the seam is
  absent.
- **Enrichment**: ONE source — conversions bound per activation (volts→angle→H); the
  controller's FIN outcomes fan in. A missing source brick degrades to unpaired recording,
  never fails activation.

## Recording {#recording}

`recording.ts`. A container holds ONLY:

1. the three PACKED `camera/<serial>/raw12p` sensor streams (verbatim wire payload), via the
   refcounted raw-pipe registry, with optional per-stream zlib routed through the
   CompressStream brick — the recorder consumes the `/zlib` sibling pipe instead, zero extra
   config. Compression is per-stream ENABLES of the app-level `record_compression` method: a
   stream compresses iff the method is `"zlib"` AND its switch is on; `"none"` gates all off.
   Lossless zlib may not hold full-rate 12p on all three cameras (unverified without the
   hardware rig; default all off);
2. the wide camera's singleton metadata record (omitted uncalibrated). Carries the
   per-triple `baseline_mm` alongside the intrinsics (additive — a container without it → the
   viewer shows "—") for Part B's vergence-plane depth readout;
3. per-target DESCRIPTOR channels (`fovea/<slot>`): JSON observations
   `{tNs, bbox, frames:{left,center,right}}` where the frame pointers are per-stream recorder
   sequences; fovea imagery is reconstructed OFFLINE, never re-encoded.

**Descriptor emission** (one path, both modes): every tracker-batch observation of an armed
target emits one descriptor — bbox from the batch (wide, undistorted). The L/R pointers are
enriched from PAIR RECORDS: the root PairStream's completed pairs carry the two matched
frames' deviceTimestamps; the recorder's per-frame notices build dts→seq maps for the
recorded raw12p streams, so a FRESH pair (`PAIR_FRESH_MS` = 1000) for the target's controller
stream re-keys to recorded sequences. FREE-RUN / stale → explicit `left:null, right:null`. The
center pointer is the NEAREST recorded center frame by timestamp and is explicitly
UNSYNCHRONIZED (multi-fovea free-runs the wide camera by choice; the V0.1 board
cables its trigger, see `hardware/rig.md`).

**Per-frame extras**: the L/R fovea streams answer `onFrame` with the matched anchor's payload
(volts / V2A angles / H, unpacked from the enrichment node's opaque doubles — `anchorExtras`,
`volt.source: fin-averaged`), exact dts→anchor binding, null when no anchor matched. In
free-run on a calibrated triple, `historyExtras` derives them from the INTERPOLATED actuation
history at the frame's trusted exposure host-ns (`volt.source: history-interpolated`), null
when history is empty/too-old OR uncalibrated. The wide stream posts no extras (its matrix is
the singleton wide-camera metadata record) but still notices so its dts→seq map feeds the
center pointer.

Bounded maps (`MAP_CAP` = 96, ~2× the recorder ring depth 48): a descriptor arriving after its
frames evicted records null pointers rather than stalling. Built on the shared
`@orchestrator/recording-service` — this file keeps only multi-fovea's semantics
(multi-fovea-recording.test.ts).

## Capture {#capture}

Degraded raw-stack capture over the leased triple (the `rawTripleShot` — no per-shot mirror
pose → no fovea wrap), distinct from `captureOnce` (the hardware-synchronized MEMS shot, which
requires the full hardware rig). EXCLUSIVITY: a recording is refused while a capture shot holds
the shared raw pipes; `busy()` refuses a mid-recording/mid-capture drain.
