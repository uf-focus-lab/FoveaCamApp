// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Scan-pattern geometry — the ellipse / line / triangle offset around the
// hand-aimed center, its MCU trajectory samples + trigger markers, the exposure
// windows, and the per-eye angles an offset resolves to. Pure + Vue-free
// (unit-tested).
// spec: docs/spec/mirror-link.md#scan-patterns

import type { Point2d } from "core/Geometry";
import { inverseTriangulate } from "@lib/stereo";
import { VSHIFT_LIMIT_DEG } from "@lib/vergence/tuning";
import type { ScanMode, ScanWindow } from "./contract";

/** Scan frequency slider range (Hz) — the UI, the contract default, and the
 *  session all read this one pair. The BASE frequency: one ellipse revolution,
 *  or one triangle sweep. */
export const SCAN_HZ_RANGE = { min: 1, max: 100 } as const;

/** Scan amplitude slider range, in degrees: the ellipse's semi-major radius,
 *  the triangle's half sweep. */
export const SCAN_AMP_RANGE = { min: 0, max: 2 } as const;

/** Main-axis direction range, degrees counter-clockwise from +x of the wide
 *  angular frame — the half-open interval (-180, 180]; see
 *  {@link normalizeAxisDeg}. */
export const SCAN_AXIS_RANGE = { min: -180, max: 180 } as const;

/** Ellipse minor/major ratio: 0 = a line along the axis, 1 = the circle. */
export const SCAN_RATIO_RANGE = { min: 0, max: 1 } as const;

/** Upper bound of every exposure window, as a fraction of its slope: the
 *  trigger line must be released and the capture engine idle before the next
 *  marker (the firmware pushes BUSY on a busy engine), and the camera needs its
 *  readout gap (spec §exposure-windows). */
export const WINDOW_MAX = 0.95;

/** Shortest exposure window, as a fraction of its slope (a zero-length pulse
 *  is no exposure at all) — the pane's dual slider `minGap`/step, so a value
 *  the pane can produce is never rewritten by the session's clamp. */
export const WINDOW_MIN = 0.005;

/** Ellipse trajectory samples per period (linear interpolation on the MCU
 *  between them; 11 CMD_TRAJECTORY DATA chunks). */
export const ELLIPSE_SAMPLES = 128;

/** Vertical-shift slider range, in degrees (symmetric about 0). The slider IS
 *  the vergence loop's `v_shift` DOF, so its range is that controller's
 *  saturation limit (spec §targeting). */
export const SHIFT_RANGE_DEG = {
  min: -VSHIFT_LIMIT_DEG,
  max: VSHIFT_LIMIT_DEG,
} as const;

const DEG = Math.PI / 180;

/** Wrap any angle (degrees) into (-180, 180]. Non-finite → 0. */
export function normalizeAxisDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const r = ((deg % 360) + 360) % 360; // [0, 360)
  return r > 180 ? r - 360 : r;
}

/** Rotate `p` by `deg` counter-clockwise (+x → +y). */
function rotate(p: Point2d, deg: number): Point2d {
  const t = deg * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: c * p.x - s * p.y, y: s * p.x + c * p.y };
}

/** One sweep T in whole microseconds — the MCU clock's unit. The triangle's
 *  2T period is exactly twice this, so its falling marker lands on the same
 *  grid as the rising one. */
export function sweepUs(hz: number): number {
  return Math.round(1e6 / hz);
}

/** The trajectory PERIOD in µs: T for the ellipse, 2T for the triangle (one
 *  rising + one falling sweep). */
export function patternPeriodUs(mode: ScanMode, hz: number): number {
  return mode === "triangle" ? 2 * sweepUs(hz) : sweepUs(hz);
}

/** The triangle wave over one 2T period: −1 at phase 0, +1 at 0.5, back to −1
 *  at 1 — linear in between. */
function triangleWave(phase01: number): number {
  const p = phase01 - Math.floor(phase01); // [0, 1)
  return p < 0.5 ? -1 + 4 * p : 3 - 4 * p;
}

/**
 * The scan OFFSET at `phase01` ∈ [0,1) of the pattern's own period, in RADIANS
 * in the wide angular frame (`θ = axisDeg`, `a = radians(ampDeg)`):
 *
 * - ellipse: `R(θ) · (a cos 2πφ, ratio · a sin 2πφ)` — ratio 1 the circle,
 *   0 a sinusoidal line along the axis;
 * - triangle: `R(θ) · (s(φ), 0)` with `s` the −a → +a → −a triangle over 2T.
 *
 * Zero amplitude ⇒ `{0, 0}` (the idle pose).
 */
