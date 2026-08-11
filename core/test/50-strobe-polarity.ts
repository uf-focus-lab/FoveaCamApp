// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Strobe polarity: does the firmware's edge sense match the electrical shape
// of the camera's strobe output? The camera's opto-isolated output is an
// open-collector sink (FLIR BFS GPIO: Line1 / OPTOOUT, 0-24 V, 25 mA max) —
// it only pulls low, so `Board::camera[].strobe` supplies its own pull-up and
// the line IDLES HIGH, going LOW for the duration of ExposureActive.
//
// Proves:
//   1. Both strobe pins idle HIGH out of Board::init() — the pull-up is
//      actually configured (Pin<INPUT_PULLUP>), not floating.
//   2. An active-LOW strobe (the honest waveform) drives CMD_FRAME to a FIN
//      with sane exposure timing.
//   3. Diagnosis when 2 fails: an active-HIGH strobe latching instead means
//      the firmware reads the line inverted relative to how it is wired.
//
// Sim support: `polarity <L|R> <high|low>` selects the injected waveform and
// `read <L|R>` probes a strobe pin's live level (test/fw-sim/main.cpp).
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
  async strobeLevel(cam: "L" | "R"): Promise<number> {
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

const sim = new Sim(simBinary);
let device: InstanceType<typeof Device> | null = null;

try {
  const ptyLine = await sim.waitLine((l) => l.startsWith("pty "), 0, 5000, "pty path");
  const ptyPath = ptyLine.line.slice(4);
  console.log("50-strobe-polarity: sim up at", ptyPath);

  device = new Device(ptyPath);
  await withTimeout(device.verifyVersion(), 5000, "verifyVersion");

  // --- 1: the pull-up is configured -------------------------------------------
  {
    const [left, right] = await Promise.all([sim.strobeLevel("L"), sim.strobeLevel("R")]);
    assert.equal(
      left,
      1,
      "left strobe pin idles HIGH — Board::camera[1].strobe must be Pin<INPUT_PULLUP>; " +
        "a bare Pin<INPUT> floats against the camera's open-collector output",
    );
    assert.equal(right, 1, "right strobe pin idles HIGH (Board::camera[2].strobe pull-up)");
    console.log("50-strobe-polarity: §1 strobe pins idle HIGH (pull-up configured) OK.");
  }

  await device.set(Protocol.Config.Bias, BIAS);
  await device.set(Protocol.System.Enable, true);
  await device.set(Protocol.Command.MirrorStream, {
    op: "CREATE",
    id: 1,
    left: TL,
    right: TR,
  });

  /** Arm both strobes at `polarity` and report whether one CMD_FRAME reaches a FIN. */
  async function latchesAt(polarity: "low" | "high"): Promise<boolean> {
    await sim.ctl(`polarity L ${polarity}`);
    await sim.ctl(`polarity R ${polarity}`);
    await sim.ctl("strobe L 500 2500");
    await sim.ctl("strobe R 700 2500");
    const frame = device!.get(Protocol.Command.Frame, {
      stream: 1,
      cameras: ["L", "R"],
      pulse: 2000,
      settle_time: 0,
    });
    await withTimeout(frame.accepted, 5000, `${polarity} frame ACK`);
    try {
      const fin = await withTimeout(frame, 5000, `${polarity} frame FIN`);
      assert(fin.t_exposure > fin.t_trigger, "exposure latches after the trigger edge");
      assert(fin.t_exposure - fin.t_trigger < 50_000n, "strobe asserts within 50 ms");
      return true;
    } catch {
      return false;
    }
  }

  // --- 2/3: which edge does the firmware actually latch on? --------------------
  {
    const activeLow = await latchesAt("low");
    await sleep(100);
    const activeHigh = await latchesAt("high");
    console.log(
      `50-strobe-polarity: active-low latches=${activeLow}, active-high latches=${activeHigh}`,
    );

    assert(
      activeLow,
      activeHigh
        ? "POLARITY MISMATCH: the strobe pin idles HIGH (pull-up) and the camera's " +
            "open-collector output pulls it LOW during exposure, but the firmware only " +
            "latches on an active-HIGH strobe (Capture.cpp onStrobeEdge treats " +
            "digitalReadFast(pin) HIGH as asserted). On the rig every frame REJs with " +
            '"Strobe timeout". Fix one side: set LineInverter=true in ' +
            "app/orchestrator/camera-trigger.ts, or invert the firmware's edge sense."
        : "active-low strobe produced no FIN, and neither did active-high — the failure " +
            "is upstream of polarity (trigger, stream, or queue state)",
    );
    console.log("50-strobe-polarity: §2 firmware latches the active-LOW strobe OK.");
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
