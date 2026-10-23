// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Center-view scan overlay helpers (spec docs/spec/mirror-link.md §views): the
// path polyline (closed on request — the session publishes `scan_path_closed`
// with the path), and the axis handle: DRAWN at least `AXIS_HANDLE_MIN_DIST`
// strokes from the center along the axis, grabbed within
// `stroke · AXIS_HANDLE_HIT` of that drawn dot but never that close to the
// center, never on the {0,0} uncalibrated sentinel.

import { describe, expect, it } from "vitest";
import {
  AXIS_HANDLE_DOT,
  AXIS_HANDLE_HIT,
  AXIS_HANDLE_MIN_DIST,
  axisHandleAt,
  hitsAxisHandle,
  polylinePath,
  scanCenterOf,
} from "@modules/mirror-link/overlay";

describe("polylinePath", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
  ];
  it("draws an open path", () => {
    expect(polylinePath(pts, false)).toBe("M 0 0 L 10 0 L 10 5");
  });
  it("closes on request", () => {
    expect(polylinePath(pts, true)).toBe("M 0 0 L 10 0 L 10 5 Z");
  });
  it("draws nothing below two points", () => {
    expect(polylinePath([], true)).toBe("");
    expect(polylinePath([{ x: 1, y: 1 }], false)).toBe("");
  });
});

describe("axisHandleAt", () => {
  const target = { x: 100, y: 50 };
  const stroke = 2;
  const min = stroke * AXIS_HANDLE_MIN_DIST;
  it("draws a far handle where the telemetry puts it", () => {
    const h = { x: 100 + 3 * min, y: 50 };
    expect(axisHandleAt(target, h, stroke)).toEqual(h);
  });
  it("pushes a near handle out to the minimum distance, keeping its direction", () => {
    // Default amplitude on a wide view: the +amp end only a few strokes out.
    const at = axisHandleAt(target, { x: 103, y: 54 }, stroke)!;
    expect(Math.hypot(at.x - target.x, at.y - target.y)).toBeCloseTo(min, 9);
    expect(at.x - target.x).toBeCloseTo(0.6 * min, 9);
    expect(at.y - target.y).toBeCloseTo(0.8 * min, 9);
  });
  it("hides the {0,0} sentinel and a handle with no direction", () => {
    expect(axisHandleAt(target, { x: 0, y: 0 }, stroke)).toBeNull();
    expect(axisHandleAt(target, target, stroke)).toBeNull();
  });
  it("keeps the drawn dot clear of the target dot", () => {
    const at = axisHandleAt(target, { x: 101, y: 50 }, stroke)!;
    expect(Math.hypot(at.x - target.x, at.y - target.y)).toBeGreaterThan(
      stroke * (AXIS_HANDLE_DOT + AXIS_HANDLE_HIT),
    );
  });
});

