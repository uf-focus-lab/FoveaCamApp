// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The MEMS controller thread node: one long-lived singleton ("controller") created
// at orchestrator startup, binding/unbinding the active serial Controller as the
// controller session connects/disconnects. Absorbs the actuation loop as a push
// model (openPosition inputs → MCU CMD_STREAM v2 / paced loop v1), owns the
// enable-iff-we-enabled lifecycle, and schedules round-robin trigger capture
// forwarding FINs to sink nodes. Also the single owner of the protocol v2.2.0
// surfaces: timestamped input pushes (`updateAt` → CMD_SCHEDULE) and the ONE
// uploaded trajectory (`openTrajectory` → CMD_TRAJECTORY, MirrorLink), whose OK
// pushes feed the same FIN sinks + mirror history. Native-free by construction
// (injected seams; type-only controller imports).
// spec: docs/spec/controller.md#controller-node

import type { Pos } from "@lib/controller-codec";
import type {
  Controller,
  FrameOutcome,
  NativeMirrorSinkHandle,
  StreamHandle,
  TrajectoryFrameOutcome,
  TrajectoryHandle,
  TrajectorySpec,
  TrajectorySwapKind,
} from "./controller.js";
import { trajectoryGraceUs } from "./trajectory-grace.js";
import type { StreamType } from "@lib/orchestrator/graph-contract.js";
import type { TrajectoryStat } from "@lib/orchestrator/contracts.js";
import { nodeId } from "@lib/orchestrator/graph-contract.js";
import {
  registerGraphWiring,
  type GraphWiring,
  type WiredNode,
} from "./graph-topology.js";
import { mirrorHistory } from "./mirror-history.js";
import { hostNowNs } from "./time-align.js";
import {
  RoundRobinFrameScheduler,
  type FrameRequest,
  type FrameRequestPromise,
  type ScheduledFrameTarget,
} from "./scheduler.js";
/** A commanded mirror pose (both eyes) — the position-stream payload. */
export interface PositionPair {
  left: Pos;
  right: Pos;
}

export interface OpenPositionOptions {
  /** Producer node id for the graph edge `from → controller` (port = the input
   *  `name`). Omit when the producer already draws its own `…→controller`
   *  edges (e.g. the marker servo's per-eye PID nodes) — no edge is registered. */
  from?: string;
  /** Initial pose — the stream CREATE target (v2) / the seed the v1 loop holds
   *  until the first update, and the value `update()` echoes before a controller
   *  is bound. */
  initial: PositionPair;
  /** Stream type of the registered edge (default analysis/"pid"). */
  type?: StreamType;
  /** v1 awaited path only: the actuate readback + round-trip ms, per tick. On
   *  v2 (streaming) there is no round-trip, so this never fires and the caller
   *  uses `update()`'s synchronous return with a ~0 actuateMs. */
  onApplied?(volts: { L: Pos; R: Pos }, actuateMs: number): void;
}

export interface PositionInput {
  /** The lazily-created CMD_STREAM's MCU stream id (v2 controller), or null
   *  until the first update against a v2 controller creates it (and again
   *  while a native input owns the wire / on a v1 controller). The CMD_FRAME
   *  target for trigger-sync capture on this JS input's stream (spec
   *  manual-control §trigger-sync — the openNativePosition `streamId` analog). */
  readonly streamId: number | null;
  /** Push a target pose. Records `predictVolts` into the mirror-history
   *  trajectory (ONE place) and returns the predicted volts synchronously; the
   *  MCU stream (v2) / paced loop (v1) applies it. When no controller is bound
   *  the last predicted value is returned (the mirror holds) and nothing is
   *  recorded. While an uploaded trajectory RUNS the push is held locally
   *  (not sent — the firmware would REJ it; nothing recorded; the last
   *  predicted value is returned) and re-asserted when the run ends. A push
   *  that follows pending `updateAt` keyframes supersedes them (the firmware
   *  clears the stream's schedule on UPDATE): mirror history drops the
   *  not-yet-due keyframe samples, then records this pose at send time. */
  update(pos: PositionPair): PositionPair;
  /** v2.2.0 timestamped push (CMD_SCHEDULE): apply `pos` at host-steady
   *  `hostNs` instead of on arrival; `interpolate` ramps linearly from the
   *  previous keyframe (or, into an empty schedule, from the current target
   *  starting now). Records the prediction into mirror history AT `hostNs`
   *  (a late keyframe — `hostNs` already past — at send time, which is when
   *  the firmware applies it). Push keyframes in time order: one older than
   *  the newest recorded sample is still sent but NOT recorded (the history
   *  is monotonic). Falls back to `update()` (immediate, counted in
   *  `scheduleFallbacks`) when the bound controller is not `v22Capable`, the
   *  input's MCU stream does not exist yet (first push creates it), or a
   *  native input owns the wire. Held like `update()` while a trajectory
   *  runs. Returns the predicted volts. */
  updateAt(
    hostNs: bigint,
    pos: PositionPair,
    opts?: { interpolate?: boolean },
  ): PositionPair;
  /** Pushes `updateAt` routed to `update()` instead (see updateAt). */
  readonly scheduleFallbacks: number;
  /** Terminate the MCU stream, retire the graph edge, and — if this was the
   *  last open input and the node enabled the controller — disable it. */
  close(): Promise<void>;
}

/** Lifecycle of the node's uploaded trajectory:
 *  `uploading` (open/reupload in flight) → `ready` (committed, stopped) ⇄
 *  `running` (START sent until STOP / ENDED / run-level CANCELLED) →
 *  `detached` (controller unbound or swapped: pushes stop, the MCU table is
 *  gone with the old device — `reupload()` or `close()`) → `closed`. */
export type NodeTrajectoryState = TrajectoryStat["state"];

export interface OpenTrajectoryOptions {
  /** The node-input name: the graph edge port into `controller` (like a
   *  position input's name) and the stats row's label. */
  name: string;
}

/** The controller node's handle on THE uploaded trajectory (at most one open).
 *  @remarks spec: docs/spec/controller.md#trajectory-ownership */
