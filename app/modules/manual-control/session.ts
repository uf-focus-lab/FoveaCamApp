// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control session — a calibrated L/C/R triple + timer-paced actuation
// with NO KCF tracker; the target is always whatever `steer` last set. A thin
// coordinator over the shared display worker + controller node. Behavior spec:
// docs/spec/manual-control.md.

import { type ServerSession } from "@orchestrator/runtime";
import { defineResourceSession, type ResourceScope } from "@orchestrator/resource-session";
import { acquireTriple, type CalibratedTriple } from "@orchestrator/calibration";
import { registerGraphWiring } from "@orchestrator/graph-topology";
import { controllerNode, startPacer, type PositionInput } from "@orchestrator/controller-node";
import { DisposerBag, publishSerials, releaseLeases } from "@orchestrator/session-resources";
import {
  ORIGIN_POS,
  radians,
  VOLT_TELEMETRY_INTERVAL_MS,
} from "@orchestrator/fovea-pipeline";
// --- trigger-sync capture (spec §trigger-sync) ---
import { activeController } from "@orchestrator/controller";
import { report } from "@orchestrator/diagnostics";
import { subscribe } from "@orchestrator/store-hub";
import { RoundRobinFrameScheduler } from "@orchestrator/scheduler";
import {
  disableHardwareTrigger,
  enableHardwareTrigger,
} from "@orchestrator/camera-trigger";
import { cameraConfigPath } from "@orchestrator/camera";
import { pairTriggerBudget, type PairTriggerBudget } from "@lib/camera-config";
import {
  createTriggerOpChain,
  engageFailureReason,
  frameRequestFromBudget,
  triggerBlockReason,
  TriggerRateWindow,
} from "@lib/trigger-sync";
// --- center-tile native views (spec §views) ---
import {
  createStereoPipe,
  SIGNED_DISPARITY_HEATMAP_RANGE,
  SIGNED_DISPARITY_WINDOW,
  type StereoHandle,
  type StereoPipeSeam,
} from "@orchestrator/stereo-pipe";
import {
  createHeatmapPipe,
  type HeatmapHandle,
  type HeatmapPipeSeam,
} from "@orchestrator/heatmap-pipe";
import {
  createCompositePipe,
  type CompositeHandle,
  type CompositeParams,
  type CompositePipeSeam,
} from "@orchestrator/composite-pipe";
import { readAnaglyphStyle, subscribeAnaglyphStyle } from "@orchestrator/anaglyph-style";
import { DEFAULT_ANAGLYPH_STYLE, type AnaglyphStyle } from "../../../docs/schema/anaglyph.js";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import type { DisplayParams, DisplayValues } from "@orchestrator/display-transport";
import {
  advertiseHomographyUndistortPipe,
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { conversionComputeH, startHomographyFeeder } from "@orchestrator/homography-feeder";
import { pushHomography } from "core/Aravis";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import { type RawPipeRegistry } from "@orchestrator/raw-pipe";
import { type CaptureShot } from "@orchestrator/capture-node";
import { createCaptureHelper, type CaptureHelper } from "@orchestrator/capture-helper";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import { manualControl, coerceView, type CenterView } from "./contract";
import { createRecording } from "./recording";
import { slewStep, type SlewPair } from "@lib/slew";
import { type SplitVolts, unifiedSplit, resolveVolts, splitFlags } from "./split";
import { makeMat, matToArray } from "@lib/mat";
import {
  createQMatrix,
  deriveFoveaIntrinsics,
  inverseTriangulate,
  vergeToDistance,
} from "@lib/stereo";
import { RECT } from "@lib/util/geometry";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { RollingStats } from "@lib/util/rolling";

export default function manualControlSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  rawPipes: RawPipeRegistry,
  // Center-tile native view seams (spec §views): the COMPOSITE brick
  // (disparity/anaglyph) + the STEREO SGBM chain (heatmap). Injected so the
  // session unit-tests without native core — same pattern as disparity-scope.
  stereoSeam: StereoPipeSeam,
  heatmapSeam: HeatmapPipeSeam,
  compositeSeam: CompositePipeSeam,
): ServerSession<typeof manualControl> {
  return defineResourceSession("manual-control", manualControl, (s) => {
    let triple: CalibratedTriple | null = null;
    let posInput: PositionInput | null = null;
    let stopActuation: (() => void) | null = null;
    let worker: VisionWorkerHandle | null = null;

    const now = () => performance.now();

    // --- center-tile native view pipes (spec §views) ---------------------
    // Created at activate over the L/R undistorted sources; parked until the
    // renderer connects the selected pipe (consumer gate). The COMPOSITE
    // brick backs disparity/anaglyph (mode retuned from `state.view`), the
    // STEREO SGBM + heatmap back the sgbm view.
    let stereo: StereoHandle | null = null;
    let stereoHeatmap: HeatmapHandle | null = null;
    let composite: CompositeHandle | null = null;
    let anaglyphStyle: AnaglyphStyle = DEFAULT_ANAGLYPH_STYLE;

    // Center-frame geometry, learned from the worker's processed center.
    let width = 0;
    let height = 0;

    // Target state — always whatever `steer` last set (no tracker/prediction).
    let target: Point2d = { x: 0, y: 0 };
    let targetAngle: Point2d = { x: 0, y: 0 };
    let distanceOverride: number | null = null;
    let shiftOverride: number | null = null;

    // Latest commanded voltages, mirrored locally for the fovea-wrap homography.
    const volts: { L: Pos; R: Pos } = { L: { ...ORIGIN_POS }, R: { ...ORIGIN_POS } };

    // Per-eye "split" volt overrides (spec §split): null = follows the unified
    // solution; a PosView drag pins it (override > unified). Any steer reunifies.
    const splitVolts: SplitVolts = unifiedSplit();

    function reunify(): void {
      splitVolts.l = null;
      splitVolts.r = null;
    }

    function publishSplit(): void {
      s.telemetry({ split: splitFlags(splitVolts) });
    }

    // --- targeting ---------------------------------------------------------

    function baseDistance(): number {
      return vergeToDistance(s.state.verge, s.state.baseline);
    }
    const baseShiftDeg = (): number => s.state.shift;
    const distance = (): number => distanceOverride ?? baseDistance();
    const shiftDeg = (): number => shiftOverride ?? baseShiftDeg();

    function targetVolts(): { l: Pos; r: Pos } {
      if (!triple) return { l: ORIGIN_POS, r: ORIGIN_POS };
      const A = inverseTriangulate(targetAngle, s.state.baseline, distance(), radians(shiftDeg()));
      const unified = { l: triple.conv.A2V.L(A.l), r: triple.conv.A2V.R(A.r) };
      return resolveVolts(unified, splitVolts); // override > unified (spec §split)
    }

    function setTargetFromPixel(px: Point2d): void {
      reunify(); // any target set reunifies (spec §targeting)
      publishSplit();
      target = px;
      distanceOverride = null;
      shiftOverride = null;
      targetAngle = triple?.undistort ? triple.undistort.angular([px], false)[0] : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
      pushParams(sliceAtParam());
    }

    function setTargetFromAngle(angle: Point2d, distance_mm?: number, shift_deg?: number): void {
      reunify(); // programmatic target set reunifies (same rule as a wide drag)
      publishSplit();
      targetAngle = angle;
      distanceOverride = distance_mm ?? null;
      shiftOverride = shift_deg ?? null;
      target = triple?.undistort ? triple.undistort.position([angle], false)[0] : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
      pushParams(sliceAtParam());
    }

    // --- worker params (main computes calibration-derived matrices) -------

    /** Fovea homographies + depth Q-matrix at the current pose — pushed on each
     *  throttled volt update (cheap; the worker uses the latest). */
    function voltParams(): DisplayParams {
      if (!triple) return {};
      const HL = triple.conv.A2H.L(triple.conv.V2A.L(volts.L));
      const HR = triple.conv.A2H.R(triple.conv.V2A.R(volts.R));
      const params: DisplayParams = {
        homographyL: Array.from(HL as unknown as Float64Array),
        homographyR: Array.from(HR as unknown as Float64Array),
      };
      if (triple.undistort) {
        const zoom = Math.max(1, s.state.zoom);
        const Q = createQMatrix(
          deriveFoveaIntrinsics(triple.undistort, triple.conv.V2A.L(volts.L), zoom),
          deriveFoveaIntrinsics(triple.undistort, triple.conv.V2A.R(volts.R), zoom),
          s.state.baseline,
        );
        params.qMatrix = Array.from(Q as unknown as Float64Array);
      }
      return params;
    }

    /** The undistorted center pixel the magnified "sliced" view crops around. */
    function sliceAtParam(): DisplayParams {
      const undistort = triple?.undistort;
      const at = undistort ? undistort.position([targetAngle], false)[0] : target;
      return { sliceAt: at };
    }

    function pushParams(params: DisplayParams): void {
      worker?.sendParams(params as Record<string, unknown>);
    }

    // --- center-tile composite mode (spec §views) ------------------------

    /** Composite params for a center view: `disparity` → difference, else
     *  anaglyph at the configured style. `style` always rides along — the native
     *  `setParams` REPLACES the whole spec, so a mode-only retune would clobber
     *  it (disparity-scope's idiom). */
    function compositeParamsFor(view: CenterView): CompositeParams {
      return {
        mode: view === "disparity" ? "difference" : "anaglyph",
        style: anaglyphStyle,
      };
    }

    /** Retune the composite brick from the selected view + current style. Only
     *  the two composite views retune; `sliced`/`sgbm` leave it parked. */
    function syncCompositeMode(view: CenterView): void {
      if (view === "disparity" || view === "anaglyph")
        composite?.retune(compositeParamsFor(view));
    }

    // --- worker results (publish frames + re-source capture + learn geo) --

    function onResult(r: VisionResult): void {
      const v = r.values as DisplayValues;
      if (v.size) {
        width = v.size.width;
        height = v.size.height;
        s.telemetry({ size: v.size });
      }
      for (const f of r.frames) {
        s.frame(f.name, makeMat(new Uint8Array(f.buffer), [f.height, f.width], f.channels));
      }
    }

    // --- capture ----------------------------------------------------------------

    // The center pipe the vision worker consumes — capture's one-shot read rides
    // it; stays connected the whole active span so the producer is live.
    let centerPipe: { shmName: string; maxBytes: number; channels: number } | null = null;

    // Capture NODE via the shared helper (spec §capture) — manual-control is a
    // CONSUMER supplying its triple snapshot; built during activation (null until then).
    let captureHelper: CaptureHelper | null = null;

    /** The capture shot's calibration-derived transforms + per-resource metadata
     *  (spec §capture). */
    function captureSnapshot(reset: boolean, indexed: boolean): CaptureShot {
      const und = triple!.undistort!;
      const { conv } = triple!;
      const zoom = Math.max(1, s.state.zoom);
      const baseline = s.state.baseline;
      const A = { L: conv.V2A.L(volts.L), R: conv.V2A.R(volts.R) };
      const intrinsics = {
        L: deriveFoveaIntrinsics(und, A.L, zoom),
        R: deriveFoveaIntrinsics(und, A.R, zoom),
      };
      const Q = createQMatrix(intrinsics.L, intrinsics.R, baseline);
      const HL = conv.A2H.L(A.L);
      const HR = conv.A2H.R(A.R);
      const size = { width: width / zoom, height: height / zoom };
      const at = und.position([targetAngle], false)[0]!;
      const rect = RECT.fromCenter(at, size);
      const sensor_size = und.sensor_size;
      return {
        reset,
        indexed,
        stackCount: s.state.cap_stack,
        H_L: Array.from(HL as unknown as Float64Array),
        H_R: Array.from(HR as unknown as Float64Array),
        rect,
        meta: {
          wide: reset
            ? { sensor_size, focal: und.focal, center: und.center, fov: und.fov }
            : undefined,
          fovea: { Q: matToArray(Q), baseline, "baseline.unit": "millimeter" },
          left: {
            sensor_size,
            volt: volts.L,
            "volt.unit": "volt",
            angle: A.L,
            "angle.unit": "radian",
            intrinsics: intrinsics.L,
          },
          right: {
            sensor_size,
            volt: volts.R,
            "volt.unit": "volt",
            angle: A.R,
            "angle.unit": "radian",
            intrinsics: intrinsics.R,
          },
        },
      } as CaptureShot;
    }

    // --- recording (reads leases.L/C/R.camera.stream directly; unchanged) --

    const recording = createRecording({
      getTriple: () => triple,
      volts: () => volts,
      rawPipes,
      // Connect a raw pipe for the recorder node (refcount++ → gate);
      // inject the JS-side significantBits the native spec drops.
      connect: (pipeId) => {
        const handle = broker.connect(pipeId);
        const injected = rawPipes.specOf(pipeId);
        return {
          shmName: handle.shmName,
          spec: injected
            ? { ...handle.spec, significantBits: injected.significantBits }
            : handle.spec,
          release: () => void broker.disconnect(pipeId),
        };
      },
      // Notify main so the viewer window auto-opens the finished `.fovea`.
      finished: (foveaPath) =>
        process.parentPort?.postMessage({ type: "recording:finished", path: foveaPath }),
      telemetry: (patch) => s.telemetry(patch),
    });

    // --- actuation -----------------------------------------------------

    let lastVoltEmit = 0;
    let lastParamPush = 0;
    const actuateMsStats = new RollingStats(0.9, 2, "ms");

    // --- trigger-sync capture (spec §trigger-sync) --------------------------
    // Intent (`state.trigger_sync`) latches; ENGAGEMENT is a live state machine:
    // hardware-trigger both foveas, then round-robin CMD_FRAME on the MCU
    // position stream. Manual-control has NO match-join, so the pairing/
    // staleness parts of disparity-scope's machine are dropped — free-run stays
    // byte-identical while disengaged.

    let triggerEngaged = false;
    /** False from idle start until the next activate: the retry tick keeps
     *  firing while teardown drains, and a re-engage there would strand the
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
    let lastTriggerBlocked: string | null = null;
    /** FIFO mutex over the lease trigger config: an engage always awaits any
     *  in-flight disengage (and vice versa) before touching leases. */
    const queueTriggerOp = createTriggerOpChain((e) =>
      console.error("[manual-control] trigger-sync op failed:", e),
    );

    /** `trigger_blocked` on TRANSITIONS only (the retry tick re-evaluates every
     *  interval; the UI needs edges, not spam). Each new reason ALSO lands in
     *  the title-bar tray as a WARNING — the drawer keeps only the warn-tinted
     *  mode select, the tray carries the detail. */
    function publishTriggerBlocked(reason: string | null): void {
      if (reason === lastTriggerBlocked) return;
      lastTriggerBlocked = reason;
      s.telemetry({ trigger_blocked: reason });
      if (reason !== null) report("trigger-sync", reason, "warning");
    }

    /** Exposure-authoritative budget over both fovea config docs. Settle hold
     *  comes from the leased triple's `settleTimeUs`. */
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
          // the first matures (TriggerRateWindow).
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
        // An ON-flip while idle/tearing-down: name the wait instead of leaving
        // the UI on its generic fallback forever.
        publishTriggerBlocked("session is not active");
        return;
      }
      // Preconditions re-checked HERE, after any queued disengage completed —
      // the pre-queue world may be gone.
      const reason = triggerBlockReason({
        tripleLeased: triple !== null,
        controller: activeController(),
        streamId: posInput?.streamId ?? null,
      });
      if (reason) {
        publishTriggerBlocked(reason);
        return;
      }
      const t = triple!;
      const streamId = posInput!.streamId!;
      const epoch = triggerEpochCounter;
      const revert = async (): Promise<void> => {
        for (const side of ["L", "R"] as const)
          try {
            await disableHardwareTrigger(t.leases[side]);
          } catch {
            // best-effort — the lease may already be releasing
          }
      };
      try {
        await enableHardwareTrigger(t.leases.L);
        await enableHardwareTrigger(t.leases.R);
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
      triggerBudget = deriveTriggerBudget();
      triggerFrames = triggerRejects = triggerTimeouts = 0;
      triggerRate.reset(now());
      triggerScheduler = new RoundRobinFrameScheduler({
        // FIN budget follows the pulse-derived interval — a long exposure must
        // not FIN-time-out under a fixed 1 s and wedge (spec §trigger-sync).
        completionTimeoutMs: Math.max(1000, (triggerBudget?.minIntervalMs ?? 0) * 3),
        requester: {
          frame(request) {
            const controller = activeController();
            if (!controller) throw new Error("No controller connected");
            return controller.frame(request);
          },
        },
        onFrame() {
          triggerFrames++;
          triggerRate.onFin();
        },
        onReject() {
          triggerRejects++;
        },
        onTimeout() {
          triggerTimeouts++;
        },
      });
      applyTriggerTarget(streamId);
      triggerScheduler.start();
      // Live budget re-derivation on either fovea's config-doc change — new
      // exposure, new pacing.
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
    async function disengageTriggerNow(blockedReason: string | null): Promise<void> {
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
      publishTriggerBlocked(s.state.trigger_sync ? blockedReason : null);
    }

    /** Engage/disengage BOTH ride the FIFO op chain: a fast OFF→ON toggle
     *  otherwise interleaves enables with in-flight disables (a disable landing
     *  last leaves a camera untriggered while the session reports engaged). */
    function engageTrigger(): Promise<void> {
      return queueTriggerOp(engageTriggerNow);
    }

    /** Disengage (intent off / idle). MUST run while the leases are live —
     *  `disableHardwareTrigger` rides `lease.reconfigure`; the idle path awaits
     *  this BEFORE `releaseLeases` (which also drains any queued engage ahead of
     *  it on the chain). */
    function disengageTrigger(blockedReason: string | null = null): Promise<void> {
      return queueTriggerOp(() => disengageTriggerNow(blockedReason));
    }

    // --- lifecycle -------------------------------------------------------

    function initParams(): Record<string, unknown> {
      // The display worker only serves the `sliced` center; disparity/anaglyph/
      // sgbm are native pipes (spec §views). No `view`/depth params: the kernel
      // defaults to sliced and stays there.
      return {
        kind: "display",
        zoom: Math.max(1, s.state.zoom),
        ...voltParams(),
        ...sliceAtParam(),
      };
    }

    /** Connect a pipe by id (refcount++ → gate) → worker input. */
    function connectPipe(role: "L" | "C" | "R", pipeId: string, ids: string[]): PipeInput {
      const handle = broker.connect(pipeId);
      ids.push(pipeId);
      const { width: w, height: h, channels, bytesPerFrame, maxBytes } = handle.spec;
      return { role, shmName: handle.shmName, width: w, height: h, channels, bytesPerFrame: maxBytes ?? bytesPerFrame };
    }

    // Resource-scoped activation (spec §teardown): an in-flight capture/recording
    // MUST drain before the worker terminates + pipes disconnect + leases release,
    // so defers below are registered in REVERSE of the drain (LIFO).
    async function activateSession(scope: ResourceScope): Promise<void> {
      // Progress monitor: an early-return leaves the list FROZEN at its step;
      // idle teardown clears a cancelled spin-up.
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing cameras" },
        { id: "pipes", label: "Building undistort pipes" },
        { id: "worker", label: "Starting display worker" },
        { id: "capture", label: "Preparing capture" },
        { id: "controller", label: "Wiring controller" },
      ]);
      monitor.start("lease");
      const t = await scope.use(() => acquireTriple(s), releaseLeases); // drains LAST
      if (!t) return; // frozen at "Leasing cameras" (contention/fail)
      monitor.done("lease");
      triple = t;
      triggerEngageAllowed = true; // latched intent re-engages via the retry tick
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

      // Advertise the center `undistort:<serial>` pipe (spec §views). Registered
      // before the worker's defer → retires AFTER consumers disconnect (LIFO).
      monitor.start("pipes");
      let undistortC: string | null = null;
      if (t.undistort) {
        undistortC = advertiseUndistortPipe(
          undistortSeam,
          t.leases.C.camera,
          t.undistort.calibration,
        );
        s.setState("undistortPipe", undistortC);
        scope.defer(() => {
          retireUndistortPipe(undistortSeam, undistortC!);
          s.setState("undistortPipe", null);
        });
      }

      // L/R mirror-steered HOMOGRAPHY undistort bricks, fed H(mirrorAt(t)) at
      // ~200 Hz — the renderer binds these for the L/R main views (spec §views).
      // The kernel keeps consuming the raw CONVERT L/R inputs below.
      const computeH = conversionComputeH(t.conv);
      const homographyIds: Record<"L" | "R", string> = { L: "", R: "" };
      for (const side of ["L", "R"] as const) {
        const pipeId = advertiseHomographyUndistortPipe(undistortSeam, t.leases[side].camera);
        homographyIds[side] = pipeId;
        const stopFeeder = startHomographyFeeder({
          pipeId,
          side,
          computeH,
          push: pushHomography,
        });
        scope.defer(() => {
          stopFeeder(); // stop pushing BEFORE the brick detaches
          retireUndistortPipe(undistortSeam, pipeId);
        });
      }
      // The L/R UNDISTORTED (homography-warped) sources the STEREO + COMPOSITE
      // center-view bricks want (spec §views); convert fallback on an
      // uncalibrated fovea cam.
      const warpedSources: Record<"L" | "R", string> = {
        L: t.undistort ? homographyIds.L : nodeId.convert(t.leases.L.camera.serial),
        R: t.undistort ? homographyIds.R : nodeId.convert(t.leases.R.camera.serial),
      };

      // STEREO SGBM + HEATMAP + COMPOSITE bricks (spec §views): the center
      // tile's disparity/anaglyph/sgbm options, parked until the renderer
      // connects the selected pipe (consumer gate). Node ids under a
      // "manual"/"manual-composite" scope. Dims from the L camera.
      const camL = t.leases.L.camera;
      const stereoDims = {
        maxWidth: camL.getFeatureInt("Width"),
        maxHeight: camL.getFeatureInt("Height"),
      };
      stereo = createStereoPipe(
        stereoSeam,
        warpedSources.L,
        warpedSources.R,
        nodeId.stereo("manual"),
        // Fixed symmetric −256…+255 window (sgbm-signed-range.md): foveated gaze
        // makes disparity SIGNED.
        { ...stereoDims, params: SIGNED_DISPARITY_WINDOW },
      );
      stereoHeatmap = createHeatmapPipe(
        heatmapSeam,
        stereo.pipeId,
        nodeId.heatmap(stereo.pipeId, "view"),
        // Normalization PINNED to the −256…+255 window (sgbm-signed-range.md).
        { ...stereoDims, params: SIGNED_DISPARITY_HEATMAP_RANGE },
      );
      // COMPOSITE (disparity/anaglyph): read the configured anaglyph style for
      // the initial attach, then watch it for LIVE retunes (disposed on idle).
      anaglyphStyle = await readAnaglyphStyle();
      const view0 = coerceView(s.state.view);
      composite = createCompositePipe(
        compositeSeam,
        warpedSources.L,
        warpedSources.R,
        nodeId.stereo("manual-composite"),
        { ...stereoDims, params: compositeParamsFor(view0) },
      );
      syncCompositeMode(view0);
      scope.defer(
        subscribeAnaglyphStyle((style) => {
          anaglyphStyle = style;
          syncCompositeMode(coerceView(s.state.view)); // retune iff a composite view is up
        }, anaglyphStyle),
      );
      // Retire the center-view bricks before the undistort retirers above
      // (registered later → drains earlier; LIFO).
      scope.defer(() => {
        stereoHeatmap?.retire();
        stereoHeatmap = null;
        stereo?.retire();
        stereo = null;
        composite?.retire();
        composite = null;
      });
      monitor.done("pipes");

      monitor.start("worker");
      const pipeIds: string[] = [];
      const centerInput = connectPipe(
        "C",
        undistortC ?? nodeId.convert(t.leases.C.camera.serial),
        pipeIds,
      );
      centerPipe = {
        shmName: centerInput.shmName,
        maxBytes: centerInput.bytesPerFrame,
        channels: centerInput.channels,
      };
      scope.defer(() => {
        centerPipe = null;
      });
      const pipes: PipeInput[] = [
        connectPipe("L", nodeId.convert(t.leases.L.camera.serial), pipeIds),
        centerInput,
        connectPipe("R", nodeId.convert(t.leases.R.camera.serial), pipeIds),
      ];
      const taps = new DisposerBag();
      publishSerials(t.leases, taps, s);
      worker = createVisionWorker(
        // meterName: the display kernel self-meters into perfSnapshot.workloads.
        { pipes, params: initParams(), meterName: nodeId.win("manual-control", "display") },
        onResult,
      );
      monitor.done("worker");

      monitor.start("capture");
      // Capture node via the shared helper, idle until `captureShot()` (spec
      // §capture): raw L/R producers advertised/connected ON DEMAND per shot.
      captureHelper = createCaptureHelper({
        id: nodeId.win("manual-control", "capture"),
        broker,
        rawPipes,
        graphInputs: {
          left: `camera/${t.leases.L.camera.serial}/raw`,
          right: `camera/${t.leases.R.camera.serial}/raw`,
          center: undistortC ?? nodeId.convert(t.leases.C.camera.serial),
        },
        cameras: () =>
          triple ? { left: triple.leases.L.camera, right: triple.leases.R.camera } : null,
        centerPipe: () => centerPipe,
        // Full fovea snapshot (undistort required) — null → "Capture not ready".
        snapshot: (reset, indexed) =>
          triple?.undistort ? captureSnapshot(reset, indexed) : null,
        recordingActive: () => recording.active,
        telemetry: (patch) => s.telemetry(patch),
      });
      captureHelper.build();
      monitor.done("capture");

      monitor.start("controller");
      // Push model (spec §actuation): the SESSION owns the 1 ms cadence; each
      // tick pushes the current target, using the node's synchronous
      // predicted-volts return for the local mirror + telemetry.
      let lastActuateMs = 0;
      posInput = controllerNode().openPosition("manual-control", {
        from: nodeId.win("manual-control", "display"),
        initial: { left: { ...volts.L }, right: { ...volts.R } },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      // Drag slew (spec §drag-slew): slew the commanded pose toward the target so
      // each tick is a distinct pose the gate passes, then epsilon-snap + go quiet.
      let commanded: SlewPair | null = null;
      let lastPaceAt = 0;
      stopActuation = startPacer(1, () => {
        const target = targetVolts();
        const now = performance.now();
        const dt = lastPaceAt > 0 ? now - lastPaceAt : 1;
        lastPaceAt = now;
        // First tick (or post-reset): command the target directly (no swoop).
        const t = commanded
          ? slewStep(commanded, target, dt).pose
          : { l: { ...target.l }, r: { ...target.r } };
        commanded = t;
        const p = posInput!.update({ left: t.l, right: t.r });
        const v = { L: p.left, R: p.right };
        volts.L = p.left;
        volts.R = p.right;
        actuateMsStats.push(lastActuateMs);
        if (now - lastParamPush >= VOLT_TELEMETRY_INTERVAL_MS) {
          lastParamPush = now;
          pushParams(voltParams());
        }
        if (now - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
          lastVoltEmit = now;
          // Per-eye pose footprint from the ACTUAL commanded volts so the boxes
          // diverge while split; DEGRADE {0,0} uncalibrated (A2P.C throws — spec §split).
          const PX = (role: "L" | "R"): Point2d =>
            triple?.undistort ? triple.conv.A2P.C(triple.conv.V2A[role](v[role]), false) : { x: 0, y: 0 };
          s.telemetry({
            volt: v,
            L_PX: PX("L"),
            R_PX: PX("R"),
            perf: { actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max } },
          });
          actuateMsStats.resetMax();
          // Trigger-sync (spec §trigger-sync): the latched intent retries
          // engagement on this throttle — preconditions are lazy (the MCU
          // stream id lands only after the first v2 update, a controller
          // reconnect). Once engaged, the achieved-rate readout publishes here.
          if (s.state.trigger_sync && !triggerEngaged) void engageTrigger();
          else if (triggerEngaged) publishTriggerTelemetry();
        }
      });

      // --- teardown (LIFO — reverse of drain; spec §teardown) -----------
      // Worker + pipes drain AFTER the awaited capture/recording drain. Terminate
      // the worker BEFORE dropping the gate.
      scope.defer(() => {
        worker?.terminate();
        worker = null;
        for (const id of pipeIds) broker.disconnect(id);
        taps.dispose();
      });
      // Awaited async drain: an in-flight capture must finish (raw pipes release)
      // before the worker + pipes tear down, then stop the capture node's worker.
      scope.defer(async () => {
        await Promise.all([recording.stop(), captureHelper?.activeCapture ?? Promise.resolve()]);
        await captureHelper?.stop();
        captureHelper = null;
      });
      // Before the drain: new activity sees "not ready" instead of racing it.
      scope.defer(() => {
        triple = null;
        s.telemetry({ ready: false });
      });
      // Trigger-sync back to free-run (spec §trigger-sync): drains AFTER the
      // pacer stops (no re-engage race) but BEFORE `triple` clears +
      // `releaseLeases` — `disableHardwareTrigger` rides `lease.reconfigure` and
      // needs the live lease. The engage gate closes first so nothing re-arms.
      scope.defer(async () => {
        triggerEngageAllowed = false;
        await disengageTrigger();
      });
      scope.defer(() => {
        stopActuation?.(); // drains FIRST — stop pushing immediately
        stopActuation = null;
        void posInput?.close(); // terminate the MCU stream + disable-iff-we-enabled
        posInput = null;
      });

      monitor.done("controller");
      s.telemetry({ ready: true });
      monitor.complete(); // spin-up finished — clear the overlay
    }

    return {
      activate: (scope) => activateSession(scope),
      idle() {
        width = height = 0; // after the full drain (leases already released)
        reunify(); // split is session-local — re-entry starts unified
        // Reset stale split/pose telemetry so a re-entry doesn't light the ⟂
        // badge for an actually-unified session. Trigger-sync readouts clear too
        // (disengage already ran in the drain; intent stays latched in state).
        lastTriggerBlocked = null;
        s.resetTelemetry(["split", "L_PX", "R_PX", "trigger", "trigger_blocked"]);
      },
      watch: {
        zoom() {
          pushParams({ zoom: Math.max(1, s.state.zoom), ...voltParams(), ...sliceAtParam() });
        },
        // `view` drives the composite brick's MODE server-side (spec §views):
        // disparity → difference, anaglyph → anaglyph; sliced/sgbm leave it
        // parked (the renderer connects the selected pipe).
        view(view) {
          syncCompositeMode(coerceView(view));
        },
        baseline() {
          pushParams(voltParams());
        },
        // Trigger-sync INTENT (spec §trigger-sync): on → engage now if
        // preconditions permit (else `trigger_blocked` + the retry tick);
        // off → back to free-run.
        trigger_sync(on) {
          if (on) void engageTrigger();
          else void disengageTrigger();
        },
      },
      commands: {
        async steer(t) {
          if (t.mode === "pixel") setTargetFromPixel(t.value);
          else setTargetFromAngle(t.value, t.distance_mm, t.shift_deg);
        },
        async splitEye({ side, volt }) {
          // Pin one eye to the dragged volt, held until any `steer` reunifies
          // (spec §split; the release keeps the pin).
          splitVolts[side] = { ...volt };
          publishSplit();
        },
        async previewVolts(queries) {
          if (!triple) return queries.map(() => ({ l: ORIGIN_POS, r: ORIGIN_POS }));
          return queries.map(({ value, distance_mm, shift_deg }) => {
            const A = inverseTriangulate(
              value,
              s.state.baseline,
              distance_mm ?? baseDistance(),
              radians(shift_deg ?? baseShiftDeg()),
            );
            return { l: triple!.conv.A2V.L(A.l), r: triple!.conv.A2V.R(A.r) };
          });
        },
        // Legacy `capture`/`getPreview` + the mixin `captureShot`/
        // `getCapturePreview` all forward to the helper (guards live inside it).
        async capture({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async captureShot({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async getPreview({ resource, index }) {
          return captureHelper ? captureHelper.getPreview(resource, index) : null;
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
          // Exclusivity (spec §capture): refuse a recording while a capture shot
          // holds the raw L/R pipes.
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
