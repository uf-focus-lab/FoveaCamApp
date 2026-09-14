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

/** Scan frequency slider range (Hz) — the UI, the contract default, and the
 *  exposure override all read this one pair. */
export const SCAN_HZ_RANGE = { min: 1, max: 100 } as const;

/** Scan amplitude (ring RADIUS) slider range, in degrees. */
export const SCAN_AMP_RANGE = { min: 0, max: 2 } as const;

/** Per-eye fine-trim slider range, in degrees (symmetric about 0). */
export const TRIM_RANGE_DEG = { min: -0.5, max: 0.5 } as const;

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

/** Per-eye fine trims, in RADIANS (the session converts the degree state). */
export interface ScanTrims {
  l: Point2d;
  r: Point2d;
}

/**
 * Compose the per-eye pointing angles for one scan sample: the offset rides the
 * wide angular frame BEFORE `inverseTriangulate`, so both eyes trace the same
 * circle around the same scene point; the trims are added per eye AFTER, so
 * they move the ring's center and never its shape. A zero offset + zero trims
 * reduce to `inverseTriangulate(A0, baseline, distanceMm)` — the same function
 * serves the idle pose.
 *
 * @param A0 Scan center in wide angular coordinates (rad).
 * @param offset Scan offset from {@link scanOffset} (rad).
 * @param baseline Inter-fovea baseline (mm).
 * @param distanceMm Verge distance (mm); `Infinity` ⇒ parallel gaze.
 * @param trims Per-eye fine alignment (rad).
 */
export function scanAngles(
  A0: Point2d,
  offset: Point2d,
  baseline: number,
  distanceMm: number,
  trims: ScanTrims,
): { l: Point2d; r: Point2d } {
  const center: Point2d = { x: A0.x + offset.x, y: A0.y + offset.y };
  const a = inverseTriangulate(center, baseline, distanceMm);
  return {
    l: { x: a.l.x + trims.l.x, y: a.l.y + trims.l.y },
    r: { x: a.r.x + trims.r.x, y: a.r.y + trims.r.y },
  };
}
