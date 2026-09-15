// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Auto-vergence PURE geometry + control math (the SESSION/PID-node side of the
// split): sizing (`foveaTileSize`, `matchMagnification`), `stepVergence`,
// `followTarget`, `seedVergence`, and the capture-epoch target ring
// (`recordTarget`/`targetAtEpoch`). Core-free (types only) so the control law +
// its tests never load the native addon. SHARED by every app that runs the
// fovea-into-wide template-match loop (disparity-scope, mirror-link). Behavior
// spec: docs/spec/disparity-scope.md (§control-law, §seed-space, §magnification,
// §needle-geometry).

import type { Point2d, Size } from "core/Geometry";
import { VEC } from "@lib/util/geometry";
import { PID } from "@lib/pid";
import { distanceToVerge, inverseTriangulate, vergeToDistance } from "@lib/stereo";
import type { CoordinateConversions } from "@lib/coordinate-conversions";

/** Fovea tile `dsize` for the needle SCALE node = `(width*scale)/zoom` per axis,
 *  landing the fovea view at `scale` px per wide px (CCOEFF is not scale-
 *  invariant, so it must meet the strip). `zoom` is the MATCH MAGNIFICATION (not
 *  the display crop zoom); `width`/`height` MUST be paired with `zoom`'s units —
 *  the session's `needleGeometry` owns the pairing (spec §needle-geometry). */
export function foveaTileSize(opts: {
  /** Frame width paired with `zoom` (fovea dims for measured, center for nominal). */
  width: number;
  /** Frame height, same pairing as `width`. */
  height: number;
  /** Match magnification (measured fovea↔wide ratio, else nominal zoom). */
  zoom: number;
  scale: number;
}): Size {
  const { width, height, zoom: z, scale: s } = opts;
  return { width: (width * s) / z, height: (height * s) / z };
}

// Re-export the fovea-footprint display math from the core-free
// display-geometry.ts (the renderer uses it and must not pull core/Vision) so
// the vision/control side keeps one import surface.
export { foveaFootprintOnWide } from "./display-geometry";

/** The fovea↔wide template-match magnification under the resolution order
 *  (spec §magnification): knob > per-triple override > measured > 1; each tier
 *  must be finite and > 0 or it falls through. `nominalZoom === 0` is "Auto". */
export function matchMagnification(
  measured: number | null | undefined,
  nominalZoom: number,
  tripleOverride?: number | null,
): number {
  if (Number.isFinite(nominalZoom) && nominalZoom > 0) return nominalZoom;
  if (tripleOverride != null && Number.isFinite(tripleOverride) && tripleOverride > 0)
    return tripleOverride;
  if (measured != null && Number.isFinite(measured) && measured > 0)
    return measured;
  return 1;
}

/** The minimal 2D controller shape {@link stepVergence} drives for `pan` —
 *  structurally satisfied by @lib/pid's `PID2D`, declared here (not imported) so
 *  the vergence math + its test stay independent of the 2D class. */
export interface Vec2Controller {
  step(error: Point2d, dt?: number, measurement?: Point2d): Point2d;
  readonly value: Point2d;
}

// --- capture-epoch target ring (spec §control-law) ----------------------

/** One target write: `t` = host steady-clock ns (the trusted-time domain every
 *  pipe frame's `deviceTimestamp` is calibrated into), `target` = the value
 *  written. The session appends one at EVERY `state.target` write. */
export type TargetSample = { t: number; target: Point2d };

/** Append a target write to the ring: monotonic-`t` (an out-of-order stamp is
 *  dropped so {@link targetAtEpoch}'s scan stays ordered), capped to
 *  `capacity` oldest-first. */
export function recordTarget(
  ring: TargetSample[],
  sample: TargetSample,
  capacity: number,
): void {
  const newest = ring[ring.length - 1];
  if (newest && sample.t < newest.t) return;
  ring.push(sample);
  if (ring.length > capacity) ring.splice(0, ring.length - capacity);
}

/** The target in effect at `epoch`: the NEWEST sample with `t ≤ epoch` (a
 *  write applies from its stamp onward). `fallback` (the live target) when the
 *  ring is empty, the epoch is missing/non-finite, or every sample is newer
 *  than the epoch — the out-of-coverage epoch an UNCALIBRATED camera clock
 *  produces lands here, degrading to the live-target fallback instead of
 *  resolving an arbitrarily stale entry. */
