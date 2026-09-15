// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-session vision worker entry (its own electron build entry, spawned by
// vision-worker-host.ts): the session-agnostic host owning SHM I/O (reader addon),
// framing, and the MessagePort transport; the pixel work is a VisionKernel dispatched by
// params.kind. READ-ONLY SHM (reader.open only, never touches the broker/gate); one frame
// at a time, awaited sequentially, so a kernel step is naturally non-reentrant.
// spec: docs/spec/vision.md#vision-worker

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { makeMat } from "@lib/mat";
import type { Mat } from "core/Vision";
import type { KernelFactory, VisionKernel, FrameSet } from "./vision-kernel.js";
import type {
  DerivedFrame,
  PipeInput,
  VisionInit,
  VisionResult,
  VisionWorkerIn,
} from "./vision-worker-protocol.js";
import { createTemplateMatchKernel } from "./template-match-kernel.js";
import { createDisplayKernel } from "./display-kernel.js";
import { createRingKernel } from "./ring-kernel.js";
import { createSpotKernel } from "./spot-kernel.js";
import { createDistortionKernel } from "@modules/calibrate-distortion/vision";
import { createCheckerKernel } from "@modules/calibrate-intrinsic/vision";

/** Kernel registry — keyed by `params.kind`. `template-match` is the generic
 *  needle-into-haystack correlator (disparity-scope spawns two); `display`
 *  serves manual-control + multi-fovea (center only); `distortion`/`checker`
 *  serve the calibrate apps; `ring` reads mirror-link's optical ring code and
 *  `spot` measures its emitter for the auto-align servo. */
const KERNELS: Record<string, KernelFactory> = {
  "template-match": createTemplateMatchKernel,
  display: createDisplayKernel,
  distortion: createDistortionKernel,
  checker: createCheckerKernel,
  ring: createRingKernel,
  spot: createSpotKernel,
};

/** Idle backoff when no pipe produced a new frame (yield-loop, ~1-3ms). */
const BACKOFF_MS = 2;

const requireHere = createRequire(import.meta.url);
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The reader addon's JS surface (see core/reader/ShmReaderAddon.cpp). */
interface ReaderAddon {
  open(name: string): unknown;
  readInto(
    handle: unknown,
    dst: ArrayBufferView,
    lastSeq: bigint,
  ):
    | null
    | { closed: true }
    | {
        seq: bigint;
        gen: number;
        width: number;
        height: number;
        originX: number; // v4: frame-bound crop origin (0/0 = uncropped)
        originY: number;
        meta: { deviceTimestamp?: bigint; systemTimestamp?: bigint };
      };
  close(handle: unknown): void;
}

type OpenPipe = {
  input: PipeInput;
  handle: unknown;
  buffer: Uint8Array;
  lastSeq: bigint;
};

const port = parentPort;
if (!port) throw new Error("vision-worker must run as a worker_thread");

let running = false;
let kernel: VisionKernel | null = null;
// TEMP size-trace (debug — remove): the kernel kind (gates the runtime frame
// trace to the disparity template-match worker) + a first-sight/on-change cache.
let traceKind = "";
const __sizeTraceSeen = new Map<string, string>();
function __sizeTrace(key: string, line: string): void {
  if (__sizeTraceSeen.get(key) === line) return;
  __sizeTraceSeen.set(key, line);
  console.log(`[size-trace] ${line}`);
}
let addon: ReaderAddon | null = null;
let pipes: OpenPipe[] = [];

// --- self-meter (VisionInit.meterName) -------------------------------------
// Kernel busy time, per-role input counts, latest-wins SKIPS as drops (ring
// seq gaps = frames the kernel never saw), result rate + max result gap.
// Cumulative counts; rates/utilization are per-report-interval deltas.
const STATS_INTERVAL_MS = 1000;
let meterName: string | null = null;
const meter = {
  startedAt: 0,
  busyMs: 0,
  inputs: new Map<string, number>(),
  dropsTotal: 0,
  results: 0,
  // per-interval baselines
  lastReportAt: 0,
  lastBusyMs: 0,
  lastInputs: new Map<string, number>(),
  lastDrops: 0,
  lastResults: 0,
  lastResultAt: 0,
  maxResultGapMs: 0,
};

