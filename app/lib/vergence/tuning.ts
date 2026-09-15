// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The vergence loop's SHARED tuning surface — the per-DOF gain triples, the
// match knobs, and the physical saturation limits. Both apps that run the
// fovea-into-wide template-match loop expose these identically (same keys,
// same defaults, same drawer block), so a rig operator reads one control panel.
// Pure data. spec: docs/spec/disparity-scope.md#control-law

/** kp / ki / kd, in order — one triple per PID group. */
export type Gains = [number, number, number];

// Physical saturation limits, shared by the sessions (PID construction) and the
// renderers (slider ranges — the PIDs are server-side, so the UI recomputes them).
export const VERGE_MIN_DISTANCE_MM = 150;
export const SHIFT_LIMIT_DEG = 5;
export const VSHIFT_LIMIT_DEG = 2;

/** The tuning every vergence-loop app carries. Apps may EXTEND it with their
 *  own knobs (disparity-scope adds a convergence `timeout`). */
export type VergenceTuning = {
  pan: Gains;
  depth: Gains;
  v_shift: Gains;
  /** Control time-step per ms elapsed; higher = faster convergence. */
  sensitivity: number;
  /** Fovea-tile match scale in [0, 1] (0 = coarse/fast, 1 = full detail). */
  scale: number;
  /** Min CCOEFF score in [-1, 1] required to trust a correction. */
  min_score: number;
  /** Guide-strip expansion around the target tile. */
  expand_x: number;
  expand_y: number;
};

export const DEFAULT_VERGENCE_TUNING: VergenceTuning = {
  pan: [0.02, 0.02, 0],
  depth: [1.0, 0.2, 0.5],
  v_shift: [0.02, 0.02, 0],
  sensitivity: 0.1,
  scale: 0,
  min_score: 0.1,
  expand_x: 3.0,
  expand_y: 2.0,
};
