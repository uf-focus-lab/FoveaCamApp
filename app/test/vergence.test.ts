// disparity-scope's `stepVergence` control law (PURE — the
// template-match mechanism lives in @orchestrator/template-match-kernel, fed
// by slice/scale bricks). `stepVergence` is the actual risk surface (error
// decomposition, PID wiring, sign conventions, low-score hold behavior) and
// is pure math over synthetic projections — matched-point pairs + scores,
// decoupled from how the split match nodes produce them. vergence.ts is
// core-free now (types only), so no native mocks are needed.

import { describe, expect, it } from "vitest";

import { PID, PID2D } from "@lib/pid";
import {
  followTarget,
  foveaFootprintOnWide,
  foveaTileSize,
  matchMagnification,
  recordTarget,
  seedVergence,
  stepVergence,
  targetAtEpoch,
  type ScopeProjection,
  type TargetSample,
  type VergenceControllers,
} from "@lib/vergence/vergence";
import type { Point2d } from "core/Geometry";
import {
  fitMagnification,
  recordMagnification,
  type CoordinateConversions,
  type MagnificationSample,
} from "@lib/coordinate-conversions";
import { distanceToVerge } from "@lib/stereo";

// Identity conversions: pixel == angle, angle == volt. Isolates the test from
// the (separately-defined, already-used-elsewhere) stereo/regression math, so
// it only verifies `stepVergence`'s own error decomposition and controller
// wiring. `P2A.C` takes the post-replumb `undistort` flag; identity ignores it.
const identityConv: Pick<CoordinateConversions, "P2A" | "A2V"> = {
  P2A: { C: (p: Point2d) => p },
  A2V: { L: (a: Point2d) => a, R: (a: Point2d) => a },
};

// The scope feeds `stepVergence` a projection (points already lifted to
// wide-frame pixels by the session's join). Under `identityConv`
// the projected points ARE the center-camera angles.
function freshControllers(): VergenceControllers {
  const scalar = () => new PID({ kp: 0, ki: 1, kd: 0, limits: [-10, 10] });
  const axis = { kp: 0, ki: 1, kd: 0, limits: [-10, 10] as [number, number] };
  return {
    pan: new PID2D({ x: axis, y: axis }),
    verge: scalar(),
    v_shift: scalar(),
  };
}

function projectionFor(
  target: Point2d,
  matchedL: Point2d,
  matchedR: Point2d,
  score = 1,
  overridden = false,
): ScopeProjection {
  return {
    l: matchedL,
    r: matchedR,
    target,
    scores: { l: score, r: score },
    overridden,
  };
}

// The fovea↔wide template match is only meaningful when the fovea tile and the
// wide guide strip render the SAME angular content at the SAME pixel scale. The
// fovea frame spans the wide FOV divided by the magnification `zoom`, so in
// wide-frame pixels it covers `width / zoom`; the guide strip is downsampled by
// `scale`, so that same footprint is `(width / zoom) * scale` strip pixels. The
// fovea tile MUST be resized to exactly that many pixels — i.e. `foveaTileSize`
// must apply the magnification identically to both sides. These pin that
// invariant so a regression that dropped `zoom` from one side (matching a
// full-resolution fovea against an un-demagnified strip — the "same pixel scale"
// class of bug) can't pass silently.
//
// NOTE: the magnification used here is the session's nominal
// `zoom` STATE (default 9.0), not the calibration-measured fovea/wide ratio
// (`findPinholeProjection` measures it as `scale` but discards it). The math is
// self-consistent for any `zoom`; correctness of the *absolute* scale still
// hinges on `zoom` matching the real optics — see docs/spec/
// disparity-scope.md.
describe("foveaTileSize (fovea↔wide match scale-consistency)", () => {
  const stripFootprintPx = (width: number, zoom: number, scale: number) =>
    (width / zoom) * scale;

  it("resizes the fovea tile to the strip footprint of one fovea frame", () => {
    for (const zoom of [1, 4, 9, 12.5]) {
      for (const scale of [1, 3, 9]) {
        const { width, height } = foveaTileSize({
          width: 1440,
          height: 1080,
          zoom,
          scale,
        });
        expect(width).toBeCloseTo(stripFootprintPx(1440, zoom, scale));
        expect(height).toBeCloseTo(stripFootprintPx(1080, zoom, scale));
      }
    }
  });

  it("keeps tile:strip pixel ratio at 1:1 regardless of zoom (both demagnify by zoom)", () => {
    // A fixed physical patch spanning `wPx` wide-frame pixels lands on the strip
    // as `wPx * scale` px and on the fovea tile as `wPx * scale` px too — the
    // `zoom` factor cancels between the two sides. If it didn't cancel, CCOEFF
    // template matching (not scale-invariant) would fail.
    const scale = 3;
    const wPx = 20; // a patch 20 wide-pixels across
    for (const zoom of [1, 6, 9, 15]) {
      const tile = foveaTileSize({ width: 1440, height: 1080, zoom, scale });
      const tilePxPerWidePx = tile.width / (1440 / zoom); // fovea-frame → tile
      const stripPxPerWidePx = scale; // wide strip downsample factor
      expect(tilePxPerWidePx * wPx).toBeCloseTo(stripPxPerWidePx * wPx);
    }
  });
});