function reportStats(now: number): void {
  if (!meterName || now - meter.lastReportAt < STATS_INTERVAL_MS) return;
  const dt = (now - meter.lastReportAt) / 1000;
  const inputs: Record<string, { count: number; ratePerSec: number }> = {};
  for (const [role, count] of meter.inputs) {
    inputs[role] = {
      count,
      ratePerSec: (count - (meter.lastInputs.get(role) ?? 0)) / dt,
    };
    meter.lastInputs.set(role, count);
  }
  port!.postMessage({
    kind: "stats",
    workload: {
      name: meterName,
      window: { startedAt: meter.startedAt, snapshotAt: now, uptimeMs: now - meter.startedAt },
      utilization: Math.min(1, (meter.busyMs - meter.lastBusyMs) / (now - meter.lastReportAt)),
      busyMs: meter.busyMs,
      inputs,
      outputs: {
        result: {
          count: meter.results,
          ratePerSec: (meter.results - meter.lastResults) / dt,
          maxIntervalMs: meter.maxResultGapMs,
        },
      },
      drops: {
        total: meter.dropsTotal,
        ratePerSec: (meter.dropsTotal - meter.lastDrops) / dt,
        byReason: {},
      },
    },
  });
  meter.lastReportAt = now;
  meter.lastBusyMs = meter.busyMs;
  meter.lastDrops = meter.dropsTotal;
  meter.lastResults = meter.results;
  meter.maxResultGapMs = 0;
}

function fail(message: string): void {
  port!.postMessage({ kind: "error", message });
}

function start(init: VisionInit): void {
  try {
    addon = requireHere(init.readerPath) as ReaderAddon;
  } catch (e) {
    fail(`reader addon load failed: ${(e as Error).message}`);
    return;
  }
  const kind = String((init.params as { kind?: unknown }).kind ?? "");
  traceKind = kind; // TEMP size-trace (debug — remove)
  const factory = KERNELS[kind];
  if (!factory) {
    fail(`unknown vision kernel: ${kind}`);
    return;
  }
  // TEMP size-trace (debug — remove): pass meterName in so the kernel can label
  // its matchTemplate trace per side (win/disparity-scope/match/L|R). Unknown
  // params are ignored by every kernel's setParams.
  kernel = factory({ ...init.params, __traceMeter: init.meterName });
  pipes = init.pipes.map((input) => ({
    input,
    handle: addon!.open(input.shmName),
    buffer: new Uint8Array(input.bytesPerFrame),
    lastSeq: 0n,
  }));
  meterName = init.meterName ?? null;
  meter.startedAt = meter.lastReportAt = Date.now();
  running = true;
  void pump();
}

/** Read every pipe once; return the frames new since last tick (latest-wins). */
function readFrames(): FrameSet | "closed" {
  const frames: FrameSet = {};
  for (const pipe of pipes) {
    const r = addon!.readInto(pipe.handle, pipe.buffer, pipe.lastSeq);
    if (r === null) continue;
    if ("closed" in r) return "closed";
    // Meter: consumed one frame; seq gaps = frames latest-wins skipped while
    // the kernel was busy (the throughput-loss signal for a kernel-bound app).
    const role = pipe.input.role;
    meter.inputs.set(role, (meter.inputs.get(role) ?? 0) + 1);
    if (pipe.lastSeq > 0n && r.seq > pipe.lastSeq + 1n)
      meter.dropsTotal += Number(r.seq - pipe.lastSeq - 1n);
    pipe.lastSeq = r.seq;
    const len = r.width * r.height * pipe.input.channels;
    // TEMP size-trace (debug — remove): the RUNTIME frame arriving at the match
    // worker per role (needle / haystack) — origin excluded (it moves with the
    // crop; only size changes reprint). Gated to the disparity template-match.
    if (traceKind === "template-match") {
      const ch = pipe.input.channels;
      __sizeTrace(
        `read/${meterName}/${role}`,
        `worker-in[${meterName}] ${role} ${r.width}x${r.height} ch=${ch} stride=${r.width * ch}`,
      );
    }
    const view = new Uint8Array(pipe.buffer.buffer, pipe.buffer.byteOffset, len);
    frames[pipe.input.role] = {
      mat: makeMat(view, [r.height, r.width], pipe.input.channels),
      seq: Number(r.seq),
      originX: r.originX,
      originY: r.originY,
      deviceTimestamp: r.meta.deviceTimestamp !== undefined ? Number(r.meta.deviceTimestamp) : undefined,
    };
  }
  return frames;
}