export function targetAtEpoch(
  ring: readonly TargetSample[],
  epoch: number | undefined,
  fallback: Point2d,
): Point2d {
  if (epoch === undefined || !Number.isFinite(epoch)) return fallback;
  for (let i = ring.length - 1; i >= 0; i--) {
    const s = ring[i]!;
    if (s.t <= epoch) return s.target;
  }
  return fallback;
}

/** The named DOF controllers the vergence step integrates (spec §control-law) —
 *  physically-meaningful DOF reconstructed symmetrically about the gaze ray,
 *  not four independent fovea pixel DOF. Live inside the PID node post-replumb. */
export type VergenceControllers = {
  /** Common-mode ray correction, x/y (rad) — a 2D controller. */
  pan: Vec2Controller;
  /** Inverse-√depth verge parameter (0 ⇒ ∞, larger ⇒ nearer). */
  verge: PID;
  /** Vertical half-shift between the foveas (rad). */
  v_shift: PID;
};

/** The scope's control INPUT: matched fovea centers + target on the UNDISTORTED
 *  wide frame (full-res px) + per-eye match confidence. Composed by the session's
 *  join from the two template-match results (spec §match-join). */
export type ScopeProjection = {
  l: Point2d;
  r: Point2d;
  /** The target AS OF THE MATCHED FRAME'S CAPTURE EPOCH (spec
   *  §control-law) — resolved by the join via {@link targetAtEpoch}, so the
   *  error pairs setpoint and measurement at the same instant. */
  target: Point2d;
  scores: { l: number; r: number };
  /** True while a pointer drag pins the target (session-local; the join stamps
   *  it) → DIRECT follow, not a PID step (spec §drag). */
  overridden: boolean;
};

export type VergenceControl = {
  /** Inter-fovea baseline (mm). */
  baseline: number;
  /** Minimum match score in [-1, 1] required to trust a correction. */
  minScore: number;
};

/**
 * Constrained vergence step (spec §control-law): lift matched centers + target
 * to center-camera angles (`P2A.C(px, false)` — undistorted input), decompose
 * into {pan, verge, v_shift} errors, integrate through the per-DOF PIDs
 * (velocity form; caller-supplied `dt` normalizes the rate), reconstruct both
 * fovea voltages via {@link inverseTriangulate}. Returns `null` (hold,
 * controllers untouched) when either match is below `minScore`.
 *
 * Error decomposition (`dL = aT − aL`, `dR = aT − aR`):
 *   pan     = (dL + dR) / 2                — common-mode mis-centering
 *   verge   = aR.x − aL.x = 2b(1/Z − 1/z)  — horizontal disparity ⇒ depth
 *   v_shift = (aR.y − aL.y) / 2            — residual vertical disparity (sign
 *             opposite pan.y: the foveas move OPPOSITE vertically — spec §control-law)
 *
 * Each PID also receives the DOF's measurement point (error = setpoint −
 * measurement), so measurement-derivative controllers never differentiate
 * target motion — see the inline decomposition table.
 */
