// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Center-view scan overlay helpers (spec docs/spec/mirror-link.md §views): the
// path polyline closes only for a non-degenerate ellipse, and the axis handle's
// grab zone is `stroke · AXIS_HANDLE_HIT` around it, never on the {0,0}
// uncalibrated sentinel.

import { describe, expect, it } from "vitest";
import {
  AXIS_HANDLE_HIT,
  hitsAxisHandle,
  isClosedPath,
  polylinePath,
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

describe("isClosedPath", () => {
  it("closes the ellipse, not its line limit nor the triangle", () => {
    expect(isClosedPath("ellipse", 1)).toBe(true);
    expect(isClosedPath("ellipse", 0.01)).toBe(true);
    expect(isClosedPath("ellipse", 0)).toBe(false);
    expect(isClosedPath("triangle", 1)).toBe(false);
  });
});

describe("hitsAxisHandle", () => {
  const handle = { x: 100, y: 50 };
  const stroke = 2;
  const r = stroke * AXIS_HANDLE_HIT;
  it("grabs inside the hit radius", () => {
    expect(hitsAxisHandle(handle, handle, stroke)).toBe(true);
    expect(hitsAxisHandle({ x: 100 + r, y: 50 }, handle, stroke)).toBe(true);
  });
  it("misses outside it", () => {
    expect(hitsAxisHandle({ x: 100 + r + 0.01, y: 50 }, handle, stroke)).toBe(
      false,
    );
  });
  it("never grabs the hidden {0,0} handle", () => {
    expect(hitsAxisHandle({ x: 0, y: 0 }, { x: 0, y: 0 }, stroke)).toBe(false);
  });
});
