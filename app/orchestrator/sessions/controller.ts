// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Controller session. Wraps the orchestrator-owned serial controller behind the
// `controller` contract. Idle until `connect` is commanded; the title-bar
// `Controller.vue` (a thin client over this session) connects on mount and is
// the sole owner of the serial device.

import { defineSession, type ServerSession } from "../runtime.js";
import {
  Controller,
  activeController,
  setActiveController,
} from "../controller.js";
import { controllerNode } from "../controller-node.js";
import { report, timeSpan } from "../diagnostics.js";
import { pingControllerOffset, setCalibration } from "../time-align.js";
import { currentAppliedLookahead } from "../serial-latency.js";
import { awaitHardwareClear } from "../hardware-gate.js";
import { controller } from "@lib/orchestrator/contracts";

const NEUTRAL = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
const ZERO_RATE = {
  txBytesPerSec: 0,
  rxBytesPerSec: 0,
  txPacketsPerSec: 0,
  rxPacketsPerSec: 0,
};
const ZERO_PRESSURE = {
  effectiveRateHz: 0,
  ceilingHz: 0,
  governorState: "off" as const,
  outqBytes: 0,
  outqHighWater: 0,
  outqSupported: true,
  txSoftFail: 0,
  ackRttMs: { p50: 0, p95: 0, max: 0, count: 0, baselineP50: 0 },
  appliedLookaheadMs: null,
};
// Serial + per-stream probes — 2 Hz keeps wire cost to a few numbers x <=8
// streams.
const PROBE_INTERVAL_MS = 500;