// The measured-magnification derivation is a distance-and-size-free
// ratio of the two cameras' marker quads: preferred from the wide camera's
// view of the SAME side marker (everything cancels), else the
// center-marker fallback with the marker-size metadata. Injected
// `area` keeps the math pure; here we use a shoelace area on synthetic quads.
function shoelace(pts: Point2d[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}
/** An axis-aligned square quad of the given side length (area = side²). */
function square(side: number): Point2d[] {
  return [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ];
}

describe("recordMagnification (marker-quad ratio, distance/size-free)", () => {
  it("preferred: sqrt(area(fovea) / area(wide side marker)) — 9× linear ⇒ 9", () => {
    // Fovea sees the side marker 9× larger (linear) than the wide camera does.
    const d: MagnificationSample = {
      img_points: square(90),
      wide_img_points: square(10),
    };
    expect(recordMagnification(d, shoelace)).toBeCloseTo(9);
  });

  it("fallback: center-marker ratio scaled by center_mm/side_mm", () => {
    // Fovea side-marker quad 90px; wide CENTER-marker quad 10px → sqrt ratio 9.
    // The center marker is half the physical size of the side (10mm vs 20mm),
    // so the true magnification is 9 × (center_mm/side_mm) = 9 × 0.5 = 4.5.
    const d: MagnificationSample = {
      img_points: square(90),
      wide_center_points: square(10),
      marker: { side_mm: 20, center_mm: 10 },
    };
    expect(recordMagnification(d, shoelace)).toBeCloseTo(4.5);
  });

  it("prefers the side-marker quad over the center-marker fallback when both exist", () => {
    const d: MagnificationSample = {
      img_points: square(90),
      wide_img_points: square(10), // preferred → 9
      wide_center_points: square(30), // fallback would give 3 × ratio
      marker: { side_mm: 20, center_mm: 10 },
    };
    expect(recordMagnification(d, shoelace)).toBeCloseTo(9);
  });

  it("excludes a record with neither wide quad (→ null)", () => {
    expect(recordMagnification({ img_points: square(90) }, shoelace)).toBeNull();
    // Center quad present but NO marker metadata → fallback unusable → null.
    expect(
      recordMagnification(
        { img_points: square(90), wide_center_points: square(10) },
        shoelace,
      ),
    ).toBeNull();
  });
});

describe("fitMagnification (mean/std over supporting records)", () => {
  it("averages the per-record magnifications and reports the spread", () => {
    const ds: MagnificationSample[] = [
      { img_points: square(80), wide_img_points: square(10) }, // 8
      { img_points: square(100), wide_img_points: square(10) }, // 10
    ];
    const { magnification, magnification_std } = fitMagnification(ds, shoelace);
    expect(magnification).toBeCloseTo(9); // (8 + 10) / 2
    expect(magnification_std).toBeCloseTo(1); // |8-9| == |10-9| == 1
  });

  it("skips records with no wide quad, keeping the supported ones", () => {
    const ds: MagnificationSample[] = [
      { img_points: square(90), wide_img_points: square(10) }, // 9
      { img_points: square(90) }, // excluded
    ];
    expect(fitMagnification(ds, shoelace).magnification).toBeCloseTo(9);
  });

  it("returns null when NO record supports a measurement (legacy dataset)", () => {
    const ds: MagnificationSample[] = [
      { img_points: square(90) },
      { img_points: square(120) },
    ];
    expect(fitMagnification(ds, shoelace)).toEqual({
      magnification: null,
      magnification_std: null,
    });
    expect(fitMagnification([], shoelace)).toEqual({
      magnification: null,
      magnification_std: null,
    });
  });
});

// Precedence: an explicit nominal `zoom > 0` is
// AUTHORITATIVE over the measured magnification. A zoom of 0 is the "Auto"
// state → use the measured value, else 1. Session and UI both mirror this.
describe("matchMagnification (precedence — explicit zoom wins, 0 = Auto)", () => {
  it("an explicit zoom > 0 is authoritative, even over a measured value", () => {
    expect(matchMagnification(8.7, 9)).toBe(9);
    expect(matchMagnification(8.7, 1)).toBe(1);
    expect(matchMagnification(8.7, 42)).toBe(42);
    // No measured value at all — the explicit zoom still drives.
    expect(matchMagnification(null, 12)).toBe(12);
  });

  it("zoom === 0 (Auto) falls back to the measured magnification", () => {
    expect(matchMagnification(8.7, 0)).toBe(8.7);
    expect(matchMagnification(9, 0)).toBe(9);
  });

  it("zoom === 0 with no valid measured value → 1 (degenerate but honest)", () => {
    expect(matchMagnification(null, 0)).toBe(1);
    expect(matchMagnification(undefined, 0)).toBe(1);
    // Degenerate measured values are rejected in Auto too, → 1.
    expect(matchMagnification(0, 0)).toBe(1);
    expect(matchMagnification(-1, 0)).toBe(1);
    expect(matchMagnification(NaN, 0)).toBe(1);
    expect(matchMagnification(Infinity, 0)).toBe(1);
  });

  it("a non-finite/negative nominal zoom is treated as unset (→ measured/1)", () => {
    expect(matchMagnification(8.7, -2)).toBe(8.7); // negative ⇒ Auto ⇒ measured
    expect(matchMagnification(null, -2)).toBe(1); // and no measured ⇒ 1
    expect(matchMagnification(8.7, NaN)).toBe(8.7);
  });

  it("full chain: knob > per-triple override > measured > 1", () => {
    // The knob (nominal zoom > 0) is authoritative — wins over BOTH the
    // override and the measured value.
    expect(matchMagnification(8.7, 9, 5)).toBe(9);
    // Auto (knob 0): the per-triple override wins over the measured value.
    expect(matchMagnification(8.7, 0, 5)).toBe(5);
    // Auto with no override: the measured value drives.
    expect(matchMagnification(8.7, 0, null)).toBe(8.7);
    expect(matchMagnification(8.7, 0, undefined)).toBe(8.7);
    // Auto with no override AND no measured: the honest 1× floor.
    expect(matchMagnification(null, 0, null)).toBe(1);
    // Override wins even when there is no measured value at all.
    expect(matchMagnification(null, 0, 6)).toBe(6);
  });

  it("rejects a degenerate override at its tier (falls through to measured/1)", () => {
    expect(matchMagnification(8.7, 0, 0)).toBe(8.7); // 0 override ⇒ measured
    expect(matchMagnification(8.7, 0, -3)).toBe(8.7); // negative ⇒ measured
    expect(matchMagnification(8.7, 0, NaN)).toBe(8.7); // NaN ⇒ measured
    expect(matchMagnification(8.7, 0, Infinity)).toBe(8.7); // ∞ ⇒ measured
    expect(matchMagnification(null, 0, 0)).toBe(1); // 0 override, no measured ⇒ 1
    // The 2-arg call is the override-absent case.
    expect(matchMagnification(8.7, 0)).toBe(8.7);
    expect(matchMagnification(8.7, 9)).toBe(9);
  });

  it("feeds foveaTileSize consistently in both modes (tile:strip stays 1:1)", () => {
    // Whichever magnification wins, BOTH the tile and the strip divide by it,
    // so the pixel-scale agreement is preserved.
    for (const [measured, nominal] of [
      [8.62, 9], // explicit zoom drives
      [8.62, 0], // Auto → measured drives
    ] as const) {
      const zoom = matchMagnification(measured, nominal);
      const tile = foveaTileSize({ width: 1440, height: 1080, zoom, scale: 3 });
      expect(tile.width).toBeCloseTo((1440 / zoom) * 3);
      expect(tile.height).toBeCloseTo((1080 / zoom) * 3);
    }
  });
});

// The `overridden` flag is metadata: stepVergence itself never reads it (the
// SESSION branches to `followTarget` before calling stepVergence). Pinning
// flag-agnosticism here keeps the control law honest
// if a future caller ever routes a flagged projection through it.
describe("stepVergence on an overridden projection (flag is not a control input)", () => {
  it("produces the identical command for overridden and non-overridden inputs", () => {
    const target = { x: 10, y: 4 };
    const l = { x: 8, y: 2 };
    const r = { x: 12, y: 3 };
    const a = freshControllers();
    const b = freshControllers();
    const outA = stepVergence(
      projectionFor(target, l, r, 1, false),
      a,
      identityConv,
      { baseline: 200, minScore: 0.1 },
      10,
    );
    const outB = stepVergence(
      projectionFor(target, l, r, 1, true),
      b,
      identityConv,
      { baseline: 200, minScore: 0.1 },
      10,
    );
    expect(outB).toEqual(outA); // drag changes nothing in the control law
    expect(b.verge.value).toBeCloseTo(a.verge.value);
    expect(b.pan.value.x).toBeCloseTo(a.pan.value.x);
  });

  it("holds on a low score even when flagged (why the session must NOT route drags here)", () => {
    const ctl = freshControllers();
    const proj = projectionFor({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }, 0.01, true);
    const out = stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(out).toBeNull();
    expect(ctl.verge.value).toBe(0); // untouched — no windup behind the hold
  });
});

// The drag path: pointer-down RESETS
// pan/verge/v_shift, and while `overridden` the session commands
// `followTarget` with the (all-zero) controller state — BOTH eyes exactly ON
// the raw cursor ray, parallel, vergence at INFINITY, no residual
// corrections; no PID stepping, no match-score gate. A match-gated drag would
// deadlock (strip recenters on the dragged target → scores drop → hold →
// foveas never move); these pin the follow map + the release continuity that
// replaces the seed on this path.
describe("followTarget (drag: parallel follow on the raw ray, vergence at infinity)", () => {
  // The DRAG's held state: ALL controllers reset at pointer-down.
  const dragHeld = () => ({ pan: { x: 0, y: 0 }, verge: 0, v_shift: 0 });

  it("drag state (all DOF reset): both eyes exactly ON the cursor ray, parallel", () => {
    for (const target of [
      { x: 0, y: 0 },
      { x: 12, y: -4 },
      { x: -7, y: 9 },
    ]) {
      const out = followTarget(target, dragHeld(), identityConv, 200);
      expect(out.left).toEqual(target); // parallel: L == R == ray
      expect(out.right).toEqual(target);
    }
  });

  it("a non-zero held pan offsets the ray (generic map — the drag resets pan at start)", () => {
    const held = { pan: { x: 1.5, y: -0.5 }, verge: 0, v_shift: 0 };
    const out = followTarget({ x: 10, y: 4 }, held, identityConv, 200);
    expect(out.left).toEqual({ x: 11.5, y: 3.5 });
    expect(out.right).toEqual({ x: 11.5, y: 3.5 });
  });

  it("is the generic forward map: a non-zero held verge/v_shift reconstructs a converged pose", () => {
    // NOT the drag state (the session zeroes these) — pins that the function
    // is stepVergence's reconstruction for ANY controller state. Small angles
    // so tan/atan2 stay in range; verge > 0 ⇒ finite distance ⇒ the eyes toe
    // in symmetrically about the ray; v_shift splits vertically.
    const held = { pan: { x: 0, y: 0 }, verge: 0.5, v_shift: 0.02 };
    const baseline = 200;
    const target = { x: 0.1, y: 0.05 };
    const out = followTarget(target, held, identityConv, baseline);
    expect(out.left.x).toBeGreaterThan(out.right.x); // toe-in (converged)
    expect(out.left.y - target.y).toBeCloseTo(held.v_shift);
    expect(out.right.y - target.y).toBeCloseTo(-held.v_shift);
    // Moving the target moves BOTH eyes (the follow), same held convergence.
    const out2 = followTarget({ x: 0.2, y: 0.05 }, held, identityConv, baseline);
    expect(out2.left.x).toBeGreaterThan(out.left.x);
    expect(out2.right.x).toBeGreaterThan(out.right.x);
    expect(out2.left.x).toBeGreaterThan(out2.right.x);
  });

  it("release continuity: a zero-error stepVergence from the same controller values reproduces the follow output", () => {
    // On pointer-up the target stays at the drag end and the controllers
    // carry exactly what the follow commanded (all reset at pointer-down).
    // Once the foveas arrive (matched centres == target ⇒ zero error), the
    // first PID step's reconstruction is the SAME forward map followTarget
    // used ⇒ identical volts, no release jump. Exercised for the actual drag
    // state AND a generic held state (the identity is a property of the map,
    // not of the reset).
    for (const held of [
      { pan: { x: 0, y: 0 }, verge: 0, v_shift: 0 }, // the drag state
      { pan: { x: 0.02, y: -0.01 }, verge: 0.4, v_shift: 0.015 }, // generic
    ]) {
      const target = { x: 0.08, y: -0.03 };
      const follow = followTarget(target, held, identityConv, 200);
      const ctl = freshControllers();
      ctl.pan.value = held.pan;
      ctl.verge.value = held.verge;
      ctl.v_shift.value = held.v_shift;
      const resumed = stepVergence(
        projectionFor(target, target, target, 1),
        ctl,
        identityConv,
        { baseline: 200, minScore: 0.1 },
        10,
      );
      expect(resumed).not.toBeNull();
      expect(resumed!.left.x).toBeCloseTo(follow.left.x);
      expect(resumed!.left.y).toBeCloseTo(follow.left.y);
      expect(resumed!.right.x).toBeCloseTo(follow.right.x);
      expect(resumed!.right.y).toBeCloseTo(follow.right.y);
    }
  });
});

// The per-eye pose markers on the wide C view must draw at the fovea FOOTPRINT
// (the magnified fovea frame shrinks onto the wide view by the app-config zoom),
// not at the full wide-frame size — user-reported marker-scaling bug.
describe("foveaFootprintOnWide (wide-view marker size)", () => {
  it("shrinks a full frame by the zoom ratio", () => {
    expect(foveaFootprintOnWide({ width: 1440, height: 1080 }, 9)).toEqual({
      width: 160,
      height: 120,
    });
    expect(foveaFootprintOnWide({ width: 1200, height: 900 }, 3)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it("clamps zoom to >= 1 (a <1 zoom can't shrink the wide FOV)", () => {
    const full = { width: 1440, height: 1080 };
    expect(foveaFootprintOnWide(full, 1)).toEqual(full);
    expect(foveaFootprintOnWide(full, 0.5)).toEqual(full);
    expect(foveaFootprintOnWide(full, 0)).toEqual(full);
  });

  it("matches the sliced-center crop math (width/zoom × height/zoom)", () => {
    // The overlay footprint and the kernel's sliced crop MUST agree so the
    // markers frame exactly the tile the sliced view shows.
    for (const zoom of [1, 4, 9, 12.5]) {
      const f = foveaFootprintOnWide({ width: 1440, height: 1080 }, zoom);
      const z = Math.max(1, zoom);
      expect(f.width).toBeCloseTo(1440 / z);
      expect(f.height).toBeCloseTo(1080 / z);
    }
  });
});

// The drag-release seam (user-reported "mirror jumps to another location"):
// `seedVergence` inverts `stepVergence`'s reconstruction. A parallel drag (both
// eyes on the SAME ray) MUST seed verge/v_shift = 0; the jump was recovering the
// angles from the pinned VOLTS through the asymmetric per-eye V2A, which returns
// gL ≠ gR and fabricates a toe-in. Seeding from the KNOWN ray keeps them 0.
describe("seedVergence (drag-release reconstruction — no fabricated toe-in)", () => {
  it("a PARALLEL gaze (gL == gR) seeds verge = v_shift = 0 and pan = ray − target", () => {
    const ray = { x: 0.2, y: -0.1 };
    const aT = { x: 0.15, y: -0.05 };
    const seed = seedVergence(ray, ray, aT, 200);
    expect(seed.verge).toBe(0);
    expect(seed.v_shift).toBe(0);
    expect(seed.pan.x).toBeCloseTo(ray.x - aT.x);
    expect(seed.pan.y).toBeCloseTo(ray.y - aT.y);
  });

  it("target == drag ray ⇒ pan = 0 (resume exactly at the dragged ray)", () => {
    const ray = { x: 0.3, y: 0.05 };
    const seed = seedVergence(ray, ray, ray, 200);
    expect(seed.pan.x).toBeCloseTo(0);
    expect(seed.pan.y).toBeCloseTo(0);
    expect(seed.verge).toBe(0);
    expect(seed.v_shift).toBe(0);
  });

  it("DOCUMENTS the bug: asymmetric per-eye angles (the volt round-trip) fabricate verge + v_shift", () => {
    // A parallel drag round-tripped through independent L/R V2A regressions
    // comes back as two slightly different angles (the OLD seed path).
    const ray = { x: 0.2, y: -0.1 };
    const gL = { x: ray.x + 0.01, y: ray.y + 0.006 };
    const gR = { x: ray.x - 0.008, y: ray.y - 0.004 };
    const round = seedVergence(gL, gR, ray, 200);
    expect(Math.abs(round.verge)).toBeGreaterThan(0); // fabricated toe-in = the jump
    expect(Math.abs(round.v_shift)).toBeGreaterThan(0);
    // Seeding from the KNOWN ray instead keeps both exactly 0.
    const direct = seedVergence(ray, ray, ray, 200);
    expect(direct.verge).toBe(0);
    expect(direct.v_shift).toBe(0);
  });

  it("recovers a genuine finite verge from a truly converged pose (generic override path)", () => {
    // Build gL/gR from the forward model at distance z; the inverse returns z.
    const baseline = 200;
    const z = 1000;
    const ray = { x: 0.1, y: 0.02 };
    const b = baseline / 2;
    const x = z * Math.tan(ray.x);
    const gL = { x: Math.atan2(x + b, z), y: ray.y + 0.03 };
    const gR = { x: Math.atan2(x - b, z), y: ray.y - 0.03 };
    const seed = seedVergence(gL, gR, ray, baseline);
    expect(seed.verge).toBeCloseTo(distanceToVerge(z, baseline));
    expect(seed.v_shift).toBeCloseTo(0.03);
    expect(seed.pan.x).toBeCloseTo(0);
    expect(seed.pan.y).toBeCloseTo(0);
  });
});

// End-to-end continuity: seed the controllers from the released override, then
// run ONE stepVergence — the command must equal the pinned override volts (no
// jump), and a subsequent disparity must drive convergence.
describe("drag-release continuity (seed → step reproduces the override)", () => {
  // Asymmetric per-eye A2V so a volt round-trip WOULD fabricate vergence; P2A
  // identity (undistorted pixel == angle). stepVergence uses only P2A + A2V.
  const A2VL = (a: Point2d): Point2d => ({ x: 2 * a.x + 0.05 * a.y + 0.1, y: 3 * a.y - 0.02 });
  const A2VR = (a: Point2d): Point2d => ({ x: 1.7 * a.x - 0.03 * a.y - 0.2, y: 2.6 * a.y + 0.05 });
  const conv: Pick<CoordinateConversions, "P2A" | "A2V"> = {
    P2A: { C: (p: Point2d) => p },
    A2V: { L: A2VL, R: A2VR },
  };

  function seededControllers(seed: {
    pan: Point2d;
    verge: number;
    v_shift: number;
  }): VergenceControllers {
    const ctl = freshControllers();
    ctl.pan.value = seed.pan;
    ctl.verge.value = seed.verge;
    ctl.v_shift.value = seed.v_shift;
    return ctl;
  }

  it("first post-release command == the pinned override volts (drag: both eyes on the ray)", () => {
    const ray = { x: 12, y: -4 }; // undistorted pixel == angle (identity P2A)
    const target = ray; // the drag sets target to the drag point
    const override = { l: A2VL(ray), r: A2VR(ray) };
    // Drag-path seed: from the KNOWN ray (gL = gR = ray), not V2A(volts).
    const seed = seedVergence(ray, ray, conv.P2A.C(target, false), 200);
    const ctl = seededControllers(seed);
    // The foveas are where the override put them: both on the drag ray, so
    // their matched wide-pixel centres == the target.
    const proj = projectionFor(target, ray, ray, 1);
    const out = stepVergence(proj, ctl, conv, { baseline: 200, minScore: 0.1 }, 10);
    expect(out).not.toBeNull();
    expect(out!.left.x).toBeCloseTo(override.l.x);
    expect(out!.left.y).toBeCloseTo(override.l.y);
    expect(out!.right.x).toBeCloseTo(override.r.x);
    expect(out!.right.y).toBeCloseTo(override.r.y);
  });

  it("the fabricated-verge seed (the volt round-trip) DOES jump; the direct-ray seed does not", () => {
    const ray = { x: 5, y: 2 };
    const aT = ray;
    const override = { l: A2VL(ray), r: A2VR(ray) };
    // Eyes on the drag ray, matched at the target ⇒ zero first-step error, so
    // any command deviation is purely the seed's fabricated toe-in.
    const proj = projectionFor(ray, ray, ray, 1);

    const good = seededControllers(seedVergence(ray, ray, aT, 200));
    const outGood = stepVergence(proj, good, conv, { baseline: 200, minScore: 0.1 }, 10)!;
    const jumpGood = Math.hypot(outGood.left.x - override.l.x, outGood.right.x - override.r.x);
    expect(jumpGood).toBeLessThan(1e-9);

    // Same drag, but seeded from asymmetric per-eye angles (the volt round-trip).
    const bad = seededControllers(
      seedVergence({ x: ray.x + 0.02, y: ray.y + 0.01 }, { x: ray.x - 0.02, y: ray.y - 0.01 }, aT, 200),
    );
    const outBad = stepVergence(proj, bad, conv, { baseline: 200, minScore: 0.1 }, 10)!;
    const jumpBad = Math.hypot(outBad.left.x - override.l.x, outBad.right.x - override.r.x);
    expect(jumpBad).toBeGreaterThan(1e-3);
  });

  it("then converges: a residual disparity in the next projection steps verge toward closing it", () => {
    const ray = { x: 0, y: 0 };
    const ctl = seededControllers(seedVergence(ray, ray, ray, 200));
    // Matched R further right than L ⇒ positive verge error ⇒ eyes toe in.
    const proj = projectionFor({ x: 0, y: 0 }, { x: -3, y: 0 }, { x: 3, y: 0 }, 1);
    stepVergence(proj, ctl, conv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.verge.value).toBeGreaterThan(0);
  });
});

describe("stepVergence", () => {
  it("holds (returns null) and leaves the controllers untouched when either match score is below minScore", () => {
    const ctl = freshControllers();
    const proj = projectionFor({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.05);
    const result = stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(result).toBeNull();
    expect(ctl.verge.value).toBe(0);
    expect(ctl.pan.value.x).toBe(0);
  });

  it("commands zero correction when both eyes already match the target exactly", () => {
    const ctl = freshControllers();
    const target = { x: 5, y: -3 };
    const proj = projectionFor(target, target, target, 1);
    const result = stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(result).not.toBeNull();
    // Zero pan/verge/v_shift error -> the controllers stay at their initial
    // value, and the reconstructed ray is just the target itself (identity).
    expect(ctl.verge.value).toBeCloseTo(0);
    expect(ctl.v_shift.value).toBeCloseTo(0);
    expect(result!.left.x).toBeCloseTo(target.x);
    expect(result!.left.y).toBeCloseTo(target.y);
    expect(result!.right.x).toBeCloseTo(target.x);
  });

  it("a right-matched-further-right-than-left disparity integrates verge positively", () => {
    const ctl = freshControllers();
    const target = { x: 0, y: 0 };
    // aR.x - aL.x > 0 (see the module doc's error decomposition table).
    const proj = projectionFor(target, { x: -2, y: 0 }, { x: 2, y: 0 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.verge.value).toBeGreaterThan(0);
  });

  it("a positive (aR.y - aL.y) disparity integrates v_shift positively", () => {
    const ctl = freshControllers();
    const target = { x: 0, y: 0 };
    // eVshift = (aR.y - aL.y) / 2, fed to the controller as-is (the header
    // comment's "opposite sign" note describes how v_shift is later *applied*
    // to the two eyes' y — out.l.y = ray.y + v_shift, out.r.y = ray.y -
    // v_shift — not a negation inside stepVergence itself).
    const proj = projectionFor(target, { x: 0, y: -2 }, { x: 0, y: 2 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.v_shift.value).toBeGreaterThan(0);
  });

  it("a common-mode offset (both eyes short of the target by the same amount) drives pan, not verge", () => {
    const ctl = freshControllers();
    const target = { x: 10, y: 4 };
    const proj = projectionFor(target, { x: 8, y: 2 }, { x: 8, y: 2 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 10);
    expect(ctl.verge.value).toBeCloseTo(0);
    expect(ctl.v_shift.value).toBeCloseTo(0);
    expect(ctl.pan.value.x).toBeGreaterThan(0);
    expect(ctl.pan.value.y).toBeGreaterThan(0);
  });

  it("dt=0 still saturates but performs no meaningful integration step", () => {
    const ctl = freshControllers();
    const proj = projectionFor({ x: 0, y: 0 }, { x: -5, y: 0 }, { x: 5, y: 0 }, 1);
    stepVergence(proj, ctl, identityConv, { baseline: 200, minScore: 0.1 }, 0);
    expect(ctl.verge.value).toBeCloseTo(0);
  });
});

// The vergence controllers run derivative-on-
// measurement, and stepVergence supplies each DOF's measurement point. Only
// PAN actually changes behavior — its setpoint (the target ray) moves during
// follow; verge/v_shift regulate to a CONSTANT 0-disparity setpoint, so their
// measurement-mode derivative is numerically identical to error mode.
describe("stepVergence derivative-on-measurement (R2 — no target kick)", () => {
  const kdAxis = {
    kp: 0,
    ki: 0,
    kd: 1,
    dTau: 0,
    limits: [-10, 10] as [number, number],
  };
  function kdControllers(derivativeOn: "error" | "measurement"): VergenceControllers {
    const opts = { ...kdAxis, derivativeOn };
    return {
      pan: new PID2D({ x: opts, y: opts }),
      verge: new PID(opts),
      v_shift: new PID(opts),
    };
  }
  const step = (ctl: VergenceControllers, target: Point2d, l: Point2d, r: Point2d) =>
    stepVergence(
      projectionFor(target, l, r, 1),
      ctl,
      identityConv,
      { baseline: 200, minScore: 0.1 },
      1,
    );

  it("a target jump with matched centers HELD kicks pan kd in error mode, NOT in measurement mode", () => {
    const eyes = { x: 0, y: 0 };
    const onError = kdControllers("error");
    const onMeas = kdControllers("measurement");
    step(onError, { x: 0, y: 0 }, eyes, eyes); // prime derivative memory
    step(onMeas, { x: 0, y: 0 }, eyes, eyes);
    const target = { x: 5, y: -3 }; // the tracker moved the setpoint
    const outError = step(onError, target, eyes, eyes)!;
    const outMeas = step(onMeas, target, eyes, eyes)!;
    // Error mode: d(ePan)/dt = target velocity rides kd into the ray
    // (output ≠ target even though ki = 0 integrated nothing).
    expect(Math.abs(outError.left.x - target.x)).toBeGreaterThan(1);
    // Measurement mode: gaze unchanged → zero derivative → ray == target.
    expect(outMeas.left.x).toBeCloseTo(target.x);
    expect(outMeas.left.y).toBeCloseTo(target.y);
  });

  it("gaze (measurement) motion drives the pan derivative identically in both modes", () => {
    const target = { x: 0, y: 0 };
    const onError = kdControllers("error");
    const onMeas = kdControllers("measurement");
    step(onError, target, { x: 1, y: 0 }, { x: 1, y: 0 });
    step(onMeas, target, { x: 1, y: 0 }, { x: 1, y: 0 });
    const outError = step(onError, target, { x: 3, y: 0 }, { x: 3, y: 0 })!;
    const outMeas = step(onMeas, target, { x: 3, y: 0 }, { x: 3, y: 0 })!;
    expect(outMeas.left.x).toBeCloseTo(outError.left.x);
    expect(outMeas.right.x).toBeCloseTo(outError.right.x);
  });

  it("verge/v_shift commands are UNCHANGED by the mode (constant 0-disparity setpoint)", () => {
    const target = { x: 0, y: 0 };
    const onError = kdControllers("error");
    const onMeas = kdControllers("measurement");
    // A growing disparity (both axes) — pure measurement motion; with ki = 0
    // the commanded pose is ALL derivative, so any mode divergence shows.
    step(onError, target, { x: -1, y: -1 }, { x: 1, y: 1 });
    step(onMeas, target, { x: -1, y: -1 }, { x: 1, y: 1 });
    const outError = step(onError, target, { x: -2, y: -2 }, { x: 2, y: 2 })!;
    const outMeas = step(onMeas, target, { x: -2, y: -2 }, { x: 2, y: 2 })!;
    expect(outMeas.left).toEqual(outError.left);
    expect(outMeas.right).toEqual(outError.right);
    // And the derivative genuinely acted (toe-in + vertical split ≠ 0).
    expect(outMeas.left.x).not.toBeCloseTo(outMeas.right.x);
    expect(outMeas.left.y).not.toBeCloseTo(outMeas.right.y);
  });
});

// The capture-epoch target ring. The join
// resolves the target AS OF the matched frame's capture timestamp (trusted
// host-ns deviceTimestamp) so the PID error never contains phantom
// target-motion the matches haven't seen yet.
describe("targetAtEpoch / recordTarget (capture-epoch target ring, R1)", () => {
  const FALLBACK = { x: 999, y: 999 };
  function ringOf(...ts: [number, number][]): TargetSample[] {
    const ring: TargetSample[] = [];
    for (const [t, x] of ts) recordTarget(ring, { t, target: { x, y: -x } }, 16);
    return ring;
  }

  it("resolves an exact epoch to that sample", () => {
    const ring = ringOf([100, 1], [200, 2], [300, 3]);
    expect(targetAtEpoch(ring, 200, FALLBACK)).toEqual({ x: 2, y: -2 });
  });

  it("between entries → nearest-not-after (the write in effect at the epoch)", () => {
    const ring = ringOf([100, 1], [200, 2], [300, 3]);
    expect(targetAtEpoch(ring, 250, FALLBACK)).toEqual({ x: 2, y: -2 });
    expect(targetAtEpoch(ring, 299.9, FALLBACK)).toEqual({ x: 2, y: -2 });
  });

  it("after the last entry → the newest write (target unchanged since)", () => {
    const ring = ringOf([100, 1], [200, 2]);
    expect(targetAtEpoch(ring, 5000, FALLBACK)).toEqual({ x: 2, y: -2 });
  });

  it("before the first entry → fallback (out of coverage is untrusted — the uncalibrated-clock degrade)", () => {
    const ring = ringOf([100, 1], [200, 2]);
    expect(targetAtEpoch(ring, 50, FALLBACK)).toBe(FALLBACK);
  });

  it("empty ring / missing / non-finite epoch → fallback (the live target)", () => {
    expect(targetAtEpoch([], 100, FALLBACK)).toBe(FALLBACK);
    const ring = ringOf([100, 1]);
    expect(targetAtEpoch(ring, undefined, FALLBACK)).toBe(FALLBACK);
    expect(targetAtEpoch(ring, NaN, FALLBACK)).toBe(FALLBACK);
    expect(targetAtEpoch(ring, Infinity, FALLBACK)).toBe(FALLBACK);
  });

  it("recordTarget caps the ring oldest-first and drops out-of-order stamps", () => {
    const ring: TargetSample[] = [];
    for (let t = 1; t <= 20; t++) recordTarget(ring, { t, target: { x: t, y: 0 } }, 8);
    expect(ring.length).toBe(8);
    expect(ring[0]!.t).toBe(13); // oldest evicted
    recordTarget(ring, { t: 5, target: { x: -1, y: 0 } }, 8); // clock hiccup
    expect(ring.length).toBe(8);
    expect(ring[ring.length - 1]!.t).toBe(20); // dropped, order intact
    // Equal stamps are kept (same-instant rewrite wins as the newer entry).
    recordTarget(ring, { t: 20, target: { x: 42, y: 0 } }, 8);
    expect(targetAtEpoch(ring, 20, FALLBACK)).toEqual({ x: 42, y: 0 });
  });
});
