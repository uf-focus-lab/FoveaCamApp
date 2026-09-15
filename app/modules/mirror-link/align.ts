// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Auto-align geometry: find the emitter in a fovea frame, and invert the
// fixation model so ONE observation per eye yields the gaze angle, the verge
// distance and the vertical shift that put it at both fovea centers. Pure —
// Vue-free, core-free, unit-tested.
// spec: docs/spec/mirror-link.md#targeting

import type { Point2d } from "core/Geometry";

/** A frame the spot finder consumes — interleaved 8-bit pixels. */
export type AlignImage = {
  data: Uint8Array;
  width: number;
  height: number;
  /** 4 = BGRA/RGBA (luma = max channel), 1 = mono. */
  channels: number;
};

/** Below this peak (8-bit) there is no emitter in frame, only noise. */
const MIN_PEAK = 32;
/** Fewer lit pixels than this is a hot pixel, not a dot. */
const MIN_PIXELS = 3;

/**
 * Centroid of the brightest blob: every pixel at or above `fraction` of the
 * frame's peak luminance, averaged. Null when the frame holds no emitter (peak
 * under {@link MIN_PEAK}) or the blob is a single hot pixel.
 */
export function brightestSpot(
  img: AlignImage,
  fraction = 0.9,
): { x: number; y: number; peak: number } | null {
  const { data, width, height, channels } = img;
  const luma = (i: number): number => {
    const p = i * channels;
    if (channels < 3) return data[p];
    const b = data[p];
    const g = data[p + 1];
    const r = data[p + 2];
    return b > g ? (b > r ? b : r) : g > r ? g : r;
  };
  const count = width * height;
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const v = luma(i);
    if (v > peak) peak = v;
  }
  if (peak < MIN_PEAK) return null;
  const level = fraction * peak;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++)
      if (luma(row + x) >= level) {
        sx += x;
        sy += y;
        n++;
      }
  }
  if (n < MIN_PIXELS) return null;
  return { x: sx / n, y: sy / n, peak };
}

/** What one auto-align solved for. */
export type Alignment = {
  /** Gaze ray in wide angular coordinates (rad). */
  angle: Point2d;
  /** Verge distance along the ray (mm); `Infinity` = parallel gaze. */
  distanceMm: number;
  /** Vertical half-shift between the foveas (rad) — `+s` raises L, lowers R. */
  shiftRad: number;
};

/**
 * Invert `inverseTriangulate` in closed form: given where each fovea is ACTUALLY
 * looking, recover the one gaze ray, the distance the two rays cross at, and
 * the vertical shift between them.
 *
 * With `b = baseline/2`, `tan aL.x = (x + b)/z` and `tan aR.x = (x − b)/z`, so
 * `z = 2b / (tan aL.x − tan aR.x)` and `x = z·tan aL.x − b`. Diverging or
 * parallel rays (`z ≤ 0` or non-finite) mean no crossing in front: `Infinity`,
 * with the gaze ray the mean of the two.
 */
export function solveAlignment(
  aL: Point2d,
  aR: Point2d,
  baselineMm: number,
): Alignment {
  const b = baselineMm / 2;
  const denom = Math.tan(aL.x) - Math.tan(aR.x);
  const z = denom !== 0 ? (2 * b) / denom : Infinity;
  const converged = Number.isFinite(z) && z > 0;
  const angle: Point2d = {
    x: converged ? Math.atan2(z * Math.tan(aL.x) - b, z) : (aL.x + aR.x) / 2,
    y: (aL.y + aR.y) / 2,
  };
  return {
    angle,
    distanceMm: converged ? z : Infinity,
    shiftRad: (aL.y - aR.y) / 2,
  };
}

/**
 * Pixel→angle sign per axis for a fovea frame (RIG-GATED). The calibration
 * model — split-tracking's `eyeJInv`, same pinhole basis — places a target at
 * pixel offset `p` from the frame center at gaze `angle0 + p/focal`, i.e. `+1`
 * on both axes; a mirror/camera mounting flip shows up as the spot moving AWAY
 * on the rig, and flipping the axis here is the whole fix.
 */
export const SPOT_TO_ANGLE_SIGN: Point2d = { x: 1, y: 1 };

/**
 * Angular offset from a fovea-frame spot to that eye's gaze correction: the
 * pinhole `atan((s − c)/f)` per axis, signed by {@link SPOT_TO_ANGLE_SIGN}.
 *
 * @param spot the emitter in fovea-frame px.
 * @param center the fovea view's principal point (`deriveFoveaIntrinsics().c`).
 * @param focal px per radian per axis (`deriveFoveaIntrinsics().f`).
 */
export function spotOffsetAngle(
  spot: Point2d,
  center: Point2d,
  focal: Point2d,
): Point2d {
  const safe = (d: number, f: number): number =>
    Number.isFinite(f) && f !== 0 ? Math.atan(d / f) : 0;
  return {
    x: SPOT_TO_ANGLE_SIGN.x * safe(spot.x - center.x, focal.x),
    y: SPOT_TO_ANGLE_SIGN.y * safe(spot.y - center.y, focal.y),
  };
}
