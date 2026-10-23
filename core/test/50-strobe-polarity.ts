// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Strobe polarity on the V0.1 controller board. Triggering uses the camera's
// NON-isolated lines: `Board::camera[].trigger` drives camera Line3 (the
// BFS's input-only non-isolated line) and `Board::camera[].strobe` reads
// camera Line2, which the host programs as an ExposureActive output
// (LineInverter=true, bench 2026-10-22). The BFS Line2 output is OPEN DRAIN:
// it pulls the Teensy-pulled-up line LOW while the camera exposes and
// releases it (HIGH) otherwise — `Board::STROBE_ACTIVE_LEVEL = LOW`, the
// single constant Capture.cpp keys every edge decision on.
// (`OPTO_STROBE_ACTIVE_LEVEL` assumes the same shape for the opto-isolated
// Line1; unmeasured.)
//
// Proves:
//   1. All three strobe lines (C, L, R) idle at the RELEASED level (HIGH, the
//      pull-up) — the sim's default waveform is the honest open-drain one.
//   2. The active-LOW waveform drives CMD_FRAME to a FIN with sane exposure
//      timing, both for the L|R pair and for C|L|R — the center camera is
//      triggerable (no "no strobe cable" REJ).
//   3. Polarity is a board constant, not something the line negotiates: an
//      inverted active-HIGH waveform (LineInverter=false) against the
//      active-LOW firmware times out ("Strobe timeout: line stuck at active
//      level ..."). If it FINs instead, Capture.cpp is not honouring
//      STROBE_ACTIVE_LEVEL.
//
// Sim support (test/fw-sim/main.cpp): `strobe <C|L|R> ...` arms injection,
// `polarity <C|L|R> <high|low>` selects the waveform (default = the Board
// constant), `read <C|L|R>` probes a strobe pin's live level.
//
// Run UNSANDBOXED: node core/test/50-strobe-polarity.ts

import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
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

type Cam = "C" | "L" | "R";

class Sim {
  readonly proc: ChildProcessByStdio<Writable, Readable, null>;
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

  async ctl(cmd: string): Promise<void> {
    const from = this.mark();
    this.proc.stdin.write(cmd + "\n");
    await this.waitLine((l) => l === `ok ${cmd}`, from, 5000, `ctl(${cmd})`);
  }

  /** Live level of a camera's strobe pin, as the firmware's ISR would read it. */
  async strobeLevel(cam: Cam): Promise<number> {
    const from = this.mark();
    this.proc.stdin.write(`read ${cam}\n`);
    const hit = await this.waitLine(
      (l) => l.startsWith(`level ${cam} `),
      from,
      5000,
      `read ${cam}`,
    );
    return Number(hit.line.split(" ")[2]);
  }
}

const simBinary = fileURLToPath(new URL("../../test/build/fovea-fw-sim", import.meta.url));
if (!existsSync(simBinary)) {
  console.error(`fovea-fw-sim not built at ${simBinary} — run: cd test && make build`);
  process.exit(1);
}

const BIAS = 30000;
const TL: AnalogChannels = [1000, 2000, 3000, 4000];
const TR: AnalogChannels = [4000, 3000, 2000, 1000];
// Injected strobe schedule per camera: assert at +rise, release at +fall (µs
// after that camera's trigger rise).
const SCHEDULE: Record<Cam, string> = { C: "300 2000", L: "500 2500", R: "700 2500" };

const sim = new Sim(simBinary);
let device: InstanceType<typeof Device> | null = null;

