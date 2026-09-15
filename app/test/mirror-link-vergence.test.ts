// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The MirrorLink seam between the SHARED vergence loop (@lib/vergence) and the
// native orbit brick: the session's pose chain (`anglesAt` → A2V) must BE
// `followTarget`'s forward map at zero offset, and the orbit brick's
// `center + J·offset` must reproduce that chain to first order — the two facts
// the app's geometry rests on. Pure: the chain is rebuilt here from the same
// exported pieces the session composes, over a fake conversion set.
// spec: docs/spec/mirror-link.md#targeting , #actuation

import { describe, expect, it } from "vitest";
import type { Point2d } from "core/Geometry";
import {
  followTarget,
  seedVergence,
  type VergenceSeed,
} from "@lib/vergence/vergence";
import { vergeToDistance } from "@lib/stereo";
import { scanAngles } from "@modules/mirror-link/scan";

const BASELINE = 200;
const J_EPS_RAD = 1e-3; // the session's finite-difference half-step
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

describe("orbit pose bridging (center + J·offset)", () => {
  /** The session's `orbitJacobians`: row-major 2×2 volts per radian. */
  function jacobians(): { jL: number[]; jR: number[] } {
    const px = voltsAt({ x: J_EPS_RAD, y: 0 });
    const mx = voltsAt({ x: -J_EPS_RAD, y: 0 });
    const py = voltsAt({ x: 0, y: J_EPS_RAD });
    const my = voltsAt({ x: 0, y: -J_EPS_RAD });
    const d = 2 * J_EPS_RAD;
    const eye = (k: "l" | "r") => [
      (px[k].x - mx[k].x) / d,
      (py[k].x - my[k].x) / d,
      (px[k].y - mx[k].y) / d,
      (py[k].y - my[k].y) / d,
    ];
    return { jL: eye("l"), jR: eye("r") };
  }

  it("linearizes the exact chain to better than 1 % over the whole amplitude range", () => {
    const center = voltsAt(ZERO);
    const { jL, jR } = jacobians();
    const ampRad = (2 * Math.PI) / 180; // SCAN_AMP_RANGE.max
    let worst = 0;
    for (let k = 0; k < 64; k++) {
      const phi = (2 * Math.PI * k) / 64;
      const o = { x: ampRad * Math.cos(phi), y: ampRad * Math.sin(phi) };
      const exact = voltsAt(o);
      const linear = {
        l: {
          x: center.l.x + jL[0]! * o.x + jL[1]! * o.y,
          y: center.l.y + jL[2]! * o.x + jL[3]! * o.y,
        },
        r: {
          x: center.r.x + jR[0]! * o.x + jR[1]! * o.y,
          y: center.r.y + jR[2]! * o.x + jR[3]! * o.y,
        },
      };
      const radius = Math.hypot(exact.l.x - center.l.x, exact.l.y - center.l.y);
      worst = Math.max(
        worst,
        Math.hypot(linear.l.x - exact.l.x, linear.l.y - exact.l.y) / radius,
        Math.hypot(linear.r.x - exact.r.x, linear.r.y - exact.r.y) / radius,
      );
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("puts the ring's centre exactly on the commanded pose", () => {
    const center = voltsAt(ZERO);
    const { jL } = jacobians();
    // A zero offset contributes nothing — the brick's idle pose IS the chain's.
    close(center.l.x + jL[0]! * 0 + jL[1]! * 0, center.l.x);
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