export interface NodeTrajectory {
  readonly name: string;
  /** MCU table id (null while detached / uploading). */
  readonly id: number | null;
  readonly state: NodeTrajectoryState;
  /** START at host-steady `atHostNs` (default: now on the MCU) for `cycles`
   *  (default 0 = forever). Holds every position input from this call until
   *  the run ends. Throws when detached/closed or already running. */
  start(atHostNs?: bigint, cycles?: number): Promise<void>;
  /** STOP (no-op unless running); position inputs then re-take the DAC. */
  stop(): Promise<void>;
  /** STOP if running, DELETE the table (best-effort), retire the graph input,
   *  and disable iff the node enabled the controller and nothing else is
   *  open. Idempotent. */
  close(): Promise<void>;
  /** Every push for this table (OK and non-OK). OK pushes ALSO reach the
   *  node's FIN sinks and mirror history. Stops firing once detached. */
  onFrame(cb: (frame: TrajectoryFrameOutcome) => void): () => void;
  /** State transitions. `controllerAvailable` is true on a `detached`
   *  notification when a v2.2 controller is bound again — the cue for the
   *  session to decide whether to `reupload()` (never automatic). */
  onStateChange(
    cb: (
      state: NodeTrajectoryState,
      detail: { controllerAvailable: boolean },
    ) => void,
  ): () => void;
  /** Re-upload the same spec to the currently bound v2.2 controller (only
   *  from `detached`); back to `ready` on success, `detached` on failure. */
  reupload(): Promise<void>;
  /** Swap in a new spec (same period) PHASE-CONTINUOUSLY while running —
   *  `TrajectoryHandle.replace`: the mirror keeps sweeping, position inputs
   *  stay held, pushes keep flowing on this handle. From `ready` it is a plain
   *  re-upload. Throws when detached/closed/uploading, or on a period change
   *  while running (stop first). The new spec is what `reupload()` sends;
   *  `reuploads` in the stats row counts successful swaps and `lastSwap`
   *  says whether the last running one was atomic (firmware 2.2.1) or the
   *  STOP/START pair. Pushes from a retired table during its grace still
   *  arrive here, scored against THAT table's spec (per id, from the swap
   *  instant — also while the swap's DELETE is still out, and for every
   *  table still in grace after a second swap). Calls made while
   *  a swap is in flight COALESCE (latest spec wins, sent once the in-flight
   *  swap lands; every coalesced caller settles with it). `stop()` waits for
   *  in-flight + pending swaps; `close()` rejects the pending one and waits
   *  for the in-flight one. */
  replace(spec: TrajectorySpec): Promise<void>;
}

/** Native position input: a session pipes a native volts producer (compose brick
 *  `volt_out`) into the sink's `pos_in`; needs a bound v2 controller (stream +
 *  sink created lazily, detached on unbind/close). Shares the JS-input
 *  enable/disable lifecycle.
 *  @remarks spec: docs/spec/controller.md#native-position-input */
export interface OpenNativePositionOptions {
  initial: PositionPair;
  /** Graph node id for the sink's incoming link edge (default "controller"). */
  nodeId?: string;
  /** A native sink is live — pipe into `sink.pos_in` now. */
  onAttach(sink: NativeMirrorSinkHandle["sink"]): void;
  /** The sink is going away (unbind/close) — release the link now. */
  onDetach(): void;
}

export interface NativePositionInput {
  /** The live native sink (null while no v2 controller is bound). */
  readonly sink: NativeMirrorSinkHandle["sink"] | null;
  /** The attached sink's MCU stream id (null until the lazy/async native
   *  attach lands) — the CMD_FRAME target for trigger-sync capture. */
  readonly streamId: number | null;
  /** Detach + TERMINATE + retire (disable iff we enabled and last one out). */
  close(): Promise<void>;
}

/** An injected FIN-outcome sink (no native imports): the anchor enrichment
 *  node registers one, and `startTriggerCapture` forwards every completed
 *  exposure to it (pairing-nodes). An OK push of the node's uploaded
 *  trajectory is forwarded too, tagged with `outcome.trajectory`. */
export type FinSink = (outcome: FrameOutcome) => void;

export interface TriggerCaptureOptions {
  /** Round-robin CMD_FRAME targets (stream ids from the open position inputs). */
  targets: ScheduledFrameTarget[];
  /** Scheduler pass-through knobs (pacing, timeouts). */
  scheduler?: Partial<
    Pick<
      import("./scheduler.js").FrameSchedulerOptions,
      | "maxInFlight"
      | "defaultMinIntervalMs"
      | "acceptedTimeoutMs"
      | "completionTimeoutMs"
    >
  >;
}

const V1_INTERVAL_MS = 1;
/** Non-OK trajectory pushes log at most once per status per this window. */
const TRAJECTORY_LOG_INTERVAL_MS = 1000;
/** Graph node id of the (single) uploaded-trajectory input. */
export const trajectoryNodeId = (): string =>
  `${nodeId.controller()}/trajectory`;
const TRAJECTORY_STREAM: StreamType = {
  kind: "analysis",
  schema: "trajectory",
};

/** Expected host-ns trigger instant of `marker` in `cycle` of a run started
 *  at `startHostNs`: start + cycle·period + marker offset (µs → ns). */
export function expectedTriggerNs(
  startHostNs: bigint,
  cycle: number,
  periodUs: number,
  markerOffsetUs: number,
): bigint {
  return (
    startHostNs +
    BigInt(cycle) * BigInt(periodUs) * 1000n +
    BigInt(markerOffsetUs) * 1000n
  );
}

/** At most one line per key per `intervalMs`; the next line after a quiet
 *  window carries how many were suppressed. Injected sink/clock for tests. */
export class RateLimitedLog {
  private readonly last = new Map<string, { at: number; suppressed: number }>();
  constructor(
    private readonly intervalMs = TRAJECTORY_LOG_INTERVAL_MS,
    private readonly sink: (msg: string) => void = (m) => console.warn(m),
    private readonly now: () => number = () => Date.now(),
  ) {}

  note(key: string, msg: string): void {
    const t = this.now();
    const entry = this.last.get(key);
    if (entry && t - entry.at < this.intervalMs) {
      entry.suppressed++;
      return;
    }
    const suffix = entry?.suppressed
      ? ` (+${entry.suppressed} suppressed)`
      : "";
    this.last.set(key, { at: t, suppressed: 0 });
    this.sink(msg + suffix);
  }
}

export class ControllerNode {
  private controller: Controller | null = null;
  private enabledByUs = false;

  // Position inputs, and the node-level "latest pose / last input" the v1 loop
  // actuates (single-input assumption — app exclusivity).
  private readonly inputs = new Set<PositionInputImpl>();
  // Native position inputs (native-compose-controller.md) — attach/detach with
  // the controller bind lifecycle; counted with `inputs` for disable-on-last.
  private readonly nativeInputs = new Set<NativePositionInputImpl>();
  private latestPose: PositionPair;
  private lastInput: PositionInputImpl | null = null;

  // v1 paced loop.
  private v1Running = false;

  // Trigger mode: FIN outcomes fan out to registered sinks (anchor enrichment).
  private readonly finListeners = new Set<FinSink>();

  // THE uploaded trajectory (v2.2.0) — at most one open: the firmware runs one
  // at a time, and a second owner would fight over the DAC + pushes.
  private trajectory: NodeTrajectoryImpl | null = null;

  // Topology: ONE stable wiring registered at construction (stays first in the
  // registration Set, so its declared `controller` node wins over any
  // placeholder a PID/​position edge would otherwise synthesize). `statsKey` is
  // MUTATED IN PLACE on connect/disconnect — the fold reads it live each snapshot
  // — so the node keeps its position without a churny re-register.
  private readonly wiringNode: WiredNode = {
    id: nodeId.controller(),
    kind: "controller",
    output: null,
    transport: "native",
  };
  private readonly wiring: GraphWiring = {
    nodes: [this.wiringNode],
    edges: [],
  };
  private readonly unregisterWiring: () => void;

  constructor(
    initial: PositionPair = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
  ) {
    this.latestPose = clonePair(initial);
    this.unregisterWiring = registerGraphWiring(this.wiring);
  }

  // --- controller binding (sessions/controller on connect/disconnect) --------

