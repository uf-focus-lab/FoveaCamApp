// Two-stage auto-tune — run machine + optimizer SMOKE TEST against a toy
// delayed plant driven through the real `stepVergence`/`followTarget` law
// (simulation is used only to smoke-test the optimizer itself). This asserts
// the pipeline produces finite, bounded gains that improve the SIM cost vs
// DEFAULT_TUNING — it is
// NOT a claim about the rig (spec docs/spec/disparity-scope.md#autotune).

import { describe, expect, it } from "vitest";
import { PID, PID2D } from "@lib/pid";
import type { Point2d } from "core/Geometry";
import type { CoordinateConversions } from "@lib/coordinate-conversions";
import {
  followTarget,
  stepVergence,
  type ScopeProjection,
} from "@lib/vergence/vergence";
import {
  AutotuneRun,
  DOF_ORDER,
  gainsToVector,
  vectorToGains,
  mergeRelayGains,
  type AutotuneHooks,
  type AutotuneOptions,
  type AutotuneProgress,
  type AutotuneStage,
  type DofErrors,
  type GainSet,
  type GainTriple,
} from "@modules/disparity-scope/autotune";
import {
  regulationCost,
  stepCost,
  type StepTraceSample,
} from "@modules/disparity-scope/step-cost";
import { DEFAULT_TUNING } from "@modules/disparity-scope/contract";

const identityConv: Pick<CoordinateConversions, "P2A" | "A2V"> = {
  P2A: { C: (p: Point2d) => p },
  A2V: { L: (a: Point2d) => a, R: (a: Point2d) => a },
};

// Physical envelope mirroring the session's (rad; contract limit constants).
const SHIFT_LIM = 0.0873;
const VSHIFT_LIM = 0.0349;
const BASELINE = 200;
const VERGE_MAX = Math.sqrt(BASELINE / 150);
/** Scene plane depth; verge equilibrium = √(BASELINE/Zs) ≈ 0.6. */
const SCENE_Z = 555.6;
const VERGE0 = Math.sqrt(BASELINE / SCENE_Z);

const DEFAULT_GAINS: GainSet = {
  pan: [...DEFAULT_TUNING.pan],
  depth: [...DEFAULT_TUNING.depth],
  v_shift: [...DEFAULT_TUNING.v_shift],
};

type Pose = { l: Point2d; r: Point2d };
type Controllers = { pan: PID2D; verge: PID; v_shift: PID };

function makeControllers(): Controllers {
  const MEAS = { derivativeOn: "measurement" as const };
  const axis = { ...MEAS, limits: [-SHIFT_LIM, SHIFT_LIM] as [number, number] };
  return {
    pan: new PID2D({ x: axis, y: axis }),
    verge: new PID({ ...MEAS, limits: [0, VERGE_MAX] }),
    v_shift: new PID({ ...MEAS, limits: [-VSHIFT_LIM, VSHIFT_LIM] }),
  };
}

function applyGainsTo(ctl: Controllers, g: GainSet): void {
  const p = (t: GainTriple) => ({ kp: t[0], ki: t[1], kd: t[2] });
  ctl.pan.setParams({ x: p(g.pan), y: p(g.pan) });
  ctl.verge.setParams(p(g.depth));
  ctl.v_shift.setParams(p(g.v_shift));
}

// The session's error decomposition over an identity-conv projection.
function decompose(p: ScopeProjection): DofErrors {
  const { l: aL, r: aR, target: aT } = p;
  return {
    panX: (aT.x - aL.x + (aT.x - aR.x)) / 2,
    panY: (aT.y - aL.y + (aT.y - aR.y)) / 2,
    verge: aR.x - aL.x,
    v_shift: (aR.y - aL.y) / 2,
  };
}

/** Miscalibrated actuation map (an A2V regression error): the reconstruction's
 *  target feedthrough lands short, leaving the residual only FEEDBACK removes —
 *  without it a scripted target step exercises the plant, not the gains. */
