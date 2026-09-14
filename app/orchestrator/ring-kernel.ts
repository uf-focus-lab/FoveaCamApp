// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// RING vision kernel: turns a fovea frame that integrated one MirrorLink
// revolution into a binary ring, decodes the optical frame on it, and
// back-annotates the result in frame px/radians. Runs INSIDE the vision worker,
// one reader per input role (L/R). Pixel work is plain typed-array math — no
// core/Vision call — so the extraction unit-tests without the native addon.
// spec: docs/spec/ring-code.md#reader

import {
  decodeRing,
  ringHex,
  ringText,
  type RingFieldName,
  type RingReadout,
} from "@lib/ring-code";
import type { Mat } from "core/Vision";
import type { FrameSet, KernelOutput, VisionKernel } from "./vision-kernel.js";

/** Bright-mask level between the frame's dark floor and its peak. */
const DEFAULT_BRIGHT_FRACTION = 0.5;
/** Mask decimation for the fit — the ring is many px wide, full res buys nothing. */
const DECIMATE = 2;
/** Fewer inliers than this is speckle, not a ring. */
const MIN_RING_POINTS = 24;
/** Below this radius (frame px) no chip could be resolved. */
const MIN_RADIUS_PX = 16;
/** Angular-coverage bins and the fraction of them a real ring must occupy. */
const COVERAGE_BINS = 72;
const MIN_COVERAGE = 0.5;
/** Robust re-fits after the algebraic fit, each dropping >3σ radial residuals. */
const ROBUST_REFITS = 2;
const PROFILE_MIN = 512;
const PROFILE_MAX = 4096;
/** Radial taps averaged per angular sample. */
const TAPS = [-1.5, 0, 1.5];

/** A frame the reader consumes — a plain view over interleaved 8-bit pixels. */
export type RingImage = {
  data: Uint8Array;
  width: number;
  height: number;
  /** 4 = BGRA/RGBA (luminance = max channel), 1 = mono. */
  channels: number;
};

export type RingReadOptions = {
  minChipPx?: number;
  brightFraction?: number;
};

export type RingCircle = { x: number; y: number; r: number };

/** A reader owns its scratch buffers — one per input role, reused every frame
 *  (the hot path allocates only when the profile length grows). */
export interface RingReader {
  read(img: RingImage, opts?: RingReadOptions): RingReadout;
}

const luma = (img: RingImage, index: number): number => {
  const p = index * img.channels;
  if (img.channels < 3) return img.data[p];
  const b = img.data[p];
  const g = img.data[p + 1];
  const r = img.data[p + 2];
  return b > g ? (b > r ? b : r) : g > r ? g : r;
};

/** Bilinear luminance at a (possibly fractional) pixel; 0 outside the frame. */
function sample(img: RingImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return 0;
  const fx = x - x0;
  const fy = y - y0;
  const row = y0 * img.width + x0;
  const a = luma(img, row);
  const b = luma(img, row + 1);
  const c = luma(img, row + img.width);
  const d = luma(img, row + img.width + 1);
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

/**
 * Algebraic (Kåsa) circle fit over `count` points: minimizes the ALGEBRAIC
 * residual of `x² + y² = A·x + B·y + C`, a 3×3 normal system. Null when the
 * points are degenerate (collinear / coincident).
 */
function kasaFit(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
): RingCircle | null {
  if (count < 3) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0,
    sz = 0,
    sxz = 0,
    syz = 0;
  for (let i = 0; i < count; i++) {
    const x = xs[i];
    const y = ys[i];
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sz += z;
    sxz += x * z;
    syz += y * z;
  }
  // Normal equations [sxx sxy sx; sxy syy sy; sx sy n] · [A B C]ᵀ = [sxz syz sz]ᵀ
  const m = [
    [sxx, sxy, sx, sxz],
    [sxy, syy, sy, syz],
    [sx, sy, count, sz],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = m[row][col] / m[col][col];
      for (let k = col; k < 4; k++) m[row][k] -= f * m[col][k];
    }
  }
  const A = m[0][3] / m[0][0];
  const B = m[1][3] / m[1][1];
  const C = m[2][3] / m[2][2];
  const cx = A / 2;
  const cy = B / 2;
  const rr = C + cx * cx + cy * cy;
  if (!(rr > 0) || !Number.isFinite(rr)) return null;
  return { x: cx, y: cy, r: Math.sqrt(rr) };
}