  /** Bind the freshly-connected serial device and fold its `controller:<port>`
   *  serial meter into the node's stats. Streams recreate lazily on the next
   *  update; the v1 loop (re)starts if inputs are open. */
  bindController(c: Controller): void {
    // A swap without an unbind still strands the trajectory on the old device.
    const t = this.trajectory;
    if (t?.owner && t.owner !== c) t.detach();
    this.controller = c;
    this.wiringNode.statsKey = `controller:${c.port}`;
    // Report (never auto-reupload) that a detached trajectory could come back.
    if (t?.state === "detached") t.notifyRebind(!!c.v22Capable);
    if (this.inputs.size > 0 && !c.v2Capable) this.ensureV1Loop();
    // Native inputs attach lazily against the fresh controller (v2 only).
    for (const input of this.nativeInputs) input.sync();
  }

  /** Unbind on disconnect: drop every MCU stream (best-effort — the device may
   *  be gone) and stop the v1 loop. NEVER disables — disable-on-disconnect lives
   *  in the session + janitor (hardware-quiescence invariant). */
  async unbindController(): Promise<void> {
    const gone = this.controller;
    this.controller = null;
    delete this.wiringNode.statsKey;
    this.enabledByUs = false;
    this.v1Running = false;
    // The trajectory's MCU table went with the device: detach (pushes stop,
    // no wire traffic — the device may already be gone).
    this.trajectory?.detach();
    if (gone) {
      for (const input of this.inputs) await input.dropStream();
      // Native inputs detach (link released via onDetach, sink dropped;
      // TERMINATE is best-effort — the device may already be gone).
      for (const input of this.nativeInputs) await input.drop();
    }
  }

  get connected(): boolean {
    return !!this.controller?.connected;
  }

  // --- position inputs -------------------------------------------------------

  /** Open a NATIVE position input (native-compose-controller.md). The sink
   *  attaches asynchronously (needs a bound v2 controller — now or on a later
   *  bind); the session reacts via `onAttach`/`onDetach`. */
  openNativePosition(
    name: string,
    opts: OpenNativePositionOptions,
  ): NativePositionInput {
    const input = new NativePositionInputImpl(this, name, opts);
    this.nativeInputs.add(input);
    input.sync();
    return input;
  }

  openPosition(name: string, opts: OpenPositionOptions): PositionInput {
    const input = new PositionInputImpl(this, name, opts);
    this.inputs.add(input);
    this.latestPose = clonePair(opts.initial);
    this.lastInput = input;
    if (opts.from !== undefined)
      this.wiring.edges.push({
        from: opts.from,
        to: nodeId.controller(),
        port: name,
        type: opts.type ?? PID_STREAM,
      });
    const c = this.controller;
    if (c && !c.v2Capable) this.ensureV1Loop();
    return input;
  }

  // --- trigger mode ----------------------------------------------------------

  /** Register a FIN-outcome sink (the anchor enrichment node). Every completed
   *  exposure from an active `startTriggerCapture` is forwarded here — the root
   *  PairStream (not this node) does the L/R matching (pairing-nodes). Returns
   *  an unregister. */
  onFin(sink: FinSink): () => void {
    this.finListeners.add(sink);
    return () => this.finListeners.delete(sink);
  }

  /** Start round-robin CMD_FRAME capture; each FIN outcome is forwarded to the
   *  registered FIN sinks. Composes the pure `RoundRobinFrameScheduler`. */
  startTriggerCapture(opts: TriggerCaptureOptions): { stop(): void } {
    const requester = {
      frame: (request: FrameRequest): FrameRequestPromise => {
        const c = this.controller;
        if (!c) throw new Error("Controller not connected");
        return c.frame(request);
      },
    };
    const scheduler = new RoundRobinFrameScheduler({
      requester,
      targets: opts.targets,
      ...(opts.scheduler ?? {}),
      onFrame: (outcome) => this.emitFin(outcome),
    });
    scheduler.start();
    return { stop: () => scheduler.stop() };
  }

  private emitFin(outcome: FrameOutcome): void {
    for (const sink of this.finListeners) sink(outcome);
  }

  // --- uploaded trajectory (v2.2.0 CMD_TRAJECTORY, MirrorLink) ---------------

  /** Upload `spec` to the bound controller and own it as THE node trajectory.
   *  Requires a bound v2.2 controller; refuses a second open (one trajectory
   *  at a time — close the first). Enables the controller if it is disabled
   *  (disabled again on the last close iff the node enabled it). Resolves
   *  once the table is committed (`ready`).
   *  @remarks spec: docs/spec/controller.md#trajectory-ownership */
  async openTrajectory(
    spec: TrajectorySpec,
    opts: OpenTrajectoryOptions,
  ): Promise<NodeTrajectory> {
    if (this.trajectory)
      throw new Error(
        `A trajectory ("${this.trajectory.name}") is already open on the controller node — close it first (the firmware runs one at a time)`,
      );
    const c = this.controller;
    if (!c) throw new Error("openTrajectory requires a bound controller");
    if (!c.v22Capable)
      throw new Error(
        "openTrajectory requires firmware >= 2.2.0 (CMD_TRAJECTORY unavailable)",
      );
    // Reserve the slot SYNCHRONOUSLY so a concurrent open is refused too.
    const t = new NodeTrajectoryImpl(this, opts.name, spec);
    this.trajectory = t;
    this.wiring.nodes.push(t.wiringNode);
    this.wiring.edges.push({
      from: trajectoryNodeId(),
      to: nodeId.controller(),
      port: opts.name,
      type: TRAJECTORY_STREAM,
    });
    try {
      await t.upload(c);
    } catch (error) {
      await t.discard();
      throw error;
    }
    return t;
  }

  /** The open trajectory's stats row (null when none) — published in the
   *  controller session telemetry. */
  trajectorySnapshot(): TrajectoryStat | null {
    return this.trajectory?.snapshot() ?? null;
  }

  /** Node-level stats: per position input (held / schedule counters) + the
   *  trajectory row. */
  statsSnapshot(): {
    inputs: Array<ReturnType<PositionInputImpl["stats"]>>;
    trajectory: TrajectoryStat | null;
  } {
    return {
      inputs: [...this.inputs].map((i) => i.stats()),
      trajectory: this.trajectorySnapshot(),
    };
  }

  /** @internal — an input held a push during the run (trajectory stats). */
  noteHeldPush(): void {
    this.trajectory?.noteHeldPush();
  }

  /** @internal — true while THE trajectory runs on `c`: position inputs hold
   *  their pushes (the firmware REJects stream writes meanwhile). */
  trajectoryOwnsDac(c: Controller): boolean {
    const t = this.trajectory;
    return !!t && t.state === "running" && t.owner === c;
  }

  /** @internal — the run ended (STOP / ENDED / run-level CANCELLED / close):
   *  every position input re-takes the DAC with its latest pose. */
  resumeInputs(): void {
    for (const input of this.inputs) input.resume();
  }

  /** @internal — a run is starting: pending scheduled keyframes no longer move
   *  the mirror (the trajectory owns the DAC; resume supersedes them), so
   *  their future history samples are dropped. */
  noteTrajectoryStart(): void {
    mirrorHistory.truncateAfter(hostNowNs());
    for (const input of this.inputs) input.clearSchedule();
  }

