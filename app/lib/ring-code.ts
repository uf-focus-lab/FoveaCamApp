// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Ring code — the optical frame a blinking emitter paints around ONE MirrorLink
// scan revolution, and the decoder that reads it back off a binary ring sample
// array. Pure: Vue-free, core-free, no DOM. Rotation-, direction- and
// seam-agnostic; the chip arc is MEASURED per frame, never assumed.
// spec: docs/spec/ring-code.md#frame

/** Frame boundary — Manchester data never holds 3 OFF chips. */
export const GAP: readonly number[] = [0, 0, 0];

/** Start of sequence: the only 4-chip ON run on the ring, asymmetric so the
 *  reading direction is decidable. */
export const LEADER: readonly number[] = [1, 1, 1, 1, 0, 1, 1, 0];

/** Chips in the LEADER's opening ON burst — the first clock estimate. */
const LEADER_ON = 4;

/** Thinnest chip arc (ring samples) the reader will trust; below it the emitter
 *  is over budget (spec §budget) and the frame is refused, never guessed. */
export const DEFAULT_MIN_CHIP_PX = 12;

/** Largest frame the reader will chase before declaring the gap missing. */
const MAX_BITS = 8 * (2 + 255);

/**
 * CRC-8 (poly 0x07, init 0x00, MSB-first, no reflection, no final XOR) over a
 * BIT sequence — the LEN and DATA bits, never the chips.
 *
 * @returns the 8-bit register value.
 */
export function crc8(bits: ArrayLike<number>): number {
  let reg = 0;
  for (let i = 0; i < bits.length; i++) {
    const fb = ((reg >> 7) & 1) ^ (bits[i] & 1);
    reg = ((reg << 1) & 0xff) ^ (fb ? 0x07 : 0);
  }
  return reg;
}

function pushBits(out: number[], value: number, n: number): void {
  for (let i = n - 1; i >= 0; i--) out.push((value >> i) & 1);
}

/**
 * Encode one frame: `[GAP][LEADER][Manchester(LEN | DATA | CRC8)]`, MSB-first,
 * bit `1` → chips `1 0` and bit `0` → chips `0 1`.
 *
 * @returns the chip sequence (0/1), `11 + 16·(LEN + 2)` chips long.
 */
export function encodeFrame(data: Uint8Array): Uint8Array {
  const payload: number[] = [];
  pushBits(payload, data.length & 0xff, 8);
  for (const byte of data) pushBits(payload, byte, 8);
  const bits = payload.slice();
  pushBits(bits, crc8(payload), 8);
  const chips = new Uint8Array(GAP.length + LEADER.length + 2 * bits.length);
  let k = 0;
  for (const c of GAP) chips[k++] = c;
  for (const c of LEADER) chips[k++] = c;
  for (const b of bits) {
    chips[k++] = b ? 1 : 0;
    chips[k++] = b ? 0 : 1;
  }
  return chips;
}

/** Why a frame was dropped (spec §reader). There is no correction, only
 *  rejection: the emitter's next cycle is a fresh, independent read. `no ring`
 *  comes from the EXTRACTION stage (no circle fit); the rest from `decodeRing`. */
export type RingFailure =
  | "no ring"
  | "no leader"
  | "below resolution"
  | "low contrast"
  | "chip period inconsistent with LEN"
  | "no terminating gap"
  | "truncated"
  | "crc mismatch";

/** Minimum separation between a bit's two half-chip means, on the NORMALIZED
 *  profile (0..1). Below it the chips have merged (blur, over-budget emitter)
 *  and guessing would risk a CRC-passing wrong read. */
export const DEFAULT_MIN_CONTRAST = 0.15;

/** A frame-structure boundary the renderer draws a divider at. `byte` marks an
 *  interior DATA byte boundary; the rest open their field. */
export type RingFieldName = "gap" | "leader" | "len" | "data" | "crc" | "byte";

/** One boundary, as a (fractional) sample index in the ORIGINAL array's
 *  orientation — the caller maps it to an angle. */
export type RingFieldEdge = { name: RingFieldName; at: number };

