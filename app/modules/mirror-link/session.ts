// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// MirrorLink session — a calibrated L/C/R triple whose two fovea mirrors trace a
// fast periodic SCAN PATTERN (ellipse / line / triangle) around a hand-aimed
// center. The pattern runs on the MCU as the controller node's uploaded
// trajectory, whose markers trigger both fovea exposures at exact phases (the
// trigger pulse IS the exposure window); the triangle's falling-sweep frames are
// flipped by a per-eye flip brick. A stripped manual-control: no set-points, no
// split, no display worker. Behavior spec: docs/spec/mirror-link.md.

import { type ServerSession } from "@orchestrator/runtime";
import {
  defineResourceSession,
  type ResourceScope,
} from "@orchestrator/resource-session";
import {
  acquireTriple,
  type CalibratedTriple,
} from "@orchestrator/calibration";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import {
  controllerNode,
  expectedTriggerNs,
  startPacer,
  trajectoryNodeId,
  type NodeTrajectory,
  type NodeTrajectoryState,
  type PositionInput,
} from "@orchestrator/controller-node";
import {
  DisposerBag,
  publishSerials,
  releaseLeases,
} from "@orchestrator/session-resources";
import {
  ORIGIN_POS,
  radians,
  VOLT_TELEMETRY_INTERVAL_MS,
} from "@orchestrator/fovea-pipeline";
import {
  activeController,
  TrajectoryReplaceError,
  type TrajectoryFrameOutcome,
  type TrajectorySpec,
} from "@orchestrator/controller";
import {
  disableHardwareTrigger,
  enableHardwareTrigger,
} from "@orchestrator/camera-trigger";
import { report } from "@orchestrator/diagnostics";
import {
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { createRawRecording } from "@orchestrator/raw-recording";
import {
  CAPTURE_RING_DEPTH,
  createCaptureHelper,
  rawTripleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import type { CaptureShot } from "@orchestrator/capture-node";
import type { Serializable } from "@lib/orchestrator/protocol";
import {
  createVisionWorker,
  type VisionWorkerHandle,
} from "@orchestrator/vision-worker-host";
import type {
  PipeInput,
  VisionResult,
} from "@orchestrator/vision-worker-protocol";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeSpec } from "@lib/orchestrator/pipe-contract";
import { makeMat } from "@lib/mat";
import type { RingReadout } from "@lib/ring-code";
import type { PipeBroker } from "@orchestrator/pipe-session";
import { rawPipeSpec, type RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import { cameraPipeSpec, type CameraLease } from "@orchestrator/registry";
import { createTriggerOpChain } from "@lib/trigger-sync";
import { slewStep, type SlewPair } from "@lib/slew";
import {
  deriveFoveaIntrinsics,
  distanceToVerge,
  vergeToDistance,
} from "@lib/stereo";
import {
  createPidNode,
  outputOf,
  type PidNodeHandle,
} from "@orchestrator/pid-node";
import {
  createSlicePipe,
  type SliceHandle,
  type SlicePipeSeam,
} from "@orchestrator/slice-pipe";
import {
  createScalePipe,
  type ScaleHandle,
  type ScalePipeSeam,
} from "@orchestrator/scale-pipe";
import {
  createFlipPipe,
  type FlipAnchor,
  type FlipHandle,
  type FlipProbe,
  type FlipPipeSeam,
} from "@orchestrator/flip-pipe";
import {
  foveaTileSize,
  matchMagnification,
  recordTarget,
  seedVergence,
  stepVergence,
  targetAtEpoch,
  type ScopeProjection,
  type TargetSample,
  type VergenceControllers,
  type VergenceSeed,
} from "@lib/vergence/vergence";
import { matchPartnerStale } from "@lib/vergence/match-join";
import {
  SHIFT_LIMIT_DEG,
  VERGE_MIN_DISTANCE_MM,
  VSHIFT_LIMIT_DEG,
  type VergenceTuning,
} from "@lib/vergence/tuning";
import { RECT, VEC } from "@lib/util/geometry";
import type { TemplateMatchValues } from "@orchestrator/template-match-kernel";
import { hostNowNs } from "@orchestrator/time-align";
import { trajectoryGraceUs } from "@orchestrator/trajectory-grace";
import { PID, PID2D } from "@lib/pid";
import { deg } from "@lib/util/math";
import { RollingStats } from "@lib/util/rolling";
import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import {
  mirrorLink,
  type ScanMode,
  type ScanTelemetry,
  type ScanWindow,
  type TrajectoryTelemetry,
} from "./contract";

import {
  activeWindows,
  AXIS_HANDLE_MIN_DEG,
  axisDegFromPixelRay,
  axisHandleOffset,
  clampWindow,
  flipEdges,
  flipRebuildNeeded,
  flipToleranceUs,
  minExposureEndSpacingUs,
  normalizeAxisDeg,
  patternPath,
  patternPeriodUs,
  patternSamples,
  sameWindowValue,
  AXIS_SLIDER_RANGE,
  SCAN_AMP_RANGE,
  SCAN_HZ_RANGE,
  SCAN_RATIO_RANGE,
  scanAngles,
  sweepUs,
  timedWindowMarkers,
  WINDOW_MAX,
  windowMarkers,
  windowPaths,
  type WindowMarker,
} from "./scan";
import {
  applyTriggeredTiming,
  exposureMismatch,
  readoutSpacingUs,
  readTimingLimits,
  restoreTiming,
  snapshotTiming,
  UNKNOWN_LIMITS,
  type TimingLimits,
  type TimingSnapshot,
  type TriggeredTiming,
} from "./exposure";
import {
  applyGain,
  intersectRanges,
  restoreGain,
  snapshotGain,
  type GainSnapshot,
} from "./gain";

const SIDES = ["L", "R"] as const;
type Side = (typeof SIDES)[number];

const clampHz = (hz: number): number =>
  Math.min(Math.max(hz, SCAN_HZ_RANGE.min), SCAN_HZ_RANGE.max);

/** A window from whatever a client wrote, clamped (spec §exposure-windows). */
const windowFrom = (v: unknown): ScanWindow =>
  Array.isArray(v) && v.length === 2
    ? clampWindow([Number(v[0]), Number(v[1])])
    : [0, WINDOW_MAX];
/** Window equality up to float noise (scan.ts `sameWindowValue`): a clamp's
 *  ULP nudge is not a change worth a write-back. */
const sameWindow = sameWindowValue;

/** Points per drawn scan path — dense enough that the polyline reads as an
 *  ellipse at PosView scale, cheap enough to republish on every slider nudge. */
const SCAN_PATH_SAMPLES = 48;

/** Voltage envelope assumed while no controller is bound (controller.dv). */
const DEFAULT_DV = 170.0;

/** Lead between building the START and the trajectory's EXPLICIT host-ns
 *  start instant: the START must reach the MCU before it is due (a past
 *  `t_start` would join in progress and lose the exact-lateness reference). */
const SCAN_START_LEAD_NS = 20_000_000n;

/** Live re-upload throttle (spec §actuation): at most one `replace` per this,
 *  latest geometry wins. The node coalesces too; this keeps the wire sane. */
const REPLACE_INTERVAL_MS = 100;

/** No-exposure watchdog: a run with no OK marker push for this many periods
 *  warns once (spec §exposure-windows). */
const NO_OK_PERIODS = 2;

/** Unmatched-flip watchdog (spec §triangle-flip): over the last two periods
 *  (at least this long, so a slow scan still averages a few frames), more than
 *  this fraction of the flipped + unmatched frames being unmatched warns once
 *  per run; fewer frames than the floor never judge. */
const FLIP_WINDOW_MIN_MS = 500;
const UNMATCHED_WARN_FRACTION = 0.05;
const FLIP_WINDOW_MIN_FRAMES = 8;

/** Reasons `ScanTelemetry.mismatch_reason` names (spec §exposure-windows). */
const MISMATCH = {
  timedClamp: "Timed exposure clamped to the camera's exposure range",
  timedUnequal:
    "unequal windows: Timed exposure gives both the rising window's length",
  timedOverrun: "Timed exposure would run into the next trigger",
  rate: "trigger rate above the camera's maximum frame rate",
  readout: "exposures closer than the sensor readout",
  flip: "exposure windows too close for reliable flipping at this frequency",
  clockLapsed: "controller clock calibration lapsed",
  swapUnconfirmed:
    "replacement swap unconfirmed — the mirror may run the previous edit",
} as const;

/** A start / restart cancelled before its START went out (a stop or teardown
 *  was requested meanwhile) — undone quietly, never reported as a failure. */
class ScanCancelled extends Error {
  constructor() {
    super("scan start cancelled");
  }
}

/** Why a run that is no longer `running` ended (spec §lifecycle). */
const runEndReason = (state: NodeTrajectoryState): string =>
  state === "detached"
    ? "controller disconnected — scan stopped"
    : "the controller ended the trajectory run — scan stopped";

/** Physical saturation limits for the vergence DOF, in radians (the shared
 *  degree constants). The drawer's Verge/Shift sliders ARE these DOF, so their
 *  ranges are the controllers' limits (spec §targeting). */
const SHIFT_LIMIT = radians(SHIFT_LIMIT_DEG);
const VSHIFT_LIMIT = radians(VSHIFT_LIMIT_DEG);
/** Capture-epoch target ring capacity (>1 s of writes) + the control-dt cap in
 *  frame-units — disparity-scope's values (spec §control-law). */
const TARGET_RING_CAP = 256;
const DT_MAX_FRAMES = 4;
/** `seedVergence`'s parallel-ray guard (spec §seed-space). */
const SEED_PARALLEL_EPS = 1e-9;
/** Below this a `verge`/`shift` state write is the loop's own mirror, not a
 *  manual slider move — no re-seed. */
const DOF_EPS = 1e-9;

const errorLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];

export default function mirrorLinkSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  rawPipes: RawPipeRegistry,
  sliceSeam: SlicePipeSeam,
  scaleSeam: ScalePipeSeam,
  compressSeam?: CompressPipeSeam,
  flipSeam?: FlipPipeSeam,
): ServerSession<typeof mirrorLink> {
  return defineResourceSession("mirror-link", mirrorLink, (s) => {
    let triple: CalibratedTriple | null = null;
    let posInput: PositionInput | null = null;
    let stopActuation: (() => void) | null = null;

    const now = () => performance.now();

    // Scan CENTER — always whatever `steer` last set (spec §targeting).
    let target: Point2d = { x: 0, y: 0 };
    let targetAngle: Point2d = { x: 0, y: 0 };

    // Latest commanded voltages (the idle pose; held while the MCU scans).
    const volts: { L: Pos; R: Pos } = {
      L: { ...ORIGIN_POS },
      R: { ...ORIGIN_POS },
    };

    // --- the vergence DOF (spec §targeting) --------------------------------
    // The loop's three constrained DOF, all in MEASUREMENT-derivative mode
    // (spec disparity-scope §control-law). They are the SINGLE authority for
    // the commanded pose while engaged; the drawer sliders are while off.

    const MEAS_D = { derivativeOn: "measurement" } as const;
    const pan = new PID2D({ x: MEAS_D, y: MEAS_D });
    const verge = new PID({
      limits: [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, s.state.baseline)],
      ...MEAS_D,
    });
    const v_shift = new PID({
      limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT],
      ...MEAS_D,
    });
    const vergenceControllers: VergenceControllers = { pan, verge, v_shift };
    let vergenceEngaged = false;

    /** The DOF the pose chain reads. Engaged: the loop's integrators (the
     *  sliders mirror them at the write-back throttle). Off: the sliders, with
     *  no `pan` — a disengage folds the correction into the target ray, so the
     *  two branches agree across the transition. */
    function heldDof(): VergenceSeed {
      return vergenceEngaged
        ? { pan: pan.value, verge: verge.value, v_shift: v_shift.value }
        : {
            pan: { x: 0, y: 0 },
            verge: s.state.verge,
            v_shift: radians(s.state.shift),
          };
    }

    // --- targeting ---------------------------------------------------------

    /** Per-eye angles for a scan offset (zero offset = the idle/center pose).
     *  At zero offset this IS `followTarget`'s forward map (@lib/vergence) —
     *  the vergence loop's output and the scan ride ONE chain. */
    function anglesAt(offset: Point2d): { l: Point2d; r: Point2d } {
      const h = heldDof();
      return scanAngles(
        { x: targetAngle.x + h.pan.x, y: targetAngle.y + h.pan.y },
        offset,
        s.state.baseline,
        vergeToDistance(h.verge, s.state.baseline),
        h.v_shift,
      );
    }

    function voltsFor(angles: { l: Point2d; r: Point2d }): SlewPair {
      if (!triple) return { l: { ...ORIGIN_POS }, r: { ...ORIGIN_POS } };
      return { l: triple.conv.A2V.L(angles.l), r: triple.conv.A2V.R(angles.r) };
    }

    /** The offset-free per-eye angles (spec §targeting). */
    const centerAngles = (): { l: Point2d; r: Point2d } =>
      anglesAt({ x: 0, y: 0 });
    /** ...and as volts — the slew goal while idle and the L_PX/R_PX source. */
    const centerVolts = (): SlewPair => voltsFor(centerAngles());

    /** The scan's center ray in the WIDE angular frame — `A0 + pan`, the point
     *  every pattern offset rides on (spec §targeting); `pan` is 0 unless auto
     *  vergence is engaged. */
    function scanCenterAngle(): Point2d {
      const p = heldDof().pan;
      return { x: targetAngle.x + p.x, y: targetAngle.y + p.y };
    }

    /** The pattern family the state asks for (anything else reads as the
     *  ellipse; the `scan_mode` watch writes it back). */
    const scanMode = (): ScanMode =>
      s.state.scan_mode === "triangle" ? "triangle" : "ellipse";

    /** The pattern's shape parameters, sanitized (spec §scan-patterns). */
    function patternParams(): { axis: number; amp: number; ratio: number } {
      const amp = Number.isFinite(s.state.scan_amp) ? s.state.scan_amp : 0;
      const ratio = Number.isFinite(s.state.scan_ratio)
        ? s.state.scan_ratio
        : 1;
      return {
        axis: normalizeAxisDeg(s.state.scan_axis_deg),
        amp: Math.min(Math.max(amp, SCAN_AMP_RANGE.min), SCAN_AMP_RANGE.max),
        ratio: Math.min(
          Math.max(ratio, SCAN_RATIO_RANGE.min),
          SCAN_RATIO_RANGE.max,
        ),
      };
    }

    /** Wide-px projection of a commanded volt; {0,0} uncalibrated (A2P.C needs
     *  the center intrinsic). */
    function projectPx(side: Side, v: Pos): Point2d {
      if (!triple?.undistort) return { x: 0, y: 0 };
      return triple.conv.A2P.C(triple.conv.V2A[side](v), false);
    }

    /** Commanded volts are clamped to the controller's envelope before they
     *  reach the wire (controller-codec); the drawn path says the same. */
    function clampVolt(v: Pos): Pos {
      const lim = activeController()?.dv ?? DEFAULT_DV;
      return {
        x: Math.min(Math.max(v.x, -lim), lim),
        y: Math.min(Math.max(v.y, -lim), lim),
      };
    }

    /** The scan's DRAWABLE geometry (spec §views): the commanded path in volt
     *  space per eye, and — calibrated — the same path, its exposed windows and
     *  the axis handle in wide px, all off the EXACT chain the trajectory is
     *  built from. Recomputed on every input that moves or reshapes the
     *  pattern — never per pacer tick — and, while scanning, the same inputs
     *  re-upload the trajectory (throttled), so the re-upload rides here. */
    function publishScanGeometry(): void {
      const t = triple;
      if (!t) {
        s.telemetry({
          scan_path: { L: [], R: [] },
          scan_path_px: [],
          scan_path_closed: false,
          scan_window_px: [],
          scan_center_px: { x: 0, y: 0 },
          axis_handle_px: { x: 0, y: 0 },
        });
        return;
      }
      const mode = scanMode();
      const g = patternParams();
      const path = patternPath(mode, g.axis, g.amp, g.ratio, SCAN_PATH_SAMPLES);
      const L: Pos[] = [];
      const R: Pos[] = [];
      for (const o of path.offsets) {
        // The SAME chain the trajectory samples ride: offset → inverseTriangulate
        // + shift → A2V, clamped to the mirror's range like every commanded
        // pose — the drawn path is the path the mirror can actually take.
        const pose = voltsFor(anglesAt(o));
        L.push(clampVolt(pose.l));
        R.push(clampVolt(pose.r));
      }
      let pathPx: Point2d[] = [];
      let windowPx: Point2d[][] = [];
      let centerPx: Point2d = { x: 0, y: 0 };
      let handlePx: Point2d = { x: 0, y: 0 };
      if (t.undistort) {
        const c = scanCenterAngle();
        const px = (o: Point2d): Point2d =>
          t.conv.A2P.C({ x: c.x + o.x, y: c.y + o.y }, false);
        pathPx = path.offsets.map(px);
        windowPx = appliedWindowPx(px);
        centerPx = px({ x: 0, y: 0 });
        // At max(amp, ε): the handle encodes the axis even at amplitude 0.
        handlePx = px(
          axisHandleOffset(g.axis, Math.max(g.amp, AXIS_HANDLE_MIN_DEG)),
        );
      }
      // ONE patch: the path, its closing rule and its center travel together,
      // so the renderer never pairs a new path with an old rule.
      s.telemetry({
        scan_path: { L, R },
        scan_path_px: pathPx,
        scan_path_closed: path.closed,
        scan_window_px: windowPx,
        scan_center_px: centerPx,
        axis_handle_px: handlePx,
      });
      scheduleReplace();
    }

    /** The exposed stretches in wide px through `px`: what the cameras
     *  expose — the Timed fallback gives every window marker 0's pulse, kept
     *  inside its slope (clamped), so the drawn windows are the APPLIED ones. */
    function appliedWindowPx(px: (o: Point2d) => Point2d): Point2d[][] {
      const mode = scanMode();
      const hz = clampHz(s.state.scan_hz);
      const g = patternParams();
      const markers = scanMarkers(mode, hz).markers;
      return windowPaths(
        mode,
        hz,
        g.axis,
        g.amp,
        g.ratio,
        markers,
        SCAN_PATH_SAMPLES,
      ).map((seg) => seg.map(px));
    }

    /** The applied Timed exposure moved (arm, retime, disarm) without a
     *  geometry input: republish the drawn windows alone. */
    function publishAppliedWindows(): void {
      const t = triple;
      if (!t?.undistort) return;
      const c = scanCenterAngle();
      s.telemetry({
        scan_window_px: appliedWindowPx((o) =>
          t.conv.A2P.C({ x: c.x + o.x, y: c.y + o.y }, false),
        ),
      });
    }

    function setTargetFromPixel(px: Point2d): void {
      target = px;
      targetAngle = triple?.undistort
        ? triple.undistort.angular([px], false)[0]
        : { x: 0, y: 0 };
      // Every target write feeds the capture-epoch ring (spec §control-law) —
      // the join pairs each matched frame with the target as of ITS capture.
      recordTarget(
        targetRing,
        { t: Number(hostNowNs()), target },
        TARGET_RING_CAP,
      );
      // A steer RE-REFERENCES the loop: the new ray is the new intent, so the
      // accumulated common-mode correction is dropped (the drag re-affirm
      // semantics) and the match strip follows the new center.
      pan.value = { x: 0, y: 0 };
      steerStrip();
      s.telemetry({ target, target_angle: targetAngle });
      publishScanGeometry();
    }

    // --- scan lifecycle (spec §lifecycle) ----------------------------------
    // Session-local INTENT: never persisted, never auto-resumed on re-entry.
    // The pattern runs on the MCU as THE controller node's uploaded trajectory
    // (spec §actuation); its markers trigger both foveas at exact phases and
    // each OK marker push comes back with trusted timestamps.

    let scanActive = false;
    /** False from idle start until the next activate: a queued start must not
     *  re-arm the cameras while teardown drains. */
    let scanAllowed = false;
    /** `stopScan` commands whose stop op has not run yet. Non-zero means a stop
     *  was REQUESTED: a start/restart in flight must not send its START (spec
     *  §lifecycle). A count, not a boolean, so two quick stops cannot clear
     *  each other's request. */
    let stopsPending = 0;
    /** FIFO mutex over the lease timing config AND the trajectory: a fast
     *  toggle must not interleave an apply with an in-flight restore, nor a
     *  re-upload with a restart (manual-control's idiom). */
    const queueScanOp = createTriggerOpChain((e) =>
      console.error("[mirror-link] scan op failed:", e),
    );

    function publishScanBlocked(reason: string | null): void {
      s.telemetry({ scan_blocked: reason });
    }

    /** Local mirror of the published `scan` readout — the runtime doesn't hand
     *  back the last telemetry object, and capture metadata reads it. */
    let activeScan: ScanTelemetry | null = null;

    // -- the trajectory run --------------------------------------------------

    /** A built pattern: the spec the MCU runs, plus the markers as the WINDOWS
     *  ask for them (`raw`) — they differ only in the Timed fallback, where
     *  every marker carries marker 0's applied exposure, kept inside its
     *  slope (`overrun`: it still ran into the next trigger and was clamped).
     *  `amp` is the amplitude the samples were built for (`scan.amp_deg`
     *  publishes the RUNNING one, not the edited one). */
    type BuiltScan = {
      mode: ScanMode;
      hz: number;
      amp: number;
      spec: TrajectorySpec;
      raw: WindowMarker[];
      overrun: boolean;
    };

    let trajectory: NodeTrajectory | null = null;
    let trajectoryUnsubs: Array<() => void> = [];
    /** The spec the MCU runs NOW (after the last successful start/replace),
     *  and the window markers it was built from. */
    let runSpec: TrajectorySpec | null = null;
    let runRaw: WindowMarker[] = [];
    /** The amplitude (°) `runSpec` was built for — a failed replace leaves it
     *  at the value the MCU plays. */
    let runAmp = 0;
    /** The run's Timed markers overran the next trigger (a mismatch). */
    let runOverrun = false;
    let runMode: ScanMode = "ellipse";
    let runHz = 0;
    /** The run's EXPLICIT host-steady start instant — lateness is exact
     *  against it, and `replace` carries it (the phase continues). Host ns
     *  under the controller's MCU→host offset AT THE START; when a 30 s
     *  re-ping moves the offset, `rebaseRunStart` shifts it by the same
     *  difference (the MCU instant is what the START carried, so the view
     *  follows the new offset instead of stepping `lateness_us`). */
    let runStartNs = 0n;
    /** The controller offset `runStartNs` is expressed under. */
    let runStartOffsetNs = 0n;
    /** Re-express `runStartNs` under the controller's CURRENT offset — every
     *  push timestamp rides that offset, so the two must agree. */
    function rebaseRunStart(): void {
      const offset = activeController()?.clockOffsetNs;
      if (typeof offset !== "bigint" || offset === runStartOffsetNs) return;
      runStartNs += offset - runStartOffsetNs;
      runStartOffsetNs = offset;
    }
    /** ...and the same instant on `now()`'s clock, for the watchdogs. */
    let runStartMs = 0;
    /** A `replace` is in flight: its own failure transition (`running →
     *  ready`) is judged by `replaceNow` once the swap settles. */
    let replacing = false;
    /** The spec of the in-flight replace — pushes from a table id this run
     *  has not seen yet belong to it (the new table, mid-swap). */
    let pendingSpec: TrajectorySpec | null = null;
    /** MCU table id → the spec it runs, for THIS run: a push is scored (and
     *  its anchor's pulse taken) against the table that produced it, also
     *  for the old table's late pushes in the swap grace (spec §actuation).
     *  A retired table's entry carries `untilNs` — the controller's grace
     *  rule (`trajectoryGraceUs`) from the swap on; past it the id may be
     *  ALLOCATED AGAIN (ids alternate), so an expired entry is ignored and a
     *  push from the reallocated id resolves to the in-flight spec. The live
     *  table's entry has `untilNs = null`. */
    const specById = new Map<
      number,
      { spec: TrajectorySpec; untilNs: bigint | null }
    >();

    const specLive = (e: { untilNs: bigint | null }, at: bigint): boolean =>
      e.untilNs === null || at <= e.untilNs;

    /** `id` now runs `spec` (a start, or the new table of a swap). */
    function rememberSpec(
      id: number | null | undefined,
      spec: TrajectorySpec,
    ): void {
      if (id === null || id === undefined) return;
      const at = hostNowNs();
      for (const [k, e] of specById) if (!specLive(e, at)) specById.delete(k);
      specById.set(id, { spec, untilNs: null });
    }

    /** Ids a FAILED swap left routed as possibly-live siblings (the
     *  controller's ambiguous row): their entries never expire on their own —
     *  the next landed swap, a failed pair swap that STOPped them
     *  (`TrajectoryReplaceError.retiredSiblings`) or the run's end retires
     *  them (an atomic START replaces whichever table plays; the STOP/START
     *  pair and stop() STOP each sibling). While any exists, `mismatch` names
     *  the unconfirmed swap and an edit back to the running geometry still
     *  swaps. */
    const siblingIds = new Set<number>();

    /** A failed swap left its NEW table id routed (`TrajectoryReplaceError.
     *  replacement`): score its pushes against the spec IT carries — for the
     *  controller's grace when it can never be live, open-ended while it may
     *  be (spec §actuation: every push scored against the table that ran). */
    function rememberFailedReplacement(
      rep: { id: number; maybeLive: boolean } | null,
      spec: TrajectorySpec,
    ): void {
      if (!rep) return;
      if (rep.maybeLive) {
        siblingIds.add(rep.id);
        specById.set(rep.id, { spec, untilNs: null });
      } else {
        specById.set(rep.id, {
          spec,
          untilNs: hostNowNs() + BigInt(trajectoryGraceUs(spec)) * 1000n,
        });
      }
    }

    /** A swap landed (no sibling plays any more — replaced by the atomic
     *  START or STOPped by the pair): their entries stay valid for their
     *  grace only. */
    function retireSiblingSpecs(): void {
      for (const id of siblingIds) {
        const e = specById.get(id);
        if (e) retireSpec(id, e.spec);
      }
      siblingIds.clear();
    }

    /** A swap landed: the OLD table's entry stays valid for its grace only. */
    function retireSpec(
      id: number | null | undefined,
      spec: TrajectorySpec,
    ): void {
      if (id === null || id === undefined) return;
      const e = specById.get(id);
      if (e) e.untilNs = hostNowNs() + BigInt(trajectoryGraceUs(spec)) * 1000n;
    }

    /** The spec that produced push `f` (see {@link specById}). */
    function specFor(f: TrajectoryFrameOutcome): TrajectorySpec | null {
      const e = specById.get(f.trajectoryId);
      if (e && specLive(e, hostNowNs())) return e.spec;
      return replacing && pendingSpec ? pendingSpec : runSpec;
    }

    /** The Timed fallback's ONE exposure (µs), the pulse every marker then
     *  carries so the firmware's per-marker strobe timeout matches what the
     *  camera exposes (spec §exposure-windows); null in TriggerWidth (or
     *  unarmed). The longer eye's value should a clamp differ. */
    function timedPulseUs(): number | null {
      if (!applied) return null;
      if (
        applied.L.exposure_mode !== "Timed" &&
        applied.R.exposure_mode !== "Timed"
      )
        return null;
      const us = Math.max(applied.L.exposure_us, applied.R.exposure_us);
      return Math.max(1, Math.round(us));
    }

    /** The trigger markers for the current windows: `raw` as the windows ask,
     *  `markers` as the MCU runs them (Timed: equal pulses, each kept inside
     *  its slope — scan.ts `timedWindowMarkers`). `timedPulse` overrides the
     *  applied Timed exposure (a growing retime swaps the table FIRST, with
     *  the exposure the camera is about to take). */
    function scanMarkers(
      mode: ScanMode,
      hz: number,
      timedPulse: number | null = timedPulseUs(),
    ): { raw: WindowMarker[]; markers: WindowMarker[]; overrun: boolean } {
      const raw = windowMarkers(mode, hz, activeWindows(mode, s.state));
      if (timedPulse === null) return { raw, markers: raw, overrun: false };
      const t = timedWindowMarkers(mode, hz, raw, timedPulse);
      return { raw, markers: t.markers, overrun: t.overrun };
    }

    /**
     * The pattern as a `TrajectorySpec` (spec §actuation): every sample through
     * the EXACT chain — `voltsFor(anglesAt(offset))`, clamped like every
     * commanded pose — never a linearization; one marker per exposure window
     * (`windowMarkers`), triggering BOTH foveas. `step` stays false: the MCU's
     * linear interpolation between samples (wrapping last → first) is what
     * turns the triangle's two samples into the sweep.
     */
    function buildScan(timedPulse?: number): BuiltScan {
      const mode = scanMode();
      const hz = clampHz(s.state.scan_hz);
      const g = patternParams();
      const samples = patternSamples(mode, hz, g.axis, g.amp, g.ratio).map(
        ({ tOffsetUs, offset }) => {
          const v = voltsFor(anglesAt(offset));
          return { tOffsetUs, left: clampVolt(v.l), right: clampVolt(v.r) };
        },
      );
      const { raw, markers, overrun } =
        timedPulse === undefined
          ? scanMarkers(mode, hz)
          : scanMarkers(mode, hz, timedPulse);
      return {
        mode,
        hz,
        amp: g.amp,
        raw,
        overrun,
        spec: {
          periodUs: patternPeriodUs(mode, hz),
          samples,
          markers: markers.map((m) => ({
            tOffsetUs: m.tOffsetUs,
            pulseUs: m.pulseUs,
            cameras: ["L", "R"] as ("L" | "R")[],
          })),
          step: false,
        },
      };
    }

    const sameSpec = (a: TrajectorySpec, b: TrajectorySpec): boolean =>
      JSON.stringify(a) === JSON.stringify(b);

    // -- perf.trajectory -----------------------------------------------------

    const pushes = { ok: 0, timeout: 0, busy: 0, other: 0 };
    let latenessUs = 0;
    let reuploads = 0;
    let lastSwap: TrajectoryTelemetry["last_swap"] = null;
    let lastOkMs = 0;
    /** No OK push for {@link NO_OK_PERIODS} periods of the active run — the
     *  no-OK watchdog's condition, `perf.trajectory.stalled` (see
     *  {@link watchNoOk}). */
    let stalled = false;
    /** Flip counters for THIS run: `base` holds what retired bricks counted
     *  (a tolerance change or a restart rebuilds them), `flipCounts` is base +
     *  the live bricks' own counters (spec §triangle-flip). */
    const flipBase = {
      flipped: { L: 0, R: 0 },
      unmatched: { L: 0, R: 0 },
    };
    const flipCounts = {
      flipped: { L: 0, R: 0 },
      unmatched: { L: 0, R: 0 },
    };
    /** Last matched-frame skew per eye (µs) — kept across probes that matched
     *  nothing (the brick reports 0 then, which is not a measurement). */
    let flipSkewUs = { L: 0, R: 0 };
    /** Each live brick's counters at the previous probe (matched-delta gate). */
    const lastProbe: Partial<
      Record<Side, { frames: number; unmatched: number }>
    > = {};
    /** Summed flip counters over recent probes — the unmatched watchdog's window. */
    let flipWindow: { at: number; flipped: number; unmatched: number }[] = [];
    // Each failure family warns once per run.
    let warnedNoOk = false;
    let warnedUnmatched = false;
    let warnedReplace = false;
    let warnedMismatch = false;
    let warnedNoFlipSeam = false;

    /** A new scan: counters and once-per-run warnings start over. Called by
     *  `startScanNow` only (and on idle) — a restart / brick rebuild within a
     *  run keeps counting. */
    function resetRunStats(): void {
      pushes.ok = pushes.timeout = pushes.busy = pushes.other = 0;
      latenessUs = 0;
      reuploads = 0;
      lastSwap = null;
      lastOkMs = 0;
      stalled = false;
      flipBase.flipped = { L: 0, R: 0 };
      flipBase.unmatched = { L: 0, R: 0 };
      flipCounts.flipped = { L: 0, R: 0 };
      flipCounts.unmatched = { L: 0, R: 0 };
      flipSkewUs = { L: 0, R: 0 };
      flipWindow = [];
      warnedNoOk = warnedUnmatched = warnedReplace = warnedMismatch = false;
    }

    function trajectoryPerf(): TrajectoryTelemetry {
      return {
        running: scanActive && trajectory?.state === "running",
        pushes: { ...pushes },
        lateness_us: latenessUs,
        reuploads,
        flipped: { ...flipCounts.flipped },
        unmatched: { ...flipCounts.unmatched },
        skew_us: { ...flipSkewUs },
        flip_tolerance_us:
          flips.L || flips.R ? Number(flipToleranceNs) / 1000 : 0,
        last_swap: lastSwap,
        stalled: scanActive && stalled,
      };
    }

    /** Every push of THE run's tables (spec §exposure-windows). OK pushes are
     *  the exposure ground truth: the flip anchor goes out FIRST, synchronously
     *  — the flip brick never holds a frame back, so a frame processed before
     *  its anchor arrived passes unflipped (spec §triangle-flip). The anchor
     *  carries BOTH exposure edges — `tExposure` and `tExposure + pulse` of
     *  that marker in the table that pushed it — so the brick matches whichever
     *  edge the camera stamps its frames with. */
    function onTrajectoryFrame(f: TrajectoryFrameOutcome): void {
      const spec = specFor(f);
      const m = f.marker !== null ? spec?.markers?.[f.marker] : undefined;
      if (f.status === "OK") {
        if (f.marker !== null && (flips.L || flips.R)) {
          const anchor: FlipAnchor = {
            tStart: f.tExposure,
            tEnd: f.tExposure + BigInt(m?.pulseUs ?? 0) * 1000n,
            flip: f.marker === 1,
          };
          flips.L?.pushAnchor(anchor);
          flips.R?.pushAnchor(anchor);
        }
        pushes.ok++;
        lastOkMs = now();
        if (m && spec) {
          rebaseRunStart();
          latenessUs =
            Number(
              f.tTrigger -
                expectedTriggerNs(
                  runStartNs,
                  f.cycle,
                  spec.periodUs,
                  m.tOffsetUs,
                ),
            ) / 1000;
        }
        // The stall clears at once (not at the throttle) — AFTER the lateness
        // update, so the republish carries this push's figure.
        if (stalled) {
          stalled = false;
          publishPerf();
        }
        return;
      }
      if (f.status === "STROBE_TIMEOUT") pushes.timeout++;
      else if (f.status === "BUSY") pushes.busy++;
      else pushes.other++; // run-level ENDED / CANCELLED, UNKNOWN
    }

    /** The run ended under us (controller unbound/swapped, or the MCU ended or
     *  cancelled it): the scan is over — restore and say why. Ignored before
     *  the start commits (`startScanNow` re-checks the state at its commit
     *  point) and, during a replace, the `ready` the failed swap itself causes
     *  (`replaceNow` re-checks once the swap settles); a `detached` mid-swap
     *  queues the abort right away (it runs after the replace op). */
    function onTrajectoryState(
      traj: NodeTrajectory,
      state: NodeTrajectoryState,
    ): void {
      if (traj !== trajectory || !scanActive) return;
      if (state === "running" || state === "uploading") return;
      if (replacing && state === "ready") return;
      void queueScanOp(() => abortScanNow(runEndReason(state), traj));
    }

    /** The controller clock's calibration lapsed mid-scan (two missed 30 s
     *  re-pings): every timestamp the scan scores rides that offset, so it is
     *  a `mismatch_reason` — not a stop (the MCU's own phase is unaffected).
     *  Re-evaluated at the telemetry throttle; republished on a change. */
    let clockLapsed = false;
    function watchClock(): void {
      const lapsed = activeController()?.clockCalibrated === false;
      if (lapsed === clockLapsed) return;
      clockLapsed = lapsed;
      publishScanTelemetry();
    }

    /** No OK push for {@link NO_OK_PERIODS} periods → `stalled` (the status
     *  line's amber, spec §views) and one warning per run. Re-evaluated at the
     *  telemetry throttle, whose `perf` patch republishes it; the next OK push
     *  clears it at once. */
    function watchNoOk(tick: number): void {
      if (!scanActive || !runSpec) return;
      const since = Math.max(lastOkMs, runStartMs);
      stalled = tick - since > (NO_OK_PERIODS * runSpec.periodUs) / 1000;
      if (!stalled || warnedNoOk) return;
      warnedNoOk = true;
      report(
        "mirror-link",
        `no fovea exposure confirmed for ${NO_OK_PERIODS} scan periods ` +
          `(${pushes.timeout} strobe timeouts, ${pushes.busy} busy) — check the trigger/strobe cabling ` +
          `(a missed strobe keeps the capture engine busy past the next trigger when the gap ` +
          `after the window is under 5 ms, so BUSY pushes follow strobe timeouts)`,
        "warning",
      );
    }

    /** Fold one eye's live brick counters into the run's (base + live), and
     *  take its matched-frame skew when it matched anything since last time. */
    function foldProbe(side: Side, p: FlipProbe): void {
      flipCounts.flipped[side] = flipBase.flipped[side] + p.flipped;
      flipCounts.unmatched[side] = flipBase.unmatched[side] + p.unmatched;
      const prev = lastProbe[side] ?? { frames: 0, unmatched: 0 };
      const matched = p.frames - p.unmatched - (prev.frames - prev.unmatched);
      if (matched > 0 && Number.isFinite(p.matchedSkewNs))
        flipSkewUs[side] = p.matchedSkewNs / 1000;
      lastProbe[side] = { frames: p.frames, unmatched: p.unmatched };
    }

    /** Read the flip bricks' counters and judge the unmatched share over the
     *  last two periods (spec §triangle-flip). */
    function probeFlips(tick: number): void {
      if (!flips.L && !flips.R) return;
      for (const side of SIDES) {
        const p = flips[side]?.probe();
        if (p) foldProbe(side, p);
      }
      const sample = {
        at: tick,
        flipped: flipCounts.flipped.L + flipCounts.flipped.R,
        unmatched: flipCounts.unmatched.L + flipCounts.unmatched.R,
      };
      flipWindow.push(sample);
      const span = Math.max(
        FLIP_WINDOW_MIN_MS,
        (2 * (runSpec?.periodUs ?? 0)) / 1000,
      );
      // Keep the NEWEST sample at least `span` old as the window base.
      while (flipWindow.length > 2 && tick - flipWindow[1]!.at >= span)
        flipWindow.shift();
      const base = flipWindow[0]!;
      if (warnedUnmatched || tick - base.at < span) return;
      const dU = sample.unmatched - base.unmatched;
      const dF = sample.flipped - base.flipped;
      if (
        dU + dF < FLIP_WINDOW_MIN_FRAMES ||
        dU <= UNMATCHED_WARN_FRACTION * (dU + dF)
      )
        return;
      warnedUnmatched = true;
      report(
        "mirror-link",
        `falling-sweep frames arriving before their marker push — they are shown unflipped ` +
          `(${dU} of ${dU + dF} unmatched over the last ${(span / 1000).toFixed(1)} s)`,
        "warning",
      );
    }

    /** Open + START one run of `built`. `cancelled` is checked right before
     *  the START goes out: a stop or teardown requested meanwhile throws
     *  {@link ScanCancelled} instead (the caller undoes the open). */
    async function runTrajectory(
      built: BuiltScan,
      cancelled: () => boolean,
    ): Promise<void> {
      const traj = await controllerNode().openTrajectory(built.spec, {
        name: "mirror-link",
      });
      trajectory = traj;
      runSpec = built.spec;
      runRaw = built.raw;
      runAmp = built.amp;
      runOverrun = built.overrun;
      runMode = built.mode;
      runHz = built.hz;
      specById.clear();
      rememberSpec(traj.id, built.spec);
      trajectoryUnsubs.push(
        traj.onFrame(onTrajectoryFrame),
        traj.onStateChange((state) => onTrajectoryState(traj, state)),
      );
      // The flip bricks exist BEFORE the first trigger: the first falling frame
      // must already find its brick (spec §triangle-flip).
      const tol = flipTolerance(built);
      flipTooClose = built.mode === "triangle" && tol.tooClose;
      syncFlips(built.mode === "triangle", tol.ns);
      if (cancelled()) throw new ScanCancelled();
      // An EXPLICIT start instant: lateness is exact and replace carries the
      // phase from it (spec controller.md#trajectory-ownership).
      const at = hostNowNs() + SCAN_START_LEAD_NS;
      runStartNs = at;
      runStartOffsetNs = activeController()?.clockOffsetNs ?? 0n;
      runStartMs = now() + Number(SCAN_START_LEAD_NS) / 1e6;
      lastOkMs = 0;
      stalled = false;
      warnedNoOk = false;
      warnedUnmatched = false;
      flipWindow = [];
      await traj.start(at);
    }

    /** Stop + close THE run's table (best-effort: the device may be gone). */
    async function closeTrajectory(): Promise<void> {
      const traj = trajectory;
      trajectory = null;
      runSpec = null;
      runRaw = [];
      runOverrun = false;
      pendingSpec = null;
      specById.clear();
      siblingIds.clear();
      for (const u of trajectoryUnsubs.splice(0)) u();
      if (!traj) return;
      try {
        await traj.stop();
      } catch {
        // best-effort — close() stops a running table too
      }
      try {
        await traj.close();
      } catch {
        // best-effort — the controller may already be gone
      }
    }

    // -- the triangle flip (spec §triangle-flip) -----------------------------

    const flips: Partial<Record<Side, FlipHandle>> = {};
    let flipToleranceNs = 0n;
    /** The run's windows are too close for the tolerance floor (a mismatch). */
    let flipTooClose = false;

    /** The run's flip tolerance (scan.ts `flipToleranceUs`: 0.4 × min(T,
     *  closest circular EDGE gap between markers of different flip), floored
     *  at 1 ms, capped at 0.45 × that gap), in ns, that cap (`capNs`), and
     *  whether the floor had to give way to the cap. The edges are the markers
     *  AS THE MCU RUNS THEM — the anchors carry exactly those. */
    function flipTolerance(built: BuiltScan): {
      ns: bigint;
      capNs: bigint;
      tooClose: boolean;
    } {
      const r = flipToleranceUs(
        built.spec.periodUs,
        sweepUs(built.hz),
        flipEdges(built.spec.markers ?? []),
      );

      return {
        ns: BigInt(Math.round(r.toleranceUs * 1000)),
        capNs: BigInt(Math.round(r.capUs * 1000)),
        tooClose: r.tooClose,
      };
    }

    /** The flip source's pipe spec: the broker's own record of the advertised
     *  convert pipe (connected just long enough to read it), else the spec the
     *  convert pipe is advertised with (`cameraPipeSpec`). */
    function sourcePipeSpec(cam: CameraLease["camera"]): PipeSpec {
      const id = nodeId.convert(cam.serial);
      try {
        const handle = broker.connect(id);
        try {
          if (handle?.spec) return { ...handle.spec, id };
        } finally {
          broker.disconnect(id);
        }
      } catch {
        // not connectable from here — fall back to the advertised shape
      }
      return cameraPipeSpec(cam);
    }

    /** Advertise + attach one flip brick per eye on its convert pipe (the
     *  source pipe's own spec — a flip changes no byte), publish
     *  `state.flipPipes`, and re-bind the ring reader. The bricks' graph rows
     *  are NATIVE (`Topology.report()`: kind "flip", the `frame` input from the
     *  convert pipe and — via `anchorFrom` — the `anchor` input from the
     *  trajectory node), so the session registers none. All or nothing: a
     *  failed eye retires the other and rethrows. */
    function buildFlips(t: CalibratedTriple, toleranceNs: bigint): void {
      if (!flipSeam) {
        if (!warnedNoFlipSeam) {
          warnedNoFlipSeam = true;
          report(
            "mirror-link",
            "triangle flip unavailable (no flip brick in this build) — falling-sweep frames are shown unflipped",
            "warning",
          );
        }
        return;
      }
      const built: Partial<Record<Side, FlipHandle>> = {};
      try {
        for (const side of SIDES) {
          const cam = t.leases[side].camera;
          built[side] = createFlipPipe(
            flipSeam,
            nodeId.convert(cam.serial),
            sourcePipeSpec(cam),
            nodeId.flip(cam.serial),
            { toleranceNs, anchorFrom: trajectoryNodeId() },
          );
        }
      } catch (e) {
        for (const side of SIDES) built[side]?.retire();
        throw e;
      }
      flips.L = built.L;
      flips.R = built.R;
      flipToleranceNs = toleranceNs;
      for (const side of SIDES) delete lastProbe[side]; // fresh bricks count from 0
      s.setState("flipPipes", { L: built.L!.pipeId, R: built.R!.pipeId });
      rebindRingNode();
    }

    /** The reverse, consumers first: the views fall back to the raw pipes
     *  (`flipPipes` → null), the reader lets go of the flip pipes, then the
     *  bricks retire (their final counters folded into the run's) and the
     *  reader re-binds the raw pipes. Best-effort per step — a stop path must
     *  always reach the camera restore after it. */
    function retireFlips(): void {
      if (!flips.L && !flips.R) return;
      const failures: string[] = [];
      const step = (what: string, fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          failures.push(`${what}: ${errorLine(e)}`);
        }
      };
      step("views", () => s.setState("flipPipes", { L: null, R: null }));
      const hadRing = ringNode !== null;
      if (hadRing) step("ring reader", disposeRingNode);
      for (const side of SIDES) {
        const h = flips[side];
        delete flips[side];
        if (!h) continue;
        step(`${side} probe`, () => {
          const p = h.probe();
          if (p) foldProbe(side, p);
        });
        flipBase.flipped[side] = flipCounts.flipped[side];
        flipBase.unmatched[side] = flipCounts.unmatched[side];
        delete lastProbe[side];
        step(`${side} retire`, () => h.retire());
      }
      // Teardown (`scanAllowed` already false) disposes the reader next anyway.
      if (hadRing && scanAllowed) step("ring reader", buildRingNode);
      if (failures.length)
        report(
          "mirror-link",
          `flip pipe retire incomplete: ${failures.join("; ")}`,
          "warning",
        );
    }

    /** Flip pipes exactly in triangle mode while scanning; a tolerance change
     *  (a new sweep time) rebuilds them — the brick takes it at attach. */
    function syncFlips(want: boolean, toleranceNs: bigint): void {
      const have = !!(flips.L || flips.R);
      if (have && (!want || toleranceNs !== flipToleranceNs)) retireFlips();
      if (want && !flips.L && !flips.R && triple)
        buildFlips(triple, toleranceNs);
    }

    // -- camera programming (spec §exposure-windows) -------------------------

    /** Pre-scan timing per eye, captured once at start and restored verbatim on
     *  stop / idle — the per-camera config docs are never touched. */
    const snapshots: Partial<Record<Side, TimingSnapshot>> = {};
    /** Eyes whose trigger mode was (or may have been partly) programmed. */
    const triggerArmed: Partial<Record<Side, true>> = {};
    /** What the cameras took, and the marker-0 pulse a Timed exposure was
     *  written for (TriggerWidth needs no write per window). */
    let applied: Record<Side, TriggeredTiming> | null = null;
    let appliedPulseUs = 0;
    /** Each fovea's maximum frame rate and readout time UNDER the triggered
     *  timing — read in the same reconfigure, right after it is applied (the
     *  pre-scan exposure caps the rate otherwise); the trigger rate and
     *  readout checks (spec §exposure-windows). */
    const limits: Record<Side, TimingLimits> = {
      L: UNKNOWN_LIMITS,
      R: UNKNOWN_LIMITS,
    };

    /** Snapshot (once) → trigger mode on (once) → triggered timing, on the
     *  lease's safe reconfigure path. */
    async function armEye(
      side: Side,
      lease: CameraLease,
      pulseUs: number,
      preferTriggerWidth: boolean,
    ): Promise<TriggeredTiming> {
      // Reads only — before the trigger write resets TriggerActivation.
      if (!snapshots[side]) snapshots[side] = snapshotTiming(lease.camera);
      if (!triggerArmed[side]) {
        triggerArmed[side] = true; // before the await: a partial write still needs the disable
        const r = await enableHardwareTrigger(lease);
        if (r.lineInverter)
          report(
            "mirror-link",
            `${side} strobe LineInverter not written: ${r.lineInverter}`,
            "warning",
          );
      }
      const box: { v?: TriggeredTiming } = {};
      await lease.reconfigure(() => {
        box.v = applyTriggeredTiming(lease.camera, {
          pulseUs,
          preferTriggerWidth,
        });
        limits[side] = readTimingLimits(lease.camera);
      });
      return box.v!;
    }

    /** Arm L then R. ONE exposure mode for both eyes: a Timed fallback on
     *  either re-applies the other as Timed, so both expose the same window. */
    async function armCameras(
      t: CalibratedTriple,
      pulseUs: number,
    ): Promise<Record<Side, TriggeredTiming>> {
      const a = {} as Record<Side, TriggeredTiming>;
      for (const side of SIDES)
        a[side] = await armEye(side, t.leases[side], pulseUs, true);
      if (a.L.exposure_mode !== a.R.exposure_mode)
        for (const side of SIDES)
          if (a[side].exposure_mode === "TriggerWidth")
            a[side] = await armEye(side, t.leases[side], pulseUs, false);
      return a;
    }

    /** Free-run again, then the pre-scan timing verbatim — best-effort per
     *  step AND per feature (the lease may be releasing); what did not land is
     *  reported once. MUST run while the leases are live. */
    async function disarmCameras(t: CalibratedTriple): Promise<void> {
      const failures: string[] = [];
      for (const side of SIDES) {
        const lease = t.leases[side];
        if (triggerArmed[side]) {
          try {
            await disableHardwareTrigger(lease);
          } catch (e) {
            failures.push(`${side} trigger off: ${errorLine(e)}`);
          }
          delete triggerArmed[side];
        }
        const snap = snapshots[side];
        if (snap) {
          try {
            await lease.reconfigure(() => {
              for (const f of restoreTiming(lease.camera, snap))
                failures.push(`${side} ${f}`);
            });
          } catch (e) {
            failures.push(`${side} restore: ${errorLine(e)}`);
          }
          delete snapshots[side];
        }
      }
      applied = null;
      appliedPulseUs = 0;
      limits.L = limits.R = UNKNOWN_LIMITS;
      publishAppliedWindows();
      if (failures.length)
        report(
          "mirror-link",
          `camera timing restore incomplete: ${failures.join("; ")}`,
          "warning",
        );
    }

    /** The marker-0 pulse the windows ask for moved: in TIMED mode the
     *  exposure itself moves (and with it every marker's pulse — the caller
     *  rebuilds the spec after); in TriggerWidth the pulse IS the exposure —
     *  nothing to write. */
    async function retimeIfNeeded(
      t: CalibratedTriple,
      pulse: number,
    ): Promise<void> {
      if (!applied || pulse === appliedPulseUs) return;
      if (
        applied.L.exposure_mode === "TriggerWidth" &&
        applied.R.exposure_mode === "TriggerWidth"
      ) {
        appliedPulseUs = pulse;
        return;
      }
      const a = {} as Record<Side, TriggeredTiming>;
      for (const side of SIDES)
        a[side] = await armEye(side, t.leases[side], pulse, false);
      applied = a;
      appliedPulseUs = pulse;
      publishAppliedWindows();
    }

    /** The Timed exposure the cameras WILL take for `pulse` (µs): clamped to
     *  each eye's exposure range, the longer eye's — what `timedPulseUs`
     *  reads once the write landed. */
    function predictTimedPulseUs(t: CalibratedTriple, pulse: number): number {
      let us = 0;
      for (const side of SIDES) {
        try {
          const r = t.leases[side].camera.exposure_range;
          us = Math.max(us, Math.min(Math.max(pulse, r.min), r.max));
        } catch {
          us = Math.max(us, pulse);
        }
      }
      return Math.max(1, Math.round(us));
    }

    /** Why the cameras cannot take the run's windows as asked (spec
     *  §exposure-windows), in priority order; empty when they can. */
    function mismatchReasons(timed: boolean): string[] {
      if (!runSpec || !applied) return [];
      const reasons: string[] = [];
      const markers = runSpec.markers ?? [];
      // A failed swap's table may be live: the MCU may run the abandoned
      // geometry (Timed: the camera deliberately keeps the shorter exposure,
      // so the clamp check would misreport it). Settled by the next landed
      // swap.
      const unconfirmed = siblingIds.size > 0;
      if (timed) {
        const want0 = runRaw[0]?.pulseUs ?? 0;
        if (
          !unconfirmed &&
          (exposureMismatch(applied.L.exposure_us, want0) ||
            exposureMismatch(applied.R.exposure_us, want0))
        )
          reasons.push(MISMATCH.timedClamp);
        if (runRaw.some((m) => exposureMismatch(want0, m.pulseUs)))
          reasons.push(MISMATCH.timedUnequal);
        if (runOverrun) reasons.push(MISMATCH.timedOverrun);
      }
      // One trigger per sweep T per camera, in both patterns.
      const maxFps = Math.min(limits.L.frame_rate_max, limits.R.frame_rate_max);
      if (Number.isFinite(maxFps) && 1e6 / sweepUs(runHz) > maxFps)
        reasons.push(MISMATCH.rate);
      // The readout: SensorReadoutTime where readable, else 1 / max fps.
      const readout = Math.max(
        readoutSpacingUs(limits.L),
        readoutSpacingUs(limits.R),
      );
      if (
        runMode === "triangle" &&
        readout > 0 &&
        minExposureEndSpacingUs(runSpec.periodUs, markers) < readout
      )
        reasons.push(MISMATCH.readout);
      if (runMode === "triangle" && flipTooClose) reasons.push(MISMATCH.flip);
      if (clockLapsed) reasons.push(MISMATCH.clockLapsed);
      if (unconfirmed) reasons.push(MISMATCH.swapUnconfirmed);
      return reasons;
    }

    /** Publish the applied scan (non-null exactly while active), with
     *  `mismatch` / `mismatch_reason` from {@link mismatchReasons} — warned
     *  once per run (re-armed when the mismatch clears). */
    function publishScanTelemetry(): void {
      if (!runSpec || !applied) return;
      const markers = runSpec.markers ?? [];
      const timed =
        applied.L.exposure_mode === "Timed" ||
        applied.R.exposure_mode === "Timed";
      const reasons = mismatchReasons(timed);
      const mismatch = reasons.length > 0;
      const reason = mismatch ? reasons.join("; ") : null;
      const scan: ScanTelemetry = {
        mode: runMode,
        hz: runHz,
        amp_deg: runAmp,
        period_us: runSpec.periodUs,
        windows: markers.map((m) => ({
          t_offset_us: m.tOffsetUs,
          pulse_us: m.pulseUs,
        })),
        exposure_mode: timed ? "Timed" : "TriggerWidth",
        exposure_us: { L: applied.L.exposure_us, R: applied.R.exposure_us },
        frame_rate: { L: applied.L.frame_rate, R: applied.R.frame_rate },
        mismatch,
        mismatch_reason: reason,
      };
      activeScan = scan;
      s.telemetry({ scan });
      if (!mismatch) {
        warnedMismatch = false;
        return;
      }
      if (warnedMismatch) return;
      warnedMismatch = true;
      const detail = timed
        ? ` (Timed fallback: L ${(applied.L.exposure_us / 1000).toFixed(2)} ms, ` +
          `R ${(applied.R.exposure_us / 1000).toFixed(2)} ms for ` +
          `${runRaw.map((m) => (m.pulseUs / 1000).toFixed(2)).join(" / ")} ms windows)`
        : "";
      report(
        "mirror-link",
        `the cameras cannot take the exposure windows as asked: ${reason}${detail}`,
        "warning",
      );
    }

    // -- start / stop / restart / re-upload ----------------------------------

    /** Undo a start that did not commit: the table, the flip pipes, then —
     *  ALWAYS — the cameras. */
    async function undoStart(t: CalibratedTriple): Promise<void> {
      try {
        await closeTrajectory();
        retireFlips();
      } finally {
        await disarmCameras(t);
      }
    }

    /** Edits that landed while a start/restart was awaiting (spec §lifecycle):
     *  a new mode or period restarts, anything else goes through a replace —
     *  UNCONDITIONALLY: a Timed pulse-only edit builds a spec identical to the
     *  running one (the markers carry the APPLIED exposure), and only
     *  `replaceNow` re-times the camera for it (it skips a true no-op). */
    function reconcileRun(): void {
      if (!scanActive || !runSpec) return;
      const now = buildScan();
      if (now.mode !== runMode || now.spec.periodUs !== runSpec.periodUs)
        void queueScanOp(restartScanNow);
      else scheduleReplace();
    }

    /**
     * Start (spec §lifecycle): a bound v2.2 controller with a calibrated
     * clock, then BOTH cameras armed (snapshot → trigger mode → triggered
     * timing), then the trajectory opened and STARTed at an explicit host
     * instant — unless a stop / teardown was requested meanwhile. Any failure
     * undoes what was done and refuses with the reason; a run that ended
     * while starting is a refusal too. Edits made during the awaits are
     * reconciled at the commit point. Serialized via {@link queueScanOp}.
     */
    async function startScanNow(): Promise<boolean> {
      if (scanActive) return true;
      if (!scanAllowed || !triple) {
        publishScanBlocked("no camera triple leased");
        return false;
      }
      const c = activeController();
      if (!c) {
        publishScanBlocked("no controller connected");
        return false;
      }
      if (!c.v22Capable) {
        publishScanBlocked("controller firmware >= 2.2.0 required");
        return false;
      }
      // Every trusted timestamp (marker pushes, flip anchors, lateness) rides
      // the MCU↔host offset — no scan on an unpinged or lapsed clock.
      if (!c.clockCalibrated) {
        publishScanBlocked("controller clock not calibrated yet");
        return false;
      }
      const t = triple;
      const cancelled = (): boolean =>
        !scanAllowed || triple !== t || stopsPending > 0;
      // A stop / teardown requested while this start was queued: the cameras
      // are never armed for it.
      if (cancelled()) return false;
      resetRunStats();
      clockLapsed = false;
      const pulse0 = buildScan().raw[0]?.pulseUs ?? 0;
      try {
        applied = await armCameras(t, pulse0);
        appliedPulseUs = pulse0;
      } catch (e) {
        await disarmCameras(t);
        publishScanBlocked(`exposure override failed: ${errorLine(e)}`);
        return false;
      }
      // Idled / re-leased / stopped while awaiting — undo, stay out.
      if (cancelled()) {
        await disarmCameras(t);
        return false;
      }
      try {
        // Built AFTER arming: a Timed fallback gives every marker its pulse.
        await runTrajectory(buildScan(), cancelled);
      } catch (e) {
        await undoStart(t);
        if (!(e instanceof ScanCancelled))
          publishScanBlocked(`trajectory start failed: ${errorLine(e)}`);
        return false;
      }
      if (cancelled()) {
        await undoStart(t);
        return false;
      }
      // The run may have ended during the START await (a CANCELLED push, a
      // detach) — the state listener ignores it before the commit.
      const traj = trajectory;
      if (!traj || traj.state !== "running") {
        const reason = runEndReason(traj?.state ?? "detached");
        await undoStart(t);
        publishScanBlocked(reason);
        report("mirror-link", reason, "warning");
        return false;
      }
      scanActive = true;
      pushRingEnabled();
      publishAppliedWindows();
      publishScanBlocked(null);

      publishScanTelemetry();
      publishPerf();
      reconcileRun();
      return true;
    }

    /** Stop (spec §lifecycle): the trajectory first (the node re-takes the DAC
     *  for the idle pose), the flip pipes, then the cameras back to free-run and
     *  their pre-scan timing — the camera restore runs whatever threw before
     *  it. The reader steps (enable off, readouts dropped) are best-effort:
     *  reported, never fatal to the stop. Serialized via {@link queueScanOp}.
     *  MUST run while the leases are live — the restore rides
     *  `lease.reconfigure`. */
    async function stopScanNow(): Promise<void> {
      const wasActive = scanActive;
      scanActive = false;
      const t = triple;
      try {
        cancelReplace();
        await closeTrajectory();
        retireFlips();
        for (const [what, fn] of [
          ["ring enable", pushRingEnabled],
          ["ring readout reset", resetRingTelemetry],
        ] as const)
          try {
            fn();
          } catch (e) {
            report(
              "mirror-link",
              `scan stop: ${what} failed: ${errorLine(e)}`,
              "warning",
            );
          }
      } finally {
        if (t) await disarmCameras(t);
        if (wasActive) {
          activeScan = null;
          s.telemetry({ scan: null });
        }
        publishPerf();
      }
    }

    /** The run ended under us: stop for good and say why. `traj` (when given)
     *  must still be THE run — a stale notice for a replaced table is moot. */
    async function abortScanNow(
      reason: string,
      traj?: NodeTrajectory,
    ): Promise<void> {
      if (!scanActive) return;
      if (traj && traj !== trajectory) return;
      await stopScanNow();
      publishScanBlocked(reason);
      report("mirror-link", reason, "warning");
    }

    /** A PERIOD change while active (`scan_hz`, `scan_mode`): replace cannot
     *  swap it, so stop → rebuild → start, keeping the camera config (only a
     *  Timed exposure is re-written, and only for a new pulse). A stop /
     *  teardown requested meanwhile takes the stop path instead of a START; a
     *  run that ended during the START aborts. Serialized via
     *  {@link queueScanOp}. */
    async function restartScanNow(): Promise<void> {
      const t = triple;
      if (!scanActive || !t) return;
      const cancelled = (): boolean =>
        !scanAllowed || triple !== t || stopsPending > 0;
      if (cancelled()) return stopScanNow();
      // The run may have ended (a detach whose notice is still queued behind
      // this op) or the clock lapsed: never re-open on either.
      const live = trajectory;
      if (!live || live.state !== "running")
        return abortScanNow(runEndReason(live?.state ?? "detached"));
      if (!activeController()?.clockCalibrated)
        return abortScanNow("controller clock not calibrated");
      let built = buildScan();
      if (
        runSpec &&
        built.mode === runMode &&
        built.spec.periodUs === runSpec.periodUs
      )
        return replaceNow(); // same period after all (e.g. a no-op write)
      cancelReplace();
      await closeTrajectory();
      try {
        await retimeIfNeeded(t, built.raw[0]?.pulseUs ?? 0);
        built = buildScan(); // a Timed re-write moves every marker's pulse
        await runTrajectory(built, cancelled);
      } catch (e) {
        if (e instanceof ScanCancelled) return stopScanNow();
        await abortScanNow(`scan restart failed: ${errorLine(e)}`);
        return;
      }
      const traj = trajectory;
      if (traj && traj.state !== "running") {
        await abortScanNow(runEndReason(traj.state), traj);
        return;
      }
      publishScanTelemetry();
    }

    // Live geometry → phase-continuous re-upload, ≤ 10 Hz, latest wins, and
    // at most ONE replace op queued at a time (a replace slower than the
    // throttle must not stack an op per steer event).
    let replaceTimer: ReturnType<typeof setTimeout> | null = null;
    let replacePending = false;
    let replaceQueued = false;
    let lastReplaceAt = -Infinity;

    /** Called by every geometry change: (re)arm the throttle timer; the spec is
     *  built when the op RUNS, so whatever arrived meanwhile wins. */
    function scheduleReplace(): void {
      if (!scanActive) return;
      replacePending = true;
      if (replaceTimer || replaceQueued) return; // the queued op will see it
      const wait = Math.max(0, lastReplaceAt + REPLACE_INTERVAL_MS - now());
      replaceTimer = setTimeout(() => {
        replaceTimer = null;
        if (!replacePending) return;
        replacePending = false;
        replaceQueued = true;
        lastReplaceAt = now(); // the throttle counts from QUEUE time
        void queueScanOp(async () => {
          // This op builds the spec NOW, so edits that arrived while it was
          // queued are covered; later ones arm the timer again.
          replaceQueued = false;
          replacePending = false;
          await replaceNow();
        });
      }, wait);
    }

    function cancelReplace(): void {
      if (replaceTimer) clearTimeout(replaceTimer);
      replaceTimer = null;
      replacePending = false;
    }

    /** Swap the running table for the current geometry (`NodeTrajectory.
     *  replace`, spec §actuation). A period change is the restart's job; an
     *  identical spec is skipped; a stop / teardown requested after this op
     *  was queued makes it moot. In Timed mode a new marker-0 window re-times
     *  the camera so that its exposure NEVER exceeds the MCU pulse (+ the
     *  strobe margin): a SHRINKING exposure is written before the swap, a
     *  GROWING one after it (the swapped-in table already carries the
     *  predicted exposure). A failed swap after a pre-swap write writes the
     *  previous exposure back — unless the new table MAY be live (the shorter
     *  exposure is safe under either). Once the swap settles (success or
     *  failure) a run that is no longer `running` aborts the scan; a failure
     *  that left it running keeps the old geometry (warned once) — or, when
     *  the new table may be live, an unconfirmed one (`mismatch` says so). */
    async function replaceNow(): Promise<void> {
      const traj = trajectory;
      const t = triple;
      if (!scanActive || !traj || !t || !runSpec) return;
      if (!scanAllowed || stopsPending > 0) return;
      let built = buildScan();
      if (built.mode !== runMode || built.spec.periodUs !== runSpec.periodUs)
        return;
      const pulse0 = built.raw[0]?.pulseUs ?? 0;
      const prevPulseUs = appliedPulseUs;
      let retimedBefore = false;
      let retimeAfter = false;
      if (applied && pulse0 !== appliedPulseUs) {
        const current = timedPulseUs();
        if (current === null) {
          await retimeIfNeeded(t, pulse0); // TriggerWidth: bookkeeping only
        } else {
          const next = predictTimedPulseUs(t, pulse0);
          if (next <= current) {
            try {
              await retimeIfNeeded(t, pulse0);
            } catch (e) {
              await abortScanNow(
                `exposure re-apply failed: ${errorLine(e)}`,
                traj,
              );
              return;
            }
            retimedBefore = true;
            built = buildScan();
          } else {
            built = buildScan(next);
            retimeAfter = true;
          }
        }
      }
      // Not while a failed swap's table MAY be live (`siblingIds`): the MCU
      // might run the abandoned geometry, so even the running spec must be
      // swapped in again to settle it (and, Timed, re-time the camera).
      if (sameSpec(built.spec, runSpec) && siblingIds.size === 0) {
        // Nothing for the MCU — but the REQUESTED windows may still have
        // changed (Timed: every marker carries marker 0's pulse, so a falling
        // END edit builds the same spec): the mismatch checks read them.
        runRaw = built.raw;
        runOverrun = built.overrun;
        publishScanTelemetry();
        return;
      }
      const oldId = traj.id;
      const oldSpec = runSpec;
      replacing = true;
      pendingSpec = built.spec;
      let error: unknown = null;
      let failed = false;
      try {
        await traj.replace(built.spec);
      } catch (e) {
        failed = true;
        error = e;
      } finally {
        replacing = false;
        pendingSpec = null;
      }
      if (trajectory !== traj) return;
      const ended =
        traj.state !== "running" ||
        (error instanceof TrajectoryReplaceError && !error.running);
      if (ended) {
        await abortScanNow(
          failed
            ? `live trajectory re-upload ended the run: ${errorLine(error)}`
            : runEndReason(traj.state),
          traj,
        );
        return;
      }
      if (failed) {
        if (!warnedReplace) {
          warnedReplace = true;
          const rep0 =
            error instanceof TrajectoryReplaceError ? error.replacement : null;
          report(
            "mirror-link",
            `live trajectory re-upload failed: ${errorLine(error)} — ` +
              (rep0?.maybeLive
                ? "the mirror may run either the previous or the new edit until the next edit lands"
                : "the scan keeps its previous geometry"),
            "warning",
          );
        }
        const rep =
          error instanceof TrajectoryReplaceError ? error.replacement : null;
        rememberFailedReplacement(rep, built.spec);
        // A failed PAIR swap STOPped earlier siblings: graced, not live.
        if (error instanceof TrajectoryReplaceError)
          for (const sid of error.retiredSiblings ?? []) {
            const e = specById.get(sid);
            if (e && siblingIds.delete(sid)) retireSpec(sid, e.spec);
          }
        // The camera took the shorter exposure of a swap that never landed:
        // back to the running table's (its MCU pulses still carry it). NOT
        // while the new table MAY be live: the shorter exposure is safe under
        // either table, the longer one would overrun its pulse.
        if (retimedBefore && !rep?.maybeLive)
          try {
            await retimeIfNeeded(t, prevPulseUs);
          } catch (e) {
            await abortScanNow(
              `exposure re-apply failed: ${errorLine(e)}`,
              traj,
            );
            return;
          }
        publishScanTelemetry();
        return;
      }
      runSpec = built.spec;
      runRaw = built.raw;
      runAmp = built.amp;
      runOverrun = built.overrun;
      if (traj.id !== oldId) retireSpec(oldId, oldSpec);
      retireSiblingSpecs();
      rememberSpec(traj.id, built.spec);
      reuploads++;
      // A growing Timed exposure: the MCU pulses are longer now — only now may
      // the camera expose longer. Should the camera take a different value than
      // predicted, the next replace swaps the markers onto it.
      if (retimeAfter) {
        const swappedPulse = built.spec.markers?.[0]?.pulseUs;
        try {
          await retimeIfNeeded(t, pulse0);
        } catch (e) {
          await abortScanNow(`exposure re-apply failed: ${errorLine(e)}`, traj);
          return;
        }
        if (timedPulseUs() !== swappedPulse) scheduleReplace();
      }
      // Atomic (firmware 2.2.1) or the STOP/START pair — the node's row says.
      lastSwap = controllerNode().trajectorySnapshot?.()?.lastSwap ?? lastSwap;
      // The flip bricks are rebuilt only when the tolerance in force is UNSAFE
      // (above the new cap) or STALE (below the floor that fits again, or
      // below half the new tolerance) — scan.ts `flipRebuildNeeded`, spec
      // §triangle-flip. In between they keep it: a dragged window must not
      // rebind the views and restart the ring worker on every replace.
      // `tooClose` follows the rule, not the brick. Both sides go through the
      // same ns rounding, so a brick built from this rule compares equal.
      const tol = flipTolerance(built);
      flipTooClose = runMode === "triangle" && tol.tooClose;
      const us = (ns: bigint): number => Number(ns) / 1000;
      if (
        runMode === "triangle" &&
        (flips.L || flips.R) &&
        flipRebuildNeeded(us(flipToleranceNs), {
          toleranceUs: us(tol.ns),
          capUs: us(tol.capNs),
          tooClose: tol.tooClose,
        })
      ) {
        try {
          syncFlips(true, tol.ns);
        } catch (e) {
          await abortScanNow(`flip pipe rebuild failed: ${errorLine(e)}`, traj);
          return;
        }
      }
      publishScanTelemetry();
    }

    // --- gain override (spec §gain) -----------------------------------------
    // Session-wide, not scan-scoped: aligning on a dim source needs it BEFORE
    // the scan. Same live-handle model as the exposure override — the
    // per-camera config docs are never written.

    /** Gain writes are allowed from the lease until teardown begins (like
     *  `scanAllowed`, which only turns on once the actuation is wired — a
     *  carried-over gain is applied before that). */
    let gainAllowed = false;
    /** Pre-session gain per eye, restored on idle. */
    const gainSnapshots: Partial<Record<Side, GainSnapshot>> = {};
    /** The range BOTH foveas honor; {0,0} until leased (slider disabled). */
    let gainRange = { min: 0, max: 0 };

    /** Drive both eyes to `dB`, clamped to the shared range — the clamped value
     *  goes back into state so the readout never shows a gain the hardware did
     *  not take. Serialized on {@link queueScanOp}. */
    async function applyGainNow(dB: number): Promise<void> {
      const t = triple;
      // Ignored once teardown began: it would land after the gain restore.
      if (!t || !gainAllowed || gainRange.min === gainRange.max) return;
      const want = Math.min(Math.max(dB, gainRange.min), gainRange.max);
      if (want !== s.state.gain) s.setState("gain", want);
      for (const side of SIDES) {
        const lease = t.leases[side];
        try {
          await lease.reconfigure(() => {
            if (!gainSnapshots[side])
              gainSnapshots[side] = snapshotGain(lease.camera);
            applyGain(lease.camera, want);
          });
        } catch (e) {
          report(
            "mirror-link",
            `gain override failed: ${errorLine(e)}`,
            "warning",
          );
        }
      }
    }

    /** Restore both eyes' pre-session gain, best-effort (the lease may be
     *  releasing). Runs AFTER the exposure restore. */
    async function restoreGainNow(): Promise<void> {
      const t = triple;
      for (const side of SIDES) {
        const snap = gainSnapshots[side];
        if (!snap) continue;
        if (t)
          try {
            await t.leases[side].reconfigure(() =>
              restoreGain(t.leases[side].camera, snap),
            );
          } catch {
            // best-effort — the lease may already be releasing
          }
        delete gainSnapshots[side];
      }
    }

    // --- ring reader (spec §reader) -----------------------------------------
    // An OPTIONAL node (`state.ring_reader`, default OFF): one vision worker
    // over the two fovea pipes — the RAW convert pipes, or the triangle scan's
    // FLIP pipes while they exist (spec §triangle-flip) — with the pixel work
    // further gated on the scan (an un-scanned frame holds no ring).

    let ringWorker: VisionWorkerHandle | null = null;
    let ringNode: { dispose(): void } | null = null;
    const ring: { L: RingReadout | null; R: RingReadout | null } = {
      L: null,
      R: null,
    };

    /** Carry the last SUCCESSFUL read through failures so the decoded value
     *  stays on screen while frames drop (spec ring-code.md §error recovery). */
    function mergeReadout(side: Side, next: RingReadout): RingReadout {
      if (next.ok) return next;
      const prev = ring[side];
      const last = prev?.ok
        ? { text: prev.text ?? "", hex: prev.hex ?? "" }
        : prev?.last;
      return last ? { ...next, last } : next;
    }

    function onRingResult(r: VisionResult): void {
      // The per-eye debug strips (spec §ring-views) ride the session frame
      // channels; the worker only emits them while a histogram is on screen.
      for (const f of r.frames) {
        const side = f.name.endsWith("-R") ? "R" : "L";
        s.frame(
          side === "R" ? "ring-R" : "ring-L",
          makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels),
        );
      }
      let changed = false;
      for (const side of SIDES) {
        const value = r.values[side] as RingReadout | undefined;
        if (!value) continue;
        ring[side] = mergeReadout(side, value);
        changed = true;
      }
      if (changed) s.telemetry({ ring: { L: ring.L, R: ring.R } });
    }

    /** The reader only runs while the scan does, and only builds debug strips
     *  while a histogram stage is selected; no node ⇒ nothing to push. */
    function pushRingEnabled(): void {
      ringWorker?.sendParams({
        enabled: scanActive,
        debug: s.state.ring_view !== "off",
      });
    }

    /** Drop the published readouts. The annotations assert a decode of THIS
     *  frame; once the scan stops, the frames are free-running and un-scanned,
     *  so keeping the last one on screen would be a lie. */
    function resetRingTelemetry(): void {
      if (!ring.L && !ring.R) return;
      ring.L = ring.R = null;
      s.telemetry({ ring: { L: null, R: null } });
    }

    /** Connect the two fovea pipes (the flip pipes while they exist, else the
     *  raw convert pipes), publish the node + its edges, and spawn the worker.
     *  Idempotent; a no-op without a leased triple. The flip transitions
     *  rebuild it in both directions ({@link rebindRingNode}). */
    function buildRingNode(): void {
      const t = triple;
      if (ringNode || !t) return;
      const node = nodeId.win("mirror-link", "ring");
      const pipeIds: string[] = [];
      const pipes: PipeInput[] = SIDES.map((side) => {
        const pipeId =
          flips[side]?.pipeId ?? nodeId.convert(t.leases[side].camera.serial);
        const handle = broker.connect(pipeId);
        pipeIds.push(pipeId);
        const { width, height, channels, bytesPerFrame, maxBytes } =
          handle.spec;
        return {
          role: side,
          shmName: handle.shmName,
          width,
          height,
          channels,
          bytesPerFrame: maxBytes ?? bytesPerFrame,
        };
      });
      const unregister = registerGraphWiring({
        nodes: [
          {
            id: node,
            kind: "ring",
            owner: "win/mirror-link",
            output: { kind: "analysis", schema: "ring" },
            transport: "worker",
          },
        ],
        edges: pipes.map((pipe, i) => ({
          from: pipeIds[i],
          to: node,
          port: pipe.role,
          type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" } as const,
        })),
      });
      ringWorker = createVisionWorker(
        {
          pipes,
          params: {
            kind: "ring",
            enabled: scanActive,
            debug: s.state.ring_view !== "off",
          },
          meterName: node,
        },
        onRingResult,
      );
      ringNode = {
        dispose() {
          // Stop reading BEFORE the consumer gate drops, and drop the profiler
          // row with the node it describes.
          ringWorker?.terminate();
          ringWorker = null;
          unregister();
          for (const id of pipeIds) broker.disconnect(id);
          ring.L = ring.R = null;
          s.telemetry({ ring: { L: null, R: null } });
        },
      };
    }

    function disposeRingNode(): void {
      const node = ringNode;
      ringNode = null;
      node?.dispose();
    }

    /** Re-bind an EXISTING reader to the current fovea pipes (a flip pipe came
     *  or went). No reader → nothing to do (it binds right when built). */
    function rebindRingNode(): void {
      if (!ringNode) return;
      disposeRingNode();
      buildRingNode();
    }

    // --- capture (spec §capture) --------------------------------------------
    // The offline ring analyzer's input: full-depth L/R fovea frames + the
    // undistorted center, with the scan/reader state alongside them.

    let captureHelper: CaptureHelper | null = null;
    let centerPipe: {
      shmName: string;
      maxBytes: number;
      channels: number;
    } | null = null;

    /** The scan + reader context an offline decode needs next to the pixels. */
    function mirrorLinkMeta(): Serializable {
      const t = triple;
      const A = t ? centerAngles() : null;
      const V = t ? centerVolts() : null;
      const g = patternParams();
      return {
        scan: activeScan,
        // The pattern the frames were exposed on. Capture reads the RAW pipes,
        // which the triangle flip does NOT touch: a falling-sweep frame is
        // stored as the camera saw it (spec §triangle-flip).
        pattern: {
          mode: scanMode(),
          axis_deg: g.axis,
          amp_deg: g.amp,
          ratio: g.ratio,
          windows: activeWindows(scanMode(), s.state),
        },
        ring: { L: ring.L, R: ring.R },
        shift: s.state.shift,
        "shift.unit": "degree",
        verge: s.state.verge,
        baseline: s.state.baseline,
        "baseline.unit": "millimeter",
        target_angle: { x: targetAngle.x, y: targetAngle.y },
        "target_angle.unit": "radian",
        // The CENTER pose's homographies — recorded for reference only; the
        // saved fovea frames are deliberately UNWARPED (see below).
        center_pose:
          t && V && A
            ? {
                volt: { L: V.l, R: V.r },
                angle: { L: A.l, R: A.r },
                H_L: Array.from(t.conv.A2H.L(A.l) as unknown as Float64Array),
                H_R: Array.from(t.conv.A2H.R(A.r) as unknown as Float64Array),
              }
            : null,
      } as Serializable;
    }

    /** One capture shot. IDENTITY homographies and a full-frame rect: a frame
     *  that integrated a stretch of the path has no single pose to warp against,
     *  and the un-warped ring IS the thing being debugged (spec §capture). */
    function captureSnapshot(reset: boolean, indexed: boolean): CaptureShot {
      const shot = rawTripleShot({
        reset,
        indexed,
        stackCount: Math.max(1, s.state.cap_stack),
        note: "mirror-link: unwarped ring frames (a scanned frame has no single mirror pose)",
      });
      const link = mirrorLinkMeta();
      const und = triple?.undistort;
      const wide =
        reset && und
          ? {
              sensor_size: und.sensor_size,
              focal: und.focal,
              center: und.center,
              fov: und.fov,
            }
          : {};
      const merge = (base: Serializable, extra: object): Serializable =>
        ({ ...(base as object), ...extra, mirror_link: link }) as Serializable;
      return {
        ...shot,
        meta: {
          wide: reset ? merge(shot.meta.wide ?? {}, wide) : undefined,
          fovea: merge(shot.meta.fovea, {}),
          left: merge(shot.meta.left, {}),
          right: merge(shot.meta.right, {}),
        },
      };
    }

    // --- auto vergence (spec §targeting) ------------------------------------
    // The SAME fovea-into-wide template-match loop Disparity Scope runs (spec
    // disparity-scope §topology, §match-join, §control-law), with this app's
    // targeting: a target-centered strip sliced out of the C undistort and each
    // RAW fovea scaled to the same px-per-wide-px, matched per eye, joined at
    // ONE pid node that integrates {pan, verge, v_shift}. Its reconstruction IS
    // the scan CENTER — the pattern rides on top of it. Session-local intent,
    // like the scan: the nodes exist only while engaged.

    /** One side's latest match, lifted to absolute undistorted-wide px. */
    type SideMatch = {
      center: Point2d;
      score: number;
      seq: number;
      at: number;
      epoch: number;
    };

    let stripSlice: SliceHandle | null = null;
    let stripScale: ScaleHandle | null = null;
    const needleScales: Partial<Record<Side, ScaleHandle>> = {};
    let vergeNode: PidNodeHandle<SlewPair> | null = null;
    let vergenceNode: { dispose(): void } | null = null;
    let vergenceStatus = "off";
    /** Wide/fovea source dims — the loop's crop space + needle base, read once
     *  per activation (spec disparity-scope §needle-geometry). */
    let wide: Size = { width: 0, height: 0 };
    let foveaDims: Size = { width: 0, height: 0 };
    let stripScaleFactor = 1;
    let lastVergeStep = 0;
    let lastSteppedSeq = -1;
    let lastDofWrite = 0;
    /** A Verge/Shift slider is under the pointer — the write-back would yank a
     *  fully-controlled knob mid-drag (spec §targeting). */
    let dofHeld = false;
    const latestMatch: Partial<Record<Side, SideMatch>> = {};
    /** Capture-epoch target ring (spec disparity-scope §capture-epoch-target). */
    const targetRing: TargetSample[] = [];

    const MATCH_IDS = {
      L: nodeId.win("mirror-link", "match", "L"),
      R: nodeId.win("mirror-link", "match", "R"),
    } as const;

    function vergeLimit(): number {
      return distanceToVerge(VERGE_MIN_DISTANCE_MM, s.state.baseline);
    }

    function syncGains(t: VergenceTuning): void {
      const panLim: [number, number] = [-SHIFT_LIMIT, SHIFT_LIMIT];
      const p = { kp: t.pan[0], ki: t.pan[1], kd: t.pan[2], limits: panLim };
      pan.setParams({ x: p, y: p });
      verge.setParams({ kp: t.depth[0], ki: t.depth[1], kd: t.depth[2] });
      v_shift.setParams({
        kp: t.v_shift[0],
        ki: t.v_shift[1],
        kd: t.v_shift[2],
        limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT],
      });
    }

    function publishVergenceStatus(): void {
      s.telemetry({ vergence_status: vergenceStatus });
    }

    /** Re-seed both DOF controllers from the sliders — the release half of
     *  `holdDof`, and the same assignment the per-DOF watches make. */
    function seedDofFromState(): void {
      if (!vergenceEngaged) return;
      verge.value = s.state.verge;
      v_shift.value = radians(s.state.shift);
      lastDofWrite = now(); // resume the mirror from THIS value, not the old one
    }

    /** Mirror the integrators into the drawer sliders (spec §targeting): while
     *  engaged the loop OWNS `verge`/`shift`, so the sliders show the result and
     *  HOLD it on disengage. Throttled — a per-step `setState` would flood the
     *  channel; the writes re-publish the drawn ring through their watches. */
    const DOF_WRITE_INTERVAL_MS = 100;
    function writeBackDof(force = false): void {
      if (!vergenceEngaged) return;
      if (dofHeld && !force) return; // a pointer owns the slider
      const t = now();
      if (!force && t - lastDofWrite < DOF_WRITE_INTERVAL_MS) return;
      lastDofWrite = t;
      s.setState("verge", verge.value);
      s.setState("shift", deg(v_shift.value));
      publishScanGeometry(); // `pan` moves the pattern without touching state
    }

    // --- magnification + crop geometry (spec disparity-scope §magnification) --
    // MirrorLink has no zoom knob: the resolution order starts at the triple's
    // stored override, then the calibration-measured ratio, then 1.

    function measuredMatchZoom(): number | null {
      if (!triple) return null;
      const { L, R } = triple.magnification;
      if (L !== null && R !== null) return (L + R) / 2;
      return L ?? R;
    }

    function matchZoom(): number {
      return matchMagnification(
        measuredMatchZoom(),
        0,
        triple?.zoomOverride ?? null,
      );
    }

    /** The needle scaler's zoom + BASE DIMS, paired by the zoom's units —
     *  measured → fovea dims, nominal → center dims (spec §needle-geometry). */
    function needleGeometry(): { zoom: number; base: Size } {
      const override = triple?.zoomOverride ?? null;
      const measured = measuredMatchZoom();
      const overrideWins =
        override != null && Number.isFinite(override) && override > 0;
      const measuredWins =
        !overrideWins &&
        measured != null &&
        Number.isFinite(measured) &&
        measured > 0;
      return {
        zoom: matchMagnification(measured, 0, override),
        base: measuredWins ? foveaDims : wide,
      };
    }

    function effectiveScale(): number {
      const ratio = Math.max(0, Math.min(1, s.state.tuning.scale));
      return 1 + (matchZoom() - 1) * ratio;
    }

    function clampToWide(r: Rect): Rect {
      const x = Math.max(0, Math.min(r.x, wide.width));
      const y = Math.max(0, Math.min(r.y, wide.height));
      return {
        x,
        y,
        width: Math.max(1, Math.min(r.width, wide.width - x)),
        height: Math.max(1, Math.min(r.height, wide.height - y)),
      };
    }

    /** The match strip: the center tile expanded by `expand_x`/`expand_y`,
     *  centered on the RAW dragged target (where we look for the fovea). */
    function stripRect(): Rect {
      const z = Math.max(1, matchZoom());
      const t = s.state.tuning;
      return clampToWide(
        RECT.fromCenter(target, {
          width: (wide.width / z) * t.expand_x,
          height: (wide.height / z) * t.expand_y,
        }),
      );
    }

    function steerStrip(): void {
      if (wide.width) stripSlice?.steer(stripRect());
    }

    /** Retune the strip ratio + both needles — every side must land at the same
     *  px-per-wide-px (CCOEFF matching is not scale-invariant). */
    function retuneScalers(): void {
      if (!wide.width) return;
      stripScaleFactor = effectiveScale();
      stripScale?.retune({ ratio: stripScaleFactor });
      const g = needleGeometry();
      const size = foveaTileSize({
        width: g.base.width,
        height: g.base.height,
        zoom: g.zoom,
        scale: stripScaleFactor,
      });
      const dsize = {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
      };
      needleScales.L?.retune({ dsize });
      needleScales.R?.retune({ dsize });
    }

    // --- the join + the control step (spec disparity-scope §match-join) ------

    function onMatch(side: Side, r: VisionResult): void {
      if (!vergenceEngaged) return;
      const v = r.values as unknown as TemplateMatchValues;
      vergeNode?.ingest(side === "L" ? "l" : "r");
      // Lift out of scaled-strip space (/s → full-res strip-local px) + the
      // frame's crop origin → absolute undistorted-wide px.
      const sF = stripScaleFactor > 0 ? stripScaleFactor : 1;
      const rectFull = VEC.mul(v.rect, 1 / sF);
      const c = RECT.getCenter(rectFull);
      const m: SideMatch = {
        center: { x: v.origin.x + c.x, y: v.origin.y + c.y },
        score: v.score,
        seq: v.seq ?? 0,
        at: now(),
        epoch: v.deviceTimestamp ?? 0,
      };
      latestMatch[side] = m;
      // ABSOLUTE wide px, not strip-local: the wide view draws these directly.
      const abs = {
        rect: {
          ...rectFull,
          x: v.origin.x + rectFull.x,
          y: v.origin.y + rectFull.y,
        },
        score: v.score,
      };
      s.telemetry(side === "L" ? { match_left: abs } : { match_right: abs });
      const other = latestMatch[side === "L" ? "R" : "L"];
      if (!other || m.seq < other.seq) return; // pair incomplete — wait
      if (
        matchPartnerStale({
          ageMs: now() - other.at,
          seqGap: m.seq - other.seq,
        })
      ) {
        vergenceStatus = "hold: match stale";
        publishVergenceStatus();
        return;
      }
      // One control step per PAIR (kd explosion; spec §match-join).
      const pairSeq = Math.min(m.seq, other.seq);
      if (pairSeq <= lastSteppedSeq) return;
      lastSteppedSeq = pairSeq;
      runVergence({
        l: (side === "L" ? m : other).center,
        r: (side === "R" ? m : other).center,
        target: targetAtEpoch(targetRing, v.deviceTimestamp, target),
        scores: {
          l: (side === "L" ? m : other).score,
          r: (side === "R" ? m : other).score,
        },
        overridden: false, // no drag override in this app — steer re-seeds instead
      });
    }

    /** The control law, run inside the pid node's step. Returns the commanded
     *  CENTER volts; on any hold it returns the held pose so the mirrors freeze
     *  rather than wind down. */
    function vergenceStep(projection: ScopeProjection): SlewPair {
      const held = centerVolts();
      if (!triple || !triple.undistort) {
        vergenceStatus = "no calibration";
        return held;
      }
      if (scanActive) {
        // The needle is a RING, not the dot the match was cut from — a step now
        // would servo on noise. Hold; the integrators keep their values.
        vergenceStatus = "paused: scanning";
        return held;
      }
      const t = now();
      const dt = Math.min(
        (t - lastVergeStep) * s.state.tuning.sensitivity,
        DT_MAX_FRAMES,
      );
      const out = stepVergence(
        projection,
        vergenceControllers,
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        { baseline: s.state.baseline, minScore: s.state.tuning.min_score },
        dt,
      );
      if (!out) {
        vergenceStatus = "hold: match low score";
        return held;
      }
      lastVergeStep = t;
      vergenceStatus = "tracking";
      // The step moved the integrators and `heldDof` reads them, so the pose
      // chain IS the reconstruction — evaluated against the LIVE target (only
      // the PID ERROR uses the capture-epoch one; spec §capture-epoch-target).
      return centerVolts();
    }

    function runVergence(projection: ScopeProjection): void {
      if (!vergeNode) return;
      outputOf(vergeNode.step(() => vergenceStep(projection)));
      publishVergenceStatus();
      writeBackDof(); // republishes the geometry → the idle pose + any re-upload
    }

    /** Seed the integrators from the CURRENT commanded pose — ANGLES, never a
     *  volts round-trip (spec disparity-scope §seed-space). */
    function seedVergenceFromPose(): void {
      if (!triple || !triple.undistort) return;
      const A = centerAngles();
      const seed = seedVergence(
        A.l,
        A.r,
        targetAngle,
        s.state.baseline,
        SEED_PARALLEL_EPS,
      );
      pan.value = seed.pan;
      verge.value = seed.verge;
      v_shift.value = seed.v_shift;
    }

    /** Build the strip/needle/match/pid chain and engage. Idempotent. */
    /** Local mirror of the published refusal — the runtime hands no telemetry
     *  back, and the `startVergence` command reports the reason it just set. */
    let vergenceBlocked: string | null = null;
    function publishVergenceBlocked(reason: string | null): void {
      vergenceBlocked = reason;
      s.telemetry({ vergence_blocked: reason });
    }

    function startVergenceNow(): boolean {
      const t = triple;
      if (vergenceEngaged) return true;
      if (!t) {
        publishVergenceBlocked("no camera triple leased");
        return false;
      }
      if (!t.undistort) {
        publishVergenceBlocked("the wide camera has no undistort calibration");
        return false;
      }
      if (!wide.width) {
        publishVergenceBlocked("wide frame size unknown");
        return false;
      }
      const serialC = t.leases.C.camera.serial;
      const cSourceId = s.state.undistortPipe ?? nodeId.convert(serialC);
      const pipeIds: string[] = [];
      const connect = (role: string, pipeId: string): PipeInput => {
        const handle = broker.connect(pipeId);
        pipeIds.push(pipeId);
        const { width, height, channels, bytesPerFrame, maxBytes } =
          handle.spec;
        return {
          role,
          shmName: handle.shmName,
          width,
          height,
          channels,
          bytesPerFrame: maxBytes ?? bytesPerFrame,
        };
      };

      // Seed BEFORE engaging: `heldDof` still reads the sliders here, so the
      // reconstruction reproduces exactly the pose the mirrors hold.
      seedVergenceFromPose();

      stripScaleFactor = effectiveScale();
      stripSlice = createSlicePipe(
        sliceSeam,
        cSourceId,
        nodeId.slice(serialC, "vergence-strip"),
        { rect: stripRect(), maxWidth: wide.width, maxHeight: wide.height },
      );
      stripScale = createScalePipe(
        scaleSeam,
        stripSlice.pipeId,
        nodeId.scale(stripSlice.pipeId, "match"),
        {
          params: { ratio: stripScaleFactor },
          maxWidth: wide.width * 2,
          maxHeight: wide.height * 2,
        },
      );
      const g0 = needleGeometry();
      const tile0 = foveaTileSize({
        width: g0.base.width,
        height: g0.base.height,
        zoom: g0.zoom,
        scale: stripScaleFactor,
      });
      const dsize0 = {
        width: Math.max(1, Math.round(tile0.width)),
        height: Math.max(1, Math.round(tile0.height)),
      };
      // The needle source is the RAW fovea CONVERT pipe (spec §needle-geometry):
      // a homography-warped fovea has already divided by the magnification once,
      // and the needle scaler's dsize divides again.
      const workers: Partial<Record<Side, VisionWorkerHandle>> = {};
      for (const side of SIDES) {
        const cam = t.leases[side].camera;
        const src = nodeId.convert(cam.serial);
        needleScales[side] = createScalePipe(
          scaleSeam,
          src,
          nodeId.scale(src, "vergence-needle"),
          {
            params: { dsize: dsize0 },
            maxWidth: cam.getFeatureInt("Width"),
            maxHeight: cam.getFeatureInt("Height"),
          },
        );
      }
      const rgba = {
        kind: "frame",
        pixelFormat: "RGBA8",
        dtype: "U8",
      } as const;
      const analysis = { kind: "analysis", schema: "template-match" } as const;
      const unregister = registerGraphWiring({
        nodes: SIDES.map((side) => ({
          id: MATCH_IDS[side],
          kind: "template-match",
          owner: "win/mirror-link",
          output: analysis,
          transport: "worker" as const,
        })),
        edges: SIDES.flatMap((side) => [
          {
            from: needleScales[side]!.pipeId,
            to: MATCH_IDS[side],
            port: "needle",
            type: rgba,
          },
          {
            from: stripScale!.pipeId,
            to: MATCH_IDS[side],
            port: "haystack",
            type: rgba,
          },
        ]),
      });
      for (const side of SIDES)
        workers[side] = createVisionWorker(
          {
            pipes: [
              connect("needle", needleScales[side]!.pipeId),
              connect("haystack", stripScale.pipeId),
            ],
            // No debugger window in this app — the correlation heatmap is never
            // consumed, so it is never computed.
            params: { kind: "template-match", emitHeatmap: false },
            meterName: MATCH_IDS[side],
          },
          (r) => onMatch(side, r),
        );
      vergeNode = createPidNode<SlewPair>({
        id: nodeId.win("mirror-link", "pid"),
        kind: "pid",
        owner: "win/mirror-link",
        inputs: [
          { from: MATCH_IDS.L, port: "l" },
          { from: MATCH_IDS.R, port: "r" },
        ],
        // Its output is the CENTER pose the "mirror-link" position input (and,
        // scanning, the trajectory) is built around.
        outputs: [{ to: nodeId.controller(), port: "mirror-link" }],
        controllers: { pan, verge, v_shift },
      });

      vergenceNode = {
        dispose() {
          // Stop reading BEFORE the consumer gate drops (FIFO teardown).
          for (const side of SIDES) {
            workers[side]?.terminate();
            delete latestMatch[side];
          }
          vergeNode?.dispose();
          vergeNode = null;
          unregister();
          for (const id of pipeIds) broker.disconnect(id);
          for (const side of SIDES) {
            needleScales[side]?.retire();
            delete needleScales[side];
          }
          stripScale?.retire();
          stripScale = null;
          stripSlice?.retire();
          stripSlice = null;
        },
      };
      vergenceEngaged = true;
      lastVergeStep = now();
      lastSteppedSeq = -1;
      vergenceStatus = scanActive ? "paused: scanning" : "tracking";
      s.setState("auto_vergence", true);
      publishVergenceBlocked(null);
      publishVergenceStatus();
      return true;
    }

    function stopVergenceNow(): void {
      if (!vergenceEngaged && !vergenceNode) return;
      // FLUSH before disengaging: `heldDof` falls back to the sliders, which
      // must already carry the loop's values or the pose would jump. `pan` has
      // no slider — it folds into the target ray, which IS where the foveas are
      // now aimed (the same collective apply the old servo did).
      if (vergenceEngaged && triple?.undistort) {
        writeBackDof(true);
        targetAngle = {
          x: targetAngle.x + pan.value.x,
          y: targetAngle.y + pan.value.y,
        };
        target = triple.conv.A2P.C(targetAngle, false);
        recordTarget(
          targetRing,
          { t: Number(hostNowNs()), target },
          TARGET_RING_CAP,
        );
        s.telemetry({ target, target_angle: targetAngle });
        pan.value = { x: 0, y: 0 };
      }
      vergenceEngaged = false;
      const node = vergenceNode;
      vergenceNode = null;
      node?.dispose();
      vergenceStatus = "off";
      s.setState("auto_vergence", false);
      publishVergenceBlocked(null);
      publishVergenceStatus();
      s.telemetry({ match_left: null, match_right: null });
      publishScanGeometry();
    }

    // --- recording (spec §recording) ---------------------------------------

    const recording = createRawRecording({
      id: "recorder/mirror-link",
      broker,
      rawPipes,
      compress: compressSeam,
      streams: () =>
        triple
          ? {
              "left-fovea": triple.leases.L.camera,
              center: triple.leases.C.camera,
              "right-fovea": triple.leases.R.camera,
            }
          : null,
      finished: (foveaPath) =>
        process.parentPort?.postMessage({
          type: "recording:finished",
          path: foveaPath,
        }),
      telemetry: (patch) => s.telemetry(patch),
    });

    // --- actuation (spec §actuation) ---------------------------------------

    let lastVoltEmit = 0;
    let lastActuateMs = 0;
    const actuateMsStats = new RollingStats(0.9, 2, "ms");
    /** Pacer tick INTERVAL: the 1 ms loop slews the idle pose, so any stall on
     *  the orchestrator loop (an allocation, a synchronous native call) is an
     *  idle pose that lags. Metered so the rig can see it — the scan itself
     *  runs on the MCU, so this meters THIS loop, never the pattern. */
    const tickGapMsStats = new RollingStats(0.9, 2, "ms");

    /** The whole `perf` telemetry object (one key — a patch replaces it). */
    function perfTelemetry(): {
      actuateMs: { mean: number; max: number };
      tickGapMs: { mean: number; max: number };
      trajectory: TrajectoryTelemetry;
    } {
      return {
        actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max },
        tickGapMs: { mean: tickGapMsStats.mean, max: tickGapMsStats.max },
        trajectory: trajectoryPerf(),
      };
    }

    function publishPerf(): void {
      s.telemetry({ perf: perfTelemetry() });
    }

    async function activateSession(scope: ResourceScope): Promise<void> {
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "pipes", label: "Building undistort pipes" },
        { id: "recording", label: "Preparing recording" },
        { id: "controller", label: "Wiring controller" },
      ]);

      monitor.start("lease");
      const t = await scope.use(() => acquireTriple(s), releaseLeases); // drains LAST
      if (!t) return; // frozen at "Leasing cameras" (contention/fail)
      triple = t;
      gainAllowed = true;
      monitor.done("lease");

      // Gain override (spec §gain): snapshot both eyes, publish the shared
      // range, then SEED `state.gain` from the live camera on a first entry
      // (no write) or re-apply a carried-over value.
      const safeGain = <T>(read: () => T, fallback: T): T => {
        try {
          return read();
        } catch {
          return fallback;
        }
      };
      const ZERO_RANGE = { min: 0, max: 0 };
      // A camera with no gain surface records NO snapshot — restore then skips
      // it rather than writing a value we never read.
      for (const side of SIDES) {
        const snap = safeGain(() => snapshotGain(t.leases[side].camera), null);
        if (snap) gainSnapshots[side] = snap;
      }
      gainRange = intersectRanges(
        safeGain(() => t.leases.L.camera.gain_range, ZERO_RANGE),
        safeGain(() => t.leases.R.camera.gain_range, ZERO_RANGE),
      );
      s.telemetry({ gain_range: gainRange });
      // The seed reads `gain` on its OWN — a model whose snapshot failed for an
      // unrelated reason must not leave the slider permanently disabled.
      const seed = safeGain<number | undefined>(
        () => t.leases.L.camera.gain,
        undefined,
      );
      if (s.state.gain === null) {
        if (seed !== undefined) s.setState("gain", seed); // seed only — no write
      } else void queueScanOp(() => applyGainNow(s.state.gain!));

      // DISPLAY-ONLY: label the leased triple by role (L/C/R) in the profiler.
      scope.defer(
        registerGraphWiring({
          roles: {
            [t.leases.L.camera.serial]: "L",
            [t.leases.C.camera.serial]: "C",
            [t.leases.R.camera.serial]: "R",
          },
          nodes: [],
          edges: [],
        }),
      );

      monitor.start("pipes");
      const taps = new DisposerBag();
      publishSerials(t.leases, taps, s);
      scope.defer(() => taps.dispose());
      // The center intrinsic undistort pipe — the steering surface (spec
      // §views). The L/R views bind the RAW convert pipes (or the triangle's
      // flip pipes) directly: a frame exposed along a stretch of the scan path
      // has no single mirror pose to warp against.
      let undistortC: string | null = null;
      if (t.undistort) {
        undistortC = advertiseUndistortPipe(
          undistortSeam,
          t.leases.C.camera,
          t.undistort.calibration,
        );
        const pipeId = undistortC;
        s.setState("undistortPipe", pipeId);
        scope.defer(() => {
          retireUndistortPipe(undistortSeam, pipeId);
          s.setState("undistortPipe", null);
        });
      }
      // Ring reader (spec §reader): OPTIONAL, default OFF. Built here only when
      // the toggle is already on; the `ring_reader` watch builds/disposes it
      // live. ONE defer, in the same drain position: it stops reading + releases
      // its pipes before the undistort retire and the lease release.
      if (s.state.ring_reader) buildRingNode();
      scope.defer(() => disposeRingNode());

      // The vergence loop's crop space (spec §targeting): the wide frame it
      // slices, and the fovea dims the needle scaler's base pairs with a
      // MEASURED magnification (spec disparity-scope §needle-geometry).
      wide = {
        width: t.leases.C.camera.getFeatureInt("Width"),
        height: t.leases.C.camera.getFeatureInt("Height"),
      };
      foveaDims = {
        width: t.leases.L.camera.getFeatureInt("Width"),
        height: t.leases.L.camera.getFeatureInt("Height"),
      };
      verge.setLimits([0, vergeLimit()]);
      syncGains(s.state.tuning);
      // OPTIONAL, default OFF — the same on-demand shape as the ring reader.
      if (s.state.auto_vergence) startVergenceNow();
      scope.defer(() => stopVergenceNow());
      monitor.done("pipes");

      // Capture node (spec §capture). The raw L/R producers are PRE-ACQUIRED
      // here, not per shot: `rawPipes.acquire` on a 0→1 transition advertises
      // the pipe (allocating a CAPTURE_RING_DEPTH × full-depth-frame SHM ring)
      // and runs the native attach, both SYNCHRONOUS on the orchestrator loop
      // that also runs the 1 ms pacer — tens of ms of stall on the loop that
      // also feeds the trajectory pushes and the flip anchors. Pre-acquired, the
      // shot path only bumps a refcount + opens the consumer gate. The
      // producers stay PARKED until that gate opens, so this costs nothing
      // while idle and touches no camera setting (attach subscribes to the
      // existing Arv::Stream).
      for (const side of SIDES) {
        const camera = t.leases[side].camera;
        const pipeId = `camera/${camera.serial}/raw`;
        const held = rawPipes.acquire({
          kind: "raw",
          camera,
          pipeId,
          spec: rawPipeSpec(camera, pipeId, CAPTURE_RING_DEPTH),
        });
        scope.defer(() => held.release());
      }
      {
        const capCenterId =
          undistortC ?? nodeId.convert(t.leases.C.camera.serial);
        const capCenter = broker.connect(capCenterId);
        scope.defer(() => void broker.disconnect(capCenterId));
        centerPipe = {
          shmName: capCenter.shmName,
          maxBytes: capCenter.spec.maxBytes ?? capCenter.spec.bytesPerFrame,
          channels: capCenter.spec.channels,
        };
        scope.defer(() => {
          centerPipe = null;
        });
        captureHelper = createCaptureHelper({
          id: nodeId.win("mirror-link", "capture"),
          broker,
          rawPipes,
          graphInputs: {
            left: `camera/${t.leases.L.camera.serial}/raw`,
            right: `camera/${t.leases.R.camera.serial}/raw`,
            center: capCenterId,
          },
          cameras: () =>
            triple
              ? { left: triple.leases.L.camera, right: triple.leases.R.camera }
              : null,
          centerPipe: () => centerPipe,
          snapshot: (reset, indexed) =>
            triple ? captureSnapshot(reset, indexed) : null,
          recordingActive: () => recording.active,
          telemetry: (patch) => s.telemetry(patch),
        });
        captureHelper.build();
      }

      monitor.start("recording");
      // Awaited drain: an in-flight recording finalizes BEFORE the pipes retire
      // + the leases release (LIFO — registered after the retirers above).
      scope.defer(async () => void (await recording.stop()));
      // An in-flight capture must finish (its raw pipes release) before the
      // recording drain and the lease release.
      scope.defer(async () => {
        await captureHelper?.activeCapture;
        await captureHelper?.stop();
        captureHelper = null;
      });
      monitor.done("recording");

      monitor.start("controller");
      // The JS position input (spec §actuation): the IDLE center pose. While
      // the trajectory runs the node holds every push and hands the DAC back
      // on stop — and the pacer does not push at all then (`scanActive`). No
      // `from`: the pose is computed in this session, not by a graph node — an
      // edge would synthesize a phantom placeholder in the profiler.
      posInput = controllerNode().openPosition("mirror-link", {
        initial: { left: { ...volts.L }, right: { ...volts.R } },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      scanAllowed = true;
      publishScanGeometry();
      // Idle slews the commanded pose toward the center with the shared
      // first-order smoother (`@lib/slew`); the slew resumes from the last idle
      // pose once a scan stops. The 1 ms tick is kept because its gap IS the
      // stall meter (`perf.tickGapMs`).
      let commanded: SlewPair | null = null;
      let lastPaceAt = 0;
      stopActuation = startPacer(1, () => {
        const tick = now();
        const dt = lastPaceAt > 0 ? tick - lastPaceAt : 1;
        if (lastPaceAt > 0) tickGapMsStats.push(dt);
        lastPaceAt = tick;
        if (!scanActive) {
          const goal = centerVolts();
          commanded = commanded
            ? slewStep(commanded, goal, dt).pose
            : { l: { ...goal.l }, r: { ...goal.r } };
          const p = posInput!.update({ left: commanded.l, right: commanded.r });
          volts.L = p.left;
          volts.R = p.right;
          actuateMsStats.push(lastActuateMs);
        }
        if (tick - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
          lastVoltEmit = tick;
          if (scanActive) {
            probeFlips(tick);
            watchNoOk(tick);
            watchClock();
          }
          // Per-eye markers come from the CENTER pose (shift included), not
          // the instantaneous scan pose — they show where each fovea is aimed.
          // The published `volt` is that same center pose while scanning (the
          // MCU owns the pattern; the path itself is drawn from `scan_path`).
          const c = centerVolts();
          s.telemetry({
            volt: scanActive
              ? { L: { ...c.l }, R: { ...c.r } }
              : { L: volts.L, R: volts.R },
            L_PX: projectPx("L", c.l),
            R_PX: projectPx("R", c.r),
            perf: perfTelemetry(),
          });
          actuateMsStats.resetMax();
          tickGapMsStats.resetMax();
        }
      });

      // --- teardown (LIFO — the LAST registered drains FIRST; spec §teardown)
      // Drain order: (1) stop the scan, (2) stop the pacer + close the idle
      // position input, (3) drop the triple — then the earlier registrations
      // (capture, recording, vergence, pipes, leases).
      scope.defer(() => {
        // (3) After both below: nothing reads the triple any more.
        triple = null;
        s.telemetry({ ready: false });
      });
      scope.defer(() => {
        // (2) The scan is already stopped, so the node has handed the DAC
        // back to this input and the mirror sits at the idle pose; only now
        // stop pushing and terminate the MCU stream (+ disable-iff-we-enabled).
        stopActuation?.();
        stopActuation = null;
        void posInput?.close();
        posInput = null;
      });
      scope.defer(async () => {
        // (1) FIRST: no queued start may arm or START any more, then stop the
        // scan while the leases and the idle position input are still live —
        // the trajectory closes (the node's `resumeInputs` re-takes the DAC
        // for the idle input, so the mirror returns to the center), the flip
        // pipes retire, the cameras go back to free-run + their pre-scan
        // timing (the restore rides `lease.reconfigure`) — then the gain
        // override (spec §gain). Exception-safe per step: a throwing vergence
        // stop never skips the scan stop, nor a throwing scan stop the gain
        // restore (each failure is reported).
        scanAllowed = false;
        gainAllowed = false;
        await queueScanOp(async () => {
          try {
            stopVergenceNow(); // the loop's workers + pid node go first
          } catch (e) {
            report(
              "mirror-link",
              `vergence stop failed on teardown: ${errorLine(e)}`,
              "warning",
            );
          }
          try {
            await stopScanNow();
          } catch (e) {
            report(
              "mirror-link",
              `scan stop failed on teardown: ${errorLine(e)}`,
              "warning",
            );
          } finally {
            await restoreGainNow();
          }
        });
      });

      monitor.done("controller");
      s.telemetry({ ready: true });
      monitor.complete(); // spin-up finished — clear the overlay
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        // After the full drain (leases released, timing restored). Scan intent
        // is session-local — a re-entry starts idle.
        target = { x: 0, y: 0 };
        targetAngle = { x: 0, y: 0 };
        volts.L = { ...ORIGIN_POS };
        volts.R = { ...ORIGIN_POS };
        activeScan = null;
        resetRunStats();
        gainRange = { min: 0, max: 0 };
        ring.L = ring.R = null;
        s.resetTelemetry([
          "vergence_status",
          "vergence_blocked",
          "match_left",
          "match_right",
          "ring",
          "scan",
          "scan_blocked",
          "scan_path",
          "scan_path_px",
          "scan_path_closed",
          "scan_window_px",
          "scan_center_px",
          "axis_handle_px",
          "perf",
          "gain_range",
          "L_PX",
          "R_PX",
        ]);
      },
      watch: {
        // Everything that moves or reshapes the commanded pattern republishes
        // the drawn geometry (the pacer never does — spec §views), which while
        // scanning also re-uploads the trajectory (spec §actuation). Verge and Shift
        // ARE the loop's DOF: while engaged a MANUAL write re-seeds that
        // controller (the write-back's own values compare equal and no-op).
        verge() {
          if (
            vergenceEngaged &&
            Math.abs(s.state.verge - verge.value) > DOF_EPS
          )
            verge.value = s.state.verge;
          publishScanGeometry();
        },
        shift() {
          if (
            vergenceEngaged &&
            Math.abs(radians(s.state.shift) - v_shift.value) > DOF_EPS
          )
            v_shift.value = radians(s.state.shift);
          publishScanGeometry();
        },
        baseline(mm) {
          if (typeof mm === "number") verge.setLimits([0, vergeLimit()]);
          publishScanGeometry();
        },
        tuning() {
          syncGains(s.state.tuning);
          retuneScalers();
          steerStrip();
        },
        auto_vergence(on) {
          void queueScanOp(async () => {
            if (on) startVergenceNow();
            else stopVergenceNow();
          });
        },
        // Pattern SHAPE (spec §scan-patterns): live while scanning — the drawn
        // geometry republishes and the trajectory re-uploads phase-continuously
        // (throttled). Out-of-range values are clamped and written back, so the
        // pane never shows a value the scan does not run (a server write fires
        // no watch — the republish below covers it).
        scan_amp(v) {
          const a = Number.isFinite(v)
            ? Math.min(Math.max(v, SCAN_AMP_RANGE.min), SCAN_AMP_RANGE.max)
            : SCAN_AMP_RANGE.min;
          if (a !== v) s.setState("scan_amp", a);
          publishScanGeometry();
        },
        scan_ratio(v) {
          const r = Number.isFinite(v)
            ? Math.min(Math.max(v, SCAN_RATIO_RANGE.min), SCAN_RATIO_RANGE.max)
            : SCAN_RATIO_RANGE.max;
          if (r !== v) s.setState("scan_ratio", r);
          publishScanGeometry();
        },
        scan_axis_deg(v) {
          const d = normalizeAxisDeg(v);
          if (d !== v) s.setState("scan_axis_deg", d);
          publishScanGeometry();
        },
        // Exposure windows (spec §exposure-windows). `tri_window_sync` keeps
        // the falling window a MIRROR of the rising one: every rising write is
        // copied over, a falling write while synced snaps back, and turning
        // sync on copies rise → fall once.
        scan_window(v) {
          const w = windowFrom(v);
          if (!sameWindow(w, v)) s.setState("scan_window", w);
          publishScanGeometry();
        },
        tri_window_rise(v) {
          const w = windowFrom(v);
          if (!sameWindow(w, v)) s.setState("tri_window_rise", w);
          if (
            s.state.tri_window_sync &&
            !sameWindow(w, s.state.tri_window_fall)
          )
            s.setState("tri_window_fall", [w[0], w[1]]);
          publishScanGeometry();
        },
        tri_window_fall(v) {
          const rise = s.state.tri_window_rise;
          if (s.state.tri_window_sync) {
            if (!sameWindow(rise, v))
              s.setState("tri_window_fall", [rise[0], rise[1]]);
          } else {
            const w = windowFrom(v);
            if (!sameWindow(w, v)) s.setState("tri_window_fall", w);
          }
          publishScanGeometry();
        },
        tri_window_sync(on) {
          const rise = s.state.tri_window_rise;
          if (on && !sameWindow(rise, s.state.tri_window_fall))
            s.setState("tri_window_fall", [rise[0], rise[1]]);
          publishScanGeometry();
        },
        // A PERIOD change (frequency, or the pattern family — the triangle runs
        // 2T): replace cannot swap it, so the op chain restarts the run. A
        // change made while a start is awaiting is reconciled at its commit
        // point (`reconcileRun`).
        scan_hz() {
          if (scanActive) void queueScanOp(restartScanNow);
          publishScanGeometry();
        },
        scan_mode(m) {
          if (m !== "ellipse" && m !== "triangle")
            s.setState("scan_mode", "ellipse");
          if (scanActive) void queueScanOp(restartScanNow);
          publishScanGeometry();
        },
        // Gain rides the SAME FIFO chain as the exposure ops (spec §gain) — a
        // drag must never interleave with an apply/restore on the same lease.
        gain(dB) {
          if (typeof dB === "number") void queueScanOp(() => applyGainNow(dB));
        },
        // Strips are built only while a histogram stage is on screen.
        ring_view: pushRingEnabled,
        // The reader node exists only while the toggle is on (spec §reader).
        // Both directions are idempotent; without a triple neither does
        // anything (activation builds it from the state).
        ring_reader(on) {
          if (on) buildRingNode();
          else disposeRingNode();
        },
      },
      commands: {
        async steer(px) {
          setTargetFromPixel(px);
        },
        // Point the main axis at a wide px (spec §scan-patterns): the direction
        // from the scan center to it, through the pixel→angle map. A pointer ON
        // the center (no direction) or an uncalibrated triple keeps the axis.
        async setAxis(px) {
          const und = triple?.undistort;
          if (!und) return;
          const raw = axisDegFromPixelRay(
            scanCenterAngle(),
            und.angular([px], false)[0],
          );
          if (raw === null) return;
          // Fold into the slider's domain (a 0.5° fold at the seam): the state
          // never holds an angle the slider cannot show (spec §scan-patterns).
          const deg = Math.max(raw, AXIS_SLIDER_RANGE.min);
          if (deg === s.state.scan_axis_deg) return;
          s.setState("scan_axis_deg", deg); // a server write fires no watch
          publishScanGeometry();
        },
        async startVergence() {
          // On the scan ops' FIFO chain: engaging must not interleave with a
          // start/stop that is re-arming the same leases.
          let ok = false;
          await queueScanOp(async () => {
            ok = startVergenceNow();
            if (!ok)
              report(
                "mirror-link",
                `auto vergence refused: ${vergenceBlocked ?? "not ready"}`,
                "warning",
              );
          });
          return ok;
        },
        async stopVergence() {
          await queueScanOp(async () => stopVergenceNow());
        },
        async holdDof(held) {
          dofHeld = held;
          if (!held) seedDofFromState();
        },
        async startScan() {
          if (scanActive) return true;
          let ok = false;
          await queueScanOp(async () => {
            ok = await startScanNow();
          });
          return ok;
        },
        async stopScan() {
          // The request is visible to a start/restart ALREADY in flight (it
          // must not send its START); it clears when this stop op runs, so a
          // start commanded after it proceeds normally.
          stopsPending++;
          await queueScanOp(async () => {
            stopsPending--;
            await stopScanNow();
          });
          publishScanBlocked(null);
        },
        // Capture — forwarded to the shared helper (its guards live inside).
        async captureShot({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async getCapturePreview({ resource, index }) {
          return captureHelper
            ? captureHelper.getPreview(resource, index)
            : null;
        },
        async saveCapture({ path, format }) {
          await captureHelper?.save(path, format);
        },
        async discardCapture() {
          await captureHelper?.discard();
        },
        async startRecording({ path }) {
          // Exclusivity (spec §capture): no recording while a capture shot
          // holds the shared raw pipes.
          if (captureHelper?.capturing) return false;
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      busy() {
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
