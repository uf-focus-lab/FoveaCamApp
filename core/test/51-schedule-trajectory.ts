// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Protocol v2.2.0 through core's `Device` against the firmware simulator
// (test/build/fovea-fw-sim — build with `cd test && make build`):
//
//   1. CMD_SCHEDULE: Protocol.Command.Schedule encodes a BigInt t_apply; the
//      ACK decodes back through the same factory; the keyframe's DAC word
//      appears only once the MCU clock passes t_apply.
//   2. CMD_TRAJECTORY: BEGIN / DATA (chunked) / MARK / COMMIT / START through
//      Protocol.Command.Trajectory; REJ reasons surface as rejections.
//   3. Device.onPush(Protocol.Command.TrajectoryFrame, cb) delivers every
//      SYN CMD_TRAJECTORY push decoded (status string, BigInt timestamps,
//      marker null on the ENDED push); onPush(factory, null) unsubscribes.
//   4. STOP / DELETE.
//
// The wire-level behavior (timing, interpolation, HOLD) is covered in depth by
// test/fw-sim-check.cpp stages C1-C4; this test pins the core JS surface.

import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type AnalogChannels,
  Device,
  Protocol,
  type TrajectoryDecoded,
  type TrajectoryFrame,
} from "core/Controller";

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
  constructor(binary: string) {
    this.proc = spawn(binary, ["--loop-us", "50"], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.proc.stdout }).on("line", (l) => this.lines.push(l));
  }
  async waitFor(pred: (l: string) => boolean, from: number, ms: number, label: string) {
    const deadline = Date.now() + ms;
    for (;;) {
      for (let i = from; i < this.lines.length; i++) if (pred(this.lines[i])) return this.lines[i];
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(5);
    }
  }
  async ctl(cmd: string) {
    const from = this.lines.length;
    this.proc.stdin.write(cmd + "\n");
    await this.waitFor((l) => l === `ok ${cmd}`, from, 5000, `ctl(${cmd})`);
  }
  /** Decoded L-mirror channel values (`dac cs=<..L..> <cmd|addr><value>`) for
   *  value-carrying commands — independent of the DAC frame set. */
  leftValues(from: number): number[] {
    const out: number[] = [];
    for (const l of this.lines.slice(from)) {
      const m = /^dac cs=(\S+) ([0-9A-F]{2})([0-9A-F]{4})/.exec(l);
      if (!m || !m[1].includes("L")) continue;
      const head = parseInt(m[2], 16);
      const cmd = (head >> 3) & 7;
      if ((cmd === 0 || cmd === 2 || cmd === 3) && (head & 7) <= 3) out.push(parseInt(m[3], 16));
    }
    return out;
  }
}

const simBinary = fileURLToPath(new URL("../../test/build/fovea-fw-sim", import.meta.url));
if (!existsSync(simBinary)) {
  console.error(`fovea-fw-sim not built at ${simBinary} — run: cd test && make build`);
  process.exit(1);
}

const L0: AnalogChannels = [12000, 22000, 32000, 42000];
const R0: AnalogChannels = [42000, 32000, 22000, 12000];

const sim = new Sim(simBinary);
let device: InstanceType<typeof Device> | null = null;