  /** @internal — an OK trajectory push: the exposure-averaged position at its
   *  exposure time is the only trustworthy mirror position while the MCU owns
   *  the DAC → mirror history; then the FIN sinks (tagged outcome). */
  forwardTrajectoryFrame(f: TrajectoryFrameOutcome): void {
    mirrorHistory.record(f.tExposure, f.left, f.right);
    this.emitFin({
      frameId: f.frameId,
      stream: f.trajectoryId,
      tTrigger: f.tTrigger,
      tExposure: f.tExposure,
      left: f.left,
      right: f.right,
      trajectory: {
        id: f.trajectoryId,
        marker: f.marker ?? -1,
        cycle: f.cycle,
      },
    });
  }

  /** @internal — release the trajectory slot + graph input; disable iff the
   *  node enabled the controller and nothing else is open. */
  async retireTrajectory(t: NodeTrajectoryImpl): Promise<void> {
    if (this.trajectory !== t) return;
    this.trajectory = null;
    const n = this.wiring.nodes.indexOf(t.wiringNode);
    if (n >= 0) this.wiring.nodes.splice(n, 1);
    const e = this.wiring.edges.findIndex(
      (x) => x.from === trajectoryNodeId() && x.to === nodeId.controller(),
    );
    if (e >= 0) this.wiring.edges.splice(e, 1);
    if (this.inputs.size === 0 && this.nativeInputs.size === 0)
      await this.disableIfLast();
  }

  // --- internals shared with PositionInputImpl -------------------------------

  /** @internal */ get liveController(): Controller | null {
    return this.controller;
  }

  /** @internal — record the trusted-time trajectory ONCE per update. */
  recordTrajectory(predicted: PositionPair): void {
    mirrorHistory.record(hostNowNs(), predicted.left, predicted.right);
  }

  /** @internal — an immediate push superseded pending scheduled keyframes:
   *  drop their not-yet-due samples, then record `predicted` now. */
  supersedeSchedule(predicted: PositionPair): void {
    const now = hostNowNs();
    mirrorHistory.truncateAfter(now);
    mirrorHistory.record(now, predicted.left, predicted.right);
  }

  /** @internal — record a scheduled keyframe at its apply time. Returns the
   *  recorded instant, or null when it was out of order (not recorded).
   *  A keyframe due in the past applies on arrival → recorded now. Into an
   *  empty schedule (newest sample already past) the firmware anchors at the
   *  arrival instant, so a hold sample is recorded at now first; a STEP
   *  keyframe (no interpolate) also holds the previous position until its
   *  instant, so `mirrorAt` shows a step, not a ramp. */
  recordScheduled(
    hostNs: bigint,
    predicted: PositionPair,
    interpolate: boolean,
  ): bigint | null {
    const now = hostNowNs();
    const t = hostNs > now ? hostNs : now;
    const newest = mirrorHistory.newest();
    if (newest && t < newest.hostNs) return null;
    if (newest && t > now) {
      if (newest.hostNs < now)
        mirrorHistory.record(now, newest.left, newest.right);
      if (!interpolate) mirrorHistory.record(t, newest.left, newest.right);
    }
    mirrorHistory.record(t, predicted.left, predicted.right);
    return t;
  }

  /** @internal — remember the freshest pose + which input drove it (v1 loop). */
  noteUpdate(input: PositionInputImpl, pose: PositionPair): void {
    this.latestPose = pose;
    this.lastInput = input;
  }

  /** @internal — enable the controller if we haven't and it isn't already. */
  async ensureEnabled(c: Controller): Promise<void> {
    if (!c.enabled) {
      await c.enable();
      this.enabledByUs = true;
    }
  }

  /** @internal — remove a drained input; disable iff we enabled + last one out. */
  async retireInput(input: PositionInputImpl): Promise<void> {
    this.inputs.delete(input);
    if (this.lastInput === input) this.lastInput = null;
    // Retire the input's graph edge.
    const idx = this.wiring.edges.findIndex(
      (e) =>
        e.to === nodeId.controller() &&
        e.port === input.name &&
        e.from === input.from,
    );
    if (idx >= 0) this.wiring.edges.splice(idx, 1);
    if (
      this.inputs.size === 0 &&
      this.nativeInputs.size === 0 &&
      !this.trajectory
    )
      await this.disableIfLast();
  }

  /** @internal — TRUE while any native input is attached OR attaching
   *  (dual-cmd-stream-handoff-race): the JS inputs must not create/hold their
   *  own CMD_STREAM in that window — the firmware DAC is first-CREATE-wins and
   *  never re-arbitrates, so a second stream either parks the mirrors dead
   *  (native stream lost the race) or leaves an orphan stream (JS stream lost).
   *  `creating` is set SYNCHRONOUSLY in sync(), so the suppression is active
   *  from `openNativePosition()`'s return — before the fallback's first update. */
  nativeEngaged(): boolean {
    for (const n of this.nativeInputs) if (n.engagedOrPending) return true;
    return false;
  }

  /** @internal — the explicit fallback→native HANDOFF: TERMINATE any stream
   *  a JS input still holds (created before the native attach began, e.g.
   *  when the controller bound after activation). Called by the native input
   *  the moment its sink attaches, BEFORE the session pipes volts into it. */
  async handoffToNative(): Promise<void> {
    for (const input of this.inputs) await input.dropStream();
  }

  /** @internal — native-input retire: same disable-iff-last discipline. */
  async retireNativeInput(input: NativePositionInputImpl): Promise<void> {
    this.nativeInputs.delete(input);
    if (
      this.inputs.size === 0 &&
      this.nativeInputs.size === 0 &&
      !this.trajectory
    )
      await this.disableIfLast();
  }

  private async disableIfLast(): Promise<void> {
    this.v1Running = false;
    const c = this.controller;
    if (this.enabledByUs && c) {
      try {
        await c.disable();
      } catch {
        // best-effort — a dropped controller may already be gone
      } finally {
        this.enabledByUs = false;
      }
    }
  }

  /** @internal — start the ONE v1 paced loop if a v1 controller + inputs exist. */
  ensureV1Loop(): void {
    if (this.v1Running) return;
    this.v1Running = true;
    void (async () => {
      while (this.v1Running) {
        const c = this.controller;
        if (!c || c.v2Capable || this.inputs.size === 0) break;
        try {
          await this.ensureEnabled(c);
          const t0 = performance.now();
          const { left, right } = await c.actuate(this.latestPose);
          this.lastInput?.opts.onApplied?.(
            { L: left, R: right },
            performance.now() - t0,
          );
        } catch {
          // Transient v1 failure (a dropped packet, a mid-swap actuate) —
          // retry next tick. Do NOT clear `enabledByUs` here: the device stays
          // enabled, and clearing the ownership flag would break
          // disable-on-last-close. The flag is cleared only where the enable
          // state actually changes: disableIfLast (we disabled) and
          // unbindController (the device is gone).
        }
        await new Promise((r) => setTimeout(r, V1_INTERVAL_MS));
      }
      this.v1Running = false;
    })();
  }

  /** Retire the node entirely (test/teardown). */
  dispose(): void {
    this.v1Running = false;
    this.trajectory?.detach();
    this.trajectory = null;
    this.finListeners.clear();
    this.unregisterWiring();
  }
}

/** Default control-edge type (no frame on the control path — scalars). */
const PID_STREAM: StreamType = { kind: "analysis", schema: "pid" };

