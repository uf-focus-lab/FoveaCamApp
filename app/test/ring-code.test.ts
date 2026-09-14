// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Ring code (spec docs/spec/ring-code.md): `encodeFrame` pinned chip-for-chip
// against the independent Python reference's vectors, and `decodeRing` proven to
// recover every vector through a port of that reference's ring simulator —
// arbitrary rotation, both directions, non-integer samples per chip, and the
// one-sample exposure seam — plus the rejection paths.

import { describe, expect, it } from "vitest";
import {
  crc8,
  decodeRing,
  encodeFrame,
  GAP,
  LEADER,
  ringHex,
  ringText,
} from "@lib/ring-code";
import vectors from "../../docs/schema/codec/ring-code-vectors.json";

const DOT = 8; // blurred dot diameter, in ring samples
const MIN_CHIP_PX = 1.5 * DOT;

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

const chipString = (chips: Uint8Array): string => chips.join("");

/** Port of the reference `expose()`: one revolution on a fixed-circumference
 *  ring — samples per chip follow from the chip count — with a DOT-wide box
 *  blur, a rotation, an optional reversal, and the one-sample exposure seam. */
function expose(
  chips: Uint8Array,
  phase: number,
  reverse: boolean,
  n: number,
): Uint8Array {
  const spc = n / chips.length;
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    raw[i] = chips[Math.floor(i / spc) % chips.length];
  const blurred = new Uint8Array(n);
  const lo = -Math.floor(DOT / 2);
  const hi = DOT - Math.floor(DOT / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += raw[(((i + k) % n) + n) % n];
    blurred[i] = sum / DOT >= 0.5 ? 1 : 0;
  }
  const rotated = new Uint8Array(n);
  for (let i = 0; i < n; i++) rotated[i] = blurred[(i + phase) % n];
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    out[i] = reverse ? rotated[n - 1 - i] : rotated[i];
  out[0] = 0; // the exposure seam
  return out;
}

/** A circumference that keeps the chip arc comfortably over the resolution
 *  floor for a message of `chips` chips (the emitter budget, spec §budget). */
const ringSamplesFor = (chips: number): number =>
  Math.max(1500, Math.ceil(chips * 1.6 * DOT));