try {
  const ptyLine = await sim.waitFor((l) => l.startsWith("pty "), 0, 5000, "pty path");
  device = new Device(ptyLine.slice(4));

  const version = await withTimeout(device.verifyVersion(), 5000, "verifyVersion");
  assert.ok(
    version.major > 2 || (version.major === 2 && version.minor >= 2),
    "firmware >= 2.2.0",
  );
  await device.set(Protocol.System.Enable, true);
  await device.set(Protocol.Command.MirrorStream, { op: "CREATE", id: 1, left: L0, right: R0 });

  // --- 1: CMD_SCHEDULE ------------------------------------------------------
  {
    const from = sim.lines.length;
    const now = (await device.get(Protocol.System.Timestamp)).valueOf() as bigint;
    const tApply = now + 150_000n;
    const ack = await device.set(Protocol.Command.Schedule, {
      stream: 1,
      t_apply: tApply,
      interpolate: false,
      left: [15151, 22000, 32000, 42000],
      right: R0,
    });
    assert.equal(ack.stream, 1, "Schedule ACK stream");
    assert.equal(ack.t_apply, tApply, "Schedule ACK echoes the BigInt t_apply");
    assert.equal(ack.interpolate, false, "Schedule ACK flags");
    assert.ok(!sim.leftValues(from).includes(15151), "not applied on arrival");
    for (;;) {
      const t = (await device.get(Protocol.System.Timestamp)).valueOf() as bigint;
      if (t > tApply + 20_000n) break;
      await sleep(10);
    }
    await sleep(20);
    assert.ok(sim.leftValues(from).includes(15151), "applied after t_apply");
    await assert.rejects(
      device.set(Protocol.Command.Schedule, { stream: 9, t_apply: tApply, left: L0, right: R0 }),
      /Unknown stream/,
      "unknown-stream REJ surfaces as a rejection",
    );
    console.log("51-schedule-trajectory: §1 Schedule OK.");
  }

  // --- 2: CMD_TRAJECTORY upload ------------------------------------------------
  const TID = 2;
  const PERIOD = 20_000;
  const N = 25;
  {
    const samples = Array.from({ length: N }, (_, i) => ({
      t_offset: i * 800,
      left: [1000 + 100 * i, 5000, 6000, 7000] as AnalogChannels,
      right: [8000, 9000, 10000, 11000] as AnalogChannels,
    }));
    const begin = await device.set(Protocol.Command.Trajectory, {
      op: "BEGIN",
      id: TID,
      sample_count: N,
      period: PERIOD,
    });
    assert.equal(begin.op, "BEGIN");
    assert.equal(begin.sample_count, N);
    for (let first = 0; first < N; first += 12) {
      const ack: TrajectoryDecoded = await device.set(Protocol.Command.Trajectory, {
        op: "DATA",
        id: TID,
        first_index: first,
        samples: samples.slice(first, first + 12),
      });
      assert.equal(ack.op, "DATA");
      assert.equal(ack.first_index, first, "DATA ACK echoes the chunk header");
    }
    await device.set(Protocol.Command.Trajectory, {
      op: "MARK",
      id: TID,
      marker: 1,
      t_offset: 10_000,
      cameras: ["L", "R"],
      pulse: 2000,
    });
    await device.set(Protocol.Command.Trajectory, { op: "COMMIT", id: TID });
    await assert.rejects(
      device.set(Protocol.Command.Trajectory, { op: "COMMIT", id: TID }),
      /already committed/,
      "double COMMIT REJ",
    );
    console.log("51-schedule-trajectory: §2 upload OK.");
  }

  // --- 3: START + onPush -------------------------------------------------------
  {
    await sim.ctl("strobe L 500 2500");
    await sim.ctl("strobe R 700 2500");
    const frames: TrajectoryFrame[] = [];
    device.onPush(Protocol.Command.TrajectoryFrame, (f) => frames.push(f));
    const now = (await device.get(Protocol.System.Timestamp)).valueOf() as bigint;
    const tStart = now + 50_000n;
    const CYCLES = 5;
    const start = await device.set(Protocol.Command.Trajectory, {
      op: "START",
      id: TID,
      t_start: tStart,
      cycles: CYCLES,
    });
    assert.equal(start.t_start, tStart, "START ACK echoes the BigInt t_start");
    await assert.rejects(
      device.set(Protocol.Command.MirrorStream, { op: "UPDATE", id: 1, left: L0, right: R0 }),
      /trajectory owns/,
      "stream UPDATE refused while the trajectory runs",
    );
    const deadline = Date.now() + 5000;
    while (!frames.some((f) => f.status === "ENDED") && Date.now() < deadline) await sleep(10);
    const markers = frames.filter((f) => f.status !== "ENDED");
    assert.equal(markers.length, CYCLES, "one push per cycle");
    markers.forEach((f, k) => {
      assert.equal(f.status, "OK");
      assert.equal(f.id, TID);
      assert.equal(f.marker, 1);
      assert.equal(f.cycle, k);
      assert.equal(typeof f.result.t_trigger, "bigint", "BigInt MCU timestamps");
      const due = tStart + BigInt(k * PERIOD + 10_000);
      assert.ok(f.result.t_trigger >= due && f.result.t_trigger - due < 5_000n, "on phase");
      assert.ok(f.result.t_exposure > f.result.t_trigger, "exposure after trigger");
      assert.equal(f.result.stream, TID, "FrameResult.stream = trajectory id");
      assert.equal(f.result.left[1], 5000, "trajectory position latched");
    });
    const ended = frames.find((f) => f.status === "ENDED")!;
    assert.equal(ended.marker, null, "ENDED push has no marker");
    assert.equal(ended.cycle, CYCLES);

    // Unsubscribe: a second run's pushes no longer reach the callback.
    device.onPush(Protocol.Command.TrajectoryFrame, null);
    const before = frames.length;
    await device.set(Protocol.Command.Trajectory, { op: "START", id: TID, cycles: 2 });
    await sleep(120);
    assert.equal(frames.length, before, "onPush(factory, null) unsubscribes");
    console.log(`51-schedule-trajectory: §3 START + ${markers.length} pushes OK.`);
  }

  // --- 4: STOP / DELETE -------------------------------------------------------
  {
    await device.set(Protocol.Command.Trajectory, { op: "STOP", id: TID });
    await device.set(Protocol.Command.Trajectory, { op: "DELETE", id: TID });
    await assert.rejects(
      device.set(Protocol.Command.Trajectory, { op: "START", id: TID }),
      /Unknown trajectory/,
      "deleted table is gone",
    );
    console.log("51-schedule-trajectory: §4 STOP/DELETE OK.");
  }

  console.log("51-schedule-trajectory: ALL OK");
} finally {
  device?.release();
  sim.proc.stdin.write("quit\n");
  await sleep(50);
  sim.proc.kill();
}