const GAIN_ERR = 0.85;

/**
 * Toy plant: mirror pose follows the command with a first-order lag through a
 * miscalibrated gain, the MATCHED CENTERS are the gaze rays' intersections
 * with a frontal scene plane at `SCENE_Z` re-projected into the wide camera
 * (eyes at x = ∓baseline/2 — the same geometry `inverseTriangulate`
 * commands), and the measurement rides a transport delay line — the
 * capture→match pipeline lag the proposal names.
 */
class Sim {
  t = 0;
  readonly base: Point2d = { x: 0.1, y: 0.05 };
  target: Point2d = { ...this.base };
  readonly ctl = makeControllers();
  lastErrors: DofErrors | null = null;
  /** Test hook: distort the measured errors (e.g. sever one DOF's channel). */
  mangle: (e: DofErrors) => DofErrors = (e) => e;
  private cmd: Pose;
  private pose: Pose;
  private line: Pose[] = [];

  constructor(gains: GainSet, readonly tau = 2, readonly delay = 3) {
    applyGainsTo(this.ctl, gains);
    this.ctl.verge.value = VERGE0; // converged on the scene plane
    const v = this.follow();
    this.cmd = v;
    this.pose = { l: { ...v.l }, r: { ...v.r } };
    for (let i = 0; i < this.delay; i++) this.line.push(this.snapshot());
  }

  private held() {
    return {
      pan: this.ctl.pan.value,
      verge: this.ctl.verge.value,
      v_shift: this.ctl.v_shift.value,
    };
  }

  private follow(): Pose {
    const v = followTarget(this.target, this.held(), identityConv, BASELINE);
    return { l: v.left, r: v.right };
  }

  private snapshot(): Pose {
    return { l: { ...this.pose.l }, r: { ...this.pose.r } };
  }

  /** Gaze angles → matched centers on the wide frame via the scene plane. */
  private project(p: Pose): Pose {
    const b = BASELINE / 2;
    return {
      l: { x: Math.atan((-b + SCENE_Z * Math.tan(p.l.x)) / SCENE_Z), y: p.l.y },
      r: { x: Math.atan((b + SCENE_Z * Math.tan(p.r.x)) / SCENE_Z), y: p.r.y },
    };
  }

  /** One camera/match tick — mirrors the session's autotune control tick. */
  tick(run: AutotuneRun | null): void {
    this.t++;
    for (const eye of ["l", "r"] as const) {
      this.pose[eye].x += (GAIN_ERR * this.cmd[eye].x - this.pose[eye].x) / this.tau;
      this.pose[eye].y += (GAIN_ERR * this.cmd[eye].y - this.pose[eye].y) / this.tau;
    }
    this.line.push(this.snapshot());
    const meas = this.project(this.line.shift()!);
    const projection: ScopeProjection = {
      l: meas.l,
      r: meas.r,
      target: { ...this.target },
      scores: { l: 1, r: 1 },
      overridden: false,
    };
    const errors = this.mangle(decompose(projection));
    this.lastErrors = errors;
    const mode =
      run && !run.done
        ? run.feed({ t: this.t, errors, scoreOk: true }).mode
        : "step";
    if (mode === "step") {
      const r = stepVergence(
        projection,
        this.ctl,
        identityConv,
        { baseline: BASELINE, minScore: 0.1 },
        1,
      );
      if (r) this.cmd = { l: r.left, r: r.right };
    } else if (mode === "drive") {
      this.cmd = this.follow();
    }
  }
}

type Outcome = { phase: string; gains: GainSet | null; message: string | null };

