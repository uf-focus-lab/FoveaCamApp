// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera/stream registry. Centralizes camera ownership BY RESOURCE (one native
// `Camera` per serial, leased via `acquire(serial)`) so consumers never open a camera
// twice or fight over its config. Each shared camera advertises one native
// `camera:<serial>` SHM pipe (the native converter producer) — N windows cost one
// acquisition. INVARIANT: no camera frames touch the JS event loop (all vision runs in
// worker threads).

import type { Camera } from "core/Aravis";
import type { Role } from "@lib/camera-config";
import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";
import { nodeId } from "@lib/orchestrator/graph-contract.js";
import { applyStoredConfig, cameraConfigPath, listCameraInfo } from "./camera.js";
import { timeSpan } from "./diagnostics.js";
import { read } from "./store-hub.js";
import { awaitHardwareClear } from "./hardware-gate.js";

// The SHM PREVIEW write runs on the native per-camera converter thread
// (`ConverterStream`, via `Aravis.attachCameraPipe`), published through
// C's `camera:<serial>` pipe. The orchestrator index injects the pipe broker's
// advertise/unadvertise + the native attach/detach here so the registry can
// (un)advertise a pipe per shared camera. Injected (not imported) so this
// module — and its vitest — never require the pipe session / native core.
export interface RegistryPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(camera: Camera, pipeId: string): void;
  detach(pipeId: string): void;
}
let pipeSeam: RegistryPipeSeam | null = null;
export function setRegistryPipeSeam(seam: RegistryPipeSeam | null): void {
  pipeSeam = seam;
}

/** The advertised spec of a shared camera's `camera/<serial>/convert` RGBA8
 *  pipe — the ONE place its shape is decided, so a chained same-shape brick
 *  (MirrorLink's flip pipes) advertises exactly what its source carries.
 *  Camera resolution comes from GenICam (no `Camera` accessor). */
export function cameraPipeSpec(
  camera: Pick<Camera, "serial" | "getFeatureInt">,
): PipeSpec {
  // Width/Height are integer GenICam nodes — `getFeature` (arv_camera_get_string)
  // throws "Not a ArvGcString" on them; use the integer accessor.
  const width = camera.getFeatureInt("Width");
  const height = camera.getFeatureInt("Height");
  const channels = 4;
  return {
    // Path-like node id.
    id: nodeId.convert(camera.serial),
    pixelFormat: "RGBA8",
    dtype: "U8",
    width,
    height,
    channels,
    stride: width * channels,
    bytesPerFrame: width * height * channels,
    ringDepth: 4,
  };
}

/** Advertise a shared camera's `camera:<serial>` RGBA8 pipe + attach B's native
 *  producer. Pure over the seam so it unit-tests without the native
 *  acquire chain. */
export function advertiseCameraPipe(
  seam: RegistryPipeSeam,
  camera: Pick<Camera, "serial" | "getFeatureInt">,
): string {
  const spec = cameraPipeSpec(camera);
  seam.advertise(spec);
  seam.attach(camera as Camera, spec.id);
  return spec.id;
}

/** Detach B's producer + un-advertise (renderer consumers see CLOSED). */
export function retireCameraPipe(seam: RegistryPipeSeam, pipeId: string): void {
  seam.detach(pipeId);
  seam.unadvertise(pipeId);
}

interface Shared {
  readonly serial: string;
  camera: Camera;
  refs: number;
  /** The advertised `camera:<serial>` pipe id, while leased. */
  pipeId?: string;
  closed: boolean; // native handle released (guards double-release)
}

/** A lease on one shared camera. Drop it with `release()` when done. */
export interface CameraLease {
  /** The shared native handle (property reads/writes act on the real camera). */
  readonly camera: Camera;
  /**
   * Run `mutate` (e.g. a pixel-format change) against the shared handle. Camera
   * frames flow through B's native `camera:<serial>` producer, not the JS loop,
   * so this is just a hook to mutate the shared camera safely; renderers/vision
   * workers read the
   * pipe and tolerate the transient.
   */
  reconfigure(mutate: () => void | Promise<void>): Promise<void>;
  /** Release this lease; the camera is closed when the last lease drops. */
  release(): void;
}