export type RingDecode =
  | {
      ok: true;
      data: Uint8Array;
      /** The frame read backwards (mirror/scan sense) — annotations are already
       *  mapped back, this only names the direction. */
      reverse: boolean;
      /** Measured chip arc, in ring samples. */
      chipPx: number;
      /** Sample index (original orientation) of the LEADER's first chip. */
      leaderStart: number;
      /** ...and of the first LEN chip. */
      dataStart: number;
      fieldEdges: RingFieldEdge[];
    }
  | {
      ok: false;
      reason: RingFailure;
      /** Which bit the read gave up on (`low contrast`) — the offline
       *  debugging hook. */
      bitIndex?: number;
      /** That bit's measured |A − B| on the normalized profile. */
      contrast?: number;
      /** The chip arc in play when it failed, when one was measured. */
      chipPx?: number;
    };

/** What one eye's reader publishes (telemetry; spec mirror-link.md §reader).
 *  A type alias, NOT an interface — it rides a contract telemetry slot whose
 *  values are constrained to `Serializable`. */
export type RingReadout = {
  ok: boolean;
  reason?: RingFailure;
  /** Printable latin-1 of the decoded bytes, non-printables as `·`. */
  text?: string;
  hex?: string;
  /** Fitted ring in frame px; null when the circle fit itself failed. */
  circle: { x: number; y: number; r: number } | null;
  chipPx?: number;
  reverse?: boolean;
  /** Failure diagnostics (spec §reader): the bit the read gave up on and its
   *  measured contrast. */
  bitIndex?: number;
  contrast?: number;
  /** Peak deviation of the measured RIDGE radius from the fitted circle, in
   *  frame px — how far the real path departs from a circle (mirror-axis gain/
   *  phase mismatch shows up here). */
  ridgePx?: number;
  /** Leader arc endpoints, radians in image coordinates (already un-reversed). */
  leaderArc?: { from: number; to: number };
  /** Field + byte boundaries, radians in image coordinates. */
  dividers?: { name: RingFieldName; angle: number }[];
  /** Debug-strip geometry when the histogram views asked for one (spec
   *  mirror-link.md §ring-views); absent otherwise. */
  strip?: { polarRows: number; width: number; rows: number };
  /** The last SUCCESSFUL read on this eye, carried through failures. */
  last?: { text: string; hex: string };
};

type Run = { value: number; start: number; length: number };

/** Circular run-length encoding. Empty for a constant ring. */
function runs(ring: Uint8Array): Run[] {
  const n = ring.length;
  let start = -1;
  for (let i = 1; i < n; i++)
    if (ring[i] !== ring[i - 1]) {
      start = i;
      break;
    }
  if (start < 0) return [];
  const out: Run[] = [];
  let i = start;
  for (;;) {
    let j = i;
    while (ring[(j + 1) % n] === ring[i % n]) j++;
    out.push({ value: ring[i % n], start: i % n, length: j - i + 1 });
    i = (j + 1) % n;
    if (i === start) return out;
  }
}

type Leader = { dataStart: number; chipPx: number; leaderStart: number };

/**
 * Every LEADER candidate on the ring, in run-length structure (spec §reader).
 * A point-sampled tail check is scale-ambiguous — under blur a 2-chip ON run
 * preceded by a 2-chip OFF run passes at half scale — so the whole
 * `GAP 000 | 1111 0 11 0` shape is measured as RUNS, in units of the burst's own
 * chip estimate. Every candidate is returned; the caller decodes each until one
 * passes CRC.
 */
function findLeaderCandidates(ring: Uint8Array): Leader[] {
  const rl = runs(ring);
  const n = ring.length;
  const out: Leader[] = [];
  if (rl.length < 5) return out;
  const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
  for (let k = 0; k < rl.length; k++) {
    const burst = rl[k];
    if (burst.value !== 1) continue;
    const spc0 = burst.length / LEADER_ON;
    if (spc0 <= 0) continue;
    const at_ = (o: number) =>
      rl[(((k + o) % rl.length) + rl.length) % rl.length];
    // GAP (≥ 3 chips OFF, bounded so a dark stretch is not a leader), then the
    // tail's own runs: 0 (1 chip), 11 (2 chips), 0 (≥ ½ chip).
    if (!within(at_(-1).length / spc0, 2.5, 5.5)) continue;
    if (!within(at_(1).length / spc0, 0.4, 1.5)) continue;
    if (!within(at_(2).length / spc0, 1.5, 2.5)) continue;
    if (at_(3).length / spc0 < 0.5) continue;
    const span = (((at_(2).start - burst.start) % n) + n) % n;
    const chipPx = (spc0 + span / 5) / 2;
    out.push({
      leaderStart: burst.start,
      dataStart: burst.start + LEADER.length * chipPx,
      chipPx,
    });
  }
  return out;
}

