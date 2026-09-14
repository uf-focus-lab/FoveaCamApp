// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// MirrorLink session — a calibrated L/C/R triple whose two fovea mirrors trace a
// fast circular scan around a hand-aimed center while each fovea's exposure spans
// exactly one revolution. A stripped manual-control: no set-points, no split, no
// display worker, no capture. Behavior spec: docs/spec/mirror-link.md.

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
  startPacer,
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
import { activeController } from "@orchestrator/controller";
import { report } from "@orchestrator/diagnostics";
import {
  advertiseUndistortPipe,
  retireUndistortPipe,
  type UndistortPipeSeam,
} from "@orchestrator/undistort-pipe";
import { createRawRecording } from "@orchestrator/raw-recording";
import {
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
import type { RingReadout } from "@lib/ring-code";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import type { CameraLease } from "@orchestrator/registry";
import { createTriggerOpChain } from "@lib/trigger-sync";
import { slewStep, type SlewPair } from "@lib/slew";
import { vergeToDistance } from "@lib/stereo";
import { RollingStats } from "@lib/util/rolling";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { mirrorLink, type ScanTelemetry } from "./contract";
import { SCAN_HZ_RANGE, scanAngles, scanOffset, type ScanTrims } from "./scan";
import {
  applyScanTiming,
  exposureMismatch,
  restoreTiming,
  scanPeriodUs,
  snapshotTiming,
  type TimingSnapshot,
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

/** Applied timing per eye, as the cameras actually took it. */
type AppliedTiming = { exposure_us: number; frame_rate: number };

const clampHz = (hz: number): number =>
  Math.min(Math.max(hz, SCAN_HZ_RANGE.min), SCAN_HZ_RANGE.max);

/** Points per drawn scan loop — dense enough that the polyline reads as a
 *  circle at PosView scale, cheap enough to republish on every slider nudge. */
const SCAN_PATH_SAMPLES = 48;

/** Voltage envelope assumed while no controller is bound (controller.dv). */
const DEFAULT_DV = 170.0;

const errorLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];

export default function mirrorLinkSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  rawPipes: RawPipeRegistry,
  compressSeam?: CompressPipeSeam,
): ServerSession<typeof mirrorLink> {
  return defineResourceSession("mirror-link", mirrorLink, (s) => {
    let triple: CalibratedTriple | null = null;
    let posInput: PositionInput | null = null;
    let stopActuation: (() => void) | null = null;

    const now = () => performance.now();

    // Scan CENTER — always whatever `steer` last set (spec §targeting).
    let target: Point2d = { x: 0, y: 0 };
    let targetAngle: Point2d = { x: 0, y: 0 };

    // Latest commanded voltages (the instantaneous scan pose while active).
    const volts: { L: Pos; R: Pos } = {
      L: { ...ORIGIN_POS },
      R: { ...ORIGIN_POS },
    };

    // --- targeting ---------------------------------------------------------

    function trims(): ScanTrims {
      return {
        l: { x: radians(s.state.trim_lx), y: radians(s.state.trim_ly) },
        r: { x: radians(s.state.trim_rx), y: radians(s.state.trim_ry) },
      };
    }

    /** Per-eye angles for a scan offset (zero offset = the idle/center pose). */
    function anglesAt(offset: Point2d): { l: Point2d; r: Point2d } {
      return scanAngles(
        targetAngle,
        offset,
        s.state.baseline,
        vergeToDistance(s.state.verge, s.state.baseline),
        trims(),
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

    /** The scan's DRAWABLE geometry (spec §views): the ring radius in wide px,
     *  and the commanded circle in volt space per eye. Recomputed on every
     *  input that moves or reshapes the ring — never per pacer tick. */
    function publishScanGeometry(): void {
      if (!triple) {
        s.telemetry({ scan_px: 0, scan_path: { L: [], R: [] } });
        return;
      }
      const hz = clampHz(s.state.scan_hz);
      const periodMs = 1000 / hz;
      const L: Pos[] = [];
      const R: Pos[] = [];
      for (let k = 0; k < SCAN_PATH_SAMPLES; k++) {
        // The SAME chain the pacer commands: offset → inverseTriangulate +
        // trims → A2V, so the drawn path is the commanded path.
        const pose = voltsFor(
          anglesAt(
            scanOffset((k / SCAN_PATH_SAMPLES) * periodMs, hz, s.state.scan_amp),
          ),
        );
        // Clamped to the mirror's range, like every commanded pose: the drawn
        // path is the path the mirror can actually take.
        L.push(clampVolt(pose.l));
        R.push(clampVolt(pose.r));
      }
      s.telemetry({ scan_path: { L, R } });
      if (!triple.undistort) {
        s.telemetry({ scan_px: 0 });
        return;
      }
      const amp = radians(s.state.scan_amp);
      const c = triple.conv.A2P.C(targetAngle, false);
      const edge = triple.conv.A2P.C(
        { x: targetAngle.x + amp, y: targetAngle.y },
        false,
      );
      s.telemetry({ scan_px: Math.hypot(edge.x - c.x, edge.y - c.y) });
    }

    function setTargetFromPixel(px: Point2d): void {
      target = px;
      targetAngle = triple?.undistort
        ? triple.undistort.angular([px], false)[0]
        : { x: 0, y: 0 };
      s.telemetry({ target, target_angle: targetAngle });
      publishScanGeometry();
    }

    // --- scan lifecycle (spec §lifecycle) ----------------------------------
    // Session-local INTENT: never persisted, never auto-resumed on re-entry.

    let scanActive = false;
    let scanT0 = 0;
    /** Pre-scan timing per eye, captured at start and restored verbatim on
     *  stop / idle / re-apply — the per-camera config docs are never touched. */
    const snapshots: Partial<Record<Side, TimingSnapshot>> = {};
    /** False from idle start until the next activate: a queued start must not
     *  re-arm the cameras while teardown drains. */
    let scanAllowed = false;
    /** FIFO mutex over the lease timing config: a fast toggle must not
     *  interleave an apply with an in-flight restore (manual-control's idiom). */
    const queueScanOp = createTriggerOpChain((e) =>
      console.error("[mirror-link] scan op failed:", e),
    );

    function publishScanBlocked(reason: string | null): void {
      s.telemetry({ scan_blocked: reason });
    }

    /** Local mirror of the published `scan` readout — the runtime doesn't hand
     *  back the last telemetry object, and the amplitude watch patches it. */
    let activeScan: ScanTelemetry | null = null;

    function publishScanTelemetry(
      hz: number,
      applied: Record<Side, AppliedTiming>,
    ): void {
      const period_us = scanPeriodUs(hz);
      const mismatch =
        exposureMismatch(applied.L.exposure_us, period_us) ||
        exposureMismatch(applied.R.exposure_us, period_us);
      const scan: ScanTelemetry = {
        hz,
        amp_deg: s.state.scan_amp,
        period_us,
        exposure_us: { L: applied.L.exposure_us, R: applied.R.exposure_us },
        frame_rate: { L: applied.L.frame_rate, R: applied.R.frame_rate },
        mismatch,
      };
      activeScan = scan;
      s.telemetry({ scan });
      if (mismatch)
        report(
          "mirror-link",
          `scan exposure misses the ${(period_us / 1000).toFixed(1)} ms revolution ` +
            `(L ${(applied.L.exposure_us / 1000).toFixed(1)} ms, ` +
            `R ${(applied.R.exposure_us / 1000).toFixed(1)} ms) — the ring readout is partial`,
          "warning",
        );
    }

    /** Snapshot (once) + override one eye, on the lease's safe reconfigure path. */
    async function applyEye(
      side: Side,
      lease: CameraLease,
      hz: number,
    ): Promise<AppliedTiming> {
      let applied: AppliedTiming = { exposure_us: 0, frame_rate: 0 };
      await lease.reconfigure(() => {
        if (!snapshots[side]) snapshots[side] = snapshotTiming(lease.camera);
        applied = applyScanTiming(lease.camera, hz);
      });
      return applied;
    }

    /** Restore whatever was snapshotted, best-effort (the lease may be releasing). */
    async function restoreEyes(t: CalibratedTriple): Promise<void> {
      for (const side of SIDES) {
        const snap = snapshots[side];
        if (!snap) continue;
        try {
          await t.leases[side].reconfigure(() =>
            restoreTiming(t.leases[side].camera, snap),
          );
        } catch {
          // best-effort — the lease may already be releasing
        }
        delete snapshots[side];
      }
    }

    /** Apply L then R; a failure on either restores whatever was applied
     *  (spec §exposure). Serialized via {@link queueScanOp}. */
    async function startScanNow(hz: number): Promise<boolean> {
      if (!scanAllowed || !triple) {
        publishScanBlocked("no camera triple leased");
        return false;
      }
      const t = triple;
      const applied = {} as Record<Side, AppliedTiming>;
      try {
        for (const side of SIDES)
          applied[side] = await applyEye(side, t.leases[side], hz);
      } catch (e) {
        await restoreEyes(t);
        publishScanBlocked(`exposure override failed: ${errorLine(e)}`);
        return false;
      }
      // Idled / re-leased while awaiting — undo, stay out.
      if (!scanAllowed || triple !== t) {
        await restoreEyes(t);
        return false;
      }
      scanT0 = now();
      scanActive = true;
      pushRingEnabled();
      publishScanBlocked(null);
      publishScanTelemetry(hz, applied);
      return true;
    }

    /** Serialized via {@link queueScanOp}. MUST run while the leases are live —
     *  the restore rides `lease.reconfigure`. */
    async function stopScanNow(): Promise<void> {
      const wasActive = scanActive;
      scanActive = false;
      pushRingEnabled();
      resetRingTelemetry();
      if (triple) await restoreEyes(triple);
      if (wasActive) {
        activeScan = null;
        s.telemetry({ scan: null });
      }
    }

    /** Live `scan_hz` change while active: re-apply at the new frequency. The
     *  two-sided exposure write makes an apply range-safe from ANY current
     *  timing, and the PRE-SCAN snapshot is kept (never re-taken), so a later
     *  stop still lands on Manage Cameras' values. */
    async function reapplyScanNow(hz: number): Promise<void> {
      if (!scanActive || !triple) return;
      const t = triple;
      const applied = {} as Record<Side, AppliedTiming>;
      try {
        for (const side of SIDES)
          applied[side] = await applyEye(side, t.leases[side], hz);
      } catch (e) {
        scanActive = false;
        pushRingEnabled();
        resetRingTelemetry();
        await restoreEyes(t);
        activeScan = null;
        s.telemetry({ scan: null });
        publishScanBlocked(`exposure override failed: ${errorLine(e)}`);
        return;
      }
      publishScanTelemetry(hz, applied);
    }

    // --- gain override (spec §gain) -----------------------------------------
    // Session-wide, not scan-scoped: aligning on a dim source needs it BEFORE
    // the scan. Same live-handle model as the exposure override — the
    // per-camera config docs are never written.

    /** Pre-session gain per eye, restored on idle. */
    const gainSnapshots: Partial<Record<Side, GainSnapshot>> = {};
    /** The range BOTH foveas honor; {0,0} until leased (slider disabled). */
    let gainRange = { min: 0, max: 0 };

    /** Drive both eyes to `dB`, clamped to the shared range — the clamped value
     *  goes back into state so the readout never shows a gain the hardware did
     *  not take. Serialized on {@link queueScanOp}. */
    async function applyGainNow(dB: number): Promise<void> {
      const t = triple;
      if (!t || gainRange.min === gainRange.max) return;
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
    // over the two RAW fovea pipes, with the pixel work further gated on the
    // scan (a frame that didn't integrate a revolution holds no ring).

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
      let changed = false;
      for (const side of SIDES) {
        const value = r.values[side] as RingReadout | undefined;
        if (!value) continue;
        ring[side] = mergeReadout(side, value);
        changed = true;
      }
      if (changed) s.telemetry({ ring: { L: ring.L, R: ring.R } });
    }

    /** The reader only runs while the scan does; no node ⇒ nothing to push. */
    function pushRingEnabled(): void {
      ringWorker?.sendParams({ enabled: scanActive });
    }

    /** Drop the published readouts. The annotations assert a decode of THIS
     *  frame; once the scan stops, the frames are free-running and un-scanned,
     *  so keeping the last one on screen would be a lie. */
    function resetRingTelemetry(): void {
      if (!ring.L && !ring.R) return;
      ring.L = ring.R = null;
      s.telemetry({ ring: { L: null, R: null } });
    }

    /** Connect the two convert pipes, publish the node + its edges, and spawn
     *  the worker. Idempotent; a no-op without a leased triple. */
    function buildRingNode(): void {
      const t = triple;
      if (ringNode || !t) return;
      const node = nodeId.win("mirror-link", "ring");
      const pipeIds: string[] = [];
      const pipes: PipeInput[] = SIDES.map((side) => {
        const pipeId = nodeId.convert(t.leases[side].camera.serial);
        const handle = broker.connect(pipeId);
        pipeIds.push(pipeId);
        const { width, height, channels, bytesPerFrame, maxBytes } = handle.spec;
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
          params: { kind: "ring", enabled: scanActive },
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
      return {
        scan: activeScan,
        ring: { L: ring.L, R: ring.R },
        trims: {
          l: { x: s.state.trim_lx, y: s.state.trim_ly },
          r: { x: s.state.trim_rx, y: s.state.trim_ry },
          unit: "degree",
        },
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
     *  that integrated a whole revolution has no single pose to warp against,
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
      // §views). The L/R views bind the RAW convert pipes directly: a frame
      // spanning a full revolution has no single mirror pose to warp against.
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
      monitor.done("pipes");

      // Capture node (spec §capture): idle until a shot is asked for; the raw
      // L/R producers are advertised/connected per shot. The center undistort
      // pipe stays connected so its producer is live for the one-shot read.
      {
        const capCenterId = undistortC ?? nodeId.convert(t.leases.C.camera.serial);
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
      // No `from`: the scan pose is computed in this session, not by a graph
      // node — an edge would synthesize a phantom placeholder in the profiler.
      posInput = controllerNode().openPosition("mirror-link", {
        initial: { left: { ...volts.L }, right: { ...volts.R } },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      scanAllowed = true;
      publishScanGeometry();
      // Push model (spec §actuation): the SESSION owns the 1 ms cadence. Idle
      // slews toward the center pose; active commands the scan pose DIRECTLY
      // (a smoother would lag and shrink the circle), and the slew resumes from
      // that last pose on stop.
      let commanded: SlewPair | null = null;
      let lastPaceAt = 0;
      stopActuation = startPacer(1, () => {
        const tick = now();
        const dt = lastPaceAt > 0 ? tick - lastPaceAt : 1;
        lastPaceAt = tick;
        if (scanActive) {
          // Phase from the WALL CLOCK — a late tick lands at the right phase.
          commanded = voltsFor(
            anglesAt(
              scanOffset(
                tick - scanT0,
                clampHz(s.state.scan_hz),
                s.state.scan_amp,
              ),
            ),
          );
        } else {
          const goal = centerVolts();
          commanded = commanded
            ? slewStep(commanded, goal, dt).pose
            : { l: { ...goal.l }, r: { ...goal.r } };
        }
        const p = posInput!.update({ left: commanded.l, right: commanded.r });
        volts.L = p.left;
        volts.R = p.right;
        actuateMsStats.push(lastActuateMs);
        if (tick - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
          lastVoltEmit = tick;
          // Per-eye markers come from the CENTER pose (trims included), not the
          // instantaneous scan pose — they show where each fovea is aimed. The
          // published `volt` is that same center pose while scanning: sampling
          // the circle at the telemetry throttle reads as random flicker, and
          // the ring itself is drawn from `scan_path`.
          const c = centerVolts();
          s.telemetry({
            volt: scanActive
              ? { L: { ...c.l }, R: { ...c.r } }
              : { L: p.left, R: p.right },
            L_PX: projectPx("L", c.l),
            R_PX: projectPx("R", c.r),
            perf: {
              actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max },
            },
          });
          actuateMsStats.resetMax();
        }
      });

      // --- teardown (LIFO — reverse of the drain; spec §teardown) ----------
      scope.defer(() => {
        triple = null;
        s.telemetry({ ready: false });
      });
      // Restore the camera timing while the leases are still live (the restore
      // rides `lease.reconfigure`), after the pacer stopped so nothing re-arms.
      // Exposure first, then the gain override (spec §gain).
      scope.defer(async () => {
        scanAllowed = false;
        await queueScanOp(async () => {
          await stopScanNow();
          await restoreGainNow();
        });
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
        // After the full drain (leases released, timing restored). Scan intent
        // is session-local — a re-entry starts idle.
        target = { x: 0, y: 0 };
        targetAngle = { x: 0, y: 0 };
        volts.L = { ...ORIGIN_POS };
        volts.R = { ...ORIGIN_POS };
        activeScan = null;
        gainRange = { min: 0, max: 0 };
        ring.L = ring.R = null;
        s.resetTelemetry([
          "ring",
          "scan",
          "scan_blocked",
          "scan_px",
          "scan_path",
          "gain_range",
          "L_PX",
          "R_PX",
        ]);
      },
      watch: {
        // Everything that moves or reshapes the commanded ring republishes the
        // drawn geometry (the pacer never does — spec §views).
        verge: publishScanGeometry,
        baseline: publishScanGeometry,
        trim_lx: publishScanGeometry,
        trim_ly: publishScanGeometry,
        trim_rx: publishScanGeometry,
        trim_ry: publishScanGeometry,
        // Amplitude is live on the next tick; only the drawn ring needs a push.
        scan_amp() {
          publishScanGeometry();
          if (activeScan) {
            activeScan = { ...activeScan, amp_deg: s.state.scan_amp };
            s.telemetry({ scan: activeScan });
          }
        },
        // Frequency re-applies the exposure override (spec §exposure).
        scan_hz(hz) {
          if (scanActive)
            void queueScanOp(() => reapplyScanNow(clampHz(hz as number)));
        },
        // Gain rides the SAME FIFO chain as the exposure ops (spec §gain) — a
        // drag must never interleave with an apply/restore on the same lease.
        gain(dB) {
          if (typeof dB === "number") void queueScanOp(() => applyGainNow(dB));
        },
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
        async startScan() {
          if (scanActive) return true;
          let ok = false;
          await queueScanOp(async () => {
            ok = await startScanNow(clampHz(s.state.scan_hz));
          });
          return ok;
        },
        async stopScan() {
          await queueScanOp(stopScanNow);
          publishScanBlocked(null);
        },
        // Capture — forwarded to the shared helper (its guards live inside).
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