/** Occupied fraction of the angular bins around `circle` — a dot occupies a
 *  handful of bins, a ring most of them (spec §reader "Circle fit"). */
function coverage(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  circle: RingCircle,
  bins: Uint8Array,
): number {
  bins.fill(0);
  for (let i = 0; i < count; i++) {
    const a = Math.atan2(ys[i] - circle.y, xs[i] - circle.x);
    const bin = Math.floor(((a + Math.PI) / (2 * Math.PI)) * COVERAGE_BINS);
    bins[Math.min(COVERAGE_BINS - 1, Math.max(0, bin))] = 1;
  }
  let used = 0;
  for (let i = 0; i < COVERAGE_BINS; i++) used += bins[i];
  return used / COVERAGE_BINS;
}

export function createRingReader(): RingReader {
  // Scratch, grown on demand and reused across frames.
  let xs = new Float64Array(0);
  let ys = new Float64Array(0);
  let profile = new Float32Array(0);
  let sorted = new Float32Array(0);
  let binary = new Uint8Array(0);
  const bins = new Uint8Array(COVERAGE_BINS);

  function ensurePoints(n: number): void {
    if (xs.length >= n) return;
    xs = new Float64Array(n);
    ys = new Float64Array(n);
  }
  function ensureProfile(n: number): void {
    if (profile.length >= n) return;
    profile = new Float32Array(n);
    sorted = new Float32Array(n);
    binary = new Uint8Array(n);
  }

  /** Bright mask on the decimated frame → the fitted circle in FULL-res px. */
  function fitCircle(
    img: RingImage,
    brightFraction: number,
  ): RingCircle | null {
    const dw = Math.floor(img.width / DECIMATE);
    const dh = Math.floor(img.height / DECIMATE);
    if (dw < 3 || dh < 3) return null;
    let dark = 255;
    let peak = 0;
    for (let y = 0; y < dh; y++) {
      const row = y * DECIMATE * img.width;
      for (let x = 0; x < dw; x++) {
        const v = luma(img, row + x * DECIMATE);
        if (v < dark) dark = v;
        if (v > peak) peak = v;
      }
    }
    if (peak <= dark) return null;
    const level = dark + brightFraction * (peak - dark);
    ensurePoints(dw * dh);
    let count = 0;
    for (let y = 0; y < dh; y++) {
      const row = y * DECIMATE * img.width;
      for (let x = 0; x < dw; x++)
        if (luma(img, row + x * DECIMATE) >= level) {
          xs[count] = x;
          ys[count] = y;
          count++;
        }
    }
    if (count < MIN_RING_POINTS) return null;
    let circle = kasaFit(xs, ys, count);
    if (!circle) return null;
    for (let pass = 0; pass < ROBUST_REFITS; pass++) {
      let mean = 0;
      for (let i = 0; i < count; i++)
        mean += Math.hypot(xs[i] - circle.x, ys[i] - circle.y);
      mean /= count;
      let varSum = 0;
      for (let i = 0; i < count; i++) {
        const d = Math.hypot(xs[i] - circle.x, ys[i] - circle.y) - mean;
        varSum += d * d;
      }
      const sigma = Math.sqrt(varSum / count);
      if (!(sigma > 0)) break;
      let kept = 0;
      for (let i = 0; i < count; i++) {
        const d = Math.abs(
          Math.hypot(xs[i] - circle.x, ys[i] - circle.y) - circle.r,
        );
        if (d <= 3 * sigma) {
          xs[kept] = xs[i];
          ys[kept] = ys[i];
          kept++;
        }
      }
      if (kept < MIN_RING_POINTS) return null;
      count = kept;
      const next = kasaFit(xs, ys, count);
      if (!next) return null;
      circle = next;
    }
    if (coverage(xs, ys, count, circle, bins) < MIN_COVERAGE) return null;
    const full = {
      x: circle.x * DECIMATE,
      y: circle.y * DECIMATE,
      r: circle.r * DECIMATE,
    };
    if (!(full.r >= MIN_RADIUS_PX)) return null;
    if (!Number.isFinite(full.x) || !Number.isFinite(full.y)) return null;
    return full;
  }

  /** Angular profile around `circle` → the thresholded binary ring. */
  function profileOf(img: RingImage, circle: RingCircle): Uint8Array {
    const n = Math.min(
      PROFILE_MAX,
      Math.max(PROFILE_MIN, Math.round(2 * Math.PI * circle.r)),
    );
    ensureProfile(n);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let sum = 0;
      for (const d of TAPS)
        sum += sample(
          img,
          circle.x + (circle.r + d) * ca,
          circle.y + (circle.r + d) * sa,
        );
      profile[i] = sum / TAPS.length;
    }
    sorted.set(profile.subarray(0, n), 0);
    sorted.subarray(0, n).sort();
    const p5 = sorted[Math.floor(0.05 * (n - 1))];
    const p95 = sorted[Math.floor(0.95 * (n - 1))];
    const level = (p5 + p95) / 2;
    for (let i = 0; i < n; i++) binary[i] = profile[i] >= level ? 1 : 0;
    return binary.subarray(0, n);
  }

  return {
    read(img, opts = {}): RingReadout {
      const circle = fitCircle(
        img,
        opts.brightFraction ?? DEFAULT_BRIGHT_FRACTION,
      );
      if (!circle) return { ok: false, reason: "no ring", circle: null };
      const ring = profileOf(img, circle);
      const decoded = decodeRing(ring, { minChipPx: opts.minChipPx });
      if (!decoded.ok) return { ok: false, reason: decoded.reason, circle };
      const angle = (i: number): number => (2 * Math.PI * i) / ring.length;
      const dividers: { name: RingFieldName; angle: number }[] =
        decoded.fieldEdges.map((e) => ({ name: e.name, angle: angle(e.at) }));
      return {
        ok: true,
        text: ringText(decoded.data),
        hex: ringHex(decoded.data),
        circle,
        chipPx: decoded.chipPx,
        reverse: decoded.reverse,
        leaderArc: {
          from: angle(decoded.leaderStart),
          to: angle(decoded.dataStart),
        },
        dividers,
      };
    },
  };
}