/** Mean of the normalized profile over the half-open sample span [from, to),
 *  circularly. */
function meanOver(sig: ArrayLike<number>, from: number, to: number): number {
  const n = sig.length;
  const i0 = Math.round(from);
  const i1 = Math.round(to);
  if (i1 <= i0) return sig[((i0 % n) + n) % n];
  let sum = 0;
  for (let x = i0; x < i1; x++) sum += sig[((x % n) + n) % n];
  return sum / (i1 - i0);
}

/** Bit-read outcome; `progress` ranks candidates so the reported failure comes
 *  from the one that got FURTHEST through the frame. */
type BitRead =
  | { ok: true; bits: number[]; chipPx: number; progress: number }
  | {
      ok: false;
      reason: RingFailure;
      bitIndex?: number;
      contrast?: number;
      chipPx: number;
      progress: number;
    };

const bitsToInt = (bits: number[], from: number, count: number): number => {
  let v = 0;
  for (let i = from; i < from + count; i++) v = (v << 1) | bits[i];
  return v;
};

/** Chips in a frame carrying `len` DATA bytes. */
const frameChips = (len: number): number =>
  GAP.length + LEADER.length + 16 * (len + 2);

/** Least-squares slope of `edge` against `chipIndex` over the recent edges — the
 *  local chip period, which follows whatever angular-speed variation the
 *  arc-length resampling left behind. */
function edgeSlope(chips: number[], edges: number[]): number {
  const m = chips.length;
  let kBar = 0;
  let xBar = 0;
  for (let i = 0; i < m; i++) {
    kBar += chips[i];
    xBar += edges[i];
  }
  kBar /= m;
  xBar /= m;
  let num = 0;
  let den = 0;
  for (let i = 0; i < m; i++) {
    const dk = chips[i] - kBar;
    num += dk * (edges[i] - xBar);
    den += dk * dk;
  }
  return den > 0 ? num / den : NaN;
}

/** Edges kept for the period fit. */
const SLOPE_WINDOW = 8;
/** Phase offsets tried per bit, spanning ±PHASE_SPAN chips. */
const PHASE_STEPS = 9;
const PHASE_SPAN = 0.35;
/** The terminating gap must average below this on the normalized profile. */
const GAP_LEVEL = 0.35;

/**
 * Manchester bits from `pos`, LENGTH-driven (spec §reader steps 6–8). Each bit
 * is a JOINT template + phase decision: the two half-chip means are evaluated at
 * nine phase offsets and the most-separated alignment wins, which re-anchors the
 * clock every bit; the chip period then follows the least-squares slope of the
 * recent mid-bit edges. LEN says how many bits the frame holds and the read
 * stops there — the trailing gap is CONFIRMED, never searched for.
 */