describe("hitsAxisHandle", () => {
  const target = { x: 100, y: 50 };
  const stroke = 2;
  const r = stroke * AXIS_HANDLE_HIT;
  const far = { x: 300, y: 50 };
  it("grabs inside the hit radius of a far handle", () => {
    expect(hitsAxisHandle(far, target, far, stroke)).toBe(true);
    expect(hitsAxisHandle({ x: 300 + r, y: 50 }, target, far, stroke)).toBe(
      true,
    );
  });
  it("misses outside it", () => {
    expect(
      hitsAxisHandle({ x: 300 + r + 0.01, y: 50 }, target, far, stroke),
    ).toBe(false);
  });
  it("never grabs the hidden {0,0} handle", () => {
    expect(
      hitsAxisHandle({ x: 0, y: 0 }, target, { x: 0, y: 0 }, stroke),
    ).toBe(false);
  });

  // The round-1 bug: at the default amplitude the +amp end sat within the hit
  // radius of the center, so a press on the crosshair rotated the axis and a
  // press just past the center flipped it 180°.
  describe("a handle overlapping the center", () => {
    const near = { x: 104, y: 50 }; // 2 strokes out — inside the old hit zone
    it("lets a press on the crosshair steer", () => {
      expect(hitsAxisHandle(target, target, near, stroke)).toBe(false);
    });
    it("lets a press just past the center (the opposite side) steer", () => {
      expect(hitsAxisHandle({ x: 97, y: 50 }, target, near, stroke)).toBe(
        false,
      );
    });
    it("lets a press at the telemetry handle position steer", () => {
      expect(hitsAxisHandle(near, target, near, stroke)).toBe(false);
    });
    it("grabs at the DRAWN position instead", () => {
      const at = axisHandleAt(target, near, stroke)!;
      expect(hitsAxisHandle(at, target, near, stroke)).toBe(true);
      expect(
        hitsAxisHandle({ x: at.x - r, y: at.y }, target, near, stroke),
      ).toBe(true);
    });
  });

  it("never grabs nearer the center than the hit radius, whatever the stroke", () => {
    // A huge stroke makes the hit zone reach back over the center.
    const big = 20;
    const h = { x: 100 + big * AXIS_HANDLE_MIN_DIST, y: 50 };
    expect(hitsAxisHandle({ x: 100 + big * 5, y: 50 }, target, h, big)).toBe(
      false,
    );
  });
});

describe("scanCenterOf + a panned scan center", () => {
  const stroke = 1;
  const target = { x: 100, y: 50 };
  // The vergence loop holds a pan: the path center sits 40 px right of the
  // crosshair, and the handle encodes +x from THAT center.
  const center = { x: 140, y: 50 };
  const handle = { x: 140 + 100, y: 50 };

  it("uses scan_center_px, and falls back to target only on {0,0}", () => {
    expect(scanCenterOf(center, target)).toEqual(center);
    expect(scanCenterOf({ x: 0, y: 0 }, target)).toEqual(target);
  });

  it("draws the handle on the ray from the scan center, not the crosshair", () => {
    const c = scanCenterOf(center, target);
    expect(axisHandleAt(c, handle, stroke)).toEqual(handle);
    // A handle close to the center is pushed out along the axis FROM the
    // center: anchored on the target the ray would point the same way here,
    // but the minimum distance would be measured from the wrong point.
    const near = { x: 142, y: 50 };
    const at = axisHandleAt(c, near, stroke)!;
    expect(at.x).toBeCloseTo(140 + AXIS_HANDLE_MIN_DIST * stroke, 9);
    expect(at.y).toBeCloseTo(50, 9);
  });

  it("keeps the direction when the handle lies off the target's ray", () => {
    // Axis straight down (+y) from the panned center: anchored on the target
    // the drawn direction would tilt toward the target.
    const down = { x: 140, y: 50 + 3 };
    const at = axisHandleAt(scanCenterOf(center, target), down, stroke)!;
    expect(at.x).toBeCloseTo(140, 9);
    expect(at.y).toBeCloseTo(50 + AXIS_HANDLE_MIN_DIST * stroke, 9);
  });

  it("excludes presses near the scan center, not near the target", () => {
    const r = stroke * AXIS_HANDLE_HIT;
    const near = { x: 142, y: 50 };
    // The crosshair sits ON the drawn handle (a pan of one handle length):
    // the exclusion is around the scan center, so the handle still grabs.
    const c = { x: 140, y: 50 };
    const at = axisHandleAt(c, near, stroke)!;
    const onHandle = { ...at };
    expect(scanCenterOf(c, onHandle)).toEqual(c);
    expect(hitsAxisHandle(at, scanCenterOf(c, onHandle), near, stroke)).toBe(
      true,
    );
    // A press on the scan center itself always steers.
    expect(hitsAxisHandle(c, c, near, stroke)).toBe(false);
    expect(
      hitsAxisHandle({ x: c.x + r - 0.01, y: c.y }, c, near, stroke),
    ).toBe(false);
  });
});
