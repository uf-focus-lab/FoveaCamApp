// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disparity-scope session — auto-vergence, SPLIT-NODE topology (thin
// main-thread coordinator: wires the graph, forwards final results).
// Behavior spec (topology, drag, freeze window, tracker, join, actuation,
// teardown): docs/spec/disparity-scope.md.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { read, subscribe } from "@orchestrator/store-hub";
import { activeController } from "@orchestrator/controller";
import { report, span, timeSpan } from "@orchestrator/diagnostics";
import { RoundRobinFrameScheduler } from "@orchestrator/scheduler";
import {
  disableHardwareTrigger,
  enableHardwareTrigger,
  readTriggerConfig,
} from "@orchestrator/camera-trigger";
import { cameraConfigPath } from "@orchestrator/camera";
import { pairTriggerBudget, type PairTriggerBudget } from "@lib/camera-config";
import { readAnaglyphStyle, subscribeAnaglyphStyle } from "@orchestrator/anaglyph-style";
import { DEFAULT_ANAGLYPH_STYLE, type AnaglyphStyle } from "../../../docs/schema/anaglyph.js";
import { resolveBaseline } from "@lib/calibration-data";
import { controllerNode, type PositionInput } from "@orchestrator/controller-node";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import { ORIGIN_POS, radians, VOLT_TELEMETRY_INTERVAL_MS } from "@orchestrator/fovea-pipeline";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import {
  advertiseHomographyUndistortPipe,
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import {
  conversionComputeH,
  startHomographyFeeder,
} from "@orchestrator/homography-feeder";
import { pushHomography } from "core/Aravis";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import {
  applyPidOverride,
  createPidNode,
  outputOf,
  type PidNodeHandle,
} from "@orchestrator/pid-node";
import { mirrorHistory } from "@orchestrator/mirror-history";
import {
  readPredictionRateHz,
  subscribePredictionRateHz,
} from "@orchestrator/prediction-rate";
import {
  clampLookaheadMs,
  publishAppliedLookahead,
  readSerialLatencyComp,
  SerialLatencyEstimator,
  subscribeSerialLatencyComp,
} from "@orchestrator/serial-latency";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import {
  disparity,
  DEFAULT_TUNING,
  VERGE_MIN_DISTANCE_MM,
  SHIFT_LIMIT_DEG,
  VSHIFT_LIMIT_DEG,
  type Tuning,
  type PidReadout,
  type VergenceVolts,
} from "./contract";
import {
  followTarget,
  foveaTileSize,
  matchMagnification,
  recordTarget,
  seedVergence,
  stepVergence,
  targetAtEpoch,
  type ScopeProjection,
  type TargetSample,
  type VergenceControllers,
} from "@lib/vergence/vergence";
import { hostNowNs } from "@orchestrator/time-align";
import { createSlicePipe, type SliceHandle, type SlicePipeSeam } from "@orchestrator/slice-pipe";
import { createScalePipe, type ScaleHandle, type ScalePipeSeam } from "@orchestrator/scale-pipe";
import {
  createStereoPipe,
  SIGNED_DISPARITY_HEATMAP_RANGE,
  SIGNED_DISPARITY_WINDOW,
  type StereoHandle,
  type StereoPipeSeam,
} from "@orchestrator/stereo-pipe";
import { createHeatmapPipe, type HeatmapHandle, type HeatmapPipeSeam } from "@orchestrator/heatmap-pipe";
import {
  createCompositePipe,
  type CompositeHandle,
  type CompositeParams,
  type CompositePipeSeam,
} from "@orchestrator/composite-pipe";
import type { TemplateMatchValues } from "@orchestrator/template-match-kernel";
import {
  consumeTracker,
  createDisparityTrackerFeed,
  TRACKER_STALL_DEADLINE_MS,
  trackerResultStale,
} from "./tracker-feed";
import { matchPartnerStale } from "@lib/vergence/match-join";
import { matchStaleMsFor, pairEpochGateTrips } from "./trigger-sync";
import {
  createTriggerOpChain,
  engageFailureReason,
  firstErrorLine,
  frameRequestFromBudget,
  triggerBlockReason,
  triggerFaultBlocked,
  triggerFaultMessage,
  TriggerFaultDetector,
  TriggerRateWindow,
  TriggerSpanSampler,
} from "@lib/trigger-sync";
import {
  AutotuneRun,
  type AutotuneStage,
  type DofErrors,
  type GainSet,
} from "./autotune";
import { DragSlew, type SlewPose } from "./drag-slew";
import { makeMat } from "@lib/mat";
import { PID, PID2D, type PidParams } from "@lib/pid";
import { distanceToVerge, vergeToDistance, vergenceToDistance } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import { RECT, VEC } from "@lib/util/geometry";
import type { Point2d, Rect, Size } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
// Direct core import in a session — accepted precedent; PURE logic lives in
// tracker-feed.ts/vergence.ts so vitest never loads the native addon.
import {
  createChainedHybridTracker,
  createChainedTracker,
  createComposeStream,
  createImmPredictor,
  type Compose,
  type ImmPredictor,
  type KcfTracker,
  type TrackerMeter,
} from "core/Tracker";
import { swapTracker, type TrackerType } from "./tracker-swap";
import type { MirrorSink } from "core/Controller";
import type { PortLink } from "../../../core/dist/types";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
import { createRawRecording } from "@orchestrator/raw-recording";
import {
  createCaptureHelper,
  rawTripleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";

const ZERO: Point2d = { x: 0, y: 0 };
const now = () => performance.now();

/** TEMP debug size-trace: log a pipeline stage's dims on first sight + on change
 *  (near-static; per-frame spam at 38fps would drown the signal). */
const __sizeTraceSeen = new Map<string, string>();
function __sizeTrace(key: string, line: string): void {
  if (__sizeTraceSeen.get(key) === line) return;
  __sizeTraceSeen.set(key, line);
  console.log(`[size-trace] ${line}`);
}

const SHIFT_LIMIT = radians(SHIFT_LIMIT_DEG);
const VSHIFT_LIMIT = radians(VSHIFT_LIMIT_DEG);
const DT_MAX_FRAMES = 10;
const TRACKER_LOST_TOLERANCE = 10;
/** Parallel-ray threshold (tan-difference) guarding the seed divide — see spec
 *  §seed-space. */
const SEED_PARALLEL_EPS = 1e-9;

/** Adapt a native tracker meter to the `WorkloadSnapshot` shape (keyed by node
 *  id so it folds onto the graph node's badge). */
function trackerWorkload(name: string, m: TrackerMeter): WorkloadSnapshot {
  const t = Date.now();
  return {
    name,
    window: { startedAt: t - m.uptimeMs, snapshotAt: t, uptimeMs: m.uptimeMs },
    utilization: m.utilization,
    busyMs: m.busyMs,
    inputs: m.inputs,
    outputs: m.outputs,
    drops: { total: m.dropTotal, ratePerSec: 0, byReason: {} },
  };
}

function cloneTuning(t: Tuning): Tuning {
  return {
    pan: [...t.pan],
    depth: [...t.depth],
    v_shift: [...t.v_shift],
    sensitivity: t.sensitivity,
    scale: t.scale,
    min_score: t.min_score,
    expand_x: t.expand_x,
    expand_y: t.expand_y,
    timeout: t.timeout,
  };
}

export default function disparityScopeSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  sliceSeam: SlicePipeSeam,
  scaleSeam: ScalePipeSeam,
  stereoSeam: StereoPipeSeam,
  heatmapSeam: HeatmapPipeSeam,
  compositeSeam: CompositePipeSeam,
  rawPipes: RawPipeRegistry,
  compress?: CompressPipeSeam,
): ServerSession<typeof disparity> {
  return defineSession("disparity-scope", disparity, (s) => {
    let triple: CalibratedTriple | null = null;

    // Capture + recording over the leased triple — see spec §capture. Both null
    // until the center pipe connects on activate.
    let captureHelper: CaptureHelper | null = null;
    let captureCenter: { shmName: string; maxBytes: number; channels: number } | null = null;

    const recording = createRawRecording({
      id: "recorder/disparity-scope",
      broker,
      rawPipes,
      compress,
      streams: () =>
        triple
          ? {
              "left-fovea": triple.leases.L.camera,
              center: triple.leases.C.camera,
              "right-fovea": triple.leases.R.camera,
            }
          : null,
      finished: (foveaPath) =>
        process.parentPort?.postMessage({ type: "recording:finished", path: foveaPath }),
      telemetry: (patch) => s.telemetry(patch),
    });
    const disposers = new DisposerBag();
    /** Controller node position input (push-model transport) — activate..idle. */
    let posInput: PositionInput | null = null;
    /** v1 awaited-actuate round-trip ms (node `onApplied`); ~0 on v2 streaming. */
    let lastActuateMs = 0;
    /** The two per-side template-match workers. */
    const workers: { L: VisionWorkerHandle | null; R: VisionWorkerHandle | null } = {
      L: null,
      R: null,
    };
    // General-purpose bricks composed on activate, retired via `disposers`
    // consumer-most-first (spec §topology).
    let stripSlice: SliceHandle | null = null;
    let tileSlice: SliceHandle | null = null;
    let stripScale: ScaleHandle | null = null;
    const needleScales: { L: ScaleHandle | null; R: ScaleHandle | null } = {
      L: null,
      R: null,
    };
    /** SGBM disparity + heatmap — PARKED until the renderer connects the heatmap
     *  pipe (spec §topology). */
    let stereo: StereoHandle | null = null;
    let stereoHeatmap: HeatmapHandle | null = null;
    /** Anaglyph / L-vs-R difference COMPOSITE brick — parked until the center
     *  view selects disparity/anaglyph; mode retuned from `state.view`. */
    let composite: CompositeHandle | null = null;
    /** Configured anaglyph L/R color arrangement (app config `anaglyph_style`),
     *  read at activate + watched live. Default RC until the read resolves. */
    let anaglyphStyle: AnaglyphStyle = DEFAULT_ANAGLYPH_STYLE;
    /** Wide (C) frame dims — the crop/scale geometry base (read once on activate). */
    let wide: Size = { width: 0, height: 0 };
    /** Fovea (L/R) source frame dims — the NEEDLE scale base when the measured
     *  magnification wins (see `needleGeometry` + spec §needle-geometry). */
    let fovea: Size = { width: 0, height: 0 };
    /** Match scale `s` commanded to the strip scaler — the divisor lifting match
     *  rects back to full-res strip-local px. */
    let stripScaleFactor = 1;
    /** Strip crop rect currently commanded (source/undistorted px). */
    let stripRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
    /** Graph-visible PID node — holds the vergence controllers + override slot. */
    let pidNode: PidNodeHandle<VergenceVolts> | null = null;
    /** Native IMM motion-predictor brick — always created while tracking (spec
     *  §actuation); free-runs at `prediction_rate_hz`, fed every raw tracker result. */
    let imm: ImmPredictor | null = null;
    /** Native compose brick — joins pid baseline + IMM predictions into final
     *  volts, pipes natively into the controller (spec §actuation). */
    let compose: Compose | null = null;
    /** Live native mirror sink (null while no v2 controller bound → JS fallback). */
    let nativeSink: MirrorSink | null = null;
    let voltLink: PortLink | null = null;
    let nativePos: import("@orchestrator/controller-node").NativePositionInput | null = null;
    /** Requested prediction rate — imm emit rate AND the governor's ceiling. */
    let currentRateHz = 600;

    let windowStart = now();
    let lastStep = now();
    let lastVoltEmit = 0;
    let status = "initializing";
    let lastGood: Point2d = ZERO;

    // --- chained tracker state (spec §tracker) ---
    /** Session-owned tracker thread on the C undistort chain. Engine is
     *  runtime-selectable (`state.tracker_type`), both drop-in (tracker-swap.ts). */
    let tk: KcfTracker | null = null;
    /** Tracker source pipe + graph node id — CONSTANT across a swap (no churn);
     *  both null while idle. */
    const trackerSrc: { pipe: string | null; node: string | null } = {
      pipe: null,
      node: null,
    };
    /** The tracker engine actually running — swap degrade fallback + dedupe. */
    let runningTrackerType: TrackerType = "hybrid";
    /** A `tracker_type` change requested during a drag, DEFERRED to drag end. */
    let pendingTrackerType: TrackerType | null = null;
    /** Native kcf → imm measurement port link — re-established on every swap. */
    let measureLink: PortLink | null = null;
    /** JS-side auto-follow gate (native has NO disarm; ignore results until re-arm). */
    let trackerArmed = false;
    /** Found results currently flowing (drives `frozen()` + the bbox overlay). */
    let trackerActive = false;
    /** A pointer drag is in flight (down..up) — the tracker override is engaged. */
    let dragging = false;
    /** Last `overridden` telemetry sent (publish transitions only). */
    let overriddenTele = false;

    /** Commanded volts — the PID node's output, pushed on every result (`pushVolts`). */
    let commandedVolts: VergenceVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
    /** Drag slew state (spec §drag-slew): first-order smoother toward the pointer
     *  target while dragging. Null outside a drag; seeded at the first apply. */
    const dragSlew = new DragSlew(now);
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    // The named DOF controllers (owned by the PID node once created). `pan` is a
    // PID2D (separate x/y integrators); `verge`/`v_shift` are scalar PIDs.
    // All in MEASUREMENT-derivative mode (spec §control-law): tracker
    // target motion must never kick kd; stepVergence supplies each DOF's
    // measurement point.
    const MEAS_D = { derivativeOn: "measurement" } as const;
    const pan = new PID2D({ x: MEAS_D, y: MEAS_D });
    const verge = new PID({
      limits: [0, distanceToVerge(VERGE_MIN_DISTANCE_MM, s.state.baseline)],
      ...MEAS_D,
    });
    const v_shift = new PID({ limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT], ...MEAS_D });
    const controllers: VergenceControllers = { pan, verge, v_shift };

    const shiftLim: [number, number] = [-SHIFT_LIMIT, SHIFT_LIMIT];
    function panParams(t: Tuning): PidParams {
      return { kp: t.pan[0], ki: t.pan[1], kd: t.pan[2], limits: shiftLim };
    }
    /** Retune the controllers from tuning (uniform {@link PidParams}) without
     *  disturbing the running integrators — `verge`'s baseline-derived limits
     *  are left intact (setParams only touches limits when passed). */
    function syncGains(t: Tuning): void {
      pan.setParams({ x: panParams(t), y: panParams(t) });
      verge.setParams({ kp: t.depth[0], ki: t.depth[1], kd: t.depth[2] });
      v_shift.setParams({
        kp: t.v_shift[0],
        ki: t.v_shift[1],
        kd: t.v_shift[2],
        limits: [-VSHIFT_LIMIT, VSHIFT_LIMIT],
      });
    }
    syncGains(s.state.tuning);

    /** Calibration-MEASURED fovea↔wide magnification (mean of both eyes when
     *  measured, a single eye's value when one is, null when neither). */
    function measuredMatchZoom(): number | null {
      if (!triple) return null;
      const { L, R } = triple.magnification;
      if (L !== null && R !== null) return (L + R) / 2;
      return L ?? R;
    }

    /** The per-triple stored optical zoom override (>0), else null — the middle
     *  tier of the magnification order (spec §magnification). */
    function tripleZoomOverride(): number | null {
      return triple?.zoomOverride ?? null;
    }

    /** Resolved match magnification under the resolution order (spec §magnification).
     *  Drives the match scale AND (via `Math.max(1, matchZoom())`) crop/search sizing. */
    function matchZoom(): number {
      return matchMagnification(measuredMatchZoom(), s.state.zoom, tripleZoomOverride());
    }

    /** The needle scaler's zoom + BASE DIMS, paired by the zoom's units —
     *  measured → fovea dims, nominal → center dims (spec §needle-geometry). The
     *  fovea branch is taken only when the measured tier WINS (by tier, not value). */
    function needleGeometry(): { zoom: number; base: Size } {
      const knob = s.state.zoom;
      const override = tripleZoomOverride();
      const measured = measuredMatchZoom();
      const zoom = matchMagnification(measured, knob, override);
      const knobWins = Number.isFinite(knob) && knob > 0;
      const overrideWins =
        !knobWins && override != null && Number.isFinite(override) && override > 0;
      const measuredWins =
        !knobWins &&
        !overrideWins &&
        measured != null &&
        Number.isFinite(measured) &&
        measured > 0;
      return { zoom, base: measuredWins ? fovea : wide };
    }

    function effectiveScale(): number {
      const ratio = Math.max(0, Math.min(1, s.state.tuning.scale));
      return 1 + (matchZoom() - 1) * ratio;
    }

    /** Auto-vergence is OFF (`timeout` at the slider-min `-1` sentinel, or a
     *  manual DOF write latched the hold — see `latchManualHold`): the
     *  control law never steps. Pointer drags and the manual sliders still
     *  steer — and a live tracker keeps FOLLOWING: the foveas ride
     *  `followVolts(target)` through the frozen/manual DOF
     *  values (controlStep's disabled branch); only the CORRECTIONS stop. */
    function autoVergenceDisabled(): boolean {
      return s.state.tuning.timeout < 0 || windowStart === -Infinity;
    }

    function frozen(): boolean {
      if (autoVergenceDisabled()) return true;
      // Active tracker (armed OR found results flowing) suspends the convergence
      // timeout, always — spec §freeze-window.
      if (trackerArmed || trackerActive) return false;
      const t = s.state.tuning.timeout;
      const timeoutMs = t > 0 ? t : Infinity;
      return timeoutMs !== Infinity && now() - windowStart > timeoutMs;
    }

    // --- crop/scale geometry (spec §topology) ------------------------------
    // The session owns ALL sizing math; the match workers stay
    // geometry-free. Steering is reactive (applied on the producers' next frame).

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

    /** The display center tile: `wide/zoom`, target-centered (the crop the
     *  `sliced` view shows). */
    function tileRect(): Rect {
      const z = Math.max(1, matchZoom()); // resolved zoom (Auto → measured)
      return clampToWide(
        RECT.fromCenter(s.state.target, {
          width: wide.width / z,
          height: wide.height / z,
        }),
      );
    }

    /** The match strip: the center tile expanded by `expand_x`/`expand_y`,
     *  target-centered. */
    function computeStripRect(): Rect {
      const z = Math.max(1, matchZoom()); // resolved zoom (Auto → measured)
      const t = s.state.tuning;
      return clampToWide(
        RECT.fromCenter(s.state.target, {
          width: (wide.width / z) * t.expand_x,
          height: (wide.height / z) * t.expand_y,
        }),
      );
    }

    /** Re-steer both slice crops to the current target/zoom/expansion. */
    function steerCrops(): void {
      if (!wide.width) return;
      tileSlice?.steer(tileRect());
      stripRect = computeStripRect();
      stripSlice?.steer(stripRect);
    }

    /** Retune the three scale nodes: strip ratio = the match scale `s` (both
     *  sides land at `s` px per wide px — CCOEFF matching is not scale-
     *  invariant), needles to the fovea's wide-frame footprint at `s`. */
    function retuneScalers(): void {
      if (!wide.width) return;
      const sF = effectiveScale();
      stripScaleFactor = sF;
      stripScale?.retune({ ratio: sF });
      const g = needleGeometry();
      const size = foveaTileSize({
        width: g.base.width,
        height: g.base.height,
        zoom: g.zoom,
        scale: sF,
      });
      const dsize = {
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height)),
      };
      needleScales.L?.retune({ dsize });
      needleScales.R?.retune({ dsize });
    }

    /** Composite params for a center view: `disparity` → difference, else
     *  anaglyph at the configured style. `style` always rides along — the native
     *  `setParams` REPLACES the whole spec, so a mode-only retune would clobber it. */
    function compositeParamsFor(view: string): CompositeParams {
      return {
        mode: view === "disparity" ? "difference" : "anaglyph",
        style: anaglyphStyle,
      };
    }

    /** Retune the composite brick from the selected view + current style. Only
     *  the two composite views retune; `sliced`/`sgbm` leave it parked. */
    function syncCompositeMode(view: string): void {
      if (view === "disparity" || view === "anaglyph")
        composite?.retune(compositeParamsFor(view));
    }

    // --- chained tracker: arm + result feed -------------------------

    /** Publish the `overridden` telemetry on TRANSITIONS only (the tracker
     *  re-affirms the flag every frame; the UI badge needs edges, not spam). */
    function publishOverridden(v: boolean): void {
      if (v === overriddenTele) return;
      overriddenTele = v;
      s.telemetry({ overridden: v });
    }

    /** (Re-)arm the chained tracker at `center` with the contract's KCF
     *  template size. Native clamps the ROI to the frame. */
    function armTracker(center: Point2d): void {
      if (!tk) return;
      tk.arm(
        RECT.fromCenter(center, {
          width: s.state.kernel.w,
          height: s.state.kernel.h,
        }),
      );
      trackerArmed = true;
      s.telemetry({ tracker_lost: false }); // (re-)armed — the latch cleared
    }

    /** Create a chained tracker of `type` on the current source pipe + node id.
     *  THROWS when no brick is attached (degradation path). */
    function createTrackerOfType(type: TrackerType): KcfTracker {
      const { pipe, node } = trackerSrc;
      if (!pipe || !node) throw new Error("tracker source not ready");
      return type === "kcf"
        ? createChainedTracker(pipe, node)
        : createChainedHybridTracker(pipe, node);
    }

    /** HOT-SWAP the object-tracker engine mid-session (spec §tracker): release,
     *  re-create on the same source/node, resume + re-pipe kcf→imm, re-arm iff
     *  armed. Degrades to the previous engine on a factory throw. Sequencing in
     *  the pure `swapTracker`. */
    function performTrackerSwap(type: TrackerType): void {
      // Only meaningful while a tracker source exists (session active).
      if (!trackerSrc.pipe || !trackerSrc.node) return;
      const wasArmed = trackerArmed;
      const res = swapTracker(tk, type, runningTrackerType, wasArmed, {
        release: (old) => {
          measureLink?.release(); // drop the old kcf → imm link first
          measureLink = null;
          old.release(); // closes the async iterator → consumeTracker exits
          trackerActive = false;
        },
        create: (t) => createTrackerOfType(t),
        consume: (nt) => {
          // Re-establish the native measurement link into the SAME imm brick.
          if (imm) measureLink = nt.track_out.pipe(imm.measure_in);
          void consumeTracker(nt, trackerFeed);
        },
        rearm: (nt) => {
          nt.arm(
            RECT.fromCenter(s.state.target, {
              width: s.state.kernel.w,
              height: s.state.kernel.h,
            }),
          );
          trackerArmed = true;
        },
      });
      tk = res.tracker;
      runningTrackerType = res.type;
      if (!res.ok) {
        console.error(
          `[disparity-scope] tracker '${type}' unavailable; kept '${res.type}'`,
        );
        // Never advertise a type that isn't running: pin the select to reality.
        if (res.type !== type) s.setState("tracker_type", res.type);
      }
    }

    // (spec §control-law): {t, target} ring in host steady-clock ns — the
    // trusted-time domain every pipe frame's deviceTimestamp is calibrated
    // into — appended at EVERY target write, so the join can resolve the
    // target AS OF a matched frame's capture epoch. 256 entries cover >1 s at
    // the combined tracker + pointer write rate; capture→match lag is ~100 ms.
    const TARGET_RING_CAP = 256;
    const targetRing: TargetSample[] = [];

    /** The ONE target write path: ring append + state write, so no
     *  `state.target` change can escape the capture-epoch history. */
    function writeTarget(p: Point2d): void {
      recordTarget(targetRing, { t: Number(hostNowNs()), target: p }, TARGET_RING_CAP);
      s.setState("target", p);
    }

    // Per-result routing off the tracker thread (spec §tracker; gating in
    // tracker-feed.ts).
    const trackerFeed = createDisparityTrackerFeed(
      {
        armed: () => trackerArmed,
        onDrag(center) {
          // This path must NOT push volts — it only UPDATES the target below.
          // The pointer handler pushes synchronously, and the match-path
          // re-affirm (controlStep's overridden branch) slews toward
          // `state.target` at match rate, off the same camera-frame cadence as
          // this callback — so a coalesced-away pointer move is still
          // steered-to within one match tick, and every drag volts writer is
          // slewed BY CONSTRUCTION (no un-slewed volts path).
          pidNode?.ingest("target"); // meter the kcf → pid target edge
          lastGood = center;
          writeTarget(center);
          steerCrops();
          publishOverridden(true);
        },
        onTrack(center, bbox) {
          pidNode?.ingest("target"); // meter the kcf → pid target edge (accepted rate)
          trackerActive = true;
          // Tracking = activity: keep the freeze window fresh — but NEVER
          // clear the manual-hold latch (a slider write freezes auto-vergence
          // while the tracker keeps following; tracker results must not
          // un-hold it).
          if (windowStart !== -Infinity) windowStart = now();
          lastGood = center;
          writeTarget(center);
          steerCrops();
          s.telemetry({ tracker_bbox: bbox });
          publishOverridden(false);
        },
        onLost() {
          markTrackerLost();
        },
      },
      TRACKER_LOST_TOLERANCE,
    );

    /** The ONE lost policy — the count-based `onLost` (delivered misses) and
     *  the stall WATCHDOG (nothing delivered at all) both land here (spec
     *  §tracker): release auto-follow, hold the last good target, restart the
     *  freeze window, latch `tracker_lost`. `composeHealthy` then flips
     *  feed-forward off at
     *  the next rebase — a dead source can never keep driving the mirrors
     *  through the predictor's coast. */
    function markTrackerLost(): void {
      trackerArmed = false;
      trackerActive = false;
      // Restart the freeze window — unless a manual hold is latched: a lost
      // tracker under "held" must stay held, not resume auto-stepping.
      if (windowStart !== -Infinity) windowStart = now();
      writeTarget(lastGood);
      s.telemetry({ tracker_bbox: null, tracker_lost: true });
    }

    /** AUTOTUNE-ONLY disengage: drop the auto-follow AND latch the hold by
     *  expiring the convergence window (`-Infinity` ⇒ `autoVergenceDisabled`,
     *  covering the `timeout=0` no-timeout mode a plain expiry can't). The tune
     *  experiments script the TARGET, so a live tracker would fight them —
     *  `tracker_enabled` flips OFF for real (the toggle must not read "on"
     *  while results are ignored). Manual DOF writes do NOT come here — they
     *  latch the hold via `latchManualHold` and keep the tracker following. */
    function disengageAutoVergence(): void {
      trackerArmed = false;
      trackerActive = false;
      windowStart = -Infinity;
      s.setState("tracker_enabled", false);
      s.telemetry({ tracker_bbox: null });
    }

    /** Manual DOF write (`setPid` slider drag) or the PAUSE button freezes
     *  auto-vergence IMMEDIATELY — even mid-track — WITHOUT touching the
     *  tracker: the hold latch stops PID
     *  stepping, while an armed tracker keeps updating the target and the
     *  foveas keep FOLLOWING it through the (now manual) DOF values —
     *  `controlStep`'s disabled branch. Cleared by: a pointer drag (its
     *  ticks restart the window), toggling the tracker off→on, the pause
     *  button's resume, or a `pidOverride` release. */
    function latchManualHold(): void {
      windowStart = -Infinity;
      publishPaused();
    }

    /** `vergence_paused` on TRANSITIONS only — the latch is written from many
     *  paths (slider writes, pause command, drag ticks, toggle re-arm), so
     *  the telemetry tick calls this as a catch-all and the direct latch
     *  paths call it for immediacy. */
    let lastPausedTele = false;
    function publishPaused(): void {
      const paused = windowStart === -Infinity;
      if (paused === lastPausedTele) return;
      lastPausedTele = paused;
      s.telemetry({ vergence_paused: paused });
    }

    // Watchdog state: stamped on EVERY delivered tracker result (found or
    // miss — delivery is what the count-based tolerance already covers);
    // checked on the telemetry cadence below.
    let lastTrackerResultAt = 0;

    // --- PID-node override slot (generic volts path ONLY) --------

    /** Mirror the server-authoritative override slot into contract state so the
     *  renderer's `usePidOverride` proxy reads `engaged`/`value` back. */
    function publishOverride(): void {
      s.setState(
        "pidOverride",
        pidNode
          ? { engaged: pidNode.override.engaged, value: pidNode.override.value }
          : { engaged: false, value: null },
      );
    }

    /** Reseed the controllers from the last override value so control resumes
     *  continuously (velocity-form integrator ⇒ output = last command). GENERIC
     *  volts path only (the `pidOverride` command) — drags don't seed; the V2A
     *  round-trip here is per-eye lossy but accepted (spec §seed-space). */
    function seedFromOverride(v: VergenceVolts): void {
      if (!triple || !triple.undistort) return;
      const conv = triple.conv;
      const gL = conv.V2A.L(v.l);
      const gR = conv.V2A.R(v.r);
      const aT = conv.P2A.C(s.state.target, false);
      const seed = seedVergence(gL, gR, aT, s.state.baseline, SEED_PARALLEL_EPS);
      pan.value = seed.pan; // PID2D setter clamps each axis to its limits
      verge.value = seed.verge; // PID setter clamps to its limits
      v_shift.value = seed.v_shift; // PID setter clamps to its limits
    }

    // --- two-stage auto-tune (spec §autotune) ---
    // Session-driven, drawer-gated; experiments run on hardware. The run rides the
    // existing manual-hold machinery (normal stepping already held, feed-
    // forward down via `frozen()`), drives DOFs through the same controller
    // `.value` + follow-map push path the sliders use, and samples the SAME
    // match-join projections the loop consumes (`runControl` branches to
    // `autotuneStep` while a run is live — the normal path is untouched).
    let autotuneRun: AutotuneRun | null = null;
    /** Bumped on every run start AND the idle silent-discard — stale run
     *  callbacks (progress/finished after teardown) become no-ops. */
    let tuneEpoch = 0;
    let tuneT0 = 0;
    /** Sensitivity captured at run start: the tune clock's ms → loop-dt-unit
     *  factor (gains are defined against loop-dt; a mid-run slider write must
     *  not warp the clock or the derived Tu). */
    let tuneSensitivity = DEFAULT_TUNING.sensitivity;
    /** Restore-on-terminal snapshot (abort restores tuning + pose + target). */
    let preTune: {
      tuning: Tuning;
      pose: { panX: number; panY: number; verge: number; v_shift: number };
      target: Point2d;
    } | null = null;
    /** A user tuning write triggered the cancel — keep THEIR tuning, only
     *  resync the live controllers (see the `tuning` watch). */
    let tuneKeepTuning = false;

    const tuneNow = (): number => (now() - tuneT0) * tuneSensitivity;

    /** Per-DOF `setpoint − measurement` errors — the same decomposition
     *  `stepVergence` integrates (spec §control-law), lifted here so the tune
     *  observes exactly what the loop would. */
    function decomposeDofErrors(p: ScopeProjection): DofErrors | null {
      if (!triple || !triple.undistort) return null;
      const toAngle = (q: Point2d): Point2d => triple!.conv.P2A.C(q, false);
      const aL = toAngle(p.l);
      const aR = toAngle(p.r);
      const aT = toAngle(p.target);
      return {
        panX: (aT.x - aL.x + (aT.x - aR.x)) / 2,
        panY: (aT.y - aL.y + (aT.y - aR.y)) / 2,
        verge: aR.x - aL.x,
        v_shift: (aR.y - aL.y) / 2,
      };
    }

    function tuningWith(g: GainSet): Tuning {
      return {
        ...cloneTuning(s.state.tuning),
        pan: [...g.pan],
        depth: [...g.depth],
        v_shift: [...g.v_shift],
      };
    }

    function currentGainSet(): GainSet {
      const t = s.state.tuning;
      return { pan: [...t.pan], depth: [...t.depth], v_shift: [...t.v_shift] };
    }

    function autotuneRefusal(): string | null {
      if (!triple || !triple.undistort) return "no calibration";
      if (dragging) return "release the drag first";
      // An armed/enabled tracker is NOT a refusal: startAutotune's
      // disengageAutoVergence() turns it off honestly (toggle included) —
      // a tune click takes over the same way a slider write does.
      if (pidNode?.override.engaged) return "release the PID override first";
      return null;
    }

    function publishAutotuneRefusal(stage: AutotuneStage, message: string): void {
      s.telemetry({
        autotune: {
          phase: "failed",
          stage,
          dof: null,
          dofsDone: 0,
          cycles: 0,
          evals: 0,
          budget: 0,
          bestCost: null,
          baselineCost: null,
          message,
          gains: null,
        },
      });
    }

    /** Terminal handler (the run's `finished` hook): persist the resulting
     *  gains (done) or restore the pre-tune tuning (abort/failure), return to
     *  the HELD state at the pre-tune pose + target — the user resumes control
     *  explicitly. Server-side setState does NOT fire the `tuning` watch, so
     *  the controllers are re-synced explicitly on every path. */
    function finishAutotune(o: { phase: "done" | "failed" | "aborted"; gains: GainSet | null }): void {
      autotuneRun = null;
      if (o.phase === "done" && o.gains) {
        const next = tuningWith(o.gains);
        s.setState("tuning", next);
        syncGains(next);
      } else if (tuneKeepTuning) {
        syncGains(s.state.tuning); // drop candidate gains, keep the user's write
      } else if (preTune) {
        s.setState("tuning", preTune.tuning);
        syncGains(preTune.tuning);
      }
      if (preTune) {
        pan.x.value = preTune.pose.panX;
        pan.y.value = preTune.pose.panY;
        verge.value = preTune.pose.verge;
        v_shift.value = preTune.pose.v_shift;
        writeTarget(preTune.target);
        steerCrops();
      }
      preTune = null;
      status = "held"; // the disengage latch persists (windowStart -Infinity)
      const v = followVolts(s.state.target);
      if (v && !pidNode?.override.engaged) {
        commandedVolts = v;
        pushVolts();
      }
    }

    /** Abort a live run (user command, or any interaction that must win —
     *  drag, slider write, tracker re-enable). The reason carries the gains
     *  OUTCOME, so the status line never claims a restore that didn't happen
     *  (a tuning-write cancel keeps the USER's gains, not the pre-tune ones). */
    function cancelAutotune(reason: string, keepTuning = false): void {
      if (!autotuneRun) return;
      tuneKeepTuning = keepTuning;
      autotuneRun.abort(
        keepTuning
          ? `${reason} (your gains kept, pose restored)`
          : `${reason} (pre-tune gains restored)`,
      ); // → finished → finishAutotune
      tuneKeepTuning = false;
    }

    function startAutotune(stage: AutotuneStage): void {
      // SILENT while a run is live: a double-click's
      // second command must never overwrite the live progress record with a
      // "failed" one — that would re-enable the tune buttons and hide abort
      // while the mirrors are still wiggling.
      if (autotuneRun) return;
      const refusal = autotuneRefusal();
      if (refusal) {
        publishAutotuneRefusal(stage, refusal);
        return;
      }
      // Enter the manual-hold machinery: the latch keeps normal stepping out
      // while the run drives, and feed-forward stays down (spec §freeze-window).
      disengageAutoVergence();
      status = "autotune";
      preTune = {
        tuning: cloneTuning(s.state.tuning),
        pose: {
          panX: pan.x.value,
          panY: pan.y.value,
          verge: verge.value,
          v_shift: v_shift.value,
        },
        target: { ...s.state.target },
      };
      tuneT0 = now();
      tuneSensitivity = s.state.tuning.sensitivity;
      const epoch = ++tuneEpoch;
      const baseTarget = { ...s.state.target };
      autotuneRun = new AutotuneRun(
        stage,
        {
          // DOF value setters clamp via each PID's integral limits — a relay
          // command can never leave the physical range (relay-tune clamps too).
          dof: {
            panX: {
              get: () => pan.x.value,
              set: (v) => {
                pan.x.value = v;
              },
              range: [shiftLim[0], shiftLim[1]],
            },
            panY: {
              get: () => pan.y.value,
              set: (v) => {
                pan.y.value = v;
              },
              range: [shiftLim[0], shiftLim[1]],
            },
            verge: {
              get: () => verge.value,
              set: (v) => {
                verge.value = v;
              },
              range: [verge.limits[0], verge.limits[1]],
            },
            v_shift: {
              get: () => v_shift.value,
              set: (v) => {
                v_shift.value = v;
              },
              range: [-VSHIFT_LIMIT, VSHIFT_LIMIT],
            },
          },
          applyGains: (g) => {
            if (epoch === tuneEpoch) syncGains(tuningWith(g)); // live, not persisted
          },
          setTargetOffset: (px) => {
            if (epoch !== tuneEpoch) return;
            writeTarget({ x: baseTarget.x + px, y: baseTarget.y });
            steerCrops();
          },
          progress: (p) => {
            if (epoch === tuneEpoch) s.telemetry({ autotune: p });
          },
          finished: (o) => {
            if (epoch === tuneEpoch) finishAutotune(o);
          },
        },
        { initialGains: currentGainSet(), startT: 0, seed: (Date.now() % 0xffff) | 1 },
      );
    }

    /** One tune control tick (replaces `controlStep` while a run is live):
     *  feed the run, then either hold, reposition after a relay command (the
     *  follow map at the live target — the setPid push path), or step the real
     *  law at the candidate gains (the CMA-ES eval window). */
    function autotuneStep(projection: ScopeProjection): VergenceVolts {
      const run = autotuneRun!;
      status = "autotune";
      const errors = decomposeDofErrors(projection);
      if (!errors) return commandedVolts;
      const minScore = s.state.tuning.min_score;
      const d = run.feed({
        t: tuneNow(),
        errors,
        scoreOk:
          projection.scores.l >= minScore && projection.scores.r >= minScore,
      });
      if (d.mode === "step" && triple) {
        const t = now();
        const dt = Math.min((t - lastStep) * tuneSensitivity, DT_MAX_FRAMES);
        const result = stepVergence(
          projection,
          controllers,
          { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
          { baseline: s.state.baseline, minScore },
          dt,
        );
        lastStep = t;
        if (result) return { l: result.left, r: result.right };
        return commandedVolts;
      }
      if (d.mode === "drive") {
        const v = followVolts(s.state.target);
        if (v) return v;
      }
      return commandedVolts;
    }

    // --- per-side match results → the pid JOIN (spec §match-join) ----------

    type SideKey = "L" | "R";
    type SideMatch = {
      center: Point2d;
      score: number;
      seq: number;
      at: number;
      /** Trusted-time capture epoch (host-ns, the frame's `deviceTimestamp`;
       *  0 = unstamped) — the trigger-sync pair window keys on it. */
      epoch: number;
    };
    /** Latest result per side; the step runs when the arriving side completes a
     *  pair (seq ≥ the other's) — order-agnostic, ~once per strip frame. */
    const latestMatch: { L: SideMatch | null; R: SideMatch | null } = {
      L: null,
      R: null,
    };
    /** Highest PAIR seq (the older side's) already steered on — gates the
     *  control step to ONCE per pair. Without it the law ran twice per strip
     *  frame (each side's arrival re-paired with the other's held result), and
     *  the second run's near-zero dt turned any kd ≠ 0 into an unbounded
     *  `Δe/dt` kick (the auto-vergence kd explosion). */
    let lastSteppedSeq = -1;

    function onMatch(side: SideKey, r: VisionResult): void {
      const v = r.values as unknown as TemplateMatchValues;
      pidNode?.ingest(side === "L" ? "l" : "r"); // meter the match → pid edge
      // The correlation heatmap → this side's session frame channel.
      for (const f of r.frames)
        if (f.name === "match")
          s.frame(
            side === "L" ? "match_left" : "match_right",
            makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels),
          );
      // Lift out of scaled-strip space (/s → full-res strip-local px) + the
      // frame's crop origin → absolute undistorted-wide px (spec §match-join).
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
      s.telemetry(
        side === "L"
          ? { match_left: { rect: rectFull, score: v.score } }
          : { match_right: { rect: rectFull, score: v.score } },
      );
      const other = latestMatch[side === "L" ? "R" : "L"];
      if (!other || m.seq < other.seq) return; // pair incomplete — wait
      // Trigger-sync pair window (spec §trigger-sync): while ENGAGED, capture
      // epochs from different trigger slots must not pair — latest-wins
      // recovers on the next arrival (a one-sided drop self-heals). Free-run
      // (not engaged) never consults epochs.
      if (
        pairEpochGateTrips(
          triggerEngaged,
          triggerBudget?.minIntervalMs ?? null,
          m.epoch,
          other.epoch,
        )
      ) {
        status = "pair skew";
        return;
      }
      // A stale partner (spec §match-join) is treated as LOST: hold the pose.
      // The AGE bound scales to the trigger cadence while engaged.
      if (
        matchPartnerStale(
          { ageMs: now() - other.at, seqGap: m.seq - other.seq },
          matchStaleMsFor(triggerEngaged, triggerBudget?.minIntervalMs ?? null),
        )
      ) {
        status = "match stale";
        return;
      }
      // Center-tile marker for the guide overlay (strip-local full-res px,
      // anchored to THIS strip frame's origin so it stays aligned mid-steer).
      const z = Math.max(1, matchZoom()); // resolved zoom (Auto → measured)
      s.telemetry({
        match_center: {
          rect: RECT.fromCenter(VEC.sub(s.state.target, v.origin), {
            width: wide.width / z,
            height: wide.height / z,
          }),
        },
      });
      // One control step per PAIR (keyed by the older side's seq): in steady
      // state that lands on the completing arrival (both sides fresh) and skips
      // the half-updated re-pair the NEXT side's arrival would form. A lagging
      // partner still steers at the laggard's rate within the staleness bounds.
      const pairSeq = Math.min(m.seq, other.seq);
      if (pairSeq <= lastSteppedSeq) return;
      lastSteppedSeq = pairSeq;
      runControl({
        l: (side === "L" ? m : other).center,
        r: (side === "R" ? m : other).center,
        // (spec §control-law): the error pairs the matched centers with the
        // target AS OF the strip frame's capture epoch (its trusted
        // deviceTimestamp), not the target as of now — a moving target no
        // longer injects phantom error ∝ velocity × pipeline delay.
        target: targetAtEpoch(targetRing, v.deviceTimestamp, s.state.target),
        scores: {
          l: (side === "L" ? m : other).score,
          r: (side === "R" ? m : other).score,
        },
        overridden: dragging, // session-local (spec §drag)
      });
    }

    /** One drag-slew step toward the follow target (spec §drag-slew): seeds from
     *  the current commanded pose on the first apply, then advances with dt =
     *  time since the previous apply. Rides the VALUE only. */
    function slewToward(target: VergenceVolts): VergenceVolts {
      const pose: SlewPose = dragSlew.toward(
        { l: commandedVolts.l, r: commandedVolts.r },
        target,
      );
      return { l: pose.l, r: pose.r };
    }

    /** Direct-follow volts for `target` (the drag path; spec §drag,
     *  {@link followTarget}). Null without a calibrated triple. */
    function followVolts(target: Point2d): VergenceVolts | null {
      if (!triple || !triple.undistort) return null;
      const r = followTarget(
        target,
        { pan: pan.value, verge: verge.value, v_shift: v_shift.value },
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        s.state.baseline,
      );
      return { l: r.left, r: r.right };
    }

    /** The vergence control law, run inside the PID node's control fn (invoked
     *  by `node.step` only when the generic override is NOT engaged). Returns
     *  the held/last volts on any hold condition so actuation freezes rather
     *  than winds down. `projection.overridden` → DIRECT FOLLOW (spec §drag). */
    function controlStep(projection: ScopeProjection): VergenceVolts {
      if (!triple || !triple.undistort) {
        status = "no calibration";
        return commandedVolts;
      }
      if (projection.overridden) {
        windowStart = now(); // drag = activity
        status = "manual";
        // Match-rate re-affirm of the drag follow, slewed like the pointer
        // path — toward the LIVE target (the drag chases the pointer, not the
        // capture-epoch target the PID error uses).
        const follow = followVolts(s.state.target);
        return follow ? slewToward(follow) : commandedVolts;
      }
      if (autoVergenceDisabled()) {
        // Distinct from "frozen" (a timeout that a drag restarts) AND from the
        // transient drag "manual": the sentinel needs the Timeout slider
        // moved, the "held" latch a new drag / tracker re-enable.
        // Disabled/held freezes the CORRECTIONS, not the tracker — while
        // auto-follow is live the foveas keep following the tracker's target
        // through the frozen/manual DOF values, slewed like every other follow
        // writer (no un-slewed volts path). No match-score gate, mirroring the
        // drag path — the follow is pure geometry off the wide-view target. The
        // status names the motion: parked and actively-following are visibly
        // different.
        const base = s.state.tuning.timeout < 0 ? "auto off" : "held";
        if (trackerActive) {
          status = `${base} · following`;
          const follow = followVolts(s.state.target);
          if (follow) return slewToward(follow);
        }
        status = base;
        return commandedVolts;
      }
      if (frozen()) {
        status = "frozen";
        return commandedVolts;
      }
      const t = now();
      const dt = Math.min((t - lastStep) * s.state.tuning.sensitivity, DT_MAX_FRAMES);
      const result = stepVergence(
        projection,
        controllers,
        { P2A: triple.conv.P2A, A2V: triple.conv.A2V },
        { baseline: s.state.baseline, minScore: s.state.tuning.min_score },
        dt,
      );
      if (!result) {
        status = "low score";
        return commandedVolts;
      }
      lastStep = t;
      status = "tracking";
      return { l: result.left, r: result.right };
    }

    function runControl(projection: ScopeProjection): void {
      if (!pidNode) return;
      // A live auto-tune run consumes the projection instead of the normal
      // step (spec §autotune); a drag still wins (`overridden` → controlStep's
      // direct follow — pointer-down already cancelled the run).
      const step =
        autotuneRun && !projection.overridden
          ? () => autotuneStep(projection)
          : () => controlStep(projection);
      commandedVolts = outputOf(pidNode.step(step));
      if (pidNode.override.engaged) status = "manual";
      pushVolts();
    }

    // --- actuation (push-model at the PID result rate; spec §actuation) ----

    /** REBASE the native compose brick from this pid command (~60 Hz):
     *  `{V_pid, p_meas, J}`, `J` = per-eye 2×2 finite-difference of
     *  `followVolts` around the target. Emits the baseline floor on every rebase. */
    const J_EPS_PX = 1; // finite-difference step (px)
    function pushVolts(): void {
      if (!compose) return;
      const target = s.state.target;
      const vPid = { l: commandedVolts.l, r: commandedVolts.r };
      let feedForward = composeHealthy();
      let jL: number[] = [0, 0, 0, 0];
      let jR: number[] = [0, 0, 0, 0];
      if (feedForward) {
        const f0 = followVolts(target);
        const fx = followVolts({ x: target.x + J_EPS_PX, y: target.y });
        const fy = followVolts({ x: target.x, y: target.y + J_EPS_PX });
        if (f0 && fx && fy) {
          // Row-major 2×2 per eye: [dVx/dpx, dVx/dpy, dVy/dpx, dVy/dpy].
          jL = [
            (fx.l.x - f0.l.x) / J_EPS_PX,
            (fy.l.x - f0.l.x) / J_EPS_PX,
            (fx.l.y - f0.l.y) / J_EPS_PX,
            (fy.l.y - f0.l.y) / J_EPS_PX,
          ];
          jR = [
            (fx.r.x - f0.r.x) / J_EPS_PX,
            (fy.r.x - f0.r.x) / J_EPS_PX,
            (fx.r.y - f0.r.y) / J_EPS_PX,
            (fy.r.y - f0.r.y) / J_EPS_PX,
          ];
        } else {
          feedForward = false; // no calibration — hold the baseline
        }
      }
      compose.rebase({
        vPid,
        pMeas: { x: target.x, y: target.y },
        jL,
        jR,
        feedForward,
      });
    }

    /** Feed-forward applies ONLY while control is healthy — tracking, not
     *  dragging, no override pinned, not frozen (spec §actuation). */
    function composeHealthy(): boolean {
      return (
        trackerActive &&
        !dragging &&
        !(pidNode?.override.engaged ?? false) &&
        !frozen()
      );
    }

    /** JS FALLBACK volt consumer (spec §actuation): drains the compose volt
     *  iterator and drives `posInput` ONLY while no native sink is attached;
     *  idles as a flag check once one is. `compose.release()` ends it. */
    async function consumeComposeFallback(brick: Compose): Promise<void> {
      try {
        for await (const v of brick) {
          if (nativeSink || !posInput) continue; // native path owns the wire
          const applied = posInput.update({ left: v.left, right: v.right });
          onVolts({ L: applied.left, R: applied.right }, lastActuateMs);
        }
      } catch {
        // iterator closed on release / teardown — normal exit
      }
    }

    function onVolts(vv: { L: Pos; R: Pos }, actuateMs: number): void {
      actuateMsStats.push(actuateMs);
      const t = now();
      if (t - lastVoltEmit < VOLT_TELEMETRY_INTERVAL_MS) return;
      lastVoltEmit = t;
      const vergence = triple ? triple.conv.V2A.L(vv.L).x - triple.conv.V2A.R(vv.R).x : 0;
      const realized_distance = vergenceToDistance(vergence, s.state.baseline / 1000);
      const commanded_distance = vergeToDistance(verge.value, s.state.baseline);
      // Per-eye pose overlay in undistorted px (distort=false). MUST guard the
      // undistort too, not just the triple — A2P.C throws on an uncalibrated
      // wide camera and the uncaught throw killed the orchestrator (spec §teardown).
      const PX = (role: "L" | "R"): Point2d =>
        triple?.undistort ? triple.conv.A2P.C(triple.conv.V2A[role](vv[role]), false) : ZERO;
      const readout: PidReadout = {
        verge: verge.value,
        panX: pan.value.x,
        panY: pan.value.y,
        v_shift: v_shift.value,
      };
      s.telemetry({
        volt: vv,
        vergence,
        realized_distance,
        commanded_distance,
        L_PX: PX("L"),
        R_PX: PX("R"),
        status,
        pids: readout,
        perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
      });
      actuateMsStats.resetMax();
    }

    // --- trigger-sync capture (spec §trigger-sync) --------------------------
    // Intent (`state.trigger_sync`) latches; ENGAGEMENT is a live state machine:
    // hardware-trigger both foveas, then round-robin CMD_FRAME on the native
    // mirror sink's stream. Every engaged-only behavior gates on
    // `triggerEngaged` — free-run stays byte-identical while disengaged.

    let triggerEngaged = false;
    /** False from idle start until the next activate: the retry tick keeps
     *  firing while teardown awaits, and a re-engage there would strand the
     *  cameras in trigger mode past `releaseLeases`. */
    let triggerEngageAllowed = false;
    /** Bumped on every disengage — an engage that awaited across it reverts. */
    let triggerEpochCounter = 0;
    let triggerBudget: PairTriggerBudget | null = null;
    let triggerScheduler: RoundRobinFrameScheduler | null = null;
    const triggerUnsubs: (() => void)[] = [];
    let triggerFrames = 0;
    let triggerRejects = 0;
    let triggerTimeouts = 0;
    /** Achieved-hz maturity window (≥1 s rolls; held between; null till first). */
    const triggerRate = new TriggerRateWindow();
    /** Caps outcome spans reaching the diagnostics ring; reset per engage. */
    const triggerSpanSampler = new TriggerSpanSampler();
    /** Passive fault gate: a streak of identical-reason failures with zero
     *  FINs (spec §trigger-sync fault gate) trips it. Reset per engage. */
    const triggerFault = new TriggerFaultDetector();
    /** A tripped fault gate latches trigger-sync OUT until intent off→on or a
     *  re-activation — a faulted engage must not flap the retry tick. */
    let triggerFaultLatched = false;
    /** Reject/timeout reasons already surfaced to the tray this engage. */
    const reportedTriggerReasons = new Set<string>();
    let lastTriggerBlocked: string | null = null;

    /** Warn the tray ONCE per distinct reject/timeout reason per engage — the
     *  scope coalesces, so the firmware's words surface live without flooding. */
    function reportDistinctTriggerReason(reason: string): void {
      if (reportedTriggerReasons.has(reason)) return;
      reportedTriggerReasons.add(reason);
      report("trigger-sync", reason, "warning");
    }
    /** FIFO mutex over the lease trigger config: an engage always awaits any
     *  in-flight disengage (and vice versa) before touching leases. */
    const queueTriggerOp = createTriggerOpChain((e) =>
      console.error("[disparity-scope] trigger-sync op failed:", e),
    );

    /** `trigger_blocked` on TRANSITIONS only (the retry tick re-evaluates
     *  every interval; the UI needs edges, not spam). Each new reason ALSO
     *  lands in the title-bar tray as a WARNING — the drawer keeps only the
     *  warn-tinted mode select, the tray carries the detail. */
    function publishTriggerBlocked(reason: string | null, warn = true): void {
      if (reason === lastTriggerBlocked) return;
      lastTriggerBlocked = reason;
      s.telemetry({ trigger_blocked: reason });
      // The fault path reports its own ERROR-level line (`warn=false`) — a
      // second warning of the compact reason would triple-surface it.
      if (reason !== null && warn) report("trigger-sync", reason, "warning");
    }

    /** Passive fault gate tripped (spec §trigger-sync fault gate): the firmware
     *  rejected every frame with one reason and no FIN ever landed — the pulse
     *  is not reaching the cameras. Surface the ERROR (interpretation + the
     *  reason), latch trigger-sync OUT so the retry tick can't re-engage, and
     *  disengage back to free-run (cameras restored, the views recover). The
     *  intent stays latched; the latch clears on intent off→on / re-activation. */
    function handleTriggerFault(reason: string): void {
      if (triggerFaultLatched) return;
      triggerFaultLatched = true;
      report("trigger-sync", triggerFaultMessage(reason), "error");
      void disengageTrigger(triggerFaultBlocked(reason), false);
    }

    /** Exposure-authoritative budget over both fovea config docs (multi-fovea's
     *  `deriveBudget` shape; the flip point stays inside `pairTriggerBudget`).
     *  Settle hold comes from the leased triple. */
    function deriveTriggerBudget(): PairTriggerBudget | null {
      if (!triple) return null;
      const safe = <T,>(fn: () => T, fallback: T): T => {
        try {
          return fn();
        } catch {
          return fallback;
        }
      };
      const camL = triple.leases.L.camera;
      const camR = triple.leases.R.camera;
      return pairTriggerBudget({
        exposureUsL: safe(() => camL.exposure, 0),
        exposureUsR: safe(() => camR.exposure, 0),
        settleUs: triple.settleTimeUs,
        maxRateHzL: safe(() => camL.frame_rate_range.max, 0),
        maxRateHzR: safe(() => camR.frame_rate_range.max, 0),
      });
    }

    /** (Re-)push the ONE scheduler target from the live budget. */
    function applyTriggerTarget(streamId: number): void {
      if (!triggerScheduler || !triggerBudget || !triple) return;
      triggerScheduler.setTargets([
        frameRequestFromBudget(triggerBudget, streamId, triple.settleTimeUs),
      ]);
    }

    function publishTriggerTelemetry(): void {
      if (!triggerEngaged || !triggerBudget) return;
      s.telemetry({
        trigger: {
          // hz rolls on ≥1 s maturity windows, held between rolls, null until
          // the first matures (TriggerRateWindow) — a per-publish 33 ms window
          // quantized it to 0 or ~30 and flapped the status line.
          hz: triggerRate.sample(now()),
          pulseMs: triggerBudget.pulseUs / 1000,
          frames: triggerFrames,
          rejects: triggerRejects,
          timeouts: triggerTimeouts,
        },
      });
    }

    /** Serialized via `queueTriggerOp` — see {@link engageTrigger}. */
    async function engageTriggerNow(): Promise<void> {
      if (triggerEngaged || !s.state.trigger_sync) return;
      if (!triggerEngageAllowed) {
        // An ON-flip while idle/tearing-down: name the wait instead of
        // leaving the UI on its generic fallback forever.
        publishTriggerBlocked("session is not active");
        return;
      }
      // Preconditions re-checked HERE, after any queued disengage completed —
      // the pre-queue world may be gone.
      const reason = triggerBlockReason({
        tripleLeased: triple !== null,
        controller: activeController(),
        streamId: nativePos?.streamId ?? null,
      });
      if (reason) {
        publishTriggerBlocked(reason);
        return;
      }
      const t = triple!;
      const streamId = nativePos!.streamId!;
      const epoch = triggerEpochCounter;
      const revert = async (): Promise<void> => {
        for (const side of ["L", "R"] as const)
          try {
            await disableHardwareTrigger(t.leases[side]);
          } catch {
            // best-effort — the lease may already be releasing
          }
      };
      const budget = deriveTriggerBudget();
      // FIN budget follows the pulse-derived interval — a long exposure must
      // not FIN-time-out under a fixed 1 s and wedge (spec §trigger-sync).
      const completionTimeoutMs = Math.max(1000, (budget?.minIntervalMs ?? 0) * 3);
      const engageMeta: Record<string, unknown> = {
        streamId,
        budget: budget && {
          pulseUs: budget.pulseUs,
          minIntervalMs: budget.minIntervalMs,
          maxRateHz: budget.maxRateHz,
        },
        settleUs: t.settleTimeUs,
        completionTimeoutMs,
      };
      try {
        await timeSpan(
          "trigger-sync.engage",
          async () => {
            await enableHardwareTrigger(t.leases.L);
            await enableHardwareTrigger(t.leases.R);
            engageMeta.L = readTriggerConfig(t.leases.L);
            engageMeta.R = readTriggerConfig(t.leases.R);
          },
          engageMeta,
        );
      } catch (e) {
        await revert();
        publishTriggerBlocked(engageFailureReason(e));
        return;
      }
      // Disengaged / idled / re-leased while awaiting — undo, stay out.
      if (
        epoch !== triggerEpochCounter ||
        !triggerEngageAllowed ||
        !s.state.trigger_sync ||
        triple !== t
      ) {
        await revert();
        return;
      }
      triggerBudget = budget;
      triggerFrames = triggerRejects = triggerTimeouts = 0;
      triggerRate.reset(now());
      triggerSpanSampler.reset();
      triggerFault.reset();
      reportedTriggerReasons.clear();
      let acksThisEngage = 0;
      triggerScheduler = new RoundRobinFrameScheduler({
        completionTimeoutMs,
        requester: {
          frame(request) {
            const controller = activeController();
            if (!controller) throw new Error("No controller connected");
            return controller.frame(request);
          },
        },
        onAccepted() {
          acksThisEngage++;
        },
        onFrame(frame) {
          triggerFrames++;
          triggerRate.onFin();
          triggerFault.onFin();
          if (triggerSpanSampler.shouldLog("fin"))
            span("trigger-sync.fin", 0, {
              stream: frame.stream,
              frameId: frame.frameId,
              exposureMs: Number(frame.tExposure - frame.tTrigger) / 1e6,
              acksSoFar: acksThisEngage,
            });
        },
        onReject(failure) {
          triggerRejects++;
          const reason = firstErrorLine(failure.error, 120);
          if (triggerSpanSampler.shouldLog("rej", reason))
            span("trigger-sync.rej", 0, { reason, acksSoFar: acksThisEngage });
          reportDistinctTriggerReason(reason);
          const fault = triggerFault.onFailure(reason);
          if (fault) handleTriggerFault(fault);
        },
        onTimeout(failure) {
          triggerTimeouts++;
          const reason = firstErrorLine(failure.error, 120);
          if (triggerSpanSampler.shouldLog("timeout", reason))
            span("trigger-sync.timeout", 0, { reason, acksSoFar: acksThisEngage });
          reportDistinctTriggerReason(reason);
          const fault = triggerFault.onFailure(reason);
          if (fault) handleTriggerFault(fault);
        },
      });
      applyTriggerTarget(streamId);
      triggerScheduler.start();
      // Live budget re-derivation on either fovea's config-doc change
      // (multi-fovea's subscription shape) — new exposure, new pacing.
      for (const side of ["L", "R"] as const)
        triggerUnsubs.push(
          subscribe(cameraConfigPath(t.leases[side].camera), () => {
            triggerBudget = deriveTriggerBudget();
            applyTriggerTarget(streamId);
          }),
        );
      triggerEngaged = true;
      publishTriggerBlocked(null);
      publishTriggerTelemetry(); // announce engagement (trigger non-null)
    }

    /** Serialized via `queueTriggerOp` — see {@link engageTrigger}. */
    async function disengageTriggerNow(
      blockedReason: string | null,
      warn: boolean,
    ): Promise<void> {
      await timeSpan(
        "trigger-sync.disengage",
        async () => {
          triggerEpochCounter++; // any in-flight engage reverts itself
          const wasEngaged = triggerEngaged;
          triggerEngaged = false;
          triggerScheduler?.stop();
          triggerScheduler = null;
          for (const u of triggerUnsubs.splice(0)) u();
          triggerBudget = null;
          if (wasEngaged && triple) {
            for (const side of ["L", "R"] as const)
              try {
                await disableHardwareTrigger(triple.leases[side]);
              } catch {
                // best-effort — the lease may already be releasing
              }
          }
          if (wasEngaged) s.telemetry({ trigger: null });
          publishTriggerBlocked(s.state.trigger_sync ? blockedReason : null, warn);
        },
        { reason: blockedReason },
      );
    }

    /** Engage/disengage BOTH ride the FIFO op chain: a fast OFF→ON toggle
     *  otherwise interleaved enables with in-flight disables (a disable
     *  landing last leaves a camera untriggered while the session reports
     *  engaged — permanent 0 Hz + climbing timeouts). */
    function engageTrigger(): Promise<void> {
      return queueTriggerOp(engageTriggerNow);
    }

    /** Disengage (intent off / controller detach / idle). MUST run while the
     *  leases are live — `disableHardwareTrigger` rides `lease.reconfigure`
     *  (spec §trigger-sync teardown invariant); the idle path awaits this
     *  BEFORE `releaseLeases`, which also drains any queued engage ahead of
     *  it on the chain. `blockedReason` publishes only while the intent stays
     *  latched (detach path). */
    function disengageTrigger(
      blockedReason: string | null = null,
      warn = true,
    ): Promise<void> {
      return queueTriggerOp(() => disengageTriggerNow(blockedReason, warn));
    }

    // --- lifecycle --------------------------------------------------------

    /** Connect a pipe by id (refcount++ consumer gate) and return its worker
     *  `PipeInput` under `role`; registers the `disconnect` on `disposers`.
     *  Connecting the shared strip twice is fine — refcounted. */
    function connectPipe(role: string, pipeId: string): PipeInput {
      const handle = broker.connect(pipeId);
      disposers.add(() => broker.disconnect(pipeId));
      const { width, height, channels, bytesPerFrame, maxBytes } = handle.spec;
      __sizeTrace(
        `advert/pipe/${role}/${pipeId}`,
        `advert pipe ${role} ${pipeId} ${width}x${height} ch=${channels} ` +
          `stride=${handle.spec.stride} fmt=${handle.spec.pixelFormat} dtype=${handle.spec.dtype} ` +
          `bytes=${bytesPerFrame} max=${handle.spec.maxWidth ?? width}x${handle.spec.maxHeight ?? height}`,
      );
      return {
        role,
        shmName: handle.shmName,
        width,
        height,
        channels,
        bytesPerFrame: maxBytes ?? bytesPerFrame,
      };
    }

    async function activateSession(): Promise<void> {
      // Reset the activity/control clocks per activation (spec §freeze-window:
      // session-creation clocks left a late re-entry frozen before frame one).
      // The progress monitor's steps stay FROZEN at the step an early-return
      // died on; idle's `disposers.dispose()` clears them.
      windowStart = now();
      lastStep = now();
      lastSteppedSeq = -1;
      triggerEngageAllowed = true; // latched intent re-engages via the retry tick
      triggerFaultLatched = false; // a fresh activation clears any prior fault latch
      dragSlew.reset();
      // Seed the capture-epoch ring so frames captured before the first target
      // write still resolve to the target in effect at activation.
      targetRing.length = 0;
      recordTarget(
        targetRing,
        { t: Number(hostNowNs()), target: s.state.target },
        TARGET_RING_CAP,
      );
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "undistort", label: "Loading calibration" },
        { id: "pipeline", label: "Building vision pipeline" },
        { id: "tracker", label: "Starting tracker" },
        { id: "controller", label: "Wiring controllers" },
      ]);
      monitor.start("lease");
      const t = await acquireTriple(s);
      if (!t) return; // frozen at "Leasing cameras" — honest (contention/fail)
      monitor.done("lease");
      triple = t;
      publishSerials(t.leases, disposers, s);

      // Per-triple baseline: `baseline_mm`, else legacy
      // `baseline_distance_mm`, else 200 (`resolveBaseline`). Activate-time only
      // (a Settings edit applies on the next start). Set state (renderer slider)
      // AND the verge limit directly (the `baseline` watch may not fire on a
      // server-side write).
      const legacyCfg = await read<{ baseline_distance_mm?: number }>(["config"], {});
      const resolvedBaseline = resolveBaseline(t.baselineMm, legacyCfg.baseline_distance_mm);
      s.setState("baseline", resolvedBaseline);
      // setLimits, NOT `.limits =` — the integral clamp aliases the construction
      // array, so a bare replace leaves the command clamped to 200 mm (spec §teardown).
      verge.setLimits([0, distanceToVerge(VERGE_MIN_DISTANCE_MM, resolvedBaseline)]);

      monitor.start("undistort");

      // Advertise the three undistort pipes (spec §topology): C = intrinsic,
      // L/R = homography (mirror-history fed). Producer retirers are added once
      // the kernel inputs connect (FIFO teardown; spec §teardown).
      const undistortIds: Record<"L" | "C" | "R", string | null> = {
        L: null,
        C: null,
        R: null,
      };
      const retirers: (() => void)[] = [];
      if (t.undistort) {
        const idC = advertiseUndistortPipe(
          undistortSeam,
          t.leases.C.camera,
          t.undistort.calibration,
        );
        undistortIds.C = idC;
        retirers.push(() => retireUndistortPipe(undistortSeam, idC));
      }
      const computeH = conversionComputeH(t.conv);
      for (const side of ["L", "R"] as const) {
        const pipeId = advertiseHomographyUndistortPipe(
          undistortSeam,
          t.leases[side].camera,
        );
        undistortIds[side] = pipeId;
        const stopFeeder = startHomographyFeeder({
          pipeId,
          side,
          computeH,
          push: pushHomography,
          // Mirror-history provenance (spec §actuation): read the native sink's
          // ring while it drives, else the JS authority.
          history: {
            mirrorAt: (t) =>
              nativeSink ? nativeSink.historyAt(t) : mirrorHistory.mirrorAt(t),
          },
        });
        retirers.push(() => {
          stopFeeder(); // stop pushing BEFORE the brick detaches
          retireUndistortPipe(undistortSeam, pipeId);
        });
      }

      monitor.done("undistort");

      monitor.start("pipeline");
      // Compose the split pipeline on the C source (spec §topology): slice →
      // scale → template-match ×2. C falls back to the raw convert pipe on an
      // uncalibrated wide camera (control then holds "no calibration").
      const serialC = t.leases.C.camera.serial;
      const cSourceId = undistortIds.C ?? nodeId.convert(serialC);
      trackerSrc.pipe = cSourceId; // hot-swap re-creates on this same source
      const camC = t.leases.C.camera;
      wide = {
        width: camC.getFeatureInt("Width"),
        height: camC.getFeatureInt("Height"),
      };
      // Fovea source dims for the needle scale base — read from L (L/R share a
      // model/resolution on the Duo; spec §needle-geometry).
      fovea = {
        width: t.leases.L.camera.getFeatureInt("Width"),
        height: t.leases.L.camera.getFeatureInt("Height"),
      };
      s.telemetry({ size: { ...wide } });

      // SLICE nodes: match strip + display center tile, live-steered by
      // `steerCrops`. Max footprint = the full frame (zoom → 1).
      stripRect = computeStripRect();
      stripSlice = createSlicePipe(
        sliceSeam,
        cSourceId,
        nodeId.slice(serialC, "scope-strip"),
        { rect: stripRect, maxWidth: wide.width, maxHeight: wide.height },
      );
      tileSlice = createSlicePipe(
        sliceSeam,
        cSourceId,
        nodeId.slice(serialC, "scope-tile"),
        { rect: tileRect(), maxWidth: wide.width, maxHeight: wide.height },
      );

      // SCALE nodes: strip at ratio `s` (meeting the demagnified
      // fovea tiles at the same pixel scale), one needle per fovea at the tile
      // dsize. Strip max = 2× frame; extremes clamp natively.
      stripScaleFactor = effectiveScale();
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
      // The NEEDLE scaler source is the RAW fovea CONVERT pipe, NOT the L/R
      // homography-undistort pipe — else the warp's ÷magnification and the
      // needle scaler's double up (the too-small-needle defect; spec §needle-geometry).
      const needleSources: Record<"L" | "R", string> = {
        L: nodeId.convert(t.leases.L.camera.serial),
        R: nodeId.convert(t.leases.R.camera.serial),
      };
      for (const side of ["L", "R"] as const) {
        const cam = t.leases[side].camera;
        needleScales[side] = createScalePipe(
          scaleSeam,
          needleSources[side],
          nodeId.scale(needleSources[side], "scope-needle"),
          {
            params: { dsize: dsize0 },
            maxWidth: cam.getFeatureInt("Width"),
            maxHeight: cam.getFeatureInt("Height"),
          },
        );
      }

      // TEMP debug size-trace: composition-time (advertised) geometry from the
      // raw sources down to the pre-sized match inputs.
      __sizeTrace(
        "advert/wide",
        `advert C-source raw-wide ${wide.width}x${wide.height} fmt=${camC.pixel_format}`,
      );
      __sizeTrace(
        "advert/fovea",
        `advert L/R-source raw-fovea(needle src) ${fovea.width}x${fovea.height} fmt=${t.leases.L.camera.pixel_format}`,
      );
      __sizeTrace(
        "advert/strip-slice",
        `advert strip-slice guide-crop ${stripRect.width}x${stripRect.height} @${stripRect.x},${stripRect.y}`,
      );
      __sizeTrace(
        "advert/strip-scale",
        `advert strip-scale guide ratio=${stripScaleFactor.toFixed(4)} ` +
          `~${Math.round(stripRect.width * stripScaleFactor)}x${Math.round(stripRect.height * stripScaleFactor)}`,
      );
      __sizeTrace(
        "advert/needle-scale",
        `advert needle-scale L&R dsize ${dsize0.width}x${dsize0.height}`,
      );

      // The L/R homography-warped undistort pipes — the wide-aligned sources
      // the STEREO + COMPOSITE bricks want (NOT the needle source; spec
      // §needle-geometry). Convert fallback on an uncalibrated fovea cam.
      const warpedSources: Record<"L" | "R", string> = {
        L: undistortIds.L ?? nodeId.convert(t.leases.L.camera.serial),
        R: undistortIds.R ?? nodeId.convert(t.leases.R.camera.serial),
      };

      // STEREO SGBM + HEATMAP (spec §topology): the center view's "SGBM
      // Disparity" option, parked until the renderer connects the heatmap pipe.
      // Ring is left-frame-sized; the emitted map may be at the brick's match scale.
      const camL = t.leases.L.camera;
      const stereoDims = {
        maxWidth: camL.getFeatureInt("Width"),
        maxHeight: camL.getFeatureInt("Height"),
      };
      stereo = createStereoPipe(
        stereoSeam,
        warpedSources.L,
        warpedSources.R,
        nodeId.stereo("scope"),
        {
          ...stereoDims,
          // Fixed symmetric −256…+255 window: foveated gaze makes disparity
          // SIGNED; a 0…+128 window matches garbage.
          params: SIGNED_DISPARITY_WINDOW,
        },
      );
      stereoHeatmap = createHeatmapPipe(
        heatmapSeam,
        stereo.pipeId,
        nodeId.heatmap(stereo.pipeId, "view"),
        {
          ...stereoDims,
          // Normalization PINNED to the −256…+255 window: per-frame auto
          // min/max locks onto the invalid marker (≈ −257) and washes the view
          // out; pinned, invalids clamp to the floor color.
          params: SIGNED_DISPARITY_HEATMAP_RANGE,
        },
      );

      // COMPOSITE (spec §topology): the center view's "Disparity (L v.s. R)" and
      // "Anaglyph" options, parked until the renderer connects it; mode retuned
      // from `state.view` below. Read the configured anaglyph style for the
      // initial attach, then watch it for LIVE retunes (deduped, disposed on idle).
      anaglyphStyle = await readAnaglyphStyle();
      composite = createCompositePipe(
        compositeSeam,
        warpedSources.L,
        warpedSources.R,
        nodeId.stereo("composite"),
        { ...stereoDims, params: compositeParamsFor(s.state.view) },
      );
      syncCompositeMode(s.state.view);
      disposers.add(
        subscribeAnaglyphStyle((style) => {
          anaglyphStyle = style;
          syncCompositeMode(s.state.view); // live retune iff a composite view is up
        }, anaglyphStyle),
      );

      // Worker inputs: pre-sized needle + the SHARED pre-sized strip (refcount++
      // per connect keeps the whole slice/scale/undistort chain awake).
      const matchInputs: Record<"L" | "R", PipeInput[]> = {
        L: [
          connectPipe("needle", needleScales.L!.pipeId),
          connectPipe("haystack", stripScale.pipeId),
        ],
        R: [
          connectPipe("needle", needleScales.R!.pipeId),
          connectPipe("haystack", stripScale.pipeId),
        ],
      };

      monitor.done("pipeline");

      monitor.start("tracker");
      // The chained tracker on its OWN native thread, tapping the same C
      // brick the kernel reads (spec §tracker). Disposer added HERE so the tap
      // detaches before the brick dies (FIFO teardown; spec §teardown).
      const kcfId = nodeId.undistortKcf(serialC);
      trackerSrc.node = kcfId; // hot-swap re-creates on this same node id
      try {
        tk = createTrackerOfType(s.state.tracker_type);
        runningTrackerType = s.state.tracker_type;
      } catch (e) {
        // No brick on the pipe — degrade to pointer-only targeting.
        console.error("[disparity-scope] chained tracker unavailable:", e);
        tk = null;
      }
      if (tk) {
        disposers.add(() => {
          tk?.release(); // closes the async iterator → consumeTracker exits
          tk = null;
          trackerArmed = false;
          trackerActive = false;
        });
        // The native IMM predictor brick — ALWAYS created while tracking (spec
        // §actuation); free-runs at `prediction_rate_hz`, live-applied below.
        const immRate = await readPredictionRateHz();
        currentRateHz = immRate;
        imm = createImmPredictor({
          rateHz: immRate,
          delayMs: t.delayCompensationMs,
          name: nodeId.imm(kcfId),
        });
        disposers.add(() => {
          imm?.release(); // ends the predict_out link deliveries
          imm = null;
        });
        // Live rate changes re-apply without reconnect; the rate is also the
        // governor's requested ceiling (spec §actuation).
        disposers.add(
          subscribePredictionRateHz((rateHz) => {
            currentRateHz = rateHz;
            imm?.setParams({ rateHz });
            try {
              nativeSink?.setGovernor({ ceilingHz: rateHz });
            } catch {
              // a detached sink mid-update — the next attach re-applies
            }
          }, immRate),
        );
        // kcf → imm native port link (spec §actuation): both endpoints native,
        // self-registers its profiler edge, disposer runs FIRST (pins bricks).
        // Module-scoped so the hot-swap can release + re-pipe it.
        measureLink = tk.track_out.pipe(imm.measure_in);
        disposers.add(() => {
          measureLink?.release();
          measureLink = null;
        });
        // JS keeps its own tracker consumption (pid target + steer + telemetry);
        // pid reads RAW results, not imm predictions (spec §actuation).
        void consumeTracker(tk, (r) => {
          lastTrackerResultAt = now(); // stall watchdog: delivery heartbeat
          trackerFeed(r);
        });
      }

      monitor.done("tracker");

      monitor.start("controller");
      // Producer teardown, consumer-most first (FIFO; spec §teardown): scalers →
      // slices → undistort bricks + homography feeders.
      disposers.add(() => {
        stripScale?.retire();
        stripScale = null;
        needleScales.L?.retire();
        needleScales.R?.retire();
        needleScales.L = needleScales.R = null;
      });
      disposers.add(() => {
        stripSlice?.retire();
        tileSlice?.retire();
        stripSlice = tileSlice = null;
      });
      // Retire heatmap → stereo → composite before the undistort retirers below.
      disposers.add(() => {
        stereoHeatmap?.retire();
        stereoHeatmap = null;
        stereo?.retire();
        stereo = null;
        composite?.retire();
        composite = null;
      });
      for (const retire of retirers) disposers.add(retire);

      const pidId = nodeId.win("disparity-scope", "pid");
      const immId = nodeId.imm(kcfId);
      const composeId = nodeId.win("disparity-scope", "compose");
      const rgba = { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" } as const; // honest RGBA8
      const analysis = { kind: "analysis", schema: "template-match" } as const;
      const matchIds = {
        L: nodeId.win("disparity-scope", "match", "L"),
        R: nodeId.win("disparity-scope", "match", "R"),
      } as const;
      // Two generic match workers (meterName = node id → per-side self-meter on
      // each node badge). The correlation heatmap is a Debugger-only DIAGNOSTIC:
      // start emitHeatmap OFF and gate it on real frame interest — computing it
      // every tick with no debugger open is wasted work.
      const HEATMAP_FRAMES = ["match_left", "match_right"] as const;
      let heatmapEmitting = false;
      const syncHeatmapInterest = (): void => {
        const want = HEATMAP_FRAMES.some((f) => s.frameInterested(f));
        if (want === heatmapEmitting) return;
        heatmapEmitting = want;
        workers.L?.sendParams({ emitHeatmap: want });
        workers.R?.sendParams({ emitHeatmap: want });
      };
      for (const side of ["L", "R"] as const) {
        workers[side] = createVisionWorker(
          {
            pipes: matchInputs[side],
            params: { kind: "template-match", emitHeatmap: false },
            meterName: matchIds[side],
          },
          (r) => onMatch(side, r),
        );
      }
      disposers.add(s.onFrameInterestChange(syncHeatmapInterest));
      syncHeatmapInterest(); // a debugger already open declared interest early
      disposers.add(
        registerGraphWiring({
          // DISPLAY-ONLY: label the leased triple by role (L/C/R) in the profiler
          // (ids stay serial-keyed).
          roles: {
            [t.leases.L.camera.serial]: "L",
            [t.leases.C.camera.serial]: "C",
            [t.leases.R.camera.serial]: "R",
          },
          nodes: [
            ...(["L", "R"] as const).map((side) => ({
              id: matchIds[side],
              kind: "template-match",
              owner: "win/disparity-scope",
              output: analysis,
              transport: "worker" as const,
            })),
            // Neither the tracker nor the IMM brick self-reports its NODE row,
            // so the session registers both. Their edges self-register via the
            // native port links / the pid + compose node wiring.
            ...(tk
              ? [
                  {
                    id: kcfId,
                    kind: "kcf",
                    owner: "win/disparity-scope",
                    output: { kind: "track" } as const,
                    transport: "native" as const,
                  },
                ]
              : []),
            ...(imm
              ? [
                  {
                    id: immId,
                    kind: "imm",
                    owner: "win/disparity-scope",
                    output: { kind: "track" } as const,
                    transport: "native" as const,
                  },
                ]
              : []),
            // The native compose brick's NODE row (its edges ride the port links).
            {
              id: composeId,
              kind: "compose",
              owner: "win/disparity-scope",
              output: { kind: "analysis", schema: "pid" } as const,
              transport: "native" as const,
            },
          ],
          edges: [
            ...(["L", "R"] as const).flatMap((side) => [
              {
                from: needleScales[side]!.pipeId,
                to: matchIds[side],
                port: "needle",
                type: rgba,
              },
              {
                from: stripScale!.pipeId,
                to: matchIds[side],
                port: "haystack",
                type: rgba,
              },
            ]),
            ...(tk ? [{ from: cSourceId, to: kcfId, port: "C", type: rgba }] : []),
          ],
        }),
      );
      // The tracker + imm bricks self-meter under their node ids — probe both
      // out-of-loop so their stats fold onto each node's badge.
      if (tk) {
        disposers.add(
          registerNativeProbe(
            (): Record<string, WorkloadSnapshot> =>
              tk ? { [kcfId]: trackerWorkload(kcfId, tk.probe()) } : {},
          ),
        );
      }
      if (imm) {
        disposers.add(
          registerNativeProbe(
            (): Record<string, WorkloadSnapshot> =>
              imm ? { [immId]: trackerWorkload(immId, imm.probe()) } : {},
          ),
        );
      }
      disposers.add(
        registerNativeProbe(
          (): Record<string, WorkloadSnapshot> =>
            compose
              ? { [composeId]: trackerWorkload(composeId, compose.probe()) }
              : {},
        ),
      );

      // The PID node — the app-specific JOIN (spec §match-join): match L/R + the
      // tracker's RAW target converge here, producing `V_pid` (~60 Hz) INTO the
      // compose node. `createPidNode` owns its own graph registration.
      pidNode = createPidNode<VergenceVolts>({
        id: pidId,
        kind: "pid",
        owner: "win/disparity-scope",
        inputs: [
          { from: matchIds.L, port: "l" },
          { from: matchIds.R, port: "r" },
          // kcf → pid: pid reads RAW tracker results, not imm predictions (spec §actuation).
          ...(tk ? [{ from: kcfId, port: "target" }] : []),
        ],
        outputs: [{ to: composeId, port: "pid" }],
        controllers: { pan, verge, v_shift },
        seed: seedFromOverride,
      });
      disposers.add(() => {
        pidNode?.dispose();
        pidNode = null;
      });

      // The NATIVE compose brick (spec §actuation). Its imm/controller edges
      // ride the port links, the pid → compose edge rides the pid node outputs.
      compose = createComposeStream({
        name: composeId,
        initial: { l: commandedVolts.l, r: commandedVolts.r },
      });
      disposers.add(() => {
        compose?.release(); // closes the volt iterator → fallback loop exits
        compose = null;
      });
      // imm → compose: the high-rate prediction pipe (latest-wins).
      if (imm) {
        const predLink = imm.predict_out.pipe(compose.pred_in);
        disposers.add(() => predLink.release());
      }

      // The legacy JS position input — the FALLBACK transport (spec §actuation);
      // carries nothing once a v2 controller streams natively.
      posInput = controllerNode().openPosition("disparity-scope", {
        initial: { left: commandedVolts.l, right: commandedVolts.r },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      // The NATIVE position input: attaches a mirror sink whenever a v2
      // controller binds; the session then pipes compose.volt_out ══ sink.pos_in.
      nativePos = controllerNode().openNativePosition("disparity-scope", {
        initial: { left: commandedVolts.l, right: commandedVolts.r },
        onAttach: (sink) => {
          nativeSink = sink;
          // Governor ceiling = the requested prediction rate (spec §actuation).
          try {
            sink.setGovernor({ ceilingHz: currentRateHz });
          } catch {
            // governor params rejected — the baked defaults still apply
          }
          voltLink = compose ? compose.volt_out.pipe(sink.pos_in) : null;
        },
        onDetach: () => {
          voltLink?.release();
          voltLink = null;
          nativeSink = null;
          // Trigger-sync loses its CMD_FRAME stream with the sink: disengage
          // (cameras back to free-run) but keep the INTENT latched — the retry
          // tick re-engages when a v2 controller re-attaches (spec §trigger-sync).
          if (triggerEngaged) void disengageTrigger("controller detached");
        },
      });
      disposers.add(() => {
        void nativePos?.close(); // detach + TERMINATE + disable-iff-last
        nativePos = null;
      });
      // Volt TELEMETRY under the native path polls the sink history at the
      // throttle; the same timer drives serial-latency compensation (spec §actuation).
      {
        const fixedDelayMs = t.delayCompensationMs;
        const estimator = new SerialLatencyEstimator();
        let latencyEnabled = await readSerialLatencyComp();
        let appliedDelayMs = fixedDelayMs;
        publishAppliedLookahead(fixedDelayMs);
        const applyDelay = (totalMs: number): void => {
          if (Math.abs(totalMs - appliedDelayMs) <= 0.05) return;
          appliedDelayMs = totalMs;
          imm?.setParams({ delayMs: totalMs });
        };
        disposers.add(
          subscribeSerialLatencyComp((enabled) => {
            latencyEnabled = enabled;
            if (!enabled) {
              estimator.reset();
              applyDelay(fixedDelayMs); // byte-identical fixed behavior
              publishAppliedLookahead(fixedDelayMs);
            }
          }, latencyEnabled),
        );
        const timer = setInterval(() => {
          // Catch-all for latch transitions that happen off the direct paths
          // (a drag tick restarting the window, toggle re-arm, activation).
          publishPaused();
          // Stall watchdog: while auto-follow is live, NO delivered result
          // within the deadline ⇒ the source is stalled — same policy as the
          // count-based lost tolerance. The status names the distinct cause
          // for the operator.
          if (
            trackerActive &&
            lastTrackerResultAt > 0 &&
            trackerResultStale(now() - lastTrackerResultAt, TRACKER_STALL_DEADLINE_MS)
          ) {
            markTrackerLost();
            status = "tracker stalled";
          }
          // Auto-tune starvation watchdog (spec §autotune): the run only
          // advances on delivered match pairs — a dead feed must FAIL the
          // tune closed (restore + held) instead of wedging it forever.
          // A failure, not an abort: "aborted" means user action everywhere.
          if (autotuneRun && autotuneRun.starved(tuneNow()))
            autotuneRun.fail("no match samples (match feed stalled; pre-tune gains restored)");
          // Trigger-sync (spec §trigger-sync): the latched intent retries
          // engagement on this tick (preconditions are lazy/async — the native
          // sink attach, a controller reconnect); once engaged, the achieved-
          // rate readout publishes at the same throttle.
          if (s.state.trigger_sync && !triggerEngaged && !triggerFaultLatched)
            void engageTrigger();
          else if (triggerEngaged) publishTriggerTelemetry();
          if (!nativeSink) {
            // No controller → fixed behavior; the estimate resets so a stale
            // link's RTTs never leak into a fresh connection.
            if (latencyEnabled && appliedDelayMs !== fixedDelayMs) {
              estimator.reset();
              applyDelay(fixedDelayMs);
              publishAppliedLookahead(fixedDelayMs);
            }
            return;
          }
          const probe = nativeSink.probe();
          if (latencyEnabled && probe.ackRttCount > 0) {
            estimator.push(probe.ackRttP50);
            // The TOTAL lookahead is clamped — congestion-inflated RTT must
            // never grow the extrapolation without bound (larger deltas defeat
            // the sink dedupe and feed the congestion back).
            // MAX_TOTAL_LOOKAHEAD_MS documents the cap.
            const total = clampLookaheadMs(fixedDelayMs + (estimator.latencyMs ?? 0));
            applyDelay(total);
            publishAppliedLookahead(appliedDelayMs);
          }
          const latest = nativeSink.historyLatest();
          if (latest) onVolts({ L: latest.left, R: latest.right }, 0);
        }, VOLT_TELEMETRY_INTERVAL_MS);
        disposers.add(() => {
          clearInterval(timer);
          publishAppliedLookahead(null); // no predictor session active
        });
      }
      pushVolts(); // park the mirrors at the current command (floor emit)
      // JS FALLBACK volt consumer (idles while the native sink is attached).
      void consumeComposeFallback(compose);
      // Auto-follow was left on: arm the fresh tracker at the current target.
      if (s.state.tracker_enabled) armTracker(s.state.target);

      // --- capture (spec §capture) -------------------------------------------
      // Persistent capture-center pipe (refcount++ keeps the producer live for
      // the worker's one-shot read), then the idle capture node over the triple.
      const capCenter = connectPipe("cap-center", cSourceId);
      captureCenter = {
        shmName: capCenter.shmName,
        maxBytes: capCenter.bytesPerFrame,
        channels: capCenter.channels,
      };
      disposers.add(() => {
        captureCenter = null;
      });
      captureHelper = createCaptureHelper({
        id: nodeId.win("disparity-scope", "capture"),
        broker,
        rawPipes,
        graphInputs: {
          left: `camera/${t.leases.L.camera.serial}/raw`,
          right: `camera/${t.leases.R.camera.serial}/raw`,
          center: cSourceId,
        },
        cameras: () =>
          triple ? { left: triple.leases.L.camera, right: triple.leases.R.camera } : null,
        centerPipe: () => captureCenter,
        snapshot: (reset, indexed) =>
          triple
            ? rawTripleShot({
                reset,
                indexed,
                stackCount: 5,
                note: "disparity-scope: raw stacks, no per-shot mirror pose (no wrap)",
              })
            : null,
        recordingActive: () => recording.active,
        telemetry: (patch) => s.telemetry(patch),
      });
      captureHelper.build();

      // Surface the measured magnification + per-triple zoom override (both
      // null-able, constant per activation) so the UI names the actual match scale.
      s.telemetry({
        ready: true,
        // `ready` alone is NOT a calibration signal — an uncalibrated triple
        // completes setup on the convert fallback (control holds "no
        // calibration"). Auto-tune gates on THIS instead.
        calibrated: !!t.undistort,
        match_magnification: measuredMatchZoom(),
        zoom_override: tripleZoomOverride(),
      });
      monitor.done("controller");
      monitor.complete(); // spin-up finished — clear the overlay
    }

    async function idleSession(): Promise<void> {
      // Silent auto-tune discard (spec §autotune): the graph is going away, so
      // skip the restore/push path (transports may already be closing) but
      // resync the live controllers from persisted tuning — temp candidate
      // gains must never leak into the next activation.
      if (autotuneRun) {
        tuneEpoch++; // stale run callbacks become no-ops
        autotuneRun = null;
        preTune = null;
        syncGains(s.state.tuning);
      }
      // Trigger-sync back to free-run FIRST — `disableHardwareTrigger` rides
      // `lease.reconfigure`, so it MUST complete before `releaseLeases` below
      // (spec §trigger-sync). Intent stays latched for the next activation;
      // the engage gate closes so the still-armed retry timer can't re-engage
      // mid-teardown.
      triggerEngageAllowed = false;
      await disengageTrigger();
      // Finalize an in-flight recording next, while the cameras are still leased
      // (spec §teardown); covers the forced dispose busy() refuses.
      await recording.stop();
      // Drain any in-flight capture shot before the center pipe/leases release.
      await captureHelper?.activeCapture;
      await captureHelper?.stop();
      captureHelper = null;
      captureCenter = null;
      // Stop actuating (fire-and-forget close). The native input's detach rode
      // `disposers`; just drop the local refs.
      void posInput?.close();
      posInput = null;
      nativeSink = null;
      voltLink = null;
      // Terminate both match workers before disconnect (no reads after the gate).
      workers.L?.terminate();
      workers.R?.terminate();
      workers.L = workers.R = null;
      latestMatch.L = latestMatch.R = null;
      lastSteppedSeq = -1; // fresh workers restart their seq counters
      targetRing.length = 0; // re-seeded on the next activate
      trackerActive = false;
      dragging = false;
      overriddenTele = false;
      // Tracker source/link/pending-swap cleared (their disposers run below).
      trackerSrc.pipe = trackerSrc.node = null;
      measureLink = null;
      pendingTrackerType = null;
      disposers.dispose(); // FIFO teardown — spec §teardown

      publishOverride(); // pidNode is now null → released state
      releaseLeases(triple);
      triple = null;
      status = "initializing";
      wide = { width: 0, height: 0 };
      fovea = { width: 0, height: 0 };
      stripScaleFactor = 1;
      commandedVolts = { l: ORIGIN_POS, r: ORIGIN_POS };
      // The transition latches must reset with the telemetry, or an identical
      // value after re-activation would be suppressed forever.
      lastTriggerBlocked = null;
      lastPausedTele = false;
      s.resetTelemetry([
        "ready",
        "calibrated",
        "status",
        "tracker_bbox",
        "match_magnification",
        "zoom_override",
        "overridden",
        "autotune",
        "trigger",
        "trigger_blocked",
        "vergence_paused",
      ]);
    }

    return {
      commands: {
        async pointer({ p, buttons: _buttons, phase }) {
          // Drag = parallel follow (spec §drag): down/move engage the tracker
          // override AND directly drive the foveas to the cursor ray.
          if (phase !== "up") {
            if (phase === "down") {
              cancelAutotune("drag started"); // user interaction wins
              dragging = true;
              trackerActive = false;
              s.telemetry({ tracker_bbox: null });
              // Drag start RESETS the controllers → both eyes on the raw cursor
              // ray, parallel; all-zero state keeps the release continuous (spec §drag).
              pan.reset();
              verge.reset();
              v_shift.reset();
            }
            tk?.override(p);
            // Steer synchronously (don't wait one tracker frame).
            lastGood = p;
            writeTarget(p);
            steerCrops();
            publishOverridden(true);
            status = "manual";
            windowStart = now(); // `dragging` reaches the join one tick late
            // Direct follow NOW; skipped while a generic override pins the output.
            const v = followVolts(p);
            if (v && !pidNode?.override.engaged) {
              commandedVolts = slewToward(v); // drag slew (spec §drag-slew)
              pushVolts();
            }
          } else {
            dragging = false;
            dragSlew.reset(); // next drag re-seeds from the settled pose
            windowStart = now(); // drag end restarts the convergence window
            publishOverridden(false);
            if (tk) {
              // releaseOverride RE-ARMS the tracker at the drag end; the PID
              // resumes with no seed (controllers held through the follow; spec §drag).
              tk.releaseOverride();
              trackerArmed = s.state.tracker_enabled;
              trackerActive = false;
            }
            // Apply a swap DEFERRED during the drag (spec §tracker) — re-arms at
            // the settled target now that `trackerArmed` reflects the post-drag gate.
            if (pendingTrackerType && pendingTrackerType !== runningTrackerType) {
              performTrackerSwap(pendingTrackerType);
            }
            pendingTrackerType = null;
          }
        },
        async resetTuning() {
          cancelAutotune("tuning reset", true);
          s.setState("tuning", cloneTuning(DEFAULT_TUNING));
        },
        async reset_vergence() {
          cancelAutotune("vergence reset");
          pan.reset();
          verge.reset();
          v_shift.reset();
          // Under a manual hold nothing would ever step, leaving
          // the zeroed readout desynced from the mirrors — reset then also
          // means "recenter": push the reconstructed (all-zero) pose. While
          // auto runs, keep the no-push behavior (the loop re-converges).
          if (autoVergenceDisabled()) {
            const v = followVolts(s.state.target);
            if (v && !pidNode?.override.engaged) {
              commandedVolts = v;
              pushVolts();
            }
          }
        },
        async setPid({ dof, value }) {
          // Bidirectional slider write: latch the hold FIRST (even mid-track),
          // so the next match pair can't fight the
          // manual value, then apply + actuate from the new DOF state. The
          // tracker stays armed: the foveas keep following its target
          // through the manual DOF values (controlStep's disabled branch).
          cancelAutotune("manual DOF write"); // slider takeover wins
          latchManualHold();
          switch (dof) {
            case "verge":
              verge.value = value;
              break;
            case "v_shift":
              v_shift.value = value;
              break;
            case "panX":
              pan.x.value = value;
              break;
            case "panY":
              pan.y.value = value;
              break;
          }
          status = "held";
          // Reconstruct + push NOW (pidOverride precedent) — the held DOF state
          // is the command, so the write moves the mirrors immediately. A
          // generic volts override outranks manual DOF writes, same as drags.
          const v = followVolts(s.state.target);
          if (v && !pidNode?.override.engaged) {
            commandedVolts = v;
            pushVolts();
          }
        },
        /** PAUSE = the slider-write takeover without a value change (spec
         *  §freeze-window): latch the hold — a live tracker keeps following.
         *  RESUME clears the latch only (the Timeout -1 sentinel is the
         *  slider's to clear). */
        async pauseVergence(pause) {
          if (pause) {
            cancelAutotune("paused"); // manual takeover wins, like setPid
            latchManualHold();
            status = "held";
          } else if (windowStart === -Infinity) {
            // A live tune also holds this latch — resume is a takeover and
            // must cancel it (restore) before un-latching, or the run would
            // suddenly fight the resumed auto-stepping.
            cancelAutotune("resumed");
            windowStart = now(); // the tracker-toggle re-engage semantics
            publishPaused();
          }
        },
        // Two-stage auto-tune (spec §autotune): relay per DOF, optionally
        // followed by the CMA-ES joint polish. Drawer-gated, never automatic;
        // runs on hardware.
        async autotune({ stage }) {
          startAutotune(stage);
        },
        async autotuneAbort() {
          cancelAutotune("stopped by user");
        },
        async pidOverride(command) {
          if (!pidNode) return;
          const state = applyPidOverride(pidNode.override, command);
          if (state.engaged && state.value) {
            commandedVolts = state.value;
            status = "manual";
            pushVolts(); // apply immediately, don't wait for the next projection
          } else if (!state.engaged) {
            windowStart = now(); // released → restart freeze window
          }
          s.setState("pidOverride", state);
        },
        // Capture — forward to the shared helper (guards live inside it).
        async captureShot({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async getCapturePreview({ resource, index }) {
          return captureHelper ? captureHelper.getPreview(resource, index) : null;
        },
        async saveCapture({ path, format }) {
          await captureHelper?.save(path, format);
        },
        async discardCapture() {
          await captureHelper?.discard();
        },
        async startRecording({ path }) {
          // Exclusivity (spec §capture): no recording while a capture shot holds
          // the shared raw pipes.
          if (captureHelper?.capturing) return false;
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
      },
      watch: {
        tuning(t) {
          // A client gain write mid-run cancels the tune but KEEPS the user's
          // tuning (only the live controllers resync; spec §autotune).
          cancelAutotune("tuning changed", true);
          syncGains(t);
          // Expansion re-shapes the strip crop; scale retunes the scalers.
          steerCrops();
          retuneScalers();
        },
        baseline(v) {
          // setLimits (not `.limits =`) — see the activate-time note.
          verge.setLimits([0, distanceToVerge(VERGE_MIN_DISTANCE_MM, v)]);
        },
        zoom() {
          // Zoom re-shapes both crops AND the tile/strip scale geometry.
          steerCrops();
          retuneScalers();
        },
        // `view` drives the composite brick's MODE server-side (spec §topology):
        // disparity → difference, anaglyph → anaglyph; sliced/sgbm leave it parked.
        view(v) {
          syncCompositeMode(v);
        },
        kernel() {
          // Re-arm live at the current target so the template size takes effect
          // immediately (a drag's release re-arms anyway).
          if (trackerArmed && !dragging) armTracker(s.state.target);
        },
        tracker_enabled(on) {
          if (!on) {
            trackerArmed = false; // JS gate: results ignored (no native disarm)
            trackerActive = false;
            s.telemetry({ tracker_bbox: null });
          } else if (!dragging) {
            cancelAutotune("tracker re-enabled"); // restore before re-arming
            // Toggling the tracker back on HANDS CONTROL BACK: clear the
            // manual-hold latch here — onTrack deliberately preserves it
            // so this is the explicit re-engage path.
            windowStart = now();
            armTracker(s.state.target);
          }
          // While dragging, the pointer-up releaseOverride re-arms.
        },
        // HOT-SWAP the tracker engine (spec §tracker) — immediate, or DEFERRED to
        // drag end during a gesture. Pre-activate writes just sit in state.
        // Trigger-sync INTENT (spec §trigger-sync): on → engage now if
        // preconditions permit (else `trigger_blocked` + the retry tick);
        // off → back to free-run.
        trigger_sync(on) {
          if (on) {
            triggerFaultLatched = false; // intent off→on clears the fault latch
            void engageTrigger();
          } else void disengageTrigger();
        },
        tracker_type(type) {
          if (!trackerSrc.pipe) return; // idle — activate will read state
          if (type === runningTrackerType) {
            pendingTrackerType = null; // a stray re-select of the live type
            return;
          }
          if (dragging) {
            pendingTrackerType = type; // apply on pointer-up
            return;
          }
          performTrackerSwap(type);
        },
      },
      activate() {
        void activateSession();
      },
      idle: idleSession,
      busy() {
        // Drain refusal: never force-drain mid-recording or mid-capture.
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