function readBits(
  sig: ArrayLike<number>,
  from: number,
  seedChipPx: number,
  minContrast: number,
): BitRead {
  const n = sig.length;
  const bits: number[] = [];
  const edgeChip: number[] = [];
  const edgePos: number[] = [];
  let pos = from;
  let chipPx = seedChipPx;
  let total: number | null = null;
  for (;;) {
    if (total !== null && bits.length === total) {
      if (meanOver(sig, pos, pos + 3 * chipPx) > GAP_LEVEL)
        return {
          ok: false,
          reason: "no terminating gap",
          chipPx,
          progress: bits.length,
        };
      return { ok: true, bits, chipPx, progress: bits.length };
    }
    // Joint bit decision + phase resync: both Manchester templates over a range
    // of phase offsets; keep the best-separated alignment.
    let bestD = 0;
    let a = 0;
    let b = 0;
    for (let k = 0; k < PHASE_STEPS; k++) {
      const d =
        (-PHASE_SPAN + (2 * PHASE_SPAN * k) / (PHASE_STEPS - 1)) * chipPx;
      const aK = meanOver(sig, pos + d, pos + d + chipPx);
      const bK = meanOver(sig, pos + d + chipPx, pos + d + 2 * chipPx);
      if (Math.abs(aK - bK) > Math.abs(a - b)) {
        bestD = d;
        a = aK;
        b = bK;
      }
    }
    const contrast = Math.abs(a - b);
    if (contrast < minContrast)
      return {
        ok: false,
        reason: "low contrast",
        bitIndex: bits.length,
        contrast,
        chipPx,
        progress: bits.length,
      };
    bits.push(a > b ? 1 : 0);
    if (total === null && bits.length === 8) {
      // LEN is a PLAUSIBILITY check, not a pin: the frame fills the ring by
      // construction, so a period far from N / frameChips(LEN) means this
      // candidate is not the frame.
      const len = bitsToInt(bits, 0, 8);
      const expected = n / frameChips(len);
      if (Math.abs(chipPx - expected) > 0.35 * expected)
        return {
          ok: false,
          reason: "chip period inconsistent with LEN",
          chipPx,
          progress: 8,
        };
      total = 16 + 8 * len;
    }
    const edge = pos + bestD + chipPx; // this bit's mid-bit edge
    edgeChip.push(2 * bits.length - 1); // ...one chip into bit k ⇒ chip 2k+1
    edgePos.push(edge);
    if (edgeChip.length >= 3) {
      const slope = edgeSlope(
        edgeChip.slice(-SLOPE_WINDOW),
        edgePos.slice(-SLOPE_WINDOW),
      );
      if (slope > 0.6 * chipPx && slope < 1.4 * chipPx) chipPx = slope;
    }
    pos = edge + chipPx;
    if (bits.length > MAX_BITS)
      return {
        ok: false,
        reason: "no terminating gap",
        chipPx,
        progress: bits.length,
      };
  }
}

/** Threshold the normalized profile at 0.5 and median-3 it (circular): a
 *  one-sample dropout — the exposure seam, speckle — cannot fake an edge. A 0/1
 *  input passes through unchanged apart from the filter. */
function median3(samples: ArrayLike<number>): Uint8Array {
  const n = samples.length;
  const out = new Uint8Array(n);
  const hi = (v: number) => (v >= 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = hi(samples[(i - 1 + n) % n]);
    const b = hi(samples[i]);
    const c = hi(samples[(i + 1) % n]);
    out[i] = a + b + c >= 2 ? 1 : 0;
  }
  return out;
}

function reversed(ring: Uint8Array): Uint8Array {
  const n = ring.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ring[n - 1 - i];
  return out;
}

/** Reverse a float profile (the decode's other reading direction). */
function reversedF(sig: ArrayLike<number>): Float32Array {
  const n = sig.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = sig[n - 1 - i];
  return out;
}

/** Field + interior byte boundaries, in the decode's own orientation. */
function edgesOf(
  dataStart: number,
  chipPx: number,
  len: number,
): RingFieldEdge[] {
  const leaderStart = dataStart - LEADER.length * chipPx;
  const edges: RingFieldEdge[] = [
    { name: "gap", at: leaderStart - GAP.length * chipPx },
    { name: "leader", at: leaderStart },
    { name: "len", at: dataStart },
    { name: "data", at: dataStart + 16 * chipPx },
  ];
  for (let i = 1; i < len; i++)
    edges.push({ name: "byte", at: dataStart + (16 + 16 * i) * chipPx });
  edges.push({ name: "crc", at: dataStart + (16 + 16 * len) * chipPx });
  return edges;
}