/** Kernel params (`kind: "ring"`). Disabled = no pixel work at all. */
export type RingParams = {
  kind?: "ring";
  enabled?: boolean;
  minChipPx?: number;
  brightFraction?: number;
};

/** Worker→main values: one readout per input role that produced a frame. */
export type RingValues = Partial<Record<string, RingReadout>>;

/** The `ring` kernel: one reader per role, decoding every arriving fovea frame
 *  while the scan is running. */
export function createRingKernel(
  initial: Record<string, unknown>,
): VisionKernel {
  const p: Required<Omit<RingParams, "kind">> = {
    enabled: false,
    minChipPx: 0,
    brightFraction: DEFAULT_BRIGHT_FRACTION,
  };
  const readers = new Map<string, RingReader>();

  const kernel: VisionKernel = {
    setParams(params: Record<string, unknown>): void {
      const d = params as RingParams;
      if (d.enabled !== undefined) p.enabled = d.enabled;
      if (d.minChipPx !== undefined) p.minChipPx = d.minChipPx;
      if (d.brightFraction !== undefined) p.brightFraction = d.brightFraction;
    },

    process(frames: FrameSet): KernelOutput {
      if (!p.enabled) return null;
      const values: RingValues = {};
      let any = false;
      for (const [role, frame] of Object.entries(frames)) {
        if (!frame) continue;
        let reader = readers.get(role);
        if (!reader) readers.set(role, (reader = createRingReader()));
        const mat = frame.mat as Mat<Uint8Array>;
        values[role] = reader.read(
          {
            data: mat,
            width: mat.shape[1] ?? 0,
            height: mat.shape[0] ?? 0,
            channels: mat.channels,
          },
          {
            minChipPx: p.minChipPx > 0 ? p.minChipPx : undefined,
            brightFraction: p.brightFraction,
          },
        );
        any = true;
      }
      if (!any) return null;
      return { values: values as Record<string, unknown>, frames: [] };
    },

    dispose(): void {
      readers.clear();
    },
  };

  kernel.setParams(initial);
  return kernel;
}