function attachRun(
  sim: Sim,
  stage: AutotuneStage,
  opts: Partial<AutotuneOptions> = {},
  hookOverrides: Partial<AutotuneHooks> = {},
) {
  const progress: AutotuneProgress[] = [];
  const result: { outcome: Outcome | null } = { outcome: null };
  const run = new AutotuneRun(
    stage,
    {
      dof: {
        panX: {
          get: () => sim.ctl.pan.x.value,
          set: (v) => {
            sim.ctl.pan.x.value = v;
          },
          range: [-SHIFT_LIM, SHIFT_LIM],
        },
        panY: {
          get: () => sim.ctl.pan.y.value,
          set: (v) => {
            sim.ctl.pan.y.value = v;
          },
          range: [-SHIFT_LIM, SHIFT_LIM],
        },
        verge: {
          get: () => sim.ctl.verge.value,
          set: (v) => {
            sim.ctl.verge.value = v;
          },
          range: [0, VERGE_MAX],
        },
        v_shift: {
          get: () => sim.ctl.v_shift.value,
          set: (v) => {
            sim.ctl.v_shift.value = v;
          },
          range: [-VSHIFT_LIM, VSHIFT_LIM],
        },
      },
      applyGains: (g) => applyGainsTo(sim.ctl, g),
      setTargetOffset: (px) => {
        sim.target = { x: sim.base.x + px, y: sim.base.y };
      },
      progress: (p) => progress.push(p),
      finished: (o) => {
        result.outcome = o;
      },
      ...hookOverrides,
    },
    {
      initialGains: DEFAULT_GAINS,
      seed: 5,
      stepPx: 0.02,
      settleTime: 30,
      levelTimeout: 200,
      dofTimeout: 1000,
      evalSettle: 60,
      evalWindow: 150,
      evalBudget: 24,
      startT: 0,
      ...opts,
    },
  );
  return { run, progress, result };
}

function runToCompletion(sim: Sim, run: AutotuneRun, cap = 30000): number {
  let ticks = 0;
  while (!run.done && ticks < cap) {
    sim.tick(run);
    ticks++;
  }
  return ticks;
}

/** Independent scripted-step cost of a gain set on a FRESH sim — the same
 *  combined objective the run's eval scores (stepped-DOF cost + cross-DOF
 *  regulation), measured outside the optimizer (the smoke test's before/after
 *  yardstick). */
function measureStepCost(gains: GainSet): number {
  const sim = new Sim(gains);
  for (let i = 0; i < 300; i++) sim.tick(null); // settle at the base target
  sim.target = { x: sim.base.x + 0.02, y: sim.base.y };
  const t0 = sim.t;
  const trace: Record<keyof DofErrors, StepTraceSample[]> = {
    panX: [],
    panY: [],
    verge: [],
    v_shift: [],
  };
  for (let i = 0; i < 200; i++) {
    sim.tick(null);
    for (const dof of DOF_ORDER)
      trace[dof].push({
        t: sim.t - t0,
        error: sim.lastErrors![dof],
        command: sim.ctl.pan.x.value,
      });
  }
  let peak = 0;
  for (const s of trace.panX) peak = Math.max(peak, Math.abs(s.error));
  let cost = stepCost(trace.panX);
  for (const dof of DOF_ORDER)
    if (dof !== "panX") cost += regulationCost(trace[dof], peak);
  return cost;
}

const finiteGainSet = (g: GainSet): boolean =>
  ([...g.pan, ...g.depth, ...g.v_shift] as number[]).every(
    (v) => Number.isFinite(v) && v >= 0,
  );

