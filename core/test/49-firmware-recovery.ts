// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Firmware-in-the-loop coverage for the right-fovea DAC-freeze mitigations,
// driving the REAL firmware TUs via
// the fovea-fw-sim harness (test/build/fovea-fw-sim; build with
// `cd test && make build`). Companion to 47-firmware-sim.ts, same DAC-word
// capture + control plane. Proves:
//   a. M1 periodic config re-assertion — while enabled with a live stream,
//      exactly the 3 idempotent refresh words (DAC_POWER 0x20000F, INT_REF
//      0x380001, LDAC 0x300000) appear ~1 s apart, on BOTH buses in lockstep
//      (cs=LR), with NO RESET (0x28xxxx) and NO value/bias write (refresh must
//      not move the mirror); the active stream's target is re-committed right
//      after; and NO refresh words appear while the system is disabled.
//   b. M2 targeted DAC recovery — SET System::Reset type=MEMS while enabled
//      replays the FULL MEMS enable() word train (incl. RESET) on the wire,
//      ACKs, and re-commits the active stream's target; while DISABLED it REJs.
//   c. GET System::Version reports this build's protocol version.
//
// Run UNSANDBOXED: node core/test/49-firmware-recovery.ts

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type AnalogChannels, Device, Protocol } from "core/Controller";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      timer.unref();
    }),
  ]);
}

// --- Sim process wrapper (mirrors 47-firmware-sim.ts) --------------------------

class Sim {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  private waiters: {
    pred: (line: string) => boolean;
    resolve: (hit: { line: string; index: number }) => void;
  }[] = [];

  constructor(binary: string) {
    this.proc = spawn(binary, ["--loop-us", "50"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const index = this.lines.push(line) - 1;
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(line)) return true;
        w.resolve({ line, index });
        return false;
      });
    });
  }

  mark(): number {
    return this.lines.length;
  }

  waitLine(
    pred: (line: string) => boolean,
    from = 0,
    timeoutMs = 5000,
    label = "sim line",
  ): Promise<{ line: string; index: number }> {
    for (let i = from; i < this.lines.length; i++)
      if (pred(this.lines[i])) return Promise.resolve({ line: this.lines[i], index: i });
    return withTimeout(
      new Promise((resolve) => this.waiters.push({ pred, resolve })),
      timeoutMs,
      label,
    );
  }

  /** All committed DAC words at/after `from`, as `{ cs, word }` in order. */
  dac(from: number): { cs: string; word: string }[] {
    return this.lines
      .slice(from)
      .filter((l) => l.startsWith("dac cs="))
      .map((l) => {
        const [, cs, word] = l.split(" ");
        return { cs: cs.slice(3), word };
      });
  }
}

const simBinary = fileURLToPath(new URL("../../test/build/fovea-fw-sim", import.meta.url));
if (!existsSync(simBinary)) {
  console.error(`fovea-fw-sim not built at ${simBinary} — run: cd test && make build`);
  process.exit(1);
}

// --- Fixtures ------------------------------------------------------------------

const BIAS = 30000; // 0x7530 -> bias broadcast word 1F7530
const T1L: AnalogChannels = [1000, 2000, 3000, 4000];
const T1R: AnalogChannels = [4000, 3000, 2000, 1000];
// The three idempotent M1 refresh words (config-only; NEVER move the mirror).
const REFRESH = ["20000F", "380001", "300000"];
// The full MEMS enable() train (RESET first, bias last), both mirrors selected.
const ENABLE_TRAIN = ["280001", "380001", "20000F", "300000", "1F7530"];
// ch[0]=1000 -> LEFT DAC channel A (WRITE_IREG|A = 0x00): the first word of a
// stream-1 re-commit (3x WRITE_IREG + APPLY_IREG per mirror, lockstep). Its
// reappearance proves targets were re-committed.
const RECOMMIT_L = "0003E8";

const sim = new Sim(simBinary);
let device: InstanceType<typeof Device> | null = null;