export function controllerSession(): ServerSession<typeof controller> {
  return defineSession("controller", controller, (s) => {
    // The active device lives in the shared holder so control-loop sessions
    // actuate the same hardware; this session owns its connect/disconnect.
    const ctrl = () => activeController();

    function publish(): void {
      const c = ctrl();
      s.telemetry({
        connected: !!c?.connected,
        enabled: !!c?.enabled,
        // Fixed at connect (firmware version) — republished here so the
        // renderer can gate the "Recover mirror" button; false when idle.
        canRecoverMems: !!c?.v21Capable,
        dv: c?.dv ?? 0,
        pos: c?.pos ?? NEUTRAL,
      });
    }

    let probeTimer: ReturnType<typeof setInterval> | null = null;
    // One-shot unplug latch (reset per probe start) — the ping rejects every
    // 500 ms while unplugged; the banner must fire once, not spam.
    let unplugReported = false;
    let prevStats: { txBytes: number; rxBytes: number; txPackets: number; rxPackets: number } | null = null;

    function stopProbe(): void {
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
      prevStats = null;
      s.telemetry({
        serialRate: ZERO_RATE,
        serialPressure: ZERO_PRESSURE,
        streams: [],
        // An open trajectory survives a disconnect as `detached` — keep
        // reporting it so the renderer sees why MirrorLink stopped.
        trajectory: controllerNode().trajectorySnapshot(),
      });
    }

    function startProbe(): void {
      stopProbe();
      unplugReported = false;
      const dtSec = PROBE_INTERVAL_MS / 1000;
      probeTimer = setInterval(() => {
        const c = ctrl();
        if (!c) {
          stopProbe();
          return;
        }
        const cur = c.stats;
        const serialRate = prevStats
          ? {
              txBytesPerSec: (cur.txBytes - prevStats.txBytes) / dtSec,
              rxBytesPerSec: (cur.rxBytes - prevStats.rxBytes) / dtSec,
              txPacketsPerSec: (cur.txPackets - prevStats.txPackets) / dtSec,
              rxPacketsPerSec: (cur.rxPackets - prevStats.rxPackets) / dtSec,
            }
          : ZERO_RATE;
        prevStats = cur;
        // Serial PRESSURE block: the Device.stats sensors + governor mirror;
        // applied lookahead bridged from the disparity session.
        // Defensive over PARTIAL stats (test fakes / an older core build):
        // a missing pressure block degrades to zeros, never a throw — the
        // probe timer must survive any stats shape (observe, never gate).
        const serialPressure = {
          effectiveRateHz: cur.governor?.effectiveRateHz ?? 0,
          ceilingHz: cur.governor?.ceilingHz ?? 0,
          governorState: cur.governor?.state ?? ("off" as const),
          outqBytes: cur.outqBytes ?? 0,
          outqHighWater: cur.outqHighWater ?? 0,
          outqSupported: cur.outqSupported ?? true,
          txSoftFail: cur.txSoftFail ?? 0,
          ackRttMs: cur.ackRttMs ?? ZERO_PRESSURE.ackRttMs,
          appliedLookaheadMs: currentAppliedLookahead(),
        };
        // Re-read the LIVE connection state every probe tick — a USB unplug
        // flips `c.connected`, and nothing else re-publishes it, so without
        // this the title-bar indicator would stay green while the mirrors
        // silently stopped steering.
        s.telemetry({
          connected: !!c.connected,
          serialRate,
          serialPressure,
          streams: c.streamSnapshot(dtSec),
          trajectory: controllerNode().trajectorySnapshot(),
        });
        // PROBE PING: keep ackRttMs live even when no user traffic flows — the
        // device-loop-saturation proxy. A SYS_TIMESTAMP GET (the clock-ping
        // machinery) is NOT Actuate, so it coexists with an active stream. A
        // rejection is ALSO the unplug signal: when the device reports
        // disconnected, flip the telemetry + banner ONCE instead of discarding
        // the exact rejection that carries the news.
        void c.readTimestamp?.().catch(() => {
          if (!c.connected && !unplugReported) {
            unplugReported = true;
            s.telemetry({ connected: false, enabled: false });
            s.fail("Controller disconnected (USB unplugged?)");
          }
        });
      }, PROBE_INTERVAL_MS);
    }

    return {
      commands: {
        async connect() {
          if (ctrl()) return true;
          // Disposable-orchestrator gate: defer opening the exclusive
          // MEMS serial until main confirms the previous instance released it.
          await awaitHardwareClear();
          s.telemetry({ pending: true });
          try {
            return await timeSpan("controller.connect", async () => {
              const info = await Controller.match({
                vendorId: s.state.vendorId,
                productId: s.state.productId,
              });
              if (!info) return false;
              const c = new Controller(info);
              await c.ready;
              setActiveController(c);
              // Bind the device into the long-lived controller NODE (position
              // streams + trigger mode). Folds its `controller:<port>` serial
              // meter into the node's graph stats; streams recreate lazily.
              controllerNode().bindController(c);
              publish();
              startProbe();
              // Unified time: MCU↔host clock calibration via
              // the v1.1 System.Timestamp ping — fire-and-forget, RACED
              // against a deadline because pre-v1.1 firmware REJects the
              // unknown property with seq 0 (dropped) and the read would
              // hang to Device teardown instead of rejecting.
              void (async () => {
                try {
                  const cal = await Promise.race([
                    pingControllerOffset(() => c.readTimestamp()),
                    new Promise<null>((r) => setTimeout(() => r(null), 3000)),
                  ]);
                  if (cal) {
                    setCalibration("controller", cal);
                    // Owner-applied dt: every FIN timestamp the
                    // controller surfaces from here on is trusted host-ns.
                    c.setClockOffsetNs(cal.offsetNs);
                  } else
                    report(
                      "time-align",
                      "controller: timestamp ping timed out (pre-v1.1 firmware?) — clock UNCALIBRATED",
                    );
                } catch (e) {
                  report("time-align", `controller: clock calibration failed: ${(e as Error).message}`);
                }
              })();
              return true;
            });
          } finally {
            s.telemetry({ pending: false });
          }
        },
        async disconnect() {
          const c = ctrl();
          setActiveController(null);
          // Unbind from the node FIRST (drops MCU streams, stops the v1 loop) so
          // the disable-on-disconnect below is the sole quiescence path — the
          // node never bypasses it (hardware-quiescence invariant).
          await controllerNode().unbindController();
          try {
            // Never hand back an energized mirror driver: releasing the port
            // leaves the firmware's Enable state untouched (hardware-safety
            // invariant).
            if (c?.connected && c.enabled) await c.disable();
          } catch (e) {
            // A failed disable-on-disconnect is a safety-relevant event —
            // surface it in the renderer error tray, not just an unwatched
            // console.
            report("controller", `disable-on-disconnect failed: ${(e as Error).message}`);
          }
          c?.release();
          stopProbe();
          publish();
        },
        async enable() {
          await ctrl()?.enable();
          publish();
        },
        async disable() {
          await ctrl()?.disable();
          publish();
        },
        async recoverMems() {
          const c = ctrl();
          if (!c) throw new Error("Controller not connected");
          // Propagates the firmware ACK/REJ to the caller (the renderer
          // surfaces failure in the error tray).
          await c.recoverMems();
        },
        async actuate(arg) {
          const c = ctrl();
          if (!c) throw new Error("Controller not connected");
          const res = await c.actuate(arg, arg.settleTime);
          s.telemetry({ pos: { left: res.left, right: res.right } });
          return res;
        },
        async trigger(ns) {
          await ctrl()?.trigger(ns);
        },
        async setBias(v) {
          return (await ctrl()?.setBias(v)) ?? 0;
        },
        async setLPF(v) {
          await ctrl()?.setLPF(v);
          return v;
        },
      },
    };
  });
}