/** One candidate's full decode attempt. */
function attemptDecode(
  sig: ArrayLike<number>,
  hit: Leader,
  n: number,
  reverse: boolean,
  minChipPx: number,
  minContrast: number,
): { result: RingDecode; progress: number } {
  if (hit.chipPx < minChipPx)
    return {
      result: { ok: false, reason: "below resolution", chipPx: hit.chipPx },
      progress: 0,
    };
  const read = readBits(sig, hit.dataStart, hit.chipPx, minContrast);
  if (!read.ok)
    return {
      result: {
        ok: false,
        reason: read.reason,
        bitIndex: read.bitIndex,
        contrast: read.contrast,
        chipPx: read.chipPx,
      },
      progress: read.progress,
    };
  const { bits, chipPx } = read;
  if (bits.length < 16)
    return {
      result: { ok: false, reason: "truncated", chipPx },
      progress: bits.length,
    };
  const len = bitsToInt(bits, 0, 8);
  const payload = bits.slice(0, bits.length - 8);
  if (crc8(payload) !== bitsToInt(bits, bits.length - 8, 8))
    return {
      result: { ok: false, reason: "crc mismatch", chipPx },
      // Ranked above a same-length earlier failure: it read the whole frame.
      progress: bits.length + 1,
    };
  const data = new Uint8Array(len);
  for (let i = 0; i < len; i++) data[i] = bitsToInt(payload, 8 + 8 * i, 8);
  // Annotations are reported in the ORIGINAL orientation: a reversed decode's
  // sample i sits at n − 1 − i.
  const unmap = (i: number): number =>
    reverse ? (((n - 1 - i) % n) + n) % n : ((i % n) + n) % n;
  return {
    result: {
      ok: true,
      data,
      reverse,
      chipPx,
      leaderStart: unmap(hit.leaderStart),
      dataStart: unmap(hit.dataStart),
      fieldEdges: edgesOf(hit.dataStart, chipPx, len).map((e) => ({
        name: e.name,
        at: unmap(e.at),
      })),
    },
    progress: bits.length + 2,
  };
}

/**
 * Decode one revolution (spec §reader): threshold + median-3 for the structural
 * search, EVERY leader candidate in both directions, and for each a per-bit
 * joint template/phase read of LEN's length, then the terminating gap and CRC-8.
 * The first CRC-valid candidate wins; if none does, the reported reason is the
 * one from the candidate that got furthest.
 *
 * @param profile the ENVELOPE-NORMALIZED ring, 0..1, resampled uniformly in ARC
 * LENGTH (index 0 at arc 0, one turn). A plain binary 0/1 array is a valid
 * profile.
 * @returns the frame plus annotation geometry (sample indices in the profile's
 * own orientation), or the reason it was dropped.
 */
export function decodeRing(
  profile: ArrayLike<number>,
  opts: { minChipPx?: number; minContrast?: number } = {},
): RingDecode {
  const minChipPx = opts.minChipPx ?? DEFAULT_MIN_CHIP_PX;
  const minContrast = opts.minContrast ?? DEFAULT_MIN_CONTRAST;
  const n = profile.length;
  if (n < 2) return { ok: false, reason: "no leader" };
  const med = median3(profile);
  let best: { result: RingDecode; progress: number } | null = null;
  for (const reverse of [false, true]) {
    const ring = reverse ? reversed(med) : med;
    const sig = reverse ? reversedF(profile) : profile;
    for (const hit of findLeaderCandidates(ring)) {
      const attempt = attemptDecode(
        sig,
        hit,
        n,
        reverse,
        minChipPx,
        minContrast,
      );
      if (attempt.result.ok) return attempt.result;
      if (!best || attempt.progress > best.progress) best = attempt;
    }
  }
  return best ? best.result : { ok: false, reason: "no leader" };
}

/** Printable latin-1 rendering of decoded bytes; anything without a visible
 *  glyph — controls, NBSP (0xA0) and the soft hyphen (0xAD) — becomes `·`. */
export function ringText(data: Uint8Array): string {
  let out = "";
  for (const b of data) {
    const visible = (b >= 0x20 && b < 0x7f) || (b >= 0xa1 && b !== 0xad);
    out += visible ? String.fromCharCode(b) : "·";
  }
  return out;
}

/** Lowercase hex of decoded bytes. */
export function ringHex(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}