export function patternOffset(
  mode: ScanMode,
  phase01: number,
  axisDeg: number,
  ampDeg: number,
  ratio: number,
): Point2d {
  const a = ampDeg * DEG;
  if (a === 0) return { x: 0, y: 0 };
  if (mode === "triangle")
    return rotate({ x: a * triangleWave(phase01), y: 0 }, axisDeg);
  const phi = 2 * Math.PI * phase01;
  const r = Math.min(Math.max(ratio, SCAN_RATIO_RANGE.min), SCAN_RATIO_RANGE.max);
  return rotate({ x: a * Math.cos(phi), y: r * a * Math.sin(phi) }, axisDeg);
}

/** One trajectory sample before the angle→volt chain: the offset to command
 *  `tOffsetUs` into the period. */
export type PatternSample = { tOffsetUs: number; offset: Point2d };

/**
 * The pattern as MCU trajectory samples (`TrajectorySample`-ready once the
 * session runs each offset through the EXACT chain):
 *
 * - ellipse: {@link ELLIPSE_SAMPLES} samples, `tOffsetUs = round(k·P/N)`, each
 *   offset at the phase of its OWN rounded time (so the MCU's clock and the
 *   geometry agree exactly);
 * - triangle: exactly TWO — `t = 0: −a`, `t = T: +a`. The MCU's linear
 *   interpolation, wrapping last → first across the period boundary, IS the
 *   triangle (`step` stays false).
 */
export function patternSamples(
  mode: ScanMode,
  hz: number,
  axisDeg: number,
  ampDeg: number,
  ratio: number,
): PatternSample[] {
  const P = patternPeriodUs(mode, hz);
  if (mode === "triangle") {
    const T = sweepUs(hz);
    return [
      { tOffsetUs: 0, offset: patternOffset(mode, 0, axisDeg, ampDeg, ratio) },
      { tOffsetUs: T, offset: patternOffset(mode, 0.5, axisDeg, ampDeg, ratio) },
    ];
  }
  const n = Math.min(ELLIPSE_SAMPLES, P);
  const out: PatternSample[] = [];
  for (let k = 0; k < n; k++) {
    const t = Math.round((k * P) / n);
    out.push({ tOffsetUs: t, offset: patternOffset(mode, t / P, axisDeg, ampDeg, ratio) });
  }
  return out;
}

/**
 * Clamp a window to `0 ≤ w0 < w1 ≤ WINDOW_MAX` with `w1 − w0 ≥ WINDOW_MIN`.
 * An inverted pair is swapped; a too-short one grows its END (or, at the cap,
 * its start). Non-finite ends fall back to the full window.
 */
export function clampWindow(w: readonly [number, number]): ScanWindow {
  let a = Number.isFinite(w[0]) ? w[0] : 0;
  let b = Number.isFinite(w[1]) ? w[1] : WINDOW_MAX;
  if (a > b) [a, b] = [b, a];
  a = Math.min(Math.max(a, 0), WINDOW_MAX);
  b = Math.min(Math.max(b, 0), WINDOW_MAX);
  if (b - a < WINDOW_MIN) {
    b = a + WINDOW_MIN;
    if (b > WINDOW_MAX) {
      b = WINDOW_MAX;
      a = WINDOW_MAX - WINDOW_MIN;
    }
  }
  return [a, b];
}

/** The scan's window state, as the contract carries it. */
export type WindowState = {
  scan_window: ScanWindow;
  tri_window_rise: ScanWindow;
  tri_window_fall: ScanWindow;
  tri_window_sync: boolean;
};

/** The windows the markers are built from, in marker order and clamped: the
 *  ellipse's one, or the triangle's rising + falling pair (the falling one
 *  MIRRORS the rising one while `tri_window_sync` is on, whatever the state
 *  holds). */
export function activeWindows(mode: ScanMode, w: WindowState): ScanWindow[] {
  if (mode === "ellipse") return [clampWindow(w.scan_window)];
  const rise = clampWindow(w.tri_window_rise);
  return [rise, w.tri_window_sync ? rise : clampWindow(w.tri_window_fall)];
}

/** One trigger: the exposure starts `tOffsetUs` into the period and lasts
 *  `pulseUs` (TriggerWidth exposure). Whole µs, as the firmware takes them. */
export type WindowMarker = { tOffsetUs: number; pulseUs: number };

