// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Short memory of mirror positions vs host time: a small ring of {hostNs, left, right}
// answering mirrorAt(hostNs) by linear interpolation, so the L/R undistort homography can
// use the mirror position at a frame's (past) exposure time (commands ~1 kHz, frames
// ~60 fps). Written ONLY by controller-node.ts (the one trajectory place) — immediate
// updates at send time, scheduled keyframes (CMD_SCHEDULE) at their apply time, and an
// uploaded trajectory's OK pushes at their exposure time. Honesty note:
// these are COMMANDS (physical mirror lags by LPF group delay + settle) — triggered
// captures should prefer the FIN exposure-averaged voltage when present.
// spec: docs/spec/controller.md#mirror-history

import type { Pos } from "@lib/controller-codec";

export interface MirrorSample {
  hostNs: bigint;
  left: Pos;
  right: Pos;
}

export interface MirrorAt {
  left: Pos;
  right: Pos;
  /** Distance from the query instant to the nearest recorded sample —
   *  the staleness/confidence signal (≥0; huge = extrapolating). */
  ageNs: bigint;
  /** False when the query landed outside the recorded span (clamped to the
   *  nearest endpoint instead of interpolated). */
  interpolated: boolean;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpPos = (a: Pos, b: Pos, t: number): Pos => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

/** Fixed-capacity ring, monotonic-time append. 4096 ≈ 4 s at the 1 kHz
 *  stream-update ceiling — comfortably longer than any frame latency. */
export class MirrorHistory {
  private readonly ring: MirrorSample[];
  private head = 0; // next write slot
  private count = 0;

  constructor(readonly capacity = 4096) {
    this.ring = new Array<MirrorSample>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Append a sample. Out-of-order timestamps (clock hiccup) are dropped —
   *  the ring must stay monotonic for the binary search. */
  record(hostNs: bigint, left: Pos, right: Pos): void {
    const newest = this.at(-1);
    if (newest && hostNs < newest.hostNs) return;
    this.ring[this.head] = {
      hostNs,
      left: { x: left.x, y: left.y },
      right: { x: right.x, y: right.y },
    };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** The newest recorded sample (null when empty). A scheduled keyframe
   *  (controller node `updateAt`) may be NEWER than now — this is then the
   *  last pending keyframe, not the current position. */
  newest(): MirrorSample | null {
    return this.at(-1);
  }

  /** Drop every sample strictly newer than `hostNs` (from the newest end —
   *  the ring stays monotonic). The controller node calls this when an
   *  immediate stream UPDATE supersedes pending CMD_SCHEDULE keyframes (the
   *  firmware clears the stream's ring, so those future samples never
   *  happen). Returns how many samples were dropped. */
  truncateAfter(hostNs: bigint): number {
    let dropped = 0;
    while (this.count > 0 && this.at(-1)!.hostNs > hostNs) {
      this.head = (this.head - 1 + this.capacity) % this.capacity;
      this.count--;
      dropped++;
    }
    return dropped;
  }

  /** i = 0 oldest … count-1 newest (negative = from the end). */
  private at(i: number): MirrorSample | null {
    if (this.count === 0) return null;
    const idx = i < 0 ? this.count + i : i;
    if (idx < 0 || idx >= this.count) return null;
    const start = (this.head - this.count + this.capacity * 2) % this.capacity;
    return this.ring[(start + idx) % this.capacity] ?? null;
  }

  /** Mirror position at `hostNs`: linear interpolation between the bracketing
   *  samples; clamped (with `interpolated: false`) outside the span; null when
   *  the ring is empty. */
  mirrorAt(hostNs: bigint): MirrorAt | null {
    if (this.count === 0) return null;
    const oldest = this.at(0)!;
    const newest = this.at(-1)!;
    if (hostNs <= oldest.hostNs)
      return {
        left: oldest.left,
        right: oldest.right,
        ageNs: oldest.hostNs - hostNs,
        interpolated: hostNs === oldest.hostNs,
      };
    if (hostNs >= newest.hostNs)
      return {
        left: newest.left,
        right: newest.right,
        ageNs: hostNs - newest.hostNs,
        interpolated: hostNs === newest.hostNs,
      };
    // Binary search for the first sample with t > hostNs.
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.at(mid)!.hostNs <= hostNs) lo = mid + 1;
      else hi = mid;
    }
    const after = this.at(lo)!;
    const before = this.at(lo - 1)!;
    const span = after.hostNs - before.hostNs;
    const t = span === 0n ? 0 : Number(hostNs - before.hostNs) / Number(span);
    const ageNs =
      hostNs - before.hostNs < after.hostNs - hostNs
        ? hostNs - before.hostNs
        : after.hostNs - hostNs;
    return {
      left: lerpPos(before.left, after.left, t),
      right: lerpPos(before.right, after.right, t),
      ageNs,
      interpolated: true,
    };
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

/** THE orchestrator-wide history (single controller ⇒ single trajectory).
 *  Written by the controller node's update path; read by the fovea/undistort
 *  homography. */
export const mirrorHistory = new MirrorHistory();