describe("AutotuneRun — relay stage on the toy plant", () => {
  it("tunes all four DOFs and lands finite, bounded Tyreus-Luyben gains", () => {
    const sim = new Sim(DEFAULT_GAINS);
    const { run, progress, result } = attachRun(sim, "relay");
    runToCompletion(sim, run);
    expect(result.outcome?.phase).toBe("done");
    const gains = result.outcome!.gains!;
    expect(finiteGainSet(gains)).toBe(true);
    expect(result.outcome!.message).toBeNull(); // every DOF found a limit cycle
    // The relay actually derived something: pan is far off the sluggish default.
    expect(gains.pan[0]).toBeGreaterThan(DEFAULT_GAINS.pan[0]);
    // Progress walked every DOF then terminated.
    const dofsSeen = new Set(progress.map((p) => p.dof).filter(Boolean));
    for (const dof of DOF_ORDER) expect(dofsSeen.has(dof)).toBe(true);
    expect(progress[progress.length - 1]!.phase).toBe("done");
    expect(progress.some((p) => p.phase === "eval")).toBe(false);
    // The run returned to the pre-tune pose (relay restores each DOF center).
    expect(sim.ctl.pan.x.value).toBeCloseTo(0, 6);
    expect(sim.ctl.verge.value).toBeCloseTo(VERGE0, 6);
  });

  it("a dead DOF gets a per-DOF failure verdict; the others still tune", () => {
    const sim = new Sim(DEFAULT_GAINS);
    sim.mangle = (e) => ({ ...e, v_shift: 0 }); // sever the v_shift channel
    const { run, result } = attachRun(sim, "relay", { dofTimeout: 400 });
    runToCompletion(sim, run);
    expect(result.outcome?.phase).toBe("done");
    // The per-DOF failure VERDICT reaches the message, not just the DOF name.
    expect(result.outcome!.message).toContain("v_shift: no oscillation");
    // The failed DOF keeps its pre-tune triple; the healthy ones moved.
    expect(result.outcome!.gains!.v_shift).toEqual(DEFAULT_GAINS.v_shift);
    expect(result.outcome!.gains!.pan[0]).toBeGreaterThan(DEFAULT_GAINS.pan[0]);
  });
});