try {
  const ptyLine = await sim.waitLine((l) => l.startsWith("pty "), 0, 5000, "pty path");
  const ptyPath = ptyLine.line.slice(4);
  console.log("49-firmware-recovery: sim up at", ptyPath);
  device = new Device(ptyPath);

  // --- c: protocol version ------------------------------------------------------
  {
    const version = await withTimeout(device.verifyVersion(), 5000, "verifyVersion");
    assert.deepEqual(
      { major: version.major, minor: version.minor, patch: version.patch },
      {
        major: Protocol.System.Version.major,
        minor: Protocol.System.Version.minor,
        patch: Protocol.System.Version.patch,
      }, // this build's shared lib/Protocol/Version.h
      "firmware reports this build's protocol version",
    );
    assert.equal(version.compatible, true, "compatible");
    const v = await device.get(Protocol.System.Version);
    assert.deepEqual(
      { major: v.major, minor: v.minor, patch: v.patch },
      {
        major: Protocol.System.Version.major,
        minor: Protocol.System.Version.minor,
        patch: Protocol.System.Version.patch,
      }, // this build's shared lib/Protocol/Version.h
      "GET System::Version = this build's version",
    );
    console.log(`49-firmware-recovery: §c GET Version ${v.major}.${v.minor}.${v.patch} OK.`);
  }

  // --- a1: NO refresh words while disabled ------------------------------------
  {
    const mark = sim.mark();
    await sleep(1300); // > 1 s refresh period; disabled housekeeping must be a no-op
    const words = sim.dac(mark);
    assert.equal(words.length, 0, "no DAC traffic at all while system disabled");
    console.log("49-firmware-recovery: §a(disabled) no refresh while disabled OK.");
  }

  // Enable + create a live stream (its target commits immediately).
  {
    const ack = await device.set(Protocol.Config.Bias, BIAS);
    assert.equal(ack.valueOf(), BIAS, "bias staged while disabled");
    const enabled = await device.set(Protocol.System.Enable, true);
    assert.equal(enabled.valueOf(), true, "enable ACK");
    const created = await device.set(Protocol.Command.MirrorStream, {
      op: "CREATE",
      id: 1,
      left: T1L,
      right: T1R,
    });
    assert.equal(created.op, "CREATE", "CREATE ACK");
    await sim.waitLine((l) => l === `dac cs=L ${RECOMMIT_L}`, 0, 5000, "CREATE commit");
  }

  // --- a2: exactly the 3 refresh words ~1 s later, then a re-commit -----------
  {
    await sleep(150); // let the CREATE commit fully flush before marking
    const mark = sim.mark();
    // First refresh lands ~1 s after the enable edge primed the cadence.
    const ldac = await sim.waitLine((l) => l === "dac cs=LR 300000", mark, 3000, "refresh LDAC");
    // The refresh is broadcast (same word on both buses: cs=LR); the
    // follow-up re-commit frames differ per mirror (T1L != T1R on every
    // channel, so they decode as cs=L / cs=R pairs), so filtering cs=LR
    // isolates the refresh train.
    const refresh = sim.dac(mark).filter((w) => w.cs === "LR").slice(0, 3);
    assert.deepEqual(
      refresh.map((w) => w.word),
      REFRESH,
      "refresh = DAC_POWER, INT_REF, LDAC in order",
    );
    assert(
      refresh.every((w) => w.cs === "LR"),
      "refresh words broadcast to BOTH mirrors (cs=LR)",
    );
    // Config-only: refresh must NOT reset (0x28xxxx) or write a value/bias.
    assert(
      !refresh.some((w) => w.word.startsWith("28")),
      "refresh never RESETs the DAC (would zero outputs)",
    );
    assert(
      !refresh.some((w) => w.word.startsWith("1F")),
      "refresh never writes a value/bias (would move the mirror)",
    );
    // The active stream's target is re-committed right after the refresh.
    const recommit = await sim.waitLine(
      (l) => l === `dac cs=L ${RECOMMIT_L}`,
      ldac.index + 1,
      3000,
      "post-refresh re-commit",
    );
    assert(recommit.index > ldac.index, "targets re-committed after the refresh");
    console.log("49-firmware-recovery: §a(enabled) 1 Hz refresh + re-commit OK.");
  }

  // --- b: SET System::Reset type=MEMS while enabled ---------------------------
  {
    const mark = sim.mark();
    const ack = await withTimeout(
      device.set(Protocol.System.Reset, "MEMS"),
      5000,
      "MEMS recovery ACK",
    );
    assert.equal(ack.valueOf(), "MEMS", "recovery ACK echoes the MEMS reset type");
    // The full enable() train must appear on the wire (RESET included). Locate
    // it by its unique RESET word so a stray periodic refresh can't confuse it.
    const words = sim.dac(mark).map((w) => w.word);
    const resetAt = words.indexOf("280001");
    assert(resetAt >= 0, "MEMS recovery replays the AD5664R RESET");
    assert.deepEqual(
      words.slice(resetAt, resetAt + 5),
      ENABLE_TRAIN,
      "MEMS recovery = full MEMS::enable() word train",
    );
    // Session survives: active stream's target re-committed after the re-init.
    const resetLineIdx = sim.lines.indexOf("dac cs=LR 1F7530", mark);
    const recommit = await sim.waitLine(
      (l) => l === `dac cs=L ${RECOMMIT_L}`,
      resetLineIdx + 1,
      3000,
      "post-recovery re-commit",
    );
    assert(recommit.index > resetLineIdx, "targets re-committed after MEMS recovery");
    console.log("49-firmware-recovery: §b MEMS recovery train + re-commit OK.");
  }

  // --- b(disabled): SET System::Reset type=MEMS while disabled REJs -----------
  {
    await device.set(Protocol.System.Enable, false);
    await assert.rejects(
      device.set(Protocol.System.Reset, "MEMS"),
      /not enabled/,
      "MEMS recovery REJs while the system is disabled",
    );
    console.log("49-firmware-recovery: §b(disabled) recovery REJ while disabled OK.");
  }

  // --- shutdown ---------------------------------------------------------------
  {
    device.release();
    device = null;
    const exited = once(sim.proc, "exit");
    sim.proc.stdin.write("quit\n");
    const [code] = (await withTimeout(exited, 5000, "sim exit")) as [number | null];
    assert.equal(code, 0, "sim exits 0 on quit");
    console.log("49-firmware-recovery: shutdown OK.");
  }

  console.log("49-firmware-recovery: ALL OK");
  process.exit(0);
} finally {
  device?.release();
  if (sim.proc.exitCode === null) sim.proc.kill("SIGKILL");
}