/**
 * The trajectory markers for `windows` (in marker order, from
 * {@link activeWindows}): marker k starts at `slopeStart_k + w0 · T` and pulses
 * `(w1 − w0) · T`, with `T` the sweep. Ellipse: ONE marker, slope start 0.
 * Triangle: marker 0 (rising) at `w0_rise · T`, marker 1 (falling) at
 * `T + w0_fall · T`; a missing falling window reuses the rising one.
 */
export function windowMarkers(
  mode: ScanMode,
  hz: number,
  windows: readonly ScanWindow[],
): WindowMarker[] {
  const T = sweepUs(hz);
  const one = (start: number, w: ScanWindow): WindowMarker => {
    const [w0, w1] = clampWindow(w);
    const t0 = start + Math.round(w0 * T);
    const t1 = start + Math.round(w1 * T);
    return { tOffsetUs: t0, pulseUs: Math.max(1, t1 - t0) };
  };
  const first = windows[0] ?? [0, WINDOW_MAX];
  if (mode === "ellipse") return [one(0, first)];
  return [one(0, first), one(T, windows[1] ?? first)];
}

/** A drawable path: offsets plus whether the renderer closes the loop. */
export type PathOffsets = { offsets: Point2d[]; closed: boolean };

/**
 * `n` points of the pattern for DRAWING (`scan_path` / `scan_path_px`): the
 * ellipse as a closed loop over one period; a ratio-0 ellipse and the triangle
 * as the OPEN segment −a → +a along the axis (both trace that line, the
 * triangle out and back).
 */
export function patternPath(
  mode: ScanMode,
  axisDeg: number,
  ampDeg: number,
  ratio: number,
  n: number,
): PathOffsets {
  const line = mode === "triangle" || ratio <= 0;
  const offsets: Point2d[] = [];
  if (line) {
    const a = ampDeg * DEG;
    for (let k = 0; k < n; k++) {
      const s = n > 1 ? -a + (2 * a * k) / (n - 1) : 0;
      offsets.push(rotate({ x: s, y: 0 }, axisDeg));
    }
    return { offsets, closed: false };
  }
  for (let k = 0; k < n; k++)
    offsets.push(patternOffset(mode, k / n, axisDeg, ampDeg, ratio));
  return { offsets, closed: true };
}

/**
 * The EXPOSED portion of the path per marker (`scan_window_px`): the offsets
 * the pattern passes through between each marker's start and end, sampled at
 * the drawn path's density (`n` points per period, at least 2 per window).
 */
export function windowPaths(
  mode: ScanMode,
  hz: number,
  axisDeg: number,
  ampDeg: number,
  ratio: number,
  markers: readonly WindowMarker[],
  n: number,
): Point2d[][] {
  const P = patternPeriodUs(mode, hz);
  return markers.map(({ tOffsetUs, pulseUs }) => {
    const p0 = tOffsetUs / P;
    const span = pulseUs / P;
    const k = Math.max(2, Math.ceil(span * n) + 1);
    const out: Point2d[] = [];
    for (let i = 0; i < k; i++)
      out.push(patternOffset(mode, p0 + (span * i) / (k - 1), axisDeg, ampDeg, ratio));
    return out;
  });
}

/** The main axis's +amp end — the draggable handle (`axis_handle_px`). */
export function axisHandleOffset(axisDeg: number, ampDeg: number): Point2d {
  return rotate({ x: ampDeg * DEG, y: 0 }, axisDeg);
}

/**
 * The main-axis direction (degrees, (-180, 180]) pointing from the scan center
 * to a wide-view point, both in the WIDE ANGULAR frame (radians) — the inverse
 * of {@link axisHandleOffset}'s direction. Null when the point coincides with
 * the center (no direction).
 */
export function axisDegFromPixelRay(
  centerAngle: Point2d,
  pointAngle: Point2d,
): number | null {
  const dx = pointAngle.x - centerAngle.x;
  const dy = pointAngle.y - centerAngle.y;
  if (!(Math.hypot(dx, dy) > 0)) return null;
  return normalizeAxisDeg(Math.atan2(dy, dx) / DEG);
}

/**
 * Compose the per-eye pointing angles for one scan sample: the offset rides the
 * wide angular frame BEFORE `inverseTriangulate`, so both eyes trace the same
 * pattern around the same scene point. The vertical SHIFT is the same toe
 * adjustment manual-control applies (`+s` raises L and lowers R) and rides
 * `inverseTriangulate` itself, so a zero offset reduces to
 * `inverseTriangulate(A0, baseline, distanceMm, shiftRad)` — the same function
 * serves the idle pose.
 *
 * @param A0 Scan center in wide angular coordinates (rad).
 * @param offset Scan offset from {@link patternOffset} (rad).
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
