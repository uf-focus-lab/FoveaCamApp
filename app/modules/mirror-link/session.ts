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
  type NativePositionInput,
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
import { nodeId, type StreamType } from "@lib/orchestrator/graph-contract";
import { makeMat } from "@lib/mat";
import type { RingReadout } from "@lib/ring-code";
import type { PipeBroker } from "@orchestrator/pipe-session";
import { rawPipeSpec, type RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import type { OrbitHandle, OrbitSeam } from "@orchestrator/orbit-pipe";
import { registerNativeProbe } from "@orchestrator/native-probes";
import type { CameraLease } from "@orchestrator/registry";
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
import type { SpotValue } from "@orchestrator/spot-kernel";
import { PID2D, type PidParams } from "@lib/pid";
import { deg } from "@lib/util/math";
import { RollingStats } from "@lib/util/rolling";
import type { Point2d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import {
  mirrorLink,
  type AlignTelemetry,
  type ScanTelemetry,
} from "./contract";
import { solveAlignment, spotOffsetAngle } from "./align";
import { SCAN_HZ_RANGE, SHIFT_RANGE_DEG, scanAngles, scanOffset } from "./scan";
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

/** JS fallback push interval while the native brick owns the wire: the pacer
 *  still ticks at 1 ms (its gap is the stall meter), but the fallback pose only
 *  tracks the slewed center, which nothing downstream consumes. */
const FALLBACK_TICK_MS = 10;

/** The orbit node's advertised output. */
const PID_STREAM: StreamType = { kind: "analysis", schema: "pid" };

/** How often the brick + sink meters are read for `perf.orbit`. Far slower than
 *  the telemetry throttle: a probe builds an object on the very loop the brick
 *  exists to keep free. */
const ORBIT_PROBE_INTERVAL_MS = 1000;

/** Orbit-sink GOVERNOR policy (spec §actuation). The compose path's AIMD
 *  defaults suit a latency-sensitive tracker: halve on ANY pressure signal,
 *  floor 60 Hz. A free-running orbit is different — 60 poses/s at a 10 Hz scan
 *  is a hexagon. Genuine link overload must still back off (`enabled` stays
 *  true), but never below a floor that keeps the ring round, and a busy MCU's
 *  inflated ACK RTT is not overload of the UPDATE path. */
const ORBIT_GOV_FLOOR_HZ = 500;
const ORBIT_GOV_RTT_INFLATION = 8;

const errorLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n", 1)[0];

export default function mirrorLinkSession(
  broker: PipeBroker,
  undistortSeam: UndistortPipeSeam,
  rawPipes: RawPipeRegistry,
  orbitSeam: OrbitSeam,
  compressSeam?: CompressPipeSeam,
): ServerSession<typeof mirrorLink> {
  return defineResourceSession("mirror-link", mirrorLink, (s) => {
    let triple: CalibratedTriple | null = null;
    let posInput: PositionInput | null = null;
    let nativePos: NativePositionInput | null = null;
    let orbit: OrbitHandle | null = null;
    let voltLink: { release(): void } | null = null;
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

    /** Per-eye angles for a scan offset (zero offset = the idle/center pose). */
    function anglesAt(offset: Point2d): { l: Point2d; r: Point2d } {
      return scanAngles(
        targetAngle,
        offset,
        s.state.baseline,
        vergeToDistance(s.state.verge, s.state.baseline),
        radians(s.state.shift),
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

    /** Finite-difference half-step for the orbit Jacobian (rad). */
    const J_EPS_RAD = 1e-3;

    /** The angle→volt chain LINEARIZED around offset 0, per eye: row-major 2×2
     *  volts per radian `[dVx/dox, dVx/doy, dVy/dox, dVy/doy]`. The native brick
     *  commands `center + J · offset`, so the emitted circle is exact to first
     *  order; `scan_path` stays the exact chain (spec §scan). */
    function orbitJacobians(): { jL: number[]; jR: number[] } {
      const at = (x: number, y: number): SlewPair =>
        voltsFor(anglesAt({ x, y }));
      const px = at(J_EPS_RAD, 0);
      const mx = at(-J_EPS_RAD, 0);
      const py = at(0, J_EPS_RAD);
      const my = at(0, -J_EPS_RAD);
      const d = 2 * J_EPS_RAD;
      const eye = (k: "l" | "r"): number[] => [
        (px[k].x - mx[k].x) / d,
        (py[k].x - my[k].x) / d,
        (px[k].y - mx[k].y) / d,
        (py[k].y - my[k].y) / d,
      ];
      return { jL: eye("l"), jR: eye("r") };
    }

    /** Hand the brick the current center + linearization (spec §actuation). */
    function pushOrbitPose(): void {
      if (!orbit || !triple) return;
      const c = centerVolts();
      const { jL, jR } = orbitJacobians();
      orbit.setPose({ centerL: c.l, centerR: c.r, jL, jR });
    }

    /** Hand the brick the ring shape, its tick rate, and whether it runs. */
    function pushOrbitParams(): void {
      orbit?.setOrbit({
        ampRad: radians(s.state.scan_amp),
        hz: clampHz(s.state.scan_hz),
        paceHz: s.state.orbit_pace_hz,
        enabled: scanActive,
      });
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

    /** The scan's DRAWABLE geometry (spec §views): the ring radius in wide px,
     *  and the commanded circle in volt space per eye. Recomputed on every
     *  input that moves or reshapes the ring — never per pacer tick. The same
     *  inputs re-linearize the native brick, so the pose push rides here. */
    function publishScanGeometry(): void {
      if (!triple) {
        s.telemetry({ scan_px: 0, scan_path: { L: [], R: [] } });
        return;
      }
      pushOrbitPose();
      const hz = clampHz(s.state.scan_hz);
      const periodMs = 1000 / hz;
      const L: Pos[] = [];
      const R: Pos[] = [];
      for (let k = 0; k < SCAN_PATH_SAMPLES; k++) {
        // The SAME chain the pacer commands: offset → inverseTriangulate +
        // shift → A2V, so the drawn path is the commanded path.
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
      pushOrbitParams();
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
      pushOrbitParams();
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
        pushOrbitParams();
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

    // --- auto-align servo (spec §targeting) ---------------------------------
    // A closed loop, not a one-shot: the `spot` kernel measures the emitter in
    // each fovea frame and FOUR PID controllers (two PID2D, one per eye) drive
    // the per-eye DESIRED angles until the spot sits at the frame center. Every
    // step re-solves the fixation model and applies the pair COLLECTIVELY —
    // gaze ray, verge distance and vertical shift together — so the two eyes can
    // never walk apart. Session-local intent, like the scan.

    let spotWorker: VisionWorkerHandle | null = null;
    let spotNode: { dispose(): void } | null = null;
    /** Per-eye PID node (each holds one PID2D = the eye's x and y controllers). */
    const alignPid: Partial<Record<Side, PidNodeHandle<Point2d>>> = {};
    const alignCtl: Partial<Record<Side, PID2D>> = {};
    /** The angles the servo is driving toward (seeded from the live pose). */
    const desired: Record<Side, Point2d> = {
      L: { x: 0, y: 0 },
      R: { x: 0, y: 0 },
    };
    const misses: Record<Side, number> = { L: 0, R: 0 };
    let alignEngaged = false;
    let lastSpotAt = 0;
    let lastSeenAt = 0;
    let alignTele: AlignTelemetry | null = null;

    /** Integrator resets after this many consecutive blind frames on an eye. */
    const MISS_RESET = 10;
    /** Both eyes blind this long ⇒ say so (the servo stays engaged). */
    const BLIND_MS = 2000;

    function pidParams(): PidParams {
      const { pid_kp: kp, pid_ki: ki, pid_kd: kd } = s.state;
      const lim = radians(Math.max(0, s.state.pid_max_step_deg));
      return { kp, ki, kd, limits: [-lim, lim] };
    }

    function publishAlign(patch?: Partial<AlignTelemetry>): void {
      if (!alignEngaged) return;
      alignTele = { ...(alignTele as AlignTelemetry), ...patch };
      s.telemetry({ align: alignTele });
    }

    /** One servo step per spot result (spec §targeting): angle error per eye →
     *  PID → desired angles → one collective solve. */
    function onSpotResult(r: VisionResult): void {
      if (!alignEngaged) return;
      const t = triple;
      const und = t?.undistort;
      if (!t || !und) return;
      const now = performance.now();
      const dt = lastSpotAt > 0 ? Math.min(0.5, (now - lastSpotAt) / 1000) : 0;
      lastSpotAt = now;
      const spots: AlignTelemetry["spots"] = { L: null, R: null };
      const errors: AlignTelemetry["error_deg"] = { L: null, R: null };
      let sawAny = false;
      for (const side of SIDES) {
        const spot = r.values[side] as SpotValue | undefined;
        const node = alignPid[side];
        const ctl = alignCtl[side];
        if (!node || !ctl) continue;
        node.ingest("spot");
        if (!spot) {
          // Blind on this eye: HOLD its angle. A long blackout would otherwise
          // wind the integrator up against a measurement that never comes.
          if (++misses[side] === MISS_RESET) ctl.reset();
          continue;
        }
        sawAny = true;
        misses[side] = 0;
        spots[side] = { x: spot.x, y: spot.y };
        // The error IS the spot's offset from the fovea center, in angle.
        const { f, c } = deriveFoveaIntrinsics(und, desired[side], 1);
        const err = spotOffsetAngle({ x: spot.x, y: spot.y }, c, f);
        errors[side] = { x: deg(err.x), y: deg(err.y) };
        ctl.setParams({ x: pidParams(), y: pidParams() });
        const step = node.step(() => ctl.step(err, dt || 1 / 30));
        const delta = outputOf(step);
        desired[side] = {
          x: desired[side].x + delta.x,
          y: desired[side].y + delta.y,
        };
      }
      if (sawAny) lastSeenAt = now;
      // COLLECTIVE apply: one gaze ray, one distance, one shift.
      const solved = solveAlignment(desired.L, desired.R, s.state.baseline);
      targetAngle = solved.angle;
      target = und.position([solved.angle], false)[0];
      const verge = Number.isFinite(solved.distanceMm)
        ? distanceToVerge(solved.distanceMm, s.state.baseline)
        : 0;
      s.setState("verge", Math.min(1, Math.max(0, verge)));
      s.setState(
        "shift",
        Math.min(
          SHIFT_RANGE_DEG.max,
          Math.max(SHIFT_RANGE_DEG.min, deg(solved.shiftRad)),
        ),
      );
      s.telemetry({ target, target_angle: targetAngle });
      publishScanGeometry();
      const blind =
        !sawAny && lastSeenAt > 0 && now - lastSeenAt > BLIND_MS
          ? "no emitter in either fovea"
          : undefined;
      publishAlign({
        spots,
        error_deg: errors,
        applied: {
          angle: solved.angle,
          distance_mm: Number.isFinite(solved.distanceMm)
            ? solved.distanceMm
            : null,
          shift_deg: s.state.shift,
        },
        ...(blind ? { reason: blind } : { reason: undefined }),
      });
    }

    /** Build the measurement node + the two PID nodes, and engage. */
    function startAlignNow(): boolean {
      const t = triple;
      if (!t || !t.undistort || alignEngaged) return alignEngaged;
      const node = nodeId.win("mirror-link", "spot");
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
            kind: "spot",
            owner: "win/mirror-link",
            output: { kind: "analysis", schema: "spot" },
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
      // One PID node per eye: spot → pid → controller, exactly the marker
      // servo's shape. Each holds a PID2D, so the four DOFs are the two nodes'
      // x/y controllers.
      for (const side of SIDES) {
        desired[side] = t.conv.V2A[side](volts[side]);
        misses[side] = 0;
        const ctl = new PID2D({ x: pidParams(), y: pidParams() });
        alignCtl[side] = ctl;
        alignPid[side] = createPidNode<Point2d>({
          id: nodeId.win("mirror-link", "pid", side),
          kind: "pid",
          owner: "win/mirror-link",
          inputs: [{ from: node, port: "spot" }],
          outputs: [{ to: nodeId.controller(), port: `align/${side}` }],
          controllers: { angle: ctl },
        });
      }
      spotWorker = createVisionWorker(
        {
          pipes,
          params: { kind: "spot", enabled: true },
          meterName: node,
        },
        onSpotResult,
      );
      spotNode = {
        dispose() {
          spotWorker?.terminate();
          spotWorker = null;
          for (const side of SIDES) {
            alignPid[side]?.dispose();
            delete alignPid[side];
            delete alignCtl[side];
          }
          unregister();
          for (const id of pipeIds) broker.disconnect(id);
        },
      };
      alignEngaged = true;
      lastSpotAt = 0;
      lastSeenAt = performance.now();
      alignTele = {
        engaged: true,
        spots: { L: null, R: null },
        error_deg: { L: null, R: null },
        applied: null,
      };
      s.telemetry({ align: alignTele });
      return true;
    }

    function stopAlignNow(): void {
      if (!alignEngaged && !spotNode) return;
      alignEngaged = false;
      const node = spotNode;
      spotNode = null;
      node?.dispose();
      alignTele = null;
      s.telemetry({ align: null });
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
    /** Pacer tick INTERVAL: the 1 ms loop is the mirror's clock, so any stall on
     *  the orchestrator loop (an allocation, a synchronous native call) is a
     *  straight chord across the scanned ring. Metered so the rig can see it —
     *  under the native brick it only meters THIS loop, never the scan. */
    const tickGapMsStats = new RollingStats(0.9, 2, "ms");

    type OrbitPerf = {
      native: boolean;
      emitHz: number;
      sinkHz: number;
      governor: {
        state: "off" | "steady" | "seeking" | "backoff";
        effectiveRateHz: number;
        backoffs: number;
        softFails: number;
        outq: number;
      };
    };
    let orbitPerf: OrbitPerf = {
      native: false,
      emitHz: 0,
      sinkHz: 0,
      governor: {
        state: "off",
        effectiveRateHz: 0,
        backoffs: 0,
        softFails: 0,
        outq: 0,
      },
    };
    let lastEmitCount = 0;
    let lastSinkCount = 0;
    let lastOrbitAt = 0;

    /** Both ends of the volt path, differenced across probe windows (the
     *  meters report LIFETIME averages, which would hide a live stall):
     *  `emitHz` off the brick's thread meter, `sinkHz` off the mirror sink's
     *  `written` counter — the number that actually reaches the wire, and the
     *  one the polygon diagnosis turns on (spec §actuation). */
    function probeOrbit(tick: number): OrbitPerf {
      const native = voltLink !== null;
      if (!orbit) return { ...orbitPerf, native, emitHz: 0, sinkHz: 0 };
      if (tick - lastOrbitAt < ORBIT_PROBE_INTERVAL_MS)
        return { ...orbitPerf, native };
      const emits = orbit.probe().outputs.volt?.count ?? 0;
      const sink = nativePos?.sink?.probe();
      const writes = sink?.written ?? 0;
      const dt = tick - lastOrbitAt;
      const stats = activeController()?.stats;
      orbitPerf = {
        native,
        emitHz: lastOrbitAt > 0 ? ((emits - lastEmitCount) * 1000) / dt : 0,
        sinkHz: lastOrbitAt > 0 ? ((writes - lastSinkCount) * 1000) / dt : 0,
        governor: {
          state: sink?.governorState ?? "off",
          effectiveRateHz: sink?.effectiveRateHz ?? 0,
          backoffs: sink?.backoffs ?? 0,
          softFails: stats?.txSoftFail ?? 0,
          outq: stats?.outqBytes ?? 0,
        },
      };
      lastEmitCount = emits;
      lastSinkCount = writes;
      lastOrbitAt = tick;
      return orbitPerf;
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

      // Capture node (spec §capture). The raw L/R producers are PRE-ACQUIRED
      // here, not per shot: `rawPipes.acquire` on a 0→1 transition advertises
      // the pipe (allocating a CAPTURE_RING_DEPTH × full-depth-frame SHM ring)
      // and runs the native attach, both SYNCHRONOUS on the orchestrator loop
      // that also runs the 1 ms pacer — tens of ms of stall mid-scan, which the
      // mirror draws as a straight chord across the ring. Pre-acquired, the
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
      // The NATIVE scan generator (spec §actuation): its own paced thread turns
      // the linearization into volts, so a synchronous camera write on this loop
      // can no longer stall a revolution. Its NODE row only — the volt link
      // reports its own `→ controller` edge (the compose brick's precedent).
      const orbitId = nodeId.win("mirror-link", "orbit");
      orbit = orbitSeam.create(orbitId);
      scope.defer(
        registerGraphWiring({
          nodes: [
            {
              id: orbitId,
              kind: "orbit",
              owner: "win/mirror-link",
              output: PID_STREAM,
              transport: "native",
            },
          ],
          edges: [],
        }),
      );
      scope.defer(
        registerNativeProbe(() => (orbit ? { [orbitId]: orbit.probe() } : {})),
      );
      // No `from`: the FALLBACK pose is computed in this session, not by a graph
      // node — an edge would synthesize a phantom placeholder in the profiler.
      posInput = controllerNode().openPosition("mirror-link", {
        initial: { left: { ...volts.L }, right: { ...volts.R } },
        onApplied: (_v, actuateMs) => {
          lastActuateMs = actuateMs;
        },
      });
      nativePos = controllerNode().openNativePosition("mirror-link", {
        initial: { left: { ...volts.L }, right: { ...volts.R } },
        onAttach: (sink) => {
          // A free-running orbit needs a different AIMD policy from the
          // latency-sensitive compose path (spec §actuation).
          try {
            sink.setGovernor({
              ceilingHz: s.state.orbit_pace_hz,
              floorHz: ORBIT_GOV_FLOOR_HZ,
              rttInflation: ORBIT_GOV_RTT_INFLATION,
              enabled: true,
            });
          } catch {
            // governor params rejected — the baked defaults still apply
          }
          voltLink = orbit ? orbit.volt_out.pipe(sink.pos_in) : null;
        },
        onDetach: () => {
          voltLink?.release();
          voltLink = null;
        },
      });
      scanAllowed = true;
      publishScanGeometry(); // seeds the brick's first pose (lands, no swoop)
      pushOrbitParams();
      // FALLBACK push model (spec §actuation): without a v2 controller the
      // SESSION still owns the 1 ms cadence — idle slews toward the center pose,
      // active commands the scan pose DIRECTLY (a smoother would lag and shrink
      // the circle), and the slew resumes from that last pose on stop. While the
      // brick owns the wire this path only tracks the CENTER, a tenth as often.
      let commanded: SlewPair | null = null;
      let lastPaceAt = 0;
      let lastPushAt = 0;
      stopActuation = startPacer(1, () => {
        const tick = now();
        const dt = lastPaceAt > 0 ? tick - lastPaceAt : 1;
        if (lastPaceAt > 0) tickGapMsStats.push(dt);
        lastPaceAt = tick;
        const native = controllerNode().nativeEngaged();
        if (!native || tick - lastPushAt >= FALLBACK_TICK_MS) {
          const pushDt = lastPushAt > 0 ? tick - lastPushAt : dt;
          lastPushAt = tick;
          if (scanActive && !native) {
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
              ? slewStep(commanded, goal, pushDt).pose
              : { l: { ...goal.l }, r: { ...goal.r } };
          }
          const p = posInput!.update({ left: commanded.l, right: commanded.r });
          volts.L = p.left;
          volts.R = p.right;
          actuateMsStats.push(lastActuateMs);
        }
        if (tick - lastVoltEmit >= VOLT_TELEMETRY_INTERVAL_MS) {
          lastVoltEmit = tick;
          // Per-eye markers come from the CENTER pose (shift included), not the
          // instantaneous scan pose — they show where each fovea is aimed. The
          // published `volt` is that same center pose while scanning: sampling
          // the circle at the telemetry throttle reads as random flicker, and
          // the ring itself is drawn from `scan_path`.
          const c = centerVolts();
          s.telemetry({
            volt:
              scanActive || native
                ? { L: { ...c.l }, R: { ...c.r } }
                : { L: volts.L, R: volts.R },
            L_PX: projectPx("L", c.l),
            R_PX: projectPx("R", c.r),
            perf: {
              actuateMs: { mean: actuateMsStats.mean, max: actuateMsStats.max },
              tickGapMs: {
                mean: tickGapMsStats.mean,
                max: tickGapMsStats.max,
              },
              // `native` is the LINK, not `nativeEngaged()`: during the attach
              // window the JS path is already suppressed and nothing is
              // driving the mirrors yet.
              orbit: probeOrbit(tick),
            },
          });
          actuateMsStats.resetMax();
          tickGapMsStats.resetMax();
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
          stopAlignNow(); // the servo's worker + PID nodes go first
          await stopScanNow();
          await restoreGainNow();
        });
      });
      // Drained in this order (LIFO — reverse of registration): the pacer, then
      // the volt link, the native input, and last the brick itself.
      scope.defer(() => {
        orbit?.release();
        orbit = null;
      });
      scope.defer(() => {
        void nativePos?.close(); // detach + TERMINATE + disable-iff-last
        nativePos = null;
      });
      scope.defer(() => {
        voltLink?.release();
        voltLink = null;
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
          "align",
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
        shift: publishScanGeometry,
        baseline: publishScanGeometry,
        // Amplitude rides the brick's live params; the drawn ring follows.
        scan_amp() {
          pushOrbitParams();
          publishScanGeometry();
          if (activeScan) {
            activeScan = { ...activeScan, amp_deg: s.state.scan_amp };
            s.telemetry({ scan: activeScan });
          }
        },
        // The generator's tick rate is also the sink governor's ceiling.
        orbit_pace_hz() {
          pushOrbitParams();
          try {
            nativePos?.sink?.setGovernor({ ceilingHz: s.state.orbit_pace_hz });
          } catch {
            // governor params rejected — the baked defaults still apply
          }
        },
        // Frequency is live on the brick (the phase accumulates across the
        // change) and re-applies the exposure override (spec §exposure).
        scan_hz(hz) {
          pushOrbitParams();
          if (scanActive)
            void queueScanOp(() => reapplyScanNow(clampHz(hz as number)));
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
        async startAlign() {
          // On the scan ops' FIFO chain: engaging must not interleave with a
          // start/stop that is re-arming the same leases.
          let ok = false;
          await queueScanOp(async () => {
            ok = startAlignNow();
            if (!ok) report("mirror-link", "auto align: not ready", "warning");
          });
          return ok;
        },
        async stopAlign() {
          await queueScanOp(async () => stopAlignNow());
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
