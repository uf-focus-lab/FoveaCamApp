// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// manage-cameras session. Opens every connected camera, polls a live property
// snapshot (~1 Hz) into telemetry, and applies edits + the pixel-format
// reconfigure flow as commands, persisting to the shared config store.
//
// Fovea Pair: while exactly one camera holds role L and one holds role R,
// telemetry carries a `pair` link and the `setPair`/`setPairPixelFormat`
// commands apply one edit to BOTH cameras (each through its own writer /
// reconfigure flow), persisting into BOTH cameras' existing config docs — no
// separate pair doc, so calibration and every other config reader stay
// untouched. A divergent pair is edit-locked until `unifyPair` copies one
// side's config onto the other (the explicit user choice).
//
// Control edits (`set`) arrive per renderer input event — per MOUSEMOVE during
// a slider drag — so they go through a per-camera `CoalescedWriter`: one
// native write in flight per camera, intermediates dropped (final value always
// lands), store persistence debounced 300 ms trailing, and only the written
// control read back and patched into the last published snapshot. The full
// every-camera snapshot (`publishViews`) stays on the 1 Hz poll + structural
// events (refresh, setPixelFormat, reset, role change).

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { cameraConfigPath, cameraInfo, listCameraInfo } from "@orchestrator/camera";
import {
  acquire,
  acquireMany,
  retryUntil,
  type CameraLease,
} from "@orchestrator/registry";
import { read, update, write } from "@orchestrator/store-hub";
import { report } from "@orchestrator/diagnostics";
import {
  disableHardwareTrigger,
  enableHardwareTrigger,
  enableSoftwareTrigger,
} from "@orchestrator/camera-trigger";
import { activeController } from "@orchestrator/controller";
import { nativeProbes } from "@orchestrator/native-probes";
import { nodeId } from "@lib/orchestrator/graph-contract";
import { firstErrorLine } from "@lib/trigger-sync";
import {
  CAMERA_CONTROLS,
  PAIR_LINKED_CONTROLS,
  describeCamera,
  pairDivergence,
  pairTriggerBudget,
  readControlFields,
  readControlPatch,
} from "@lib/camera-config";
import { CoalescedWriter } from "@lib/coalesced-writer";
import {
  manageCameras,
  type CameraView,
  type FoveaPairView,
  type TriggerTestResult,
  type TriggerTestVerdict,
} from "./contract";
import type { CameraInfo } from "@lib/orchestrator/contracts";
import type { Camera } from "core/Aravis";

