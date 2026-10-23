// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The MirrorLink seam between the SHARED vergence loop (@lib/vergence) and the
// scan pattern: the session's pose chain (`anglesAt` → A2V) must BE
// `followTarget`'s forward map at zero offset, and the trajectory samples
// (`patternSamples` through that chain) are centred on it — the facts the app's
// geometry rests on. Pure: the chain is rebuilt here from the same exported
// pieces the session composes, over a fake conversion set.
// spec: docs/spec/mirror-link.md#targeting , #actuation

import { describe, expect, it } from "vitest";
import type { Point2d } from "core/Geometry";
import {
  followTarget,
  seedVergence,
  type VergenceSeed,
} from "@lib/vergence/vergence";
import { vergeToDistance } from "@lib/stereo";
import { patternSamples, scanAngles } from "@modules/mirror-link/scan";

const BASELINE = 200;
const SEED_PARALLEL_EPS = 1e-9;

/** A deliberately NON-linear angle→volt map per eye (the real regressions are),
 *  so a first-order check is not trivially exact. */
const conv = {
  P2A: { C: (p: Point2d) => ({ x: p.x * 4e-4, y: p.y * 4e-4 }) },
  A2V: {
    L: (a: Point2d) => ({
      x: 42 * Math.tan(a.x) + 3,
      y: 39 * Math.tan(a.y) - 1,
    }),
    R: (a: Point2d) => ({
      x: 41 * Math.tan(a.x) - 2,
      y: 38 * Math.tan(a.y) + 4,
    }),
  },
};

const target: Point2d = { x: 260, y: -140 };
const targetAngle = conv.P2A.C(target);
const held: VergenceSeed = {
  pan: { x: 0.004, y: -0.002 },
  verge: 0.7,
  v_shift: 0.0015,
};

/** The session's `anglesAt` — the ONE chain the scan and the loop share. */
function anglesAt(offset: Point2d, dof: VergenceSeed = held) {
  return scanAngles(
    { x: targetAngle.x + dof.pan.x, y: targetAngle.y + dof.pan.y },
    offset,
    BASELINE,
    vergeToDistance(dof.verge, BASELINE),
    dof.v_shift,
  );
}
const voltsAt = (offset: Point2d, dof: VergenceSeed = held) => {
  const a = anglesAt(offset, dof);
  return { l: conv.A2V.L(a.l), r: conv.A2V.R(a.r) };
};

const ZERO: Point2d = { x: 0, y: 0 };
const close = (a: number, b: number, eps = 1e-12) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("mirror-link pose chain = followTarget", () => {
  it("reproduces followTarget exactly at zero offset", () => {
    const chain = voltsAt(ZERO);
    const follow = followTarget(target, held, conv, BASELINE);
    close(chain.l.x, follow.left.x);
    close(chain.l.y, follow.left.y);
    close(chain.r.x, follow.right.x);
    close(chain.r.y, follow.right.y);
  });

  it("agrees for a parallel, unshifted, uncorrected pose too", () => {
    const flat: VergenceSeed = { pan: ZERO, verge: 0, v_shift: 0 };
    const chain = voltsAt(ZERO, flat);
    const follow = followTarget(target, flat, conv, BASELINE);
    close(chain.l.x, follow.left.x);
    close(chain.r.y, follow.right.y);
  });
});

describe("trajectory samples ride the same chain", () => {
  it("a zero-amplitude pattern commands followTarget at every sample (both modes)", () => {
    const follow = followTarget(target, held, conv, BASELINE);
    for (const mode of ["ellipse", "triangle"] as const)
      for (const { offset } of patternSamples(mode, 10, 30, 0, 0.5)) {
        const v = voltsAt(offset);
        close(v.l.x, follow.left.x);
        close(v.l.y, follow.left.y);
        close(v.r.x, follow.right.x);
        close(v.r.y, follow.right.y);
      }
  });

  it("centres the ellipse on the vergence ray (the offsets average to zero)", () => {
    const s = patternSamples("ellipse", 10, 25, 1.5, 0.6);
    const mean = s.reduce(
      (m, { offset }) => ({ x: m.x + offset.x / s.length, y: m.y + offset.y / s.length }),
      { x: 0, y: 0 },
    );
    close(mean.x, 0, 1e-6);
    close(mean.y, 0, 1e-6);
  });

  it("puts the triangle's two samples symmetric about the vergence ray", () => {
    const [a, b] = patternSamples("triangle", 10, -40, 1, 1);
    close(a!.offset.x, -b!.offset.x);
    close(a!.offset.y, -b!.offset.y);
  });
});

describe("engage seam (seedVergence from the slider pose)", () => {
  it("recovers pan 0 + the sliders' verge/shift from the disengaged pose", () => {
    const sliders: VergenceSeed = { pan: ZERO, verge: 0.55, v_shift: 0.003 };
    const A = anglesAt(ZERO, sliders);
    const seed = seedVergence(
      A.l,
      A.r,
      targetAngle,
      BASELINE,
      SEED_PARALLEL_EPS,
    );
    close(seed.pan.x, 0, 1e-12);
    close(seed.pan.y, 0, 1e-12);
    close(seed.verge, sliders.verge, 1e-12);
    close(seed.v_shift, sliders.v_shift, 1e-12);
  });

  it("recovers a parallel pose without dividing by zero", () => {
    const sliders: VergenceSeed = { pan: ZERO, verge: 0, v_shift: 0 };
    const A = anglesAt(ZERO, sliders);
    const seed = seedVergence(
      A.l,
      A.r,
      targetAngle,
      BASELINE,
      SEED_PARALLEL_EPS,
    );
    expect(seed.verge).toBe(0);
    close(seed.pan.x, 0, 1e-12);
    close(seed.v_shift, 0, 1e-12);
  });

  it("round-trips a pose the loop itself reached (disengage holds it)", () => {
    const A = anglesAt(ZERO); // `held` carries a non-zero pan
    const seed = seedVergence(
      A.l,
      A.r,
      targetAngle,
      BASELINE,
      SEED_PARALLEL_EPS,
    );
    close(seed.pan.x, held.pan.x, 1e-12);
    close(seed.pan.y, held.pan.y, 1e-12);
    close(seed.verge, held.verge, 1e-12);
    close(seed.v_shift, held.v_shift, 1e-12);
  });
});