class PositionInputImpl implements PositionInput {
  private stream: StreamHandle | null = null;
  private streamOwner: Controller | null = null;
  private creating = false;
  private closed = false;
  private lastPredicted: PositionPair;
  private latest: PositionPair;
  // A push arrived while a trajectory owned the DAC (held, not sent).
  private held = false;
  private heldPushes = 0;
  // Latest recorded scheduled-keyframe instant still in the future (host ns),
  // or null: while set, an immediate push SUPERSEDES the schedule.
  private scheduledHorizonNs: bigint | null = null;
  private scheduled = 0;
  private fallbacks = 0;
  private scheduleDrops = 0;
  private historyOutOfOrder = 0;

  constructor(
    private readonly node: ControllerNode,
    readonly name: string,
    readonly opts: OpenPositionOptions,
  ) {
    this.lastPredicted = clonePair(opts.initial);
    this.latest = clonePair(opts.initial);
  }

  get from(): string | undefined {
    return this.opts.from;
  }

  get streamId(): number | null {
    return this.stream?.id ?? null;
  }

  get scheduleFallbacks(): number {
    return this.fallbacks;
  }

  update(pos: PositionPair): PositionPair {
    if (this.closed) return this.lastPredicted;
    this.latest = pos;
    this.node.noteUpdate(this, pos);

    const c = this.node.liveController;
    if (!c) return this.lastPredicted; // no device — mirror holds, nothing recorded

    // An uploaded trajectory owns the DAC: the firmware would REJ the UPDATE.
    // Hold the pose (`latest`) — nothing sent, nothing recorded — and
    // re-assert it when the run ends (resume()).
    if (this.node.trajectoryOwnsDac(c)) {
      this.held = true;
      this.heldPushes++;
      this.node.noteHeldPush();
      return this.lastPredicted;
    }

    const predicted = c.predictVolts({ left: pos.left, right: pos.right });
    this.lastPredicted = predicted;
    // Pending updateAt keyframes: this push supersedes them only once it is
    // actually on the wire, so the history write moves after the send.
    const superseding = this.schedulePending();
    // ONE place for the trusted-time trajectory (unified-time).
    if (!superseding) this.node.recordTrajectory(predicted);
    let cleared = true; // a dropped / recreated stream has no schedule left

    if (c.v2Capable) {
      // Keep `c.pos` live under streaming (no readback) so calibrate voltage
      // capture / drift derivation read the applied pose (guarded — partial
      // fakes may omit it).
      c.applyStreamedPos?.(predicted);
      // dual-cmd-stream-handoff-race: while a native input is
      // attached or attaching, this JS input must not create/hold its own
      // CMD_STREAM (see ControllerNode.nativeEngaged). Drop anything still
      // held from before the attach began; the native path owns the wire.
      if (this.node.nativeEngaged()) {
        if (this.stream) void this.dropStream();
        if (superseding) this.supersede(predicted);
        return predicted;
      }
      if (this.streamOwner && this.streamOwner !== c) void this.dropStream();
      if (this.stream && this.streamOwner === c)
        cleared = this.stream.update(pos) !== false;
      else this.ensureStream(c);
    } else {
      this.node.ensureV1Loop();
    }
    // A gated/dropped UPDATE never reached the MCU: the schedule still runs
    // (and its history stands).
    if (superseding && cleared) this.supersede(predicted);
    return predicted;
  }

  updateAt(
    hostNs: bigint,
    pos: PositionPair,
    opts: { interpolate?: boolean } = {},
  ): PositionPair {
    if (this.closed) return this.lastPredicted;
    const c = this.node.liveController;
    const s = this.stream;
    if (c && this.node.trajectoryOwnsDac(c)) return this.update(pos); // held
    if (
      !c ||
      !c.v22Capable ||
      !s ||
      this.streamOwner !== c ||
      this.node.nativeEngaged()
    ) {
      // v2.1 firmware / stream not created yet / native owns the wire / no
      // device: immediate semantics (update() creates the stream lazily).
      this.fallbacks++;
      return this.update(pos);
    }
    this.latest = pos;
    this.node.noteUpdate(this, pos);
    const predicted = c.predictVolts({ left: pos.left, right: pos.right });
    this.lastPredicted = predicted;
    const interpolate = opts.interpolate ?? false;
    try {
      s.scheduleAt(hostNs, pos, { interpolate });
    } catch {
      // Latest-wins drop under back-pressure: never reached the MCU, so it is
      // not recorded either. (`c.pos` is not touched for a future keyframe.)
      this.scheduleDrops++;
      return predicted;
    }
    this.scheduled++;
    const t = this.node.recordScheduled(hostNs, predicted, interpolate);
    if (t === null) this.historyOutOfOrder++;
    else if (this.scheduledHorizonNs === null || t > this.scheduledHorizonNs)
      this.scheduledHorizonNs = t;
    return predicted;
  }

  /** True while a recorded scheduled keyframe is still in the future. */
  private schedulePending(): boolean {
    if (this.scheduledHorizonNs === null) return false;
    if (this.scheduledHorizonNs > hostNowNs()) return true;
    this.scheduledHorizonNs = null; // everything scheduled has come due
    return false;
  }

  private supersede(predicted: PositionPair): void {
    this.scheduledHorizonNs = null;
    this.node.supersedeSchedule(predicted);
  }

  /** @internal — a trajectory run starts: pending keyframes are moot. */
  clearSchedule(): void {
    this.scheduledHorizonNs = null;
  }

  /** @internal — the trajectory run ended: re-take the DAC with the latest
   *  pose (held during the run, or the pre-run target when the input has a
   *  stream). FORCED past the stream gate — the pose may equal the last one
   *  sent, yet the firmware holds the trajectory's last position until the
   *  next stream write. Recorded at now (it applies on arrival). */
  resume(): void {
    const wasHeld = this.held;
    this.held = false;
    if (this.closed) return;
    const c = this.node.liveController;
    if (!c || (!wasHeld && !this.stream)) return;
    const pos = this.latest;
    const predicted = c.predictVolts({ left: pos.left, right: pos.right });
    this.lastPredicted = predicted;
    this.scheduledHorizonNs = null;
    if (c.v2Capable) {
      c.applyStreamedPos?.(predicted);
      if (!this.node.nativeEngaged()) {
        if (this.streamOwner && this.streamOwner !== c) void this.dropStream();
        if (this.stream && this.streamOwner === c)
          this.stream.update(pos, { force: true });
        else this.ensureStream(c);
      }
    }
    this.node.supersedeSchedule(predicted);
  }

  /** @internal — stats row (ControllerNode.statsSnapshot). */
  stats() {
    return {
      name: this.name,
      streamId: this.streamId,
      held: this.held,
      heldPushes: this.heldPushes,
      scheduled: this.scheduled,
      scheduleFallbacks: this.fallbacks,
      scheduleDrops: this.scheduleDrops,
      historyOutOfOrder: this.historyOutOfOrder,
    };
  }