try {
  const ptyLine = await sim.waitLine((l) => l.startsWith("pty "), 0, 5000, "pty path");
  const ptyPath = ptyLine.line.slice(4);
  console.log("50-strobe-polarity: sim up at", ptyPath);

  device = new Device(ptyPath);
  await withTimeout(device.verifyVersion(), 5000, "verifyVersion");

  // --- 1: every strobe line idles at the released level -----------------------
  {
    const [center, left, right] = await Promise.all([
      sim.strobeLevel("C"),
      sim.strobeLevel("L"),
      sim.strobeLevel("R"),
    ]);
    assert.equal(
      center,
      1,
      "center strobe idles HIGH (released, pull-up) — STROBE_ACTIVE_LEVEL is LOW on V0.1",
    );
    assert.equal(left, 1, "left strobe idles HIGH (released)");
    assert.equal(right, 1, "right strobe idles HIGH (released)");
    console.log("50-strobe-polarity: §1 C/L/R strobe lines idle at the released level OK.");
  }

  await device.set(Protocol.Config.Bias, BIAS);
  await device.set(Protocol.System.Enable, true);
  await device.set(Protocol.Command.MirrorStream, {
    op: "CREATE",
    id: 1,
    left: TL,
    right: TR,
  });

  /** Arm `cams` at `polarity`, run one CMD_FRAME for them, and report whether
   *  it reached a FIN (`true`) or was REJected (the REJ message). */
  async function capture(cams: Cam[], polarity: "low" | "high"): Promise<true | string> {
    for (const cam of cams) {
      await sim.ctl(`polarity ${cam} ${polarity}`);
      await sim.ctl(`strobe ${cam} ${SCHEDULE[cam]}`);
    }
    const label = `${cams.join("")} ${polarity}`;
    const frame = device!.get(Protocol.Command.Frame, {
      stream: 1,
      cameras: cams,
      pulse: 2000,
      settle_time: 0,
    });
    await withTimeout(frame.accepted, 5000, `${label} frame ACK`);
    let fin;
    try {
      fin = await withTimeout(frame, 5000, `${label} frame FIN`);
    } catch (err) {
      return String((err as Error)?.message ?? err);
    }
    assert(fin.t_exposure > fin.t_trigger, `${label}: exposure latches after the trigger edge`);
    assert(fin.t_exposure - fin.t_trigger < 50_000n, `${label}: strobe asserts within 50 ms`);
    return true;
  }

  // --- 2: the honest active-LOW (open-drain) waveform FINs, C included --------
  {
    const pair = await capture(["L", "R"], "low");
    assert.equal(
      pair,
      true,
      `active-LOW L|R strobe must FIN (got: ${pair}) — Capture.cpp must latch on ` +
        "Board::STROBE_ACTIVE_LEVEL",
    );
    const all = await capture(["C", "L", "R"], "low");
    assert.equal(
      all,
      true,
      `C|L|R frame must FIN on V0.1 — the center camera is cabled (got: ${all})`,
    );
    console.log("50-strobe-polarity: §2 active-LOW strobe FINs for L|R and C|L|R OK.");
  }

  // --- 3: an inverted active-HIGH waveform cannot pass for active-LOW ---------
  {
    await sleep(100);
    const inverted = await capture(["L", "R"], "high");
    assert.notEqual(
      inverted,
      true,
      "POLARITY NOT A BOARD CONSTANT: an active-HIGH strobe FINed against the " +
        "active-LOW firmware — Capture.cpp is reading the line without " +
        "Board::STROBE_ACTIVE_LEVEL.",
    );
    assert.match(String(inverted), /Strobe timeout/, "inverted polarity REJs as a strobe timeout");
    assert.match(
      String(inverted),
      /stuck at active level/,
      "the timeout names the line stuck at the active level (bench diagnosis)",
    );

    // Back to the honest waveform: idle HIGH (pull-up) again, and it captures.
    await sim.ctl("polarity L low");
    await sim.ctl("polarity R low");
    assert.equal(await sim.strobeLevel("L"), 1, "left strobe idles HIGH again");
    assert.equal(await sim.strobeLevel("R"), 1, "right strobe idles HIGH again");
    assert.equal(await capture(["L", "R"], "low"), true, "active-LOW FINs again");
    console.log("50-strobe-polarity: §3 inverted waveform times out (polarity contract) OK.");
  }

  await device.set(Protocol.System.Enable, false);
  device.release();
  device = null;
  const exited = once(sim.proc, "exit");
  await sim.ctl("quit");
  const [code] = (await withTimeout(exited, 5000, "sim exit")) as [number | null];
  assert.equal(code, 0, "sim exits 0 on quit");

  console.log("50-strobe-polarity: ALL OK");
  process.exit(0);
} finally {
  device?.release();
  if (sim.proc.exitCode === null) sim.proc.kill("SIGKILL");
}