const shared = new Map<string, Shared>();
// Close promises not yet settled, tracked outside `shared` (which `closeShared`
// empties immediately) so `releaseAll` can await a close that started just
// before it was called — otherwise it can return while a native handle is
// still mid-release, and a renderer racing to open the same camera finds it
// still claimed.
const closing = new Set<Promise<void>>();
// Same pending closes keyed by serial: an activation that wants a serial whose
// old handle is still mid-release must wait for that release to settle before
// opening a NEW in-process handle — otherwise the fresh handle races the old
// one's acquisition stop and every config write bounces off TLParamsLocked
// with USB3Vision access-denied.
const closingBySerial = new Map<string, Promise<void>>();

/** Await any in-flight close of `serial`'s previous handle. */
async function awaitPendingClose(serial: string): Promise<void> {
  const pending = closingBySerial.get(serial);
  if (pending) await pending;
}

// Free the native camera handle (releasing the per-process device claim).
// Idempotent — safe if a lingering lease also releases later. No JS preview loop
// to stop: camera frames flow through B's native
// producer, torn down here via `retireCameraPipe`.
function closeShared(s: Shared): Promise<void> {
  if (s.closed) return Promise.resolve();
  s.closed = true;
  shared.delete(s.serial);
  // Detach B's native producer + un-advertise the pipe (renderer
  // consumers see CLOSED and disconnect).
  if (s.pipeId && pipeSeam) {
    retireCameraPipe(pipeSeam, s.pipeId);
    s.pipeId = undefined;
  }
  const p = Promise.resolve(s.camera.release());
  // Track until settled: `s` is already out of `shared` by the time this
  // resolves, so a `releaseAll` call that lands *after* this starts but
  // *before* it finishes would otherwise miss it entirely.
  closing.add(p);
  closingBySerial.set(s.serial, p);
  p.finally(() => {
    closing.delete(p);
    if (closingBySerial.get(s.serial) === p) closingBySerial.delete(s.serial);
  });
  return p;
}

/**
 * Force-release every camera the registry holds, awaiting the native handles to
 * close — including ones already mid-close from an earlier, unrelated release
 * (e.g. a lease dropped by a session's idle handler moments ago). Used to hand
 * devices back to a renderer module that still opens cameras directly
 * (non-migrated calibrate-* / manual-control): cameras are exclusive per OS
 * process, so the orchestrator must fully let go before the renderer can claim
 * them, not just have *started* letting go.
 */
export async function releaseAll(): Promise<void> {
  await Promise.all([...shared.values()].map(closeShared).concat([...closing]));
}

/**
 * Retry `attempt` with backoff until it returns a truthy result or the bounded
 * window elapses. Absorbs the renderer→orchestrator camera handoff race: a
 * camera mid-release by the *other* process briefly fails `arv_camera_new`
 * even though it becomes available again within a few seconds (Aravis/Camera
 * exclusivity is per OS process). At session activation, "not
 * available yet" and "not connected" are indistinguishable without waiting,
 * so every camera-owning activation should go through this instead of a
 * single `acquire()` attempt.
 */
