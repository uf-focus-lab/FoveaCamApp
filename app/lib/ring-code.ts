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
  | "no mid-bit transition"
  | "no terminating gap"
  | "truncated"
  | "length mismatch"
  | "crc mismatch";

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
  | { ok: false; reason: RingFailure };

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
  /** Leader arc endpoints, radians in image coordinates (already un-reversed). */
  leaderArc?: { from: number; to: number };
  /** Field + byte boundaries, radians in image coordinates. */
  dividers?: { name: RingFieldName; angle: number }[];
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

const at = (ring: Uint8Array, pos: number): number =>
  ring[((Math.floor(pos) % ring.length) + ring.length) % ring.length];

type Leader = { dataStart: number; chipPx: number; leaderStart: number };

/** Start of sequence: an ON burst of `LEADER_ON` chips preceded by an OFF run of
 *  ≥ 2.5 chips, with the asymmetric `0 11 0` tail verified at chip centers. The
 *  burst gives the first clock estimate; the 5-chip span from the burst start to
 *  the `11` run start refines it. */
function findLeader(ring: Uint8Array): Leader | null {
  const rl = runs(ring);
  const n = ring.length;
  for (let k = 0; k < rl.length; k++) {
    const run = rl[k];
    if (run.value !== 1) continue;
    let chipPx = run.length / LEADER_ON;
    if (rl[(k - 1 + rl.length) % rl.length].length < 2.5 * chipPx) continue;
    const pos = run.start + run.length;
    let tailOk = true;
    for (let i = 0; i < 4 && tailOk; i++)
      tailOk = at(ring, pos + (i + 0.5) * chipPx) === LEADER[LEADER_ON + i];
    if (!tailOk) continue;
    const span = (((rl[(k + 2) % rl.length].start - run.start) % n) + n) % n;
    chipPx = span / 5;
    return {
      leaderStart: run.start,
      dataStart: run.start + LEADER.length * chipPx,
      chipPx,
    };
  }
  return null;
}

/** Manchester bits from `pos` until the terminating gap, re-anchoring the clock
 *  on every bit's mid-transition. Throws the failure reason as an `Error`. */
function readBits(ring: Uint8Array, from: number, chipPx: number): number[] {
  const bits: number[] = [];
  let pos = from;
  for (;;) {
    if (
      at(ring, pos + 0.5 * chipPx) === 0 &&
      at(ring, pos + 1.5 * chipPx) === 0 &&
      at(ring, pos + 2.5 * chipPx) === 0
    )
      return bits;
    const a = at(ring, pos + 0.5 * chipPx);
    const b = at(ring, pos + 1.5 * chipPx);
    if (a === b) throw new Error("no mid-bit transition");
    bits.push(a === 1 ? 1 : 0);
    let edge = pos + 0.5 * chipPx;
    while (at(ring, edge) === a && edge < pos + 1.5 * chipPx) edge += 0.25;
    pos = edge + chipPx;
    if (bits.length > MAX_BITS) throw new Error("no terminating gap");
  }
}

function median3(samples: ArrayLike<number>): Uint8Array {
  const n = samples.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = samples[(i - 1 + n) % n] ? 1 : 0;
    const b = samples[i] ? 1 : 0;
    const c = samples[(i + 1) % n] ? 1 : 0;
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

/**
 * Decode one revolution (spec §reader steps 1–7): median-3, run-length, leader
 * search in both directions, resolution guard, per-bit resynchronized Manchester
 * read terminated by the gap, then the LEN and CRC-8 checks.
 *
 * @param samples binary ring, index 0 at angle 0, one turn.
 * @returns the frame plus annotation geometry (sample indices in `samples`'
 * own orientation), or the reason it was dropped.
 */
export function decodeRing(
  samples: ArrayLike<number>,
  opts: { minChipPx?: number } = {},
): RingDecode {
  const minChipPx = opts.minChipPx ?? DEFAULT_MIN_CHIP_PX;
  const n = samples.length;
  if (n < 2) return { ok: false, reason: "no leader" };
  const med = median3(samples);
  for (const reverse of [false, true]) {
    const ring = reverse ? reversed(med) : med;
    const hit = findLeader(ring);
    if (!hit) continue;
    if (hit.chipPx < minChipPx)
      return { ok: false, reason: "below resolution" };
    let bits: number[];
    try {
      bits = readBits(ring, hit.dataStart, hit.chipPx);
    } catch (e) {
      return { ok: false, reason: (e as Error).message as RingFailure };
    }
    if (bits.length < 16) return { ok: false, reason: "truncated" };
    let len = 0;
    for (let i = 0; i < 8; i++) len = (len << 1) | bits[i];
    if (bits.length !== 8 + 8 * len + 8)
      return { ok: false, reason: "length mismatch" };
    const payload = bits.slice(0, bits.length - 8);
    let tail = 0;
    for (let i = bits.length - 8; i < bits.length; i++)
      tail = (tail << 1) | bits[i];
    if (crc8(payload) !== tail) return { ok: false, reason: "crc mismatch" };
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      let byte = 0;
      for (let k = 0; k < 8; k++) byte = (byte << 1) | payload[8 + 8 * i + k];
      data[i] = byte;
    }
    // Annotations are reported in the ORIGINAL orientation: a reversed decode's
    // sample i sits at n − 1 − i.
    const unmap = (i: number): number =>
      reverse ? (((n - 1 - i) % n) + n) % n : ((i % n) + n) % n;
    return {
      ok: true,
      data,
      reverse,
      chipPx: hit.chipPx,
      leaderStart: unmap(hit.leaderStart),
      dataStart: unmap(hit.dataStart),
      fieldEdges: edgesOf(hit.dataStart, hit.chipPx, len).map((e) => ({
        name: e.name,
        at: unmap(e.at),
      })),
    };
  }
  return { ok: false, reason: "no leader" };
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
