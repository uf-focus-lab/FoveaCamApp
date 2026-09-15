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

export type SpotSearch = {
  /** Lit-pixel threshold as a fraction of the window's peak (default 0.9). */
  fraction?: number;
  /** Sample every `step`-th pixel — a decimated first pass (default 1). */
  step?: number;
  /** Restrict the search to this window (full-res px; clamped to the frame). */
  roi?: { x: number; y: number; width: number; height: number };
};

/**
 * Centroid of the brightest blob: every pixel at or above `fraction` of the
 * searched window's peak luminance, averaged, in FULL-RES frame coordinates.
 * Null when there is no emitter (peak under {@link MIN_PEAK}) or the blob is a
 * single hot pixel. `step` decimates the scan and `roi` bounds it — a coarse
 * pass then a refine costs no copy of the frame.
 */
export function brightestSpot(
  img: AlignImage,
  opts: SpotSearch = {},
): { x: number; y: number; peak: number } | null {
  const { data, width, height, channels } = img;
  const fraction = opts.fraction ?? 0.9;
  const step = Math.max(1, Math.floor(opts.step ?? 1));
  const x0 = Math.max(0, Math.floor(opts.roi?.x ?? 0));
  const y0 = Math.max(0, Math.floor(opts.roi?.y ?? 0));
  const x1 = Math.min(width, Math.ceil(x0 + (opts.roi?.width ?? width)));
  const y1 = Math.min(height, Math.ceil(y0 + (opts.roi?.height ?? height)));
  const luma = (i: number): number => {
    const p = i * channels;
    if (channels < 3) return data[p];
    const b = data[p];
    const g = data[p + 1];
    const r = data[p + 2];
    return b > g ? (b > r ? b : r) : g > r ? g : r;
  };
  let peak = 0;
  for (let y = y0; y < y1; y += step) {
    const row = y * width;
    for (let x = x0; x < x1; x += step) {
      const v = luma(row + x);
      if (v > peak) peak = v;
    }
  }
  if (peak < MIN_PEAK) return null;
  const level = fraction * peak;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    const row = y * width;
    for (let x = x0; x < x1; x += step)
      if (luma(row + x) >= level) {
        sx += x;
        sy += y;
        n++;
      }
  }
  if (n < MIN_PIXELS) return null;
  return { x: sx / n, y: sy / n, peak };
}

/** Coarse (decimated) pass then a refine in a window around it — what the
 *  `spot` kernel runs per fovea frame. A dot small enough to fall between the
 *  decimated samples falls back to the full-resolution scan rather than being
 *  reported missing. */
export function findSpot(
  img: AlignImage,
  { decimate = 2, refinePx = 32, fraction = 0.9 } = {},
): { x: number; y: number; peak: number } | null {
  const coarse =
    brightestSpot(img, { fraction, step: decimate }) ??
    brightestSpot(img, { fraction });
  if (!coarse) return null;
  const half = refinePx / 2;
  return (
    brightestSpot(img, {
      fraction,
      roi: {
        x: coarse.x - half,
        y: coarse.y - half,
        width: refinePx,
        height: refinePx,
      },
    }) ?? coarse
  );
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