export function stepVergence(
  projection: ScopeProjection,
  ctl: VergenceControllers,
  conv: Pick<CoordinateConversions, "P2A" | "A2V">,
  ctrl: VergenceControl,
  dt: number,
): { left: Point2d; right: Point2d } | null {
  if (
    !(projection.scores.l >= ctrl.minScore) ||
    !(projection.scores.r >= ctrl.minScore) // also rejects NaN scores
  )
    return null;
  // Undistorted wide pixel → center-camera angle (already strip-offset-folded).
  const toAngle = (p: Point2d) => conv.P2A.C(p, false);
  const aL = toAngle(projection.l);
  const aR = toAngle(projection.r);
  const aT = toAngle(projection.target); // == target ray
  // Constrained errors (see JSDoc).
  const dL = VEC.sub(aT, aL);
  const dR = VEC.sub(aT, aR);
  const ePan = VEC.mul(VEC.add(dL, dR), 0.5);
  const eVerge = aR.x - aL.x;
  const eVshift = (aR.y - aL.y) / 2;
  // Per-DOF MEASUREMENT points (spec §control-law), decomposed so
  // error = setpoint − measurement holds:
  //   pan     setpoint aT,  measurement (aL+aR)/2 — the ONLY DOF whose
  //           setpoint moves; measurement-derivative kills the target kick
  //   verge   setpoint 0 (disparity nulled), measurement aL.x − aR.x
  //   v_shift setpoint 0,                    measurement (aL.y − aR.y)/2
  // For verge/v_shift the constant-0 setpoint makes measurement mode
  // numerically identical to error mode — passed for uniformity.
  const mPan = VEC.mul(VEC.add(aL, aR), 0.5);
  // Each controller integrates its error, dt-scales it, and saturates to a
  // physical range so a bad estimate can at worst rest at a limit — never fling
  // a fovea. `pan` is a 2D controller (separate x/y integrators).
  const shift = ctl.pan.step(ePan, dt, mPan);
  const verge = ctl.verge.step(eVerge, dt, aL.x - aR.x);
  const v_shift = ctl.v_shift.step(eVshift, dt, (aL.y - aR.y) / 2);
  // Reconstruct both poses symmetrically about the (shift-corrected) ray.
  const ray = VEC.add(aT, shift);
  const distance = vergeToDistance(verge, ctrl.baseline);
  const A = inverseTriangulate(ray, ctrl.baseline, distance, v_shift);
  return { left: conv.A2V.L(A.l), right: conv.A2V.R(A.r) };
}

/** The controller state {@link seedVergence} reconstructs — one value per DOF
 *  {@link stepVergence} integrates. Seeding a released PID node with these makes
 *  the resumed command continuous (velocity-form integrator = command). */
export type VergenceSeed = { pan: Point2d; verge: number; v_shift: number };

/** DIRECT target follow — the drag path (spec §drag): the forward map of
 *  {@link stepVergence}'s tail (`ray = aT + pan`, then `inverseTriangulate`)
 *  with NO PID stepping and NO match-score gate, so a drag moves the foveas even
 *  where the template match fails. Generic over `held`. */
export function followTarget(
  target: Point2d,
  held: VergenceSeed,
  conv: Pick<CoordinateConversions, "P2A" | "A2V">,
  baseline: number,
): { left: Point2d; right: Point2d } {
  const ray = VEC.add(conv.P2A.C(target, false), held.pan);
  const distance = vergeToDistance(held.verge, baseline);
  const A = inverseTriangulate(ray, baseline, distance, held.v_shift);
  return { left: conv.A2V.L(A.l), right: conv.A2V.R(A.r) };
}

/** Reconstruct the `{pan, verge, v_shift}` state whose forward map reproduces a
 *  pair of per-eye gaze ANGLES `gL`/`gR` about the target ray `aT` — the exact
 *  inverse of {@link stepVergence}'s reconstruction, seeding a released PID node
 *  for output continuity. Inputs are ANGLES, not volts: the V2A round-trip is
 *  lossy and a parallel-ray caller MUST pass `gL = gR = ray` (spec §seed-space).
 *
 *  @param parallelEps `|tan gL.x − tan gR.x|` below this ⇒ parallel (verge 0),
 *    guarding the `z = baseline/tanDiff` divide. */
export function seedVergence(
  gL: Point2d,
  gR: Point2d,
  aT: Point2d,
  baseline: number,
  parallelEps = 1e-9,
): VergenceSeed {
  const v_shift = (gL.y - gR.y) / 2;
  const rayY = (gL.y + gR.y) / 2;
  const tanDiff = Math.tan(gL.x) - Math.tan(gR.x);
  let rayX: number;
  let verge: number;
  if (Math.abs(tanDiff) < parallelEps) {
    rayX = (gL.x + gR.x) / 2;
    verge = 0;
  } else {
    const z = baseline / tanDiff;
    rayX = Math.atan2((z * (Math.tan(gL.x) + Math.tan(gR.x))) / 2, z);
    verge = distanceToVerge(z, baseline);
  }
  return { pan: { x: rayX - aT.x, y: rayY - aT.y }, verge, v_shift };
}