describe("AutotuneRun — full stage (relay + CMA-ES polish) SIMULATION SMOKE TEST", () => {
  it("produces bounded gains whose sim step cost beats DEFAULT_TUNING", () => {
    const sim = new Sim(DEFAULT_GAINS);
    const { run, progress, result } = attachRun(sim, "full");
    const ticks = runToCompletion(sim, run);
    expect(ticks).toBeLessThan(30000); // terminated within the budget
    expect(result.outcome?.phase).toBe("done");
    const gains = result.outcome!.gains!;
    expect(finiteGainSet(gains)).toBe(true);
    // Bounded: the polish is boxed to ±1 decade around the relay seed, so no
    // gain can exceed 10× the largest relay seed — sanity-cap at an absurd 1e3.
    for (const v of gainsToVector(gains)) expect(v).toBeLessThan(1e3);
    // Progress: relay → eval → done, budget fully consumed (24 CMA + baseline
    // + seed), baseline (DEFAULT gains) cost recorded, best improved on it.
    const last = progress[progress.length - 1]!;
    expect(progress.some((p) => p.phase === "eval")).toBe(true);
    expect(last.phase).toBe("done");
    expect(last.evals).toBe(26);
    expect(last.baselineCost).not.toBeNull();
    expect(last.bestCost).not.toBeNull();
    expect(last.bestCost!).toBeLessThan(last.baselineCost!);
    // THE smoke assertion: independently measured scripted-step cost improves
    // vs DEFAULT_TUNING under the identical protocol.
    const before = measureStepCost(DEFAULT_GAINS);
    const after = measureStepCost(gains);
    expect(after).toBeLessThan(before);
  });

  it("is deterministic per seed (same plant, same gains out)", () => {
    const runOnce = (): GainSet => {
      const sim = new Sim(DEFAULT_GAINS);
      const { run, result } = attachRun(sim, "full", { evalBudget: 12 });
      runToCompletion(sim, run);
      return result.outcome!.gains!;
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

describe("AutotuneRun — abort / starvation (fail closed, never wedge)", () => {
  it("abort mid-relay finishes 'aborted' with null gains and goes inert", () => {
    const sim = new Sim(DEFAULT_GAINS);
    const { run, result, progress } = attachRun(sim, "relay");
    for (let i = 0; i < 50; i++) sim.tick(run);
    run.abort("test abort");
    expect(result.outcome).toEqual({
      phase: "aborted",
      gains: null,
      message: "test abort",
    });
    expect(progress[progress.length - 1]!.phase).toBe("aborted");
    // Inert afterwards: feeds hold, no further terminal callbacks.
    expect(run.feed({ t: 1e6, errors: sim.lastErrors!, scoreOk: true })).toEqual(
      { mode: "hold" },
    );
    expect(run.done).toBe(true);
  });

  it("starved() flags a dead sample feed for the session watchdog", () => {
    const sim = new Sim(DEFAULT_GAINS);
    const { run } = attachRun(sim, "relay", { starveTimeout: 100 });
    expect(run.starved(50)).toBe(false);
    expect(run.starved(101)).toBe(true); // nothing ever fed
    sim.tick(run);
    expect(run.starved(sim.t + 99)).toBe(false);
    expect(run.starved(sim.t + 101)).toBe(true);
  });

  it("fail() (the watchdog path) finishes 'failed' — never 'aborted' (user action)", () => {
    const sim = new Sim(DEFAULT_GAINS);
    const { run, result, progress } = attachRun(sim, "relay");
    for (let i = 0; i < 20; i++) sim.tick(run);
    run.fail("no match samples (match feed stalled)");
    expect(result.outcome).toEqual({
      phase: "failed",
      gains: null,
      message: "no match samples (match feed stalled)",
    });
    expect(progress[progress.length - 1]!.phase).toBe("failed");
    expect(run.done).toBe(true);
  });

  it("a persistent low-score stream fails the run closed", () => {
    const sim = new Sim(DEFAULT_GAINS);
    const { run, result } = attachRun(sim, "relay", { starveTimeout: 100 });
    for (let t = 1; t < 300 && !run.done; t++)
      run.feed({ t, errors: sim.lastErrors ?? { panX: 0, panY: 0, verge: 0, v_shift: 0 }, scoreOk: false });
    expect(result.outcome?.phase).toBe("failed");
    expect(result.outcome!.message).toMatch(/no trusted matches/);
  });
});

describe("gain vector plumbing (pure helpers)", () => {
  it("gainsToVector/vectorToGains round-trip", () => {
    const g: GainSet = { pan: [1, 2, 3], depth: [4, 5, 6], v_shift: [7, 8, 9] };
    expect(vectorToGains(gainsToVector(g))).toEqual(g);
  });

  it("mergeRelayGains: pan = elementwise min of both axes (conservative)", () => {
    const merged = mergeRelayGains(DEFAULT_GAINS, {
      panX: { kp: 1, ki: 0.5, kd: 2 },
      panY: { kp: 0.8, ki: 0.7, kd: 3 },
    });
    expect(merged.pan).toEqual([0.8, 0.5, 2]);
    expect(merged.depth).toEqual(DEFAULT_GAINS.depth); // no verdict → kept
    expect(merged.v_shift).toEqual(DEFAULT_GAINS.v_shift);
  });

  it("mergeRelayGains: single-axis pan verdict and per-group mapping", () => {
    const merged = mergeRelayGains(DEFAULT_GAINS, {
      panY: { kp: 0.4, ki: 0.1, kd: 0.2 },
      verge: { kp: 2, ki: 0.3, kd: 1 },
      v_shift: { kp: 0.05, ki: 0.02, kd: 0.01 },
    });
    expect(merged.pan).toEqual([0.4, 0.1, 0.2]);
    expect(merged.depth).toEqual([2, 0.3, 1]);
    expect(merged.v_shift).toEqual([0.05, 0.02, 0.01]);
  });

  it("mergeRelayGains never mutates the initial set", () => {
    const initial = structuredClone(DEFAULT_GAINS);
    mergeRelayGains(initial, { verge: { kp: 9, ki: 9, kd: 9 } });
    expect(initial).toEqual(DEFAULT_GAINS);
  });
});