export async function retryUntil<T>(
  attempt: () => Promise<T | null>,
  { timeoutMs = 5000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Promote a freshly-opened `Camera` into the registry as a new `Shared`
 *  entry (stored config applied). Shared by `acquire()`'s first-lease path
 *  and `acquireMany()`'s bulk-discovery path so both agree on setup. */
async function registerShared(camera: Camera): Promise<Shared> {
  // Crash backstop (spec disparity-scope §trigger-sync): a session that died
  // with this camera hardware-triggered must never strand the next one with a
  // frozen free-run feed — clear trigger mode best-effort on every fresh open.
  try {
    camera.clearTriggers();
  } catch {
    // trigger features unavailable — the camera is free-run already
  }
  await timeSpan("camera.applyStoredConfig", () => applyStoredConfig(camera), {
    serial: camera.serial,
  });
  // Unified time: clock calibration is owned by the native hardware-owner
  // THREAD (initial at device init + incremental drift) — NO JS latch driver
  // runs here: two latch drivers interleaving corrupt each other's
  // TimestampLatchValue reads, and the native mutex cannot see a JS-driven
  // executeFeature sequence. The JS registry fills from the owner's pushed
  // metrics (onClockMetrics callback slot).
  const s: Shared = {
    serial: camera.serial,
    camera,
    refs: 0,
    closed: false,
  };
  shared.set(camera.serial, s);
  // Advertise the `camera:<serial>` RGBA8 pipe + attach B's native
  // `CaptureSink` (produce-while-leased). Skipped when the seam
  // isn't wired (vitest / view-tap-only) — the JS vision path still works.
  if (pipeSeam) s.pipeId = advertiseCameraPipe(pipeSeam, camera);
  return s;
}

/**
 * Lease the camera with this serial, opening + applying its stored config on the
 * first lease. Returns `null` if the camera is not connected.
 */
export async function acquire(serial: string): Promise<CameraLease | null> {
  let s = shared.get(serial);
  if (!s) {
    // Disposable-orchestrator gate: defer opening the exclusive
    // device until main confirms the previous hardware instance released it.
    // No-op once cleared / while the gate is disarmed (unit tests).
    await awaitHardwareClear();
    await awaitPendingClose(serial);
    const { Camera } = await import("core/Aravis");
    const cameras = await timeSpan("camera.enumerate", () => Camera.list(), { serial });
    const camera = cameras.find((c) => c.serial === serial) ?? null;
    for (const c of cameras) if (c !== camera) c.release();
    if (!camera) return null;
    s = await registerShared(camera);
  }
  s.refs++;

  let released = false;
  const lease: CameraLease = {
    get camera() {
      return s!.camera;
    },
    async reconfigure(mutate) {
      // No JS preview loop to pause — mutate the shared
      // handle directly; B's native producer + pipe consumers ride the change.
      await mutate();
    },
    release() {
      if (released) return;
      released = true;
      if (--s!.refs > 0) return;
      void closeShared(s!);
    },
  };
  return lease;
}

/**
 * Lease every serial in `serials` that's connected, in at most one discovery
 * pass total — vs. calling `acquire()` per serial, which pays its
 * own `Camera.list()` for every not-yet-shared serial (up to N discovery+open
 * passes for N cameras). Used by activations that know in advance exactly
 * which cameras they want (e.g. a calibrated L/C/R triple). A serial with no
 * entry in the returned map was not connected.
 */
export async function acquireMany(
  serials: string[],
): Promise<Map<string, CameraLease>> {
  if (serials.some((serial) => !shared.has(serial))) {
    // Disposable-orchestrator gate — see `acquire`.
    await awaitHardwareClear();
    // Let any mid-release previous handles settle before reopening (see
    // `closingBySerial`) — an in-process reopen doesn't fail like a
    // cross-process one, it "succeeds" onto a still-locked device.
    await Promise.all(serials.map(awaitPendingClose));
    const wanted = new Set(serials);
    const { Camera } = await import("core/Aravis");
    const cameras = await timeSpan("camera.enumerate", () => Camera.list(), {
      wanted: serials.length,
    });
    for (const camera of cameras) {
      if (shared.has(camera.serial) || !wanted.has(camera.serial)) {
        camera.release();
        continue;
      }
      await registerShared(camera);
    }
  }
  const leased = new Map<string, CameraLease>();
  for (const serial of serials) {
    // Every wanted, connected serial is now in `shared` (either already, or
    // just registered above) — this hits `acquire()`'s fast path, no further
    // `Camera.list()` calls.
    const lease = await acquire(serial);
    if (lease) leased.set(serial, lease);
  }
  return leased;
}

/**
 * One pass: read every connected camera's stored role *without opening it*
 * (`cameraConfigPath` only needs vendor/model/serial), lease only
 * the L/C/R matches in one bulk discovery call (`acquireMany`), drop the
 * rest. Returns null (releasing any partial match) unless all three roles
 * are covered. Shared by every session that needs the calibrated triple —
 * wrap with `retryUntil(matchTriple)` at the call site, since a camera still
 * mid-release by another process is simply absent from `listCameraInfo()`
 * for a beat, not present-but-failing.
 */
export async function matchTriple(): Promise<Record<Role, CameraLease> | null> {
  const roleOf = new Map<string, Role>();
  for (const info of await listCameraInfo()) {
    const { role } = await read<{ role?: Role }>(cameraConfigPath(info), {});
    if (role === "L" || role === "C" || role === "R") roleOf.set(info.serial, role);
  }
  const leased = await acquireMany([...roleOf.keys()]);
  const matched: Partial<Record<Role, CameraLease>> = {};
  for (const [serial, role] of roleOf) {
    const lease = leased.get(serial);
    if (!lease) continue;
    if (!matched[role]) matched[role] = lease;
    else lease.release(); // two cameras stored with the same role
  }
  if (matched.L && matched.C && matched.R)
    return matched as Record<Role, CameraLease>;
  for (const l of Object.values(matched)) l?.release();
  return null;
}