/** Read a possibly-unavailable camera getter without throwing. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

type Entry = {
  lease: CameraLease;
  serial: string;
  role?: string;
  writer: CoalescedWriter;
};

export default function manageCamerasSession(): ServerSession<typeof manageCameras> {
  return defineSession("manage-cameras", manageCameras, (s) => {
    const entries = new Map<string, Entry>();
    let poll: ReturnType<typeof setInterval> | null = null;
    let views: Record<string, CameraView> = {};
    /** In-flight trigger self-test — `testTrigger` re-entrancy latch. */
    let triggerTestRun: Promise<void> | null = null;

    function readView(e: Entry): CameraView {
      const c = e.lease.camera;
      return {
        // MUST guard every native-handle read: a camera can be force-released
        // mid-poll, and an unguarded read on a released CoreObject throws
        // uncaught inside `setInterval` → orchestrator crash.
        description: safe(() => describeCamera(c), "Camera Not Connected"),
        role: e.role as CameraView["role"],
        pixel_format: safe(() => c.pixel_format, ""),
        pixel_format_options: safe(() => c.pixel_format_options, []),
        ...readControlFields(c as unknown as Record<string, any>, safe),
      };
    }

    // The L/R fovea-pair link: exactly one camera per role, both views
    // present. Duplicate role claims break the link (which serial would the
    // pair edit?) until the user resolves the roles.
    function pairEntries(): { left: Entry; right: Entry } | null {
      const byRole: Record<"L" | "R", Entry[]> = { L: [], R: [] };
      for (const e of entries.values())
        if (e.role === "L" || e.role === "R") byRole[e.role].push(e);
      if (byRole.L.length !== 1 || byRole.R.length !== 1) return null;
      return { left: byRole.L[0], right: byRole.R[0] };
    }

    /** The one camera holding the Wide Angle (C) role, or null when none or
     *  several do — the trigger self-test's optional center leg. */
    function centerEntry(): Entry | null {
      let found: Entry | null = null;
      for (const e of entries.values())
        if (e.role === "C") {
          if (found) return null;
          found = e;
        }
      return found;
    }

    /** Why the pair link is BLOCKED despite fovea roles being claimed — the
     *  duplicate-role case must be actionable in the UI, not a silent
     *  panel-vanish. Null = linked or simply unclaimed. */
    function pairBlockReason(): string | null {
      const byRole: Record<"L" | "R", number> = { L: 0, R: 0 };
      for (const e of entries.values())
        if (e.role === "L" || e.role === "R") byRole[e.role]++;
      if (byRole.L > 1)
        return "Two cameras claim Fovea Left — resolve Roles to link the pair.";
      if (byRole.R > 1)
        return "Two cameras claim Fovea Right — resolve Roles to link the pair.";
      return null;
    }

    function pairView(): FoveaPairView | null {
      const pair = pairEntries();
      if (!pair) return null;
      const l = views[pair.left.serial];
      const r = views[pair.right.serial];
      if (!l || !r) return null;
      // Budget without settle (per-triple, added by the tracking apps).
      const budget = pairTriggerBudget({
        exposureUsL: l.exposure,
        exposureUsR: r.exposure,
        maxRateHzL: l.frame_rate_range.max,
        maxRateHzR: r.frame_rate_range.max,
      });
      return {
        left: pair.left.serial,
        right: pair.right.serial,
        divergent: pairDivergence(l, r),
        budget: { ...budget, exposureUsL: l.exposure, exposureUsR: r.exposure },
      };
    }

    function publishViews(): void {
      const next: Record<string, CameraView> = {};
      for (const [serial, e] of entries) {
        // Defense in depth: one bad entry drops from this tick instead of
        // killing the poll for every other camera.
        try {
          next[serial] = readView(e);
        } catch (err) {
          report(
            "manage-cameras",
            `readView ${serial}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      views = next;
      s.telemetry({ views, pair: gatedPair(false), pair_blocked: pairBlockReason() });
    }

    /** Last divergence list actually published. `setPair` writes land on the
     *  two cameras in separate microtasks, so a patch-path recompute between
     *  the two read-backs sees a HALF-APPLIED pair — publishing that flashes
     *  the unify prompt mid-drag and unmounts the slider being dragged. New
     *  divergence therefore surfaces only via the 1 Hz poll /
     *  structural publishes; the patch path may only CLEAR or carry it. */
    let publishedDivergent: string[] = [];
    function gatedPair(patch: boolean): FoveaPairView | null {
      const p = pairView();
      if (!p) {
        publishedDivergent = [];
        return p;
      }
      if (patch && publishedDivergent.length === 0 && p.divergent.length > 0)
        return { ...p, divergent: [] };
      publishedDivergent = p.divergent;
      return p;
    }

    // Targeted read-back after one control write: re-read only that control's
    // field family on that camera and patch it into the last snapshot — never
    // a full every-camera poll per slider tick.
    function patchView(serial: string, camera: Camera, key: string): void {
      const patch = readControlPatch(camera as unknown as Record<string, any>, key, safe);
      const view = views[serial];
      if (!patch || !view) return publishViews();
      views[serial] = { ...view, ...patch };
      // Pair rides along: divergence (gated) + the exposure-derived budget
      // both move with single-control edits.
      s.telemetry({ views, pair: gatedPair(true) });
    }

    async function registerEntry(serial: string, lease: CameraLease): Promise<void> {
      const camera = lease.camera;
      const configPath = cameraConfigPath(camera);
      const config = await read<{ role?: string }>(configPath, {});
      const writer = new CoalescedWriter({
        write: (key, value) => {
          // Inputs send correctly-typed values — assign straight through; a
          // throw means the camera refused it (never persisted).
          (camera as any)[key] = value;
        },
        onResult: (key, _value, error) => {
          if (error) console.error(`[manage-cameras] set ${key}:`, error);
          // Publish the read-back truth either way — on rejection this also
          // replaces the renderer's optimistic echo with the camera's value.
          patchView(serial, camera, key);
        },
        // configPath captured above: persistence must not touch the native
        // handle (flushes can outlive the lease).
        persist: (key, value) => update(configPath, { [key]: value }),
        onPersistError: (key, _value, err) =>
          report(
            "manage-cameras",
            `persist ${key}: ${err instanceof Error ? err.message : err}`,
          ),
      });
      entries.set(serial, { lease, serial, role: config.role, writer });
      // The raw preview rides the `camera:<serial>` native pipe (renderer usePipeFrame).
    }

    async function openCamera(serial: string): Promise<void> {
      // Retry with backoff — a failure here is a still-settling handoff race,
      // not an absent camera (it was just listed).
      const lease = await retryUntil(() => acquire(serial));
      if (lease) await registerEntry(serial, lease);
      // Can't lease a just-listed camera → held by another process; surface it.
      else s.fail(`Camera ${serial} is in use by another process.`);
    }

    function closeEntry(serial: string): void {
      const e = entries.get(serial);
      if (!e) return;
      // Drop queued writes, flush the debounced persists (store-only — safe
      // after release thanks to the captured config path).
      void e.writer.dispose();
      e.lease.release();
      entries.delete(serial);
    }

    const persist = (camera: Camera, patch: Record<string, unknown>) =>
      update(cameraConfigPath(camera), patch);

    async function applyPixelFormat(e: Entry, format: string): Promise<void> {
      const c = e.lease.camera;
      if (format === safe(() => c.pixel_format, format)) return;
      // `reconfigure` stops the shared loop before the mutate and restarts it
      // after (fresh buffer for the new payload size); retry the set to
      // absorb the cross-thread acquisition stop.
      await e.lease.reconfigure(async () => {
        let lastErr: unknown = null;
        for (let i = 0; i < 30; i++) {
          try {
            c.pixel_format = format as typeof c.pixel_format;
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        if (lastErr) console.error("[manage-cameras] set pixel format:", lastErr);
        else await persist(c, { pixel_format: format });
      });
    }

    async function refresh(): Promise<CameraInfo[]> {
      // Clear any prior contention error; a still-contended camera re-raises it.
      s.clearError();
      const found = await listCameraInfo();
      const present = new Set(found.map((c) => c.serial));
      const toOpen = found.map((c) => c.serial).filter((s) => !entries.has(s));
      if (toOpen.length > 0) {
        // One bulk discovery pass for the new cameras; per-serial retry only for
        // whichever ones a handoff race dropped.
        const leased = await acquireMany(toOpen);
        for (const [serial, lease] of leased) await registerEntry(serial, lease);
        for (const serial of toOpen)
          if (!entries.has(serial)) await openCamera(serial);
      }
      for (const serial of [...entries.keys()])
        if (!present.has(serial)) closeEntry(serial);
      const list = [...entries.values()].map((e) => cameraInfo(e.lease.camera));
      s.telemetry({ list });
      publishViews();
      poll ??= setInterval(publishViews, 1000);
      return list;
    }

    // --- Trigger self-test (§Trigger test) ------------------------------------
    // Frame-arrival probe: the camera's convert-pipe producer exposes a native
    // meter whose output `count` is MONOTONIC since producer start (same schema
    // as every JS workload — cumulative, never windowed), so a before/after diff
    // isolates a single triggered frame. Chosen over a temporary pipe consumer:
    // no new SHM consumer/ArrayBuffer, no new lease — manage-cameras already
    // leases the camera and its producer is already running.
    /** Null = the probe row is absent (producer parked/detached) — the test
     *  cannot observe frames and must verdict "unavailable", never "fail". */
    function producedFrames(serial: string): number | null {
      const probe = nativeProbes()[nodeId.convert(serial)];
      if (!probe) return null;
      let total = 0;
      for (const stat of Object.values(probe.outputs ?? {})) total += stat.count ?? 0;
      return total;
    }

    const FRAME_POLL_MS = 50;
    const BASELINE_STABLE_MS = 200;
    const BASELINE_WAIT_MS = 500;

    /** Post-flip baseline: frames exposed BEFORE the trigger flip can still be
     *  in readout/transfer/convert and land after it — crediting a dead trigger
     *  line with "ok". Wait for the counter to hold still ~200 ms (bounded
     *  ~500 ms total) before trusting it. */
    async function settledBaseline(serial: string): Promise<number | null> {
      const deadline = Date.now() + BASELINE_WAIT_MS;
      let last = producedFrames(serial);
      if (last === null) return null;
      let heldSince = Date.now();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, FRAME_POLL_MS));
        const cur = producedFrames(serial);
        if (cur === null) return null;
        if (cur !== last) {
          last = cur;
          heldSince = Date.now();
        } else if (Date.now() - heldSince >= BASELINE_STABLE_MS) break;
      }
      return last;
    }

    /** Settle the baseline, fire, then wait for one NEW producer frame —
     *  ≥1 s, scaled so a long exposure (≥~900 ms) can still deliver in time. */
    async function awaitTriggeredFrame(
      serial: string,
      exposureUs: number,
      fire: () => unknown,
    ): Promise<"ok" | "fail" | "unavailable"> {
      const baseline = await settledBaseline(serial);
      if (baseline === null) return "unavailable";
      await fire();
      const deadline = Date.now() + Math.max(1000, (exposureUs / 1000) * 2 + 500);
      while (Date.now() < deadline) {
        const cur = producedFrames(serial);
        if (cur !== null && cur > baseline) return "ok";
        await new Promise((r) => setTimeout(r, FRAME_POLL_MS));
      }
      return "fail";
    }

    /** A camera stuck in trigger mode is the frozen-preview failure class:
     *  retry the disable once, then report at ERROR naming the consequence. */
    async function restoreFreeRun(e: Entry): Promise<void> {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await disableHardwareTrigger(e.lease);
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      report(
        "trigger-test",
        `${e.serial} may be stuck in trigger mode — preview frozen; ` +
          `reset the camera or power-cycle (${firstErrorLine(lastErr, 120)})`,
        "error",
      );
    }

    /** Self-test one camera — software leg always, hardware leg iff a controller
     *  is connected. Restores free-run COMPLETELY after each leg, even on throw. */
    async function testTriggerCamera(e: Entry): Promise<TriggerTestVerdict> {
      const { camera } = e.lease;
      const verdict: TriggerTestVerdict = { sw: "skipped", hw: "no-controller" };
      const exposureUs = safe(() => camera.exposure, 0);
      // SOFTWARE leg: camera → convert-pipe path, no wiring involved.
      try {
        await enableSoftwareTrigger(e.lease);
        verdict.sw = await awaitTriggeredFrame(e.serial, exposureUs, () =>
          camera.softwareTrigger(),
        );
      } catch (err) {
        report(
          "trigger-test",
          `${e.serial} software leg: ${err instanceof Error ? err.message : err}`,
          "warning",
        );
        verdict.sw = "fail";
      } finally {
        await restoreFreeRun(e);
      }
      // HARDWARE leg: one real MCU pulse on camera Line3, only if a controller
      // is up (CMD_TRIGGER pulses every camera's trigger line, C included).
      // A dead probe means neither leg can observe frames — same verdict.
      const controller = activeController();
      if (verdict.sw === "unavailable") verdict.hw = "unavailable";
      else if (controller?.connected) {
        try {
          await enableHardwareTrigger(e.lease); // Line3 in / Line2 ExposureActive
          // CMD_TRIGGER duration is MICROSECONDS on the wire (verified: firmware
          // `Trigger.duration` is Microseconds; `Controller.trigger` forwards it
          // verbatim — NEVER ×1000). Cover the exposure, 5 ms floor for a clean
          // rising edge.
          const pulseUs = Math.round(Math.max(exposureUs, 5000));
          verdict.hw = await awaitTriggeredFrame(e.serial, exposureUs, () =>
            controller.trigger(pulseUs),
          );
        } catch (err) {
          report(
            "trigger-test",
            `${e.serial} hardware leg: ${err instanceof Error ? err.message : err}`,
            "warning",
          );
          verdict.hw = "fail";
        } finally {
          await restoreFreeRun(e);
        }
      }
      return verdict;
    }

    /** Warn (with the interpretation) on any failing side. */
    function reportTriggerTestFailures(r: TriggerTestResult): void {
      const interpret = (v: TriggerTestVerdict): string | null =>
        v.sw === "fail"
          ? "camera/stream path (software trigger produced no frame)"
          : v.hw === "fail"
            ? "trigger wiring (software ok, hardware pulse produced no frame)"
            : null;
      const parts: string[] = [];
      for (const side of ["L", "R", "C"] as const) {
        const v = r[side];
        const msg = v ? interpret(v) : null;
        if (msg) parts.push(`${side}: ${msg}`);
      }
      if (parts.length)
        report("trigger-test", `Trigger self-test — ${parts.join("; ")}.`, "warning");
    }

    return {
      commands: {
        refresh,
        async set({ serial, key, value }) {
          const e = entries.get(serial);
          if (!e) return;
          if (key === "role") {
            e.role = value as string | undefined;
            await persist(e.lease.camera, { role: value });
            publishViews();
            return;
          }
          // Fire-and-forget into the per-camera coalescer: per-mousemove
          // writes must not each block on a native write + store persist +
          // full snapshot re-read.
          e.writer.submit(key, value);
        },
        async setPixelFormat({ serial, format }) {
          const e = entries.get(serial);
          if (!e) return;
          await applyPixelFormat(e, format);
          publishViews();
        },
        // --- Fovea Pair — one panel, both cameras, atomically ----------
        async setPair({ key, value }) {
          const pair = pairEntries();
          if (!pair) return;
          // Never converge-by-overwrite: a divergent pair edits only through
          // the explicit unify choice. Keyed off the PUBLISHED divergence (the
          // one the UI shows) — a raw recompute here races the two read-backs
          // of the PREVIOUS setPair and would refuse legit mid-drag writes.
          if (publishedDivergent.length) return;
          pair.left.writer.submit(key, value);
          pair.right.writer.submit(key, value);
        },
        async setPairPixelFormat({ format }) {
          const pair = pairEntries();
          if (!pair) return;
          // Sequential on purpose: each reconfigure stops/restarts that
          // camera's shared acquisition loop — never overlap the two.
          await applyPixelFormat(pair.left, format);
          await applyPixelFormat(pair.right, format);
          publishViews();
        },
        async unifyPair({ source }) {
          const pair = pairEntries();
          if (!pair) return;
          const from =
            source === pair.left.serial
              ? pair.left
              : source === pair.right.serial
                ? pair.right
                : null;
          if (!from) return;
          const to = from === pair.left ? pair.right : pair.left;
          const src = from.lease.camera as unknown as Record<string, any>;
          const dst = to.lease.camera as unknown as Record<string, any>;
          // A queued drag value (or its debounced persist) on the target must
          // not land on top of the unify.
          to.writer.clear();
          const patch: Record<string, unknown> = {};
          for (const ctrl of PAIR_LINKED_CONTROLS) {
            // Per-control guard: one refused write skips that control, the
            // rest of the unify still lands.
            try {
              if (!src[ctrl.availableKey] || !dst[ctrl.availableKey]) continue;
              if (ctrl.autoKey && (!ctrl.autoAvailableKey || dst[ctrl.autoAvailableKey])) {
                dst[ctrl.autoKey] = src[ctrl.autoKey];
                patch[ctrl.autoKey] = src[ctrl.autoKey];
              }
              if (!ctrl.autoKey || src[ctrl.autoKey] === "Off") {
                dst[ctrl.key] = src[ctrl.key];
                // Persist the read-back truth — the camera may clamp/quantize.
                patch[ctrl.key] = dst[ctrl.key];
              }
            } catch (err) {
              report(
                "manage-cameras",
                `unifyPair ${ctrl.key}: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
          await persist(to.lease.camera, patch);
          const format = safe(() => from.lease.camera.pixel_format, "");
          if (format) await applyPixelFormat(to, format);
          publishViews();
        },
        async testTrigger() {
          // Server-side in-flight latch (the renderer's `testing` ref is
          // per-window): a second call rides the running test.
          triggerTestRun ??= (async () => {
            try {
              const pair = pairEntries();
              if (!pair) return;
              // Sequential (never overlap two reconfigure flows / triggers).
              const L = await testTriggerCamera(pair.left);
              const R = await testTriggerCamera(pair.right);
              // Center leg iff a Wide Angle camera is assigned (V0.1 cables it).
              const center = centerEntry();
              const C = center ? await testTriggerCamera(center) : undefined;
              const result: TriggerTestResult = { at: Date.now(), L, R, ...(C && { C }) };
              s.telemetry({ trigger_test: result });
              reportTriggerTestFailures(result);
            } finally {
              triggerTestRun = null;
            }
          })();
          return triggerTestRun;
        },
        async reset({ serial }) {
          const e = entries.get(serial);
          if (!e) return;
          const c = e.lease.camera;
          const cam = c as unknown as Record<string, any>;
          // A queued drag value (or its debounced persist) must not land on
          // top of the reset.
          e.writer.clear();
          try {
            // Schema-driven reset: frame rate to auto (enable off), each auto
            // control to a one-shot "Once", black level only when available.
            for (const ctrl of CAMERA_CONTROLS) {
              if (ctrl.enableKey) cam[ctrl.enableKey] = false;
              if (ctrl.autoKey) {
                if (ctrl.autoAvailableKey && !cam[ctrl.autoAvailableKey]) continue;
                cam[ctrl.autoKey] = "Once";
              }
            }
          } catch (err) {
            console.error("[manage-cameras] reset:", err);
          }
          e.role = undefined;
          await write(cameraConfigPath(c), {});
          publishViews();
        },
      },
      // Idle: stop the poll + release every camera; a later `refresh` re-opens.
      idle() {
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        for (const serial of [...entries.keys()]) closeEntry(serial);
        s.telemetry({ trigger_test: null }); // stale verdicts don't outlive the session
      },
    };
  });
}
