// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SPOT vision kernel: where the emitter sits in each fovea frame — the
// MEASUREMENT node behind mirror-link's auto-align servo. Runs INSIDE the
// vision worker, one result per arriving frame per role; the pixel work is the
// pure `findSpot` (decimated scan, then a refine window), so it unit-tests
// without the native addon.
// spec: docs/spec/mirror-link.md#targeting

import { findSpot } from "@modules/mirror-link/align";
import type { Mat } from "core/Vision";
import type { FrameSet, KernelOutput, VisionKernel } from "./vision-kernel.js";

/** Kernel params (`kind: "spot"`). Disabled = no pixel work at all. */
export type SpotParams = {
  kind?: "spot";
  enabled?: boolean;
  /** Lit-pixel threshold as a fraction of the window peak. */
  fraction?: number;
};

/** One eye's measurement: the emitter's centroid in FOVEA-FRAME px, or null
 *  when the frame holds no emitter. */
export type SpotValue = { x: number; y: number; peak: number } | null;

/** Worker→main values: one measurement per input role that produced a frame. */
export type SpotValues = Partial<Record<string, SpotValue>>;

/** Decimation for the coarse pass, and the refine window around its hit. */
const DECIMATE = 2;
const REFINE_PX = 32;

export function createSpotKernel(
  initial: Record<string, unknown>,
): VisionKernel {
  const p: Required<Omit<SpotParams, "kind">> = {
    enabled: false,
    fraction: 0.9,
  };

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as SpotParams;
      if (d.enabled !== undefined) p.enabled = d.enabled;
      if (d.fraction !== undefined) p.fraction = d.fraction;
    },

    process(frames: FrameSet): KernelOutput {
      if (!p.enabled) return null;
      const values: SpotValues = {};
      let any = false;
      for (const [role, frame] of Object.entries(frames)) {
        if (!frame) continue;
        const mat = frame.mat as Mat<Uint8Array>;
        values[role] = findSpot(
          {
            data: mat,
            width: mat.shape[1] ?? 0,
            height: mat.shape[0] ?? 0,
            channels: mat.channels,
          },
          { decimate: DECIMATE, refinePx: REFINE_PX, fraction: p.fraction },
        );
        any = true;
      }
      if (!any) return null;
      return { values: values as Record<string, unknown>, frames: [] };
    },

    dispose(): void {},
  };

  kernel.setParams(initial);
  return kernel;
}
