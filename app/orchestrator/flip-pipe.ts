// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Session-owned FLIP node: a named reuse of the native per-frame flip brick
// (`FlipStream`, docs/spec/core-streams.md#flip-stream) — a pass-through copy
// of a source pipe whose frames are VERTICALLY flipped or not, frame by frame,
// according to the trajectory marker that triggered them. MirrorLink's
// triangular scan exposes one frame on the rising sweep and one on the falling
// sweep; the second is flipped before any consumer (view, ring reader) sees it
// (docs/spec/mirror-link.md#triangle-flip). Seam-injected (never imports core
// at runtime) so a session unit-tests without the native addon.

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** One trigger the brick may match a frame to. `tExposure` is the marker
 *  push's OWNER-APPLIED trusted host-steady ns (the same domain as a frame's
 *  `deviceTimestamp` after the owner's clock dt), `flip` whether a frame
 *  exposed by this trigger is flipped. */
export interface FlipAnchor {
  tExposure: bigint;
  flip: boolean;
}

export interface FlipPipeOptions {
  /** Match tolerance: a frame flips iff an anchor lies within this of its
   *  timestamp (nearest wins). The session derives it from the marker
   *  spacing (a fraction of the sweep time T). */
  toleranceNs: bigint;
  /** Bounded anchor pool (drop-oldest); default a few periods' worth. */
  anchorCap?: number;
}

/** Brick-side counters, for `perf.trajectory.flipped` / `.unmatched`. */
export interface FlipProbe {
  frames: number;
  flipped: number;
  /** Frames with no anchor inside the tolerance — passed through unflipped. */
  unmatched: number;
  anchorPoolSize: number;
}

/** The seam this helper drives — `advertise`/`unadvertise` MUST be the pipe
 *  session handle's (discovery-mutating); the rest wrap the native brick
 *  (`attachFlipPipe` / `pushFlipAnchor` / `detachFlipPipe` / `flipProbe`) with
 *  a PIPE-ID source (chained form only, like the slice/scale seams). */
export interface FlipPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(sourcePipeId: string, pipeId: string, options: FlipPipeOptions): void;
  pushAnchor(pipeId: string, anchor: FlipAnchor): void;
  probe(pipeId: string): FlipProbe | null;
  detach(pipeId: string): void;
}

export interface FlipHandle {
  readonly pipeId: string;
  /** Feed one marker push (OK status only — a failed trigger exposed no
   *  frame). Cheap; FIN-rate. */
  pushAnchor(anchor: FlipAnchor): void;
  probe(): FlipProbe | null;
  /** Detach the producer + un-advertise (consumers see CLOSED). */
  retire(): void;
}

/** Advertise `pipeId` with the SOURCE pipe's own spec (same format, dims and
 *  ring footprint — a flip changes no bytes-per-frame) and attach the brick
 *  chained on `sourcePipeId` (a convert pipe). Advertise BEFORE attach — the
 *  producer must find its pipe. */
export function createFlipPipe(
  seam: FlipPipeSeam,
  sourcePipeId: string,
  sourceSpec: PipeSpec,
  pipeId: string,
  opts: FlipPipeOptions,
): FlipHandle {
  seam.advertise({ ...sourceSpec, id: pipeId });
  seam.attach(sourcePipeId, pipeId, opts);
  return {
    pipeId,
    pushAnchor: (a) => seam.pushAnchor(pipeId, a),
    probe: () => seam.probe(pipeId),
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}
