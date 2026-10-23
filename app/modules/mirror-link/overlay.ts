// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Ring annotation geometry — the pure view-model behind `RingOverlay`: a
// readout plus a stroke scalar in, drawable frame-px primitives out. Kept out of
// the SFC so the overlay component and the app agree on ONE shape and the
// per-frame recompute stays a cheap, dependency-explicit function.
// spec: docs/spec/mirror-link.md#reader

import type { RingReadout } from "@lib/ring-code";

/** What `RingOverlay` draws: everything already in frame px. */
export type RingViewGeometry = {
  stroke: number;
  circle: { x: number; y: number; r: number } | null;
  /** A frame DECODED — draw the arc + ticks and the circle solid. */
  on: boolean;
  /** SVG path for the LEADER arc (empty when there is nothing to draw). */
  arc: string;
  ticks: { x1: number; y1: number; x2: number; y2: number; long: boolean }[];
};

const TAU = 2 * Math.PI;

/** Overlay stroke width from a frame payload's `shape` ([h, w]) — one rule for
 *  every view in the app, so annotations scale alike. */
export function strokeFor(shape: readonly number[] | undefined): number {
  return Math.max(shape?.[1] ?? 0, shape?.[0] ?? 0, 1) * 0.003;
}

/** Build the drawable geometry for one eye. A null/failed readout yields the
 *  circle alone (dim + dashed at the call site); null yields nothing. */
export function ringGeometry(
  readout: RingReadout | null | undefined,
  stroke: number,
): RingViewGeometry {
  const circle = readout?.circle ?? null;
  const on = !!readout?.ok && !!circle;
  if (!circle) return { stroke, circle: null, on: false, arc: "", ticks: [] };
  const at = (a: number, radius: number) => ({
    x: circle.x + radius * Math.cos(a),
    y: circle.y + radius * Math.sin(a),
  });
  let arc = "";
  if (on && readout?.leaderArc) {
    const { from, to } = readout.leaderArc;
    // Minor arc: the leader is 8 of ≥43 chips, so it never spans a half turn.
    const delta = ((((to - from) % TAU) + TAU * 1.5) % TAU) - Math.PI;
    const a = at(from, circle.r);
    const b = at(to, circle.r);
    arc = `M ${a.x} ${a.y} A ${circle.r} ${circle.r} 0 0 ${delta > 0 ? 1 : 0} ${b.x} ${b.y}`;
  }
  const ticks =
    on && readout?.dividers
      ? readout.dividers.map((d) => {
          const long = d.name !== "byte";
          const len = stroke * (long ? 6 : 3);
          const a = at(d.angle, circle.r - len);
          const b = at(d.angle, circle.r + len);
          return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, long };
        })
      : [];
  return { stroke, circle, on, arc, ticks };
}

/** SVG path data for a polyline in frame px; `closed` joins the last point
 *  back to the first (the ellipse), open otherwise (the line, the triangle).
 *  Fewer than two points draw nothing. */
export function polylinePath(
  points: readonly { x: number; y: number }[],
  closed: boolean,
): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++)
    d += ` L ${points[i].x} ${points[i].y}`;
  return closed ? d + " Z" : d;
}

/** Axis-handle sizes as multiples of the overlay stroke (spec §views): the
 *  drawn dot's radius, the grab radius around it, and the shortest distance
 *  from the scan center the handle is DRAWN at. The handle only sets the axis
 *  DIRECTION, so at a small amplitude it is pushed out along the axis to
 *  `AXIS_HANDLE_MIN_DIST` strokes — far enough that its grab zone never covers
 *  the crosshair and its dot never hides the target dot. */
export const AXIS_HANDLE_DOT = 3;
export const AXIS_HANDLE_HIT = 6;
export const AXIS_HANDLE_MIN_DIST = 15;

type Px = { x: number; y: number };

/**
 * Where the axis handle is DRAWN (and hit-tested): on the ray from `target`
 * through `handle` (`telemetry.axis_handle_px`, the +amp end of the axis), at
 * `max(|handle − target|, AXIS_HANDLE_MIN_DIST · stroke)` from the target.
 * Null — hidden — on the `{0,0}` uncalibrated sentinel and when the handle
 * sits on the target (no direction to draw).
 */
export function axisHandleAt(
  target: Px,
  handle: Px,
  stroke: number,
): Px | null {
  if (handle.x === 0 && handle.y === 0) return null;
  const dx = handle.x - target.x;
  const dy = handle.y - target.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9) || !Number.isFinite(len)) return null;
  const d = Math.max(len, stroke * AXIS_HANDLE_MIN_DIST);
  return { x: target.x + (dx / len) * d, y: target.y + (dy / len) * d };
}

/** Whether a press at `p` (frame px) grabs the axis handle: within
 *  `stroke · AXIS_HANDLE_HIT` of the DRAWN handle (`axisHandleAt`) and never
 *  nearer the scan center than that same radius — a press on the crosshair
 *  always steers. */
export function hitsAxisHandle(
  p: Px,
  target: Px,
  handle: Px,
  stroke: number,
): boolean {
  const at = axisHandleAt(target, handle, stroke);
  if (!at) return false;
  const r = stroke * AXIS_HANDLE_HIT;
  if (Math.hypot(p.x - target.x, p.y - target.y) < r) return false;
  return Math.hypot(p.x - at.x, p.y - at.y) <= r;
}
