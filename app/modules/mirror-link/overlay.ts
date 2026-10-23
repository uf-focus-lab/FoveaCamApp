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

/** Whether the scan is a CLOSED path: the ellipse, unless its ratio collapses
 *  it to a line (spec §scan-patterns). */
export function isClosedPath(mode: string, ratio: number): boolean {
  return mode === "ellipse" && ratio > 0;
}

/** Axis-handle sizes as multiples of the overlay stroke: the drawn dot's
 *  radius, and the grab radius around it (spec §views). */
export const AXIS_HANDLE_DOT = 3;
export const AXIS_HANDLE_HIT = 6;

/** Whether a press at `p` (frame px) grabs the axis handle at `handle`. A
 *  `{0,0}` handle is the uncalibrated sentinel — hidden, never hit. */
export function hitsAxisHandle(
  p: { x: number; y: number },
  handle: { x: number; y: number },
  stroke: number,
): boolean {
  if (handle.x === 0 && handle.y === 0) return false;
  return (
    Math.hypot(p.x - handle.x, p.y - handle.y) <= stroke * AXIS_HANDLE_HIT
  );
}
