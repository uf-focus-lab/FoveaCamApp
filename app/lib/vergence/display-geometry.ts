// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure display-space geometry shared by the RENDERER overlays (index.vue) and
// the vision/control side. Deliberately core-free (type-only) so the renderer
// never pulls vergence.ts's runtime core/Vision import; vergence.ts re-exports it.

import type { Size } from "core/Geometry";

/** The wide-view footprint (px) of ONE fovea frame at the nominal display
 *  `zoom` — the size the per-eye pose/fovea overlay rects must draw at (a fovea
 *  camera is magnified `zoom×`, so its frame projects onto the wide view shrunk
 *  by `zoom`) and the size of the sliced-center crop. `zoom` is clamped to ≥1
 *  (a <1 "zoom" cannot shrink the wide FOV). */
export function foveaFootprintOnWide(size: Size, zoom: number): Size {
  const z = Math.max(1, zoom);
  return { width: size.width / z, height: size.height / z };
}