// OWNERSHIP RULE for postResult's zero-copy transfer: every frame a kernel
// emits is a FRESH Vision-call output (slice/diff/heatmap/wrapPerspective/cvtColor —
// audited across all four kernels), uniquely owned by this worker and never a
// view over a reused pipe read buffer. On the electron (V8_MEMORY_CAGE) build
// those are ordinary process-owned ArrayBuffers → transfer them directly. On
// a plain-node run (vitest) the non-cage Mat converter returns EXTERNALIZED
// (native-owned) ArrayBuffers, which postMessage cannot detach — keep the
// copying fallback there. The alias/shape guards below keep the rule safe if
// a future kernel ever emits a passthrough view.
const canTransferNative = !!process.versions.electron;

/** Post kernel output frames: zero-copy transfer where ownership is provable
 *  (see rule above), copying fallback otherwise. */
function postResult(values: Record<string, unknown>, mats: { name: string; mat: Mat<Uint8Array> }[]): void {
  const transfer: ArrayBuffer[] = [];
  const derived: DerivedFrame[] = mats.map(({ name, mat }) => {
    const [h = 0, w = 0] = mat.shape;
    // Direct transfer requires: electron (cage) build, the mat spans its
    // WHOLE buffer (consumers assume offset 0), the buffer is not a reused
    // pipe read buffer, and it isn't already queued for transfer (two mats
    // sharing one buffer must fall back to a copy for the second).
    const whole = mat.byteOffset === 0 && mat.byteLength === mat.buffer.byteLength;
    const aliasesRead = pipes.some((p) => p.buffer.buffer === mat.buffer);
    const owned =
      canTransferNative && whole && !aliasesRead &&
      !transfer.includes(mat.buffer as ArrayBuffer);
    const buffer = owned
      ? (mat.buffer as ArrayBuffer)
      : (mat.buffer.slice(mat.byteOffset, mat.byteOffset + mat.byteLength) as ArrayBuffer);
    transfer.push(buffer);
    return { name, buffer, width: w, height: h, channels: mat.channels };
  });
  const msg: VisionResult = {
    kind: "result",
    seq: typeof values.seq === "number" ? values.seq : undefined,
    deviceTimestamp: typeof values.deviceTimestamp === "number" ? values.deviceTimestamp : undefined,
    values,
    frames: derived,
  };
  port!.postMessage(msg, transfer);
}

async function pump(): Promise<void> {
  while (running) {
    let read: FrameSet | "closed";
    try {
      read = readFrames();
    } catch (e) {
      fail(`read failed: ${(e as Error).message}`);
      break;
    }
    if (read === "closed") break;
    const hasFrame = Object.keys(read).length > 0;
    if (hasFrame && kernel) {
      try {
        const t0 = performance.now();
        const out = await kernel.process(read);
        meter.busyMs += performance.now() - t0;
        if (out) {
          postResult(out.values, out.frames);
          const now = Date.now();
          if (meter.lastResultAt > 0)
            meter.maxResultGapMs = Math.max(meter.maxResultGapMs, now - meter.lastResultAt);
          meter.lastResultAt = now;
          meter.results++;
        }
      } catch (e) {
        fail(`vision step failed: ${(e as Error).message}`);
      }
    }
    reportStats(Date.now());
    await delay(hasFrame ? 0 : BACKOFF_MS);
  }
  cleanup();
}

function cleanup(): void {
  running = false;
  kernel?.dispose();
  kernel = null;
  if (addon) for (const pipe of pipes) try { addon.close(pipe.handle); } catch { /* already gone */ }
  pipes = [];
}

port.on("message", (msg: VisionWorkerIn) => {
  switch (msg.kind) {
    case "init":
      if (!running) start(msg);
      break;
    case "params":
      kernel?.setParams(msg.params);
      break;
    case "stop":
      running = false; // pump() falls through to cleanup on its next lap
      break;
  }
});
