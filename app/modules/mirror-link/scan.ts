// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Circular-scan geometry — the offset around the hand-aimed center and the
// per-eye angles it resolves to. Pure + Vue-free (unit-tested).
// spec: docs/spec/mirror-link.md#scan

import type { Point2d } from "core/Geometry";
import { inverseTriangulate } from "@lib/stereo";
import { VSHIFT_LIMIT_DEG } from "@lib/vergence/tuning";

/** Scan frequency slider range (Hz) — the UI, the contract default, and the
 *  exposure override all read this one pair. */
export const SCAN_HZ_RANGE = { min: 1, max: 100 } as const;

/** Scan amplitude (ring RADIUS) slider range, in degrees. */
export const SCAN_AMP_RANGE = { min: 0, max: 2 } as const;

/** Vertical-shift slider range, in degrees (symmetric about 0). The slider IS
 *  the vergence loop's `v_shift` DOF, so its range is that controller's
 *  saturation limit (spec §targeting). */
export const SHIFT_RANGE_DEG = {
  min: -VSHIFT_LIMIT_DEG,
  max: VSHIFT_LIMIT_DEG,
} as const;

const DEG = Math.PI / 180;

/**
 * The scan OFFSET at `tMs` milliseconds since the scan started, in RADIANS in
 * the wide angular frame: `amp · (cos φ, sin φ)` with `φ = 2π · hz · t / 1000`.
 * `tMs` comes from the pacer's wall clock, never a tick counter, so a late tick
 * lands at the correct phase (spec §scan). Zero amplitude ⇒ `{0, 0}`.
 */
export function scanOffset(tMs: number, hz: number, ampDeg: number): Point2d {
  const amp = ampDeg * DEG;
  if (amp === 0) return { x: 0, y: 0 };
  const phi = 2 * Math.PI * hz * (tMs / 1000);
  return { x: amp * Math.cos(phi), y: amp * Math.sin(phi) };
}

/**
 * Compose the per-eye pointing angles for one scan sample: the offset rides the
 * wide angular frame BEFORE `inverseTriangulate`, so both eyes trace the same
 * circle around the same scene point. The vertical SHIFT is the same toe
 * adjustment manual-control applies (`+s` raises L and lowers R) and rides
 * `inverseTriangulate` itself, so a zero offset reduces to
 * `inverseTriangulate(A0, baseline, distanceMm, shiftRad)` — the same function
 * serves the idle pose.
 *
 * @param A0 Scan center in wide angular coordinates (rad).
 * @param offset Scan offset from {@link scanOffset} (rad).
 * @param baseline Inter-fovea baseline (mm).
 * @param distanceMm Verge distance (mm); `Infinity` ⇒ parallel gaze.
 * @param shiftRad Vertical half-shift between the foveas (rad).
 */
export function scanAngles(
  A0: Point2d,
  offset: Point2d,
  baseline: number,
  distanceMm: number,
  shiftRad = 0,
): { l: Point2d; r: Point2d } {
  const center: Point2d = { x: A0.x + offset.x, y: A0.y + offset.y };
  return inverseTriangulate(center, baseline, distanceMm, shiftRad);
}