/** Deterministic LCG — a seeded sweep reproduces exactly on failure. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("encodeFrame", () => {
  it("matches every conformance vector chip-for-chip", () => {
    for (const v of vectors.vectors) {
      const chips = encodeFrame(fromHex(v.data_hex));
      expect(chipString(chips), `vector ${JSON.stringify(v.text)}`).toBe(
        v.chips,
      );
      expect(chips.length).toBe(v.chip_count);
      expect(chips.length).toBe(11 + 16 * (v.len + 2));
    }
  });

  it("opens with the GAP and the LEADER", () => {
    const chips = encodeFrame(new Uint8Array());
    expect([...chips.slice(0, 3)]).toEqual([...GAP]);
    expect([...chips.slice(3, 11)]).toEqual([...LEADER]);
    expect(vectors.gap).toBe(GAP.join(""));
    expect(vectors.leader).toBe(LEADER.join(""));
  });
});

describe("crc8", () => {
  it("matches every vector's CRC over the LEN + DATA bits", () => {
    for (const v of vectors.vectors) {
      const data = fromHex(v.data_hex);
      const bits: number[] = [];
      for (let i = 7; i >= 0; i--) bits.push((data.length >> i) & 1);
      for (const b of data)
        for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
      expect(crc8(bits), `vector ${JSON.stringify(v.text)}`).toBe(
        parseInt(v.crc8, 16),
      );
    }
  });

  it("is 0x00 over an empty message's LEN field", () => {
    expect(crc8([0, 0, 0, 0, 0, 0, 0, 0])).toBe(0x00);
  });
});

describe("decodeRing", () => {
  it("recovers every vector under rotation, direction and a non-integer chip arc", () => {
    const random = rng(20260914);
    let cases = 0;
    for (const v of vectors.vectors) {
      const data = fromHex(v.data_hex);
      const chips = encodeFrame(data);
      const n = ringSamplesFor(chips.length);
      for (let trial = 0; trial < 30; trial++) {
        const phase = Math.floor(random() * n);
        const reverse = random() < 0.5;
        const ring = expose(chips, phase, reverse, n);
        const got = decodeRing(ring, { minChipPx: MIN_CHIP_PX });
        const label = `${JSON.stringify(v.text)} phase=${phase} rev=${reverse}`;
        expect(got.ok, `${label}: ${got.ok ? "" : got.reason}`).toBe(true);
        if (!got.ok) continue;
        expect([...got.data], label).toEqual([...data]);
        expect(got.reverse, label).toBe(reverse);
        // The chip arc is MEASURED, never assumed: within a sample of truth.
        expect(got.chipPx, label).toBeCloseTo(n / chips.length, 0);
        cases++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(200);
  });

  it("puts the annotations back in the ORIGINAL orientation", () => {
    const data = new Uint8Array([0x48, 0x69]);
    const chips = encodeFrame(data);
    const n = ringSamplesFor(chips.length);
    for (const reverse of [false, true]) {
      const ring = expose(chips, 137, reverse, n);
      const got = decodeRing(ring, { minChipPx: MIN_CHIP_PX });
      expect(got.ok).toBe(true);
      if (!got.ok) continue;
      // The LEADER's ON burst sits between leaderStart and dataStart: sample
      // the original ring a chip into the burst and it must be ON.
      const step = got.reverse ? -1 : 1;
      const burst = Math.round(got.leaderStart + step * 1.5 * got.chipPx);
      expect(ring[((burst % n) + n) % n]).toBe(1);
      // Field edges, one per boundary + interior byte boundaries (2 bytes → 1).
      expect(got.fieldEdges.map((e) => e.name)).toEqual([
        "gap",
        "leader",
        "len",
        "data",
        "byte",
        "crc",
      ]);
      for (const e of got.fieldEdges) {
        expect(e.at).toBeGreaterThanOrEqual(0);
        expect(e.at).toBeLessThan(n);
      }
    }
  });

  it("drops a frame with a flipped bit — crc mismatch", () => {
    const chips = encodeFrame(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    const n = ringSamplesFor(chips.length);
    // Flip a whole DATA bit (both of its chips) well past the leader.
    const flipped = Uint8Array.from(chips);
    const bit = 11 + 2 * 20; // first chip of a mid-payload bit
    flipped[bit] ^= 1;
    flipped[bit + 1] ^= 1;
    const got = decodeRing(expose(flipped, 0, false, n), {
      minChipPx: MIN_CHIP_PX,
    });
    expect(got).toEqual({ ok: false, reason: "crc mismatch" });
  });

  it("drops a truncated frame — length mismatch", () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const chips = encodeFrame(data);
    const n = ringSamplesFor(chips.length);
    // Drop the last byte's worth of chips and close the ring with a gap: the
    // bit count no longer agrees with the LEN field.
    const short = new Uint8Array(chips.length - 16);
    short.set(chips.subarray(0, chips.length - 16));
    short[short.length - 1] = 0;
    short[short.length - 2] = 0;
    short[short.length - 3] = 0;
    const got = decodeRing(expose(short, 0, false, n), {
      minChipPx: MIN_CHIP_PX,
    });
    expect(got).toEqual({ ok: false, reason: "length mismatch" });
  });

  it("refuses an over-budget emitter — below resolution", () => {
    // 13 bytes = 251 chips on a 1500-sample ring ⇒ ~6 px/chip, under the
    // 1.5·dot floor. Refused outright, never partially read (spec §budget).
    const chips = encodeFrame(
      new Uint8Array([...Buffer.from("Hello, world!", "latin1")]),
    );
    const got = decodeRing(expose(chips, 0, false, 1500), {
      minChipPx: MIN_CHIP_PX,
    });
    expect(got).toEqual({ ok: false, reason: "below resolution" });
  });

  it("reports `no leader` for a blank or featureless ring", () => {
    expect(decodeRing(new Uint8Array(1500))).toEqual({
      ok: false,
      reason: "no leader",
    });
    const halves = new Uint8Array(1500);
    halves.fill(1, 0, 750);
    expect(decodeRing(halves)).toEqual({ ok: false, reason: "no leader" });
  });
});

describe("ringText / ringHex", () => {
  it("render printable latin-1 and hex", () => {
    expect(ringText(new Uint8Array([0x48, 0x69]))).toBe("Hi");
    expect(ringText(new Uint8Array([0x00, 0x1f, 0x7f]))).toBe("···");
    // Latin-1 with a glyph survives; the INVISIBLE ones (NBSP, soft hyphen)
    // would otherwise read as a gap in the message.
    expect(ringText(new Uint8Array([0xe9, 0xa5]))).toBe("é¥");
    expect(ringText(new Uint8Array([0xa0, 0xad]))).toBe("··");
    expect(ringHex(new Uint8Array([0xff, 0x00, 0xa5]))).toBe("ff00a5");
  });
});