  /** Lazily CREATE the MCU stream (guarded against concurrent creates). */
  private ensureStream(c: Controller): void {
    if (this.creating) return;
    this.creating = true;
    void (async () => {
      try {
        await this.node.ensureEnabled(c);
        const s = await c.createStream(this.latest);
        // The node may have unbound / swapped / closed — or a NATIVE input may
        // have engaged (dual-cmd-stream-handoff-race) — while awaiting.
        if (
          this.closed ||
          this.node.liveController !== c ||
          this.node.nativeEngaged()
        ) {
          await safeClose(s);
          return;
        }
        this.stream = s;
        this.streamOwner = c;
      } catch {
        // enable / create failed — drop so the next good update retries
        this.stream = null;
        this.streamOwner = null;
      } finally {
        this.creating = false;
      }
    })();
  }

  /** @internal — TERMINATE the MCU stream (controller swap / disconnect). */
  async dropStream(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    this.streamOwner = null;
    if (s) await safeClose(s);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.dropStream();
    await this.node.retireInput(this);
  }
}

/** The native position input (native-compose-controller.md) — see
 *  {@link OpenNativePositionOptions}. All async transitions reconcile against
 *  controller swaps mid-await (the PositionInputImpl.ensureStream idiom). */
class NativePositionInputImpl implements NativePositionInput {
  private handle: NativeMirrorSinkHandle | null = null;
  private creating = false;
  private closed = false;

  constructor(
    private readonly node: ControllerNode,
    readonly name: string,
    private readonly opts: OpenNativePositionOptions,
  ) {}

  get sink(): NativeMirrorSinkHandle["sink"] | null {
    return this.handle?.sink ?? null;
  }

  get streamId(): number | null {
    return this.handle?.streamId ?? null;
  }

  /** @internal — attached OR attach in flight (the JS-stream suppression
   *  window; see ControllerNode.nativeEngaged). */
  get engagedOrPending(): boolean {
    return !this.closed && (this.creating || this.handle !== null);
  }

  /** @internal — attach against the current controller if possible (open +
   *  bindController). v1 / unbound controllers simply never attach; the
   *  session's fallback path owns those. */
  sync(): void {
    const c = this.node.liveController;
    if (this.closed || this.handle || this.creating || !c || !c.v2Capable)
      return;
    this.creating = true;
    void (async () => {
      try {
        await this.node.ensureEnabled(c);
        const h = await c.createNativeMirrorSink(
          this.opts.initial,
          this.opts.nodeId ?? nodeId.controller(),
        );
        // The node may have unbound / swapped / closed while awaiting.
        if (this.closed || this.node.liveController !== c) {
          try {
            await h.close();
          } catch {
            // best-effort — the device may already be gone
          }
          return;
        }
        this.handle = h;
        // Explicit fallback→native HANDOFF (dual-cmd-stream-handoff-race):
        // TERMINATE any CMD_STREAM a JS input created before this attach —
        // BEFORE the session pipes volts in, so the firmware never holds two
        // live streams for the same DAC.
        await this.node.handoffToNative();
        try {
          this.opts.onAttach(h.sink);
        } catch {
          // a session attach fault must not wedge the node
        }
      } catch {
        // enable / create failed — a later bind retries via sync()
      } finally {
        this.creating = false;
      }
    })();
  }

