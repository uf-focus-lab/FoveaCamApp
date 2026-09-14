// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Drag-target SLEW shared by the steering pacers (manual-control, mirror-link's
// idle pose) — slew the commanded pose toward the latest pointer target so each
// 1 ms tick is a DISTINCT pose the StreamUpdateGate passes (else the raw re-push
// dedupes to the pointer rate), then epsilon-snap and go quiet. Pure + Vue-free
// (unit-tested). Behavior spec: docs/spec/manual-control.md §drag-slew.

export type SlewPos = { x: number; y: number };
export type SlewPair = { l: SlewPos; r: SlewPos };

/** First-order time constant (ms): the smoothed pose lags a MOVING target by
 *  ~one pointer interval (125 Hz ≈ 8 ms), so perceived drag latency does not
 *  grow; after the pointer stops, the tail settles to EPSILON in a few tens
 *  of ms. */
export const SLEW_TAU_MS = 8;

/** Convergence epsilon (volts, per channel). Just above the DAC LSB
 *  (200 V / 65535 ≈ 3 mV): differences below it are sub-quantization — snap
 *  to the exact target and go quiet. */
export const SLEW_EPSILON_V = 0.005;

/** One pacer tick of the smoother: move `current` toward `target` by the
 *  first-order step `1 − exp(−dt/τ)`. Returns the new commanded pose and
 *  whether it SETTLED (all four channels within epsilon → pose IS the exact
 *  target, so consecutive settled ticks dedupe downstream). Monotonic per
 *  channel (alpha ∈ (0, 1] — never overshoots), converges for any dt > 0. */
export function slewStep(
  current: SlewPair,
  target: SlewPair,
  dtMs: number,
  tauMs: number = SLEW_TAU_MS,
  epsilonV: number = SLEW_EPSILON_V,
): { pose: SlewPair; settled: boolean } {
  const alpha = tauMs > 0 ? 1 - Math.exp(-Math.max(0, dtMs) / tauMs) : 1;
  const step = (c: number, t: number): number => c + (t - c) * alpha;
  const within = (c: number, t: number): boolean => Math.abs(t - c) <= epsilonV;
  const settled =
    within(current.l.x, target.l.x) && within(current.l.y, target.l.y) &&
    within(current.r.x, target.r.x) && within(current.r.y, target.r.y);
  if (settled)
    // Snap: emit the EXACT target (once — afterwards poses are identical and
    // the stream-update gate dedupes them).
    return {
      pose: { l: { ...target.l }, r: { ...target.r } },
      settled: true,
    };
  return {
    pose: {
      l: { x: step(current.l.x, target.l.x), y: step(current.l.y, target.l.y) },
      r: { x: step(current.r.x, target.r.x), y: step(current.r.y, target.r.y) },
    },
    settled: false,
  };
}