  /** @internal — detach on unbind (sink released; TERMINATE best-effort). */
  async drop(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (!h) return;
    try {
      this.opts.onDetach();
    } catch {
      // session detach fault — keep tearing down
    }
    try {
      await h.close();
    } catch {
      // best-effort — the device may already be gone
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.drop();
    await this.node.retireNativeInput(this);
  }
}

/** THE node trajectory — see {@link NodeTrajectory}. All async transitions
 *  reconcile against unbind/swap/close mid-await (the ensureStream idiom). */
class NodeTrajectoryImpl implements NodeTrajectory {
  private _state: NodeTrajectoryState = "uploading";
  private handle: TrajectoryHandle | null = null;
  /** The controller the uploaded table lives on (null while detached). */
  owner: Controller | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly frameListeners = new Set<
    (f: TrajectoryFrameOutcome) => void
  >();
  private readonly stateListeners = new Set<
    (
      state: NodeTrajectoryState,
      detail: { controllerAvailable: boolean },
    ) => void
  >();
  private readonly log = new RateLimitedLog();
  // Run + lifetime stats.
  private startHostNs: bigint | null = null;
  /** The controller offset `startHostNs` is expressed under (a re-ping moves
   *  it; `rebaseStart` follows, so lateness never steps). */
  private startOffsetNs = 0n;
  private startExact = false;
  private cyclesSeen = 0;
  private lastMarker: number | null = null;
  private lastCycle: number | null = null;
  private lastLatenessUs: number | null = null;
  private readonly statusCounts: Record<string, number> = {};
  private heldPushes = 0;
  private reuploads = 0;
  private lastSwap: TrajectorySwapKind | null = null;
  /** Table ids other than the current one that may still push, each scored
   *  against ITS OWN spec: every id a swap retired, while its grace runs
   *  (`untilNs` = the controller's grace from the swap instant — set at the
   *  swap itself via `onSwap`, before `replace` resolves; one entry per id,
   *  so a second swap inside the first's grace keeps both), and an ambiguous
   *  replacement that may be live (`untilNs: null`, until the next swap or
   *  the run's end graces it). */
  private readonly retired = new Map<
    number,
    { spec: TrajectorySpec; untilNs: bigint | null }
  >();
  // replace(): ONE swap in flight; further calls COALESCE into a single
  // pending batch whose spec is the latest one (every coalesced caller
  // resolves/rejects with that batch). `replacingSpec` is the in-flight
  // spec — pushes from the new table id are scored against it until the
  // swap lands.
  private replaceInflight: Promise<void> | null = null;
  private replacePending: {
    spec: TrajectorySpec;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  private replacingSpec: TrajectorySpec | null = null;

  readonly wiringNode: WiredNode = {
    id: trajectoryNodeId(),
    kind: "trajectory",
    output: TRAJECTORY_STREAM,
    transport: "native",
  };

  constructor(
    private readonly node: ControllerNode,
    readonly name: string,
    private spec: TrajectorySpec,
  ) {}

  get id(): number | null {
    return this.handle?.id ?? null;
  }

  get state(): NodeTrajectoryState {
    return this._state;
  }

  /** Re-express `startHostNs` under the controller's CURRENT MCU→host offset:
   *  push timestamps ride that offset, the START carried an MCU instant. */
  private rebaseStart(): void {
    const offset = this.node.liveController?.clockOffsetNs;
    if (
      typeof offset !== "bigint" ||
      offset === this.startOffsetNs ||
      this.startHostNs === null
    )
      return;
    this.startHostNs += offset - this.startOffsetNs;
    this.startOffsetNs = offset;
  }

  /** Unnarrowed state probe (the state changes across awaits). */
  private isState(state: NodeTrajectoryState): boolean {
    return this._state === state;
  }

  private setState(
    state: NodeTrajectoryState,
    controllerAvailable = false,
  ): void {
    this._state = state;
    for (const cb of this.stateListeners) {
      try {
        cb(state, { controllerAvailable });
      } catch {
        // a session listener fault must not wedge the node
      }
    }
  }

  /** @internal — upload to `c` (open / reupload). Enables first (START needs
   *  an enabled system; enable-iff-we-enabled bookkeeping is the node's). */
  async upload(c: Controller): Promise<void> {
    this.setState("uploading");
    await this.node.ensureEnabled(c);
    const h = await c.uploadTrajectory(this.spec);
    if (this._state !== "uploading" || this.node.liveController !== c) {
      // Closed / unbound / swapped while uploading — the table is orphaned.
      try {
        await h.dispose();
      } catch {
        // best-effort — the device may already be gone
      }
      throw new Error(
        this._state === "closed"
          ? "trajectory closed during upload"
          : "controller changed during trajectory upload",
      );
    }
    this.handle = h;
    this.owner = c;
    this.unsubscribe = h.onFrame((f) => this.onPush(f));
    this.setState("ready");
  }

  /** @internal — a failed open: free the slot without wire traffic beyond
   *  what upload() already cleaned up. */
  async discard(): Promise<void> {
    this._state = "closed";
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle = null;
    this.owner = null;
    await this.node.retireTrajectory(this);
  }

  async start(atHostNs?: bigint, cycles = 0): Promise<void> {
    if (this._state === "detached")
      throw new Error(
        `Trajectory "${this.name}" is detached (controller unbound or swapped) — reupload() or close() it`,
      );
    if (this._state === "closed")
      throw new Error(`Trajectory "${this.name}" is closed`);
    if (this._state === "uploading")
      throw new Error(`Trajectory "${this.name}" is still uploading`);
    if (this._state === "running")
      throw new Error(
        `Trajectory "${this.name}" is already running — stop() it first`,
      );
    const h = this.handle!;
    // Per-run stats. t_start = 0 ("now" on the MCU) leaves only a host-side
    // estimate of the start instant — lateness is then approximate.
    this.startHostNs = atHostNs ?? hostNowNs();
    this.startOffsetNs = this.node.liveController?.clockOffsetNs ?? 0n;
    this.startExact = atHostNs !== undefined;
    this.cyclesSeen = 0;
    this.lastMarker = null;
    this.lastCycle = null;
    this.lastLatenessUs = null;
    // Hold inputs BEFORE START goes out: no stream write may race it.
    this.setState("running");
    this.node.noteTrajectoryStart();
    try {
      await h.start(atHostNs, cycles);
    } catch (error) {
      if (this.isState("running")) {
        this.setState("ready");
        this.node.resumeInputs();
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    // A replace in flight (and a coalesced pending one) lands first.
    if (this.replaceInflight) await this.drainReplace();
    if (this._state !== "running") return;
    await this.handle!.stop();
    this.endRun();
  }

  /** Run over (STOP ack / ENDED / run-level CANCELLED): inputs re-take the DAC. */
  private endRun(): void {
    if (this._state !== "running") return;
    // A possibly-live replacement is done with once the run ends (the
    // controller's stop() STOPs it and graces its id).
    for (const [id, r] of this.retired)
      if (r.untilNs === null)
        this.graceRetired(id, r.spec, trajectoryGraceUs(r.spec));
    this.setState("ready");
    this.node.resumeInputs();
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    // A pending (coalesced, not yet sent) replace is moot; an in-flight one
    // lands first so its tables are known before STOP/DELETE.
    const pending = this.replacePending;
    this.replacePending = null;
    pending?.reject(
      new Error(`Trajectory "${this.name}" closed before the replace was sent`),
    );
    if (this.replaceInflight) {
      await this.drainReplace();
      if (this.isState("closed")) return; // a concurrent close won
    }
    const wasRunning = this._state === "running";
    const h = this.handle;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle = null;
    this.owner = null;
    this.setState("closed");
    this.frameListeners.clear();
    this.retired.clear();
    if (h) {
      try {
        if (wasRunning) await h.stop();
      } catch {
        // best-effort — DELETE stops a running table anyway
      }
      try {
        await h.dispose(); // DELETE
      } catch {
        // best-effort — the device may already be gone
      }
    }
    if (wasRunning) this.node.resumeInputs();
    this.stateListeners.clear();
    await this.node.retireTrajectory(this);
  }

  onFrame(cb: (frame: TrajectoryFrameOutcome) => void): () => void {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  onStateChange(
    cb: (
      state: NodeTrajectoryState,
      detail: { controllerAvailable: boolean },
    ) => void,
  ): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** See {@link NodeTrajectory.replace}. Concurrency: one swap at a time;
   *  calls made while one is in flight COALESCE — the latest spec wins and
   *  is sent once the in-flight swap lands (intermediate specs are never
   *  uploaded; every coalesced caller settles with that one swap). */
  replace(spec: TrajectorySpec): Promise<void> {
    try {
      this.assertReplaceable(spec);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.replaceInflight) return this.launchReplace(spec);
    if (this.replacePending) {
      this.replacePending.spec = spec;
      return this.replacePending.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.replacePending = { spec, promise, resolve, reject };
    return promise;
  }

  private assertReplaceable(spec: TrajectorySpec): void {
    if (this._state === "detached")
      throw new Error(
        `Trajectory "${this.name}" is detached (controller unbound or swapped) — reupload() or close() it`,
      );
    if (this._state === "closed")
      throw new Error(`Trajectory "${this.name}" is closed`);
    if (this._state === "uploading")
      throw new Error(`Trajectory "${this.name}" is still uploading`);
    const current = this.replacingSpec ?? this.spec;
    if (this._state === "running" && spec.periodUs !== current.periodUs)
      throw new Error(
        `Trajectory "${this.name}": replace while running needs the same period (${current.periodUs} µs, got ${spec.periodUs} µs) — stop() first`,
      );
  }

  /** Start one swap; when it settles, launch the coalesced pending batch (if
   *  any) BEFORE any awaiter of this one resumes, so `drainReplace` sees it. */
  private launchReplace(spec: TrajectorySpec): Promise<void> {
    const p = this.runReplace(spec);
    this.replaceInflight = p;
    const after = () => {
      if (this.replaceInflight === p) this.replaceInflight = null;
      const next = this.replacePending;
      this.replacePending = null;
      if (next) this.launchReplace(next.spec).then(next.resolve, next.reject);
    };
    void p.then(after, after);
    return p;
  }

  private async runReplace(spec: TrajectorySpec): Promise<void> {
    this.assertReplaceable(spec); // re-checked: a coalesced batch runs later
    const h = this.handle!;
    const oldId = h.id;
    const oldSpec = this.spec;
    this.replacingSpec = spec;
    // The swap lands INSIDE h.replace (the controller's `onSwap`, before the
    // old table's DELETE and before replace resolves): from that instant the
    // new id is current (scored against `spec`) and each retired id is
    // scored against its own spec for exactly the controller's grace.
    let swapped = false;
    const landSwap = (
      to: number,
      retired: ReadonlyArray<{ id: number; graceUs: number }>,
    ) => {
      if (swapped || this.handle !== h) return;
      swapped = true;
      for (const r of retired)
        this.graceRetired(
          r.id,
          r.id === oldId ? oldSpec : (this.retired.get(r.id)?.spec ?? oldSpec),
          r.graceUs,
        );
      this.retired.delete(to);
      this.spec = spec;
    };
    try {
      await h.replace(spec, { onSwap: (e) => landSwap(e.to, e.retired) });
    } catch (error) {
      const e = error as {
        running?: boolean;
        replacement?: { id: number; maybeLive: boolean } | null;
      } | null;
      // The replacement table id stays routed here after the failure (it may
      // have played for a moment, or may be live): its pushes belong to `spec`.
      if (e?.replacement && this.handle === h) {
        if (e.replacement.maybeLive)
          this.retired.set(e.replacement.id, { spec, untilNs: null });
        else this.graceRetired(e.replacement.id, spec, trajectoryGraceUs(spec));
      }
      // The swap failed and the old table could not be re-STARTed: the run
      // is over — inputs re-take the DAC.
      if (e?.running === false && this.handle === h) this.endRun();
      throw error;
    } finally {
      this.replacingSpec = null;
    }
    // A handle without the `onSwap` hook: the swap is seen only now.
    if (!swapped && h.id !== oldId)
      landSwap(h.id, [{ id: oldId, graceUs: trajectoryGraceUs(oldSpec) }]);
    // Running stays running (inputs stay held, no resume); the new spec is
    // what reupload() sends and what lateness is scored against.
    this.spec = spec;
    this.reuploads++;
    this.lastSwap = h.lastSwap ?? this.lastSwap;
  }

  /** Score `id`'s pushes against `spec` for `graceUs` from now (0: forget). */
  private graceRetired(
    id: number,
    spec: TrajectorySpec,
    graceUs: number,
  ): void {
    if (graceUs <= 0) this.retired.delete(id);
    else
      this.retired.set(id, {
        spec,
        untilNs: hostNowNs() + BigInt(Math.ceil(graceUs)) * 1000n,
      });
  }

  /** The spec a push of table `id` is scored against: the current table's;
   *  a retired / possibly-live id's own (inside its grace); mid-swap, any
   *  other id is the new table — the in-flight spec. */
  private specForPush(id: number): TrajectorySpec {
    if (id === this.handle?.id) return this.spec;
    const r = this.retired.get(id);
    if (r) {
      if (r.untilNs === null || hostNowNs() < r.untilNs) return r.spec;
      this.retired.delete(id); // expired — the controller unrouted it too
    }
    return this.replacingSpec ?? this.spec;
  }

  /** Wait until no replace is in flight or pending (errors are the callers'). */
  private async drainReplace(): Promise<void> {
    while (this.replaceInflight) await this.replaceInflight.catch(() => {});
  }

  async reupload(): Promise<void> {
    if (this._state !== "detached")
      throw new Error(
        `Trajectory "${this.name}" is ${this._state}, not detached`,
      );
    const c = this.node.liveController;
    if (!c) throw new Error("reupload requires a bound controller");
    if (!c.v22Capable)
      throw new Error(
        "reupload requires firmware >= 2.2.0 (CMD_TRAJECTORY unavailable)",
      );
    try {
      await this.upload(c);
    } catch (error) {
      if (this.isState("uploading")) this.setState("detached");
      throw error;
    }
  }

  /** @internal — the controller went away (unbind / swap / node dispose):
   *  stop listening, forget the table (it lived on that device), no wire. */
  detach(): void {
    if (this._state === "closed" || this._state === "detached") return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handle = null;
    this.owner = null;
    this.setState("detached");
  }

  /** @internal — a position-input push was held during this run. */
  noteHeldPush(): void {
    this.heldPushes++;
  }

  /** @internal — a controller bound while detached: report, never reupload. */
  notifyRebind(controllerAvailable: boolean): void {
    if (this._state === "detached")
      this.setState("detached", controllerAvailable);
  }

  private onPush(f: TrajectoryFrameOutcome): void {
    if (this._state === "closed" || this._state === "detached") return;
    this.statusCounts[f.status] = (this.statusCounts[f.status] ?? 0) + 1;
    if (f.marker !== null) {
      this.lastMarker = f.marker;
      this.lastCycle = f.cycle;
      if (f.cycle + 1 > this.cyclesSeen) this.cyclesSeen = f.cycle + 1;
    }
    if (f.status === "OK" && f.marker !== null) {
      // Scored per table id (`specForPush`): a retired table's straggler
      // against its own spec, the new table mid-swap against the in-flight one.
      const spec = this.specForPush(f.trajectoryId);
      const marker = spec.markers?.[f.marker];
      if (marker && this.startHostNs !== null) {
        this.rebaseStart();
        this.lastLatenessUs =
          Number(
            f.tTrigger -
              expectedTriggerNs(
                this.startHostNs,
                f.cycle,
                spec.periodUs,
                marker.tOffsetUs,
              ),
          ) / 1000;
      }
      this.node.forwardTrajectoryFrame(f);
    } else {
      this.log.note(
        f.status,
        `controller: trajectory "${this.name}" (id ${f.trajectoryId}) push ${f.status}` +
          (f.marker === null
            ? " (run-level)"
            : ` at marker ${f.marker}, cycle ${f.cycle}`),
      );
      // Run-level end: the MCU no longer owns the DAC (ENDED → HOLD at phase
      // 0; CANCELLED → system disabled).
      if (
        f.marker === null &&
        (f.status === "ENDED" || f.status === "CANCELLED")
      )
        this.endRun();
    }
    for (const cb of this.frameListeners) {
      try {
        cb(f);
      } catch (error) {
        console.error("trajectory onFrame listener threw:", error);
      }
    }
  }

  snapshot(): TrajectoryStat {
    return {
      name: this.name,
      id: this.id,
      state: this._state,
      running: this._state === "running",
      periodUs: this.spec.periodUs,
      markers: this.spec.markers?.length ?? 0,
      cyclesSeen: this.cyclesSeen,
      statusCounts: { ...this.statusCounts },
      lastMarker: this.lastMarker,
      lastCycle: this.lastCycle,
      lastLatenessUs: this.lastLatenessUs,
      latenessExact: this.startExact,
      heldPushes: this.heldPushes,
      reuploads: this.reuploads,
      lastSwap: this.lastSwap,
    };
  }
}

async function safeClose(s: StreamHandle): Promise<void> {
  try {
    await s.close();
  } catch {
    // best-effort TERMINATE — a dropped controller may already be gone
  }
}

function clonePair(p: PositionPair): PositionPair {
  return {
    left: { x: p.left.x, y: p.left.y },
    right: { x: p.right.x, y: p.right.y },
  };
}

// --- module singleton (obtained like `activeController`) ---------------------
// ONE node per orchestrator process. `controllerNode()` lazily creates it (and
// registers its topology wiring); index.ts touches it at startup and
// sessions/controller.ts binds/unbinds the device on it.

let singleton: ControllerNode | null = null;

export function controllerNode(): ControllerNode {
  if (!singleton) singleton = new ControllerNode();
  return singleton;
}

/** Test hook: dispose + clear the singleton between cases. */
export function resetControllerNodeForTest(): void {
  singleton?.dispose();
  singleton = null;
}

/** A recursive-`setTimeout` pace loop (fake-timer friendly) for sessions that
 *  drive a position input at a fixed cadence — the push-model replacement for
 *  `startActuationLoop`'s internal 1 ms timer (the SESSION now owns the pacing;
 *  the node only transports). Returns a stop function. A throwing tick is
 *  swallowed so one bad frame can't kill the loop. */
export function startPacer(intervalMs: number, tick: () => void): () => void {
  let running = true;
  void (async () => {
    while (running) {
      try {
        tick();
      } catch {
        // a bad tick must not tear the pace loop down
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return () => {
    running = false;
  };
}
