// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Firmware-in-the-loop: core's
// Device driving the REAL firmware logic — firmware/src/{Protocol,Streams,
// Capture,Global,MEMS}.cpp compiled into test/build/fovea-fw-sim (HAL shim +
// pty; build with `cd test && make build`) — the first firmware BEHAVIOR
// coverage that runs off the rig. Proves:
//   1. verifyVersion handshake (this build's version) (v2Capable, two-phase unlocked).
//   2. Enable sequence — bias staged while disabled, enable rail pin, the
//      exact MEMS DAC word train (RESET, INT_REF, DAC_POWER, LDAC, bias);
//      Config::Bias REJ while enabled.
//   3. Stream table — CREATE applies the target to the DAC; awaited UPDATE
//      ACKs; fire-and-forget UPDATE (seq=0) applies SILENTLY (zero response
//      packets); TERMINATE-with-pending-frame REJ (later).
//   4. CMD_FRAME two-phase — ACK{queue_position} → injected strobes → FIN
//      with frame_id + exposure-AVERAGED positions (rise/fall latch mean,
//      pinned with a mid-exposure UPDATE); strobe-timeout REJ; 8-deep
//      queue-full REJ; duplicate-pending REJ.
//   5. Enable(false) teardown ORDER off the wire: queued/active frame REJs
//      (queue order) → pending Actuate REJ → pending Trigger REJ → enable
//      ACK; stream table actually cleared; MEMS disable bias write; trigger
//      pins released.
//   6. One-Actuate / one-Trigger-in-flight REJ (v2 two-phase FIN timing).
//   7. settle_time deferral on a stream SWITCH (v2.0.0's first behavioral
//      test anywhere): switch-frame trigger deferred >= settle window
//      (MCU-clock proof), same-stream frame undeferred, settle 0 parity.
//
// KNOWN BLOCKER (core-side — see the canary below): the current
// core build deadlocks its Device rx thread after the FIRST retired response
// (core/src/Controller.cpp handleRawPacket holds `pending.ref()` across
// notePendingChanged(), which locks `pending.ref()` again — Threading::Guard
// is non-recursive). Until that lands, this test exits 1 fast with a pointer
// instead of wedging; the sim itself is verified by test/build/fw-sim-check.
//
// Run UNSANDBOXED: node core/test/47-firmware-sim.ts

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type AnalogChannels,
  Device,
  Protocol,
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

// --- Sim process wrapper -------------------------------------------------------

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

  /** Current end-of-log marker — scope later searches to "after this point". */
  mark(): number {
    return this.lines.length;
  }

  /** First line matching `pred` at/after index `from` (waits if not yet seen). */
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

  /** Send a control line and wait for the sim's `ok` echo (sequencing barrier:
   *  once acked, the config is live for every later trigger). */
  async ctl(cmd: string): Promise<void> {
    const from = this.mark();
    this.proc.stdin.write(cmd + "\n");
    await this.waitLine((l) => l === `ok ${cmd}`, from, 5000, `ctl(${cmd})`);
  }

  dacLines(from: number, cs = "LR"): string[] {
    return this.lines
      .slice(from)
      .filter((l) => l.startsWith(`dac cs=${cs} `))
      .map((l) => l.split(" ")[2]);
  }
}

const simBinary = fileURLToPath(new URL("../../test/build/fovea-fw-sim", import.meta.url));
if (!existsSync(simBinary)) {
  console.error(`fovea-fw-sim not built at ${simBinary} — run: cd test && make build`);
  process.exit(1);
}

// --- Fixtures --------------------------------------------------------------------

const BIAS = 30000; // 0x7530
const T1L: AnalogChannels = [1000, 2000, 3000, 4000];
const T1R: AnalogChannels = [4000, 3000, 2000, 1000];
const T2L: AnalogChannels = [10000, 20000, 30000, 40000];
const T2R: AnalogChannels = [40000, 30000, 20000, 10000];
const T2bL: AnalogChannels = [12000, 22000, 32000, 42000];
const T2bR: AnalogChannels = [42000, 32000, 22000, 12000];
const T3L: AnalogChannels = [20000, 24000, 28000, 32000];
const T3R: AnalogChannels = [32000, 28000, 24000, 20000];
const meanCh = (a: AnalogChannels, b: AnalogChannels): AnalogChannels =>
  a.map((v, i) => Math.floor((v + b[i] + 1) / 2)) as AnalogChannels;
const ZERO: AnalogChannels = [0, 0, 0, 0];

const sim = new Sim(simBinary);
let device: InstanceType<typeof Device> | null = null;

try {
  const ptyLine = await sim.waitLine((l) => l.startsWith("pty "), 0, 5000, "pty path");
  const ptyPath = ptyLine.line.slice(4);
  console.log("47-firmware-sim: sim up at", ptyPath);

  device = new Device(ptyPath);

  // --- 0: CANARY for the core rx-thread deadlock (see header) -----------------
  // Two back-to-back single-phase GETs: with the wedge, the rx thread
  // deadlocks retiring the FIRST response, so the second never settles (and
  // the NEXT native get()/set() would block the main thread forever — no JS
  // timeout can fire past that point, hence this front-door check). Harmless
  // once core is fixed: both resolve in ~1 ms. Remove with the core fix.
  {
    const c1 = device.get(Protocol.System.Info);
    const c2 = device.get(Protocol.System.Version);
    const verdict = await Promise.race([
      Promise.all([c1, c2]).then(() => "ok" as const),
      sleep(3000).then(() => "wedged" as const),
    ]);
    if (verdict === "wedged") {
      console.error(
        "47-firmware-sim: BLOCKED by the core Device rx-thread deadlock — " +
          "core/src/Controller.cpp handleRawPacket() holds pending.ref() across " +
          "notePendingChanged() (non-recursive Threading::Guard). Fix core, then rerun. " +
          "Firmware-sim behavior itself is covered green by test/build/fw-sim-check.",
      );
      process.exit(1);
    }
  }

  // --- 1: version handshake ---------------------------------------------------
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
    assert.equal(device.v2Capable, true, "v2Capable set");
    const info = await device.get(Protocol.System.Info);
    assert.equal(info.valueOf(), "FoveaCam Duo Controller", "SYS_INFO");
    console.log("47-firmware-sim: §1 verifyVersion handshake OK.");
  }

  // --- 2: bias staging + Enable sequence (recorded DAC words) -----------------
  {
    const ack = await device.set(Protocol.Config.Bias, BIAS);
    assert.equal(ack.valueOf(), BIAS, "bias echo while disabled");

    const mark = sim.mark();
    const enabled = await device.set(Protocol.System.Enable, true);
    assert.equal(enabled.valueOf(), true, "enable ACK echoes enabled");
    // The full MEMS enable word train, in order: FULL RESET, INT REF on, all
    // DAC channels powered, software LDAC, then V_BIAS to the staged value —
    // all broadcast to both mirrors (same word on both buses: cs=LR). Then
    // FCLK starts, and only then does the driver enable rail (MEMS_EN, pin 6)
    // rise (Mirrorcle guide p27).
    const bias = await sim.waitLine((l) => l === "dac cs=LR 1F7530", mark, 5000, "bias DAC write");
    assert.deepEqual(
      sim.dacLines(mark).slice(0, 5),
      ["280001", "380001", "20000F", "300000", "1F7530"],
      "MEMS enable DAC word sequence",
    );
    const fclk = await sim.waitLine((l) => l === "pwm pin=10 duty=128", mark, 1000, "FCLK on");
    const rail = await sim.waitLine((l) => l === "pin 6 1", mark, 1000, "enable rail");
    assert(bias.index < fclk.index, "FCLK starts after the DAC init + bias");
    assert(fclk.index < rail.index, "enable rail rises last, after FCLK");

    // Config::Bias REJ while enabled.
    await assert.rejects(
      device.set(Protocol.Config.Bias, 1234),
      /bias while system is enabled/,
      "bias REJ while enabled",
    );
    console.log("47-firmware-sim: §2 enable sequence + bias REJ OK.");
  }

  // --- 3: stream table — CREATE / UPDATE / seq=0 silence ----------------------
  {
    const mark = sim.mark();
    const created = await device.set(Protocol.Command.MirrorStream, {
      op: "CREATE",
      id: 1,
      left: T1L,
      right: T1R,
    });
    assert.equal(created.op, "CREATE", "CREATE ACK echo");
    assert.equal(created.id, 1, "CREATE id echo");
    // A freshly CREATEd stream takes the DAC when nothing else holds it:
    // ch[0] -> DAC channel A on the LEFT mirror (WRITE_IREG|A = 0x00), the
    // first of 3x WRITE_IREG + 1x APPLY_IREG per mirror, both buses in
    // lockstep (left word, then right word, per frame).
    const commit = await sim.waitLine((l) => l === "dac cs=L 0003E8", mark, 5000, "CREATE applies target");
    await sim.waitLine((l) => l === "dac cs=R 1203E8", commit.index, 1000, "CREATE commit complete");
    assert.deepEqual(
      sim.lines.slice(commit.index, commit.index + 8),
      [
        "dac cs=L 0003E8", // A 1000
        "dac cs=R 000FA0", // A 4000
        "dac cs=L 0107D0", // B 2000
        "dac cs=R 010BB8", // B 3000
        "dac cs=L 030BB8", // D <- ch[2] 3000
        "dac cs=R 0307D0", // D <- ch[2] 2000
        "dac cs=L 120FA0", // C <- ch[3] 4000, APPLY_IREG (update all)
        "dac cs=R 1203E8", // C <- ch[3] 1000, APPLY_IREG (update all)
      ],
      "position update = 4 lockstep frames per mirror",
    );

    const updated = await device.set(Protocol.Command.MirrorStream, {
      op: "UPDATE",
      id: 1,
      left: T2L,
      right: T2R,
    });
    assert.equal(updated.op, "UPDATE", "awaited UPDATE ACKs");

    // Fire-and-forget UPDATE (seq=0): applies to the DAC, zero response bytes.
    const mark2 = sim.mark();
    const rxPackets = device.stats.rxPackets;
    device.fireAndForget(Protocol.Command.MirrorStream, {
      op: "UPDATE",
      id: 1,
      left: T2bL,
      right: T2bR,
    });
    // 12000 = 0x2EE0 on left channel A — the silent update actually moved the DAC.
    await sim.waitLine((l) => l === "dac cs=L 002EE0", mark2, 5000, "seq=0 UPDATE applies");
    await sleep(200);
    assert.equal(device.stats.rxPackets, rxPackets, "seq=0 UPDATE produced no response packet");

    // UPDATE on a nonexistent stream REJs (awaited).
    await assert.rejects(
      device.set(Protocol.Command.MirrorStream, { op: "UPDATE", id: 7, left: ZERO, right: ZERO }),
      /Unknown stream id/,
      "UPDATE unknown stream REJ",
    );
    console.log("47-firmware-sim: §3 stream table OK.");
  }

  // --- 4: CMD_FRAME two-phase + exposure-averaged positions -------------------
  {
    await sim.ctl("strobe L 500 2500");
    await sim.ctl("strobe R 700 2500");
    const frame = device.get(Protocol.Command.Frame, {
      stream: 1,
      cameras: ["L", "R"],
      pulse: 2000,
      settle_time: 0,
    });
    const accepted = await withTimeout(frame.accepted, 5000, "frame ACK");
    assert.equal(accepted.queue_position, 0, "first frame queues at position 0");
    const fin = await withTimeout(frame, 5000, "frame FIN");
    assert.equal(fin.stream, 1, "FIN stream id");
    assert(fin.frame_id >= 1, "FIN carries a 1-based frame_id");
    assert(fin.t_exposure > fin.t_trigger, "exposure latches after the trigger edge");
    assert(fin.t_exposure - fin.t_trigger < 50_000n, "strobe rise within 50 ms of trigger");
    // No UPDATE during the exposure: rise latch == fall latch == live target.
    assert.deepEqual([...fin.left], T2bL, "FIN left = stream target");
    assert.deepEqual([...fin.right], T2bR, "FIN right = stream target");

    // Exposure AVERAGING: long exposure (fall at 60 ms), UPDATE mid-exposure —
    // FIN reports the per-channel round-half-up mean of rise and fall latches.
    await sim.ctl("strobe L 500 60000");
    await sim.ctl("strobe R 700 60000");
    const long = device.get(Protocol.Command.Frame, {
      stream: 1,
      cameras: ["L", "R"],
      pulse: 58000, // strobe falls (60 ms) inside pulse + 5 ms REJ margin
      settle_time: 0,
    });
    await withTimeout(long.accepted, 5000, "long frame ACK");
    await sleep(20); // rise latch (~0.5 ms) done; fall (60 ms) far away
    device.fireAndForget(Protocol.Command.MirrorStream, {
      op: "UPDATE",
      id: 1,
      left: T3L,
      right: T3R,
    });
    const avg = await withTimeout(long, 5000, "long frame FIN");
    assert.deepEqual([...avg.left], meanCh(T2bL, T3L), "left = mean(rise, fall) latches");
    assert.deepEqual([...avg.right], meanCh(T2bR, T3R), "right = mean(rise, fall) latches");
    assert(avg.frame_id > fin.frame_id, "frame_id increments");
    console.log("47-firmware-sim: §4 two-phase FIN + exposure averaging OK.");
  }

  // --- 5: strobe-timeout REJ ---------------------------------------------------
  {
    await sim.ctl("strobe L off");
    await sim.ctl("strobe R off");
    const dead = device.get(Protocol.Command.Frame, {
      stream: 1,
      cameras: ["L", "R"],
      pulse: 2000,
      settle_time: 0,
    });
    await withTimeout(dead.accepted, 5000, "dead frame ACK");
    await assert.rejects(
      withTimeout(dead, 5000, "dead frame REJ"),
      /Strobe timeout/,
      "strobe-timeout REJ",
    );
    console.log("47-firmware-sim: §5 strobe-timeout REJ OK.");
  }

  // --- 6: queue-full / duplicate-pending / TERMINATE-pending + teardown order --
  {
    // Streams 2..10 join stream 1 (strobes stay off; pulse 2 s so nothing
    // completes underneath the assertions).
    for (let id = 2; id <= 10; id++)
      await device.set(Protocol.Command.MirrorStream, { op: "CREATE", id, left: ZERO, right: ZERO });

    const settleOrder: string[] = [];
    const finErrors = new Map<number, unknown>();
    const frames: { stream: number; fin: Promise<unknown> }[] = [];
    for (let stream = 1; stream <= 9; stream++) {
      const req = device.get(Protocol.Command.Frame, {
        stream,
        cameras: ["L", "R"],
        pulse: 2_000_000,
        settle_time: 0,
      });
      req.catch((e) => {
        settleOrder.push(`frame${stream}`);
        finErrors.set(stream, e);
      });
      const accepted = await withTimeout(req.accepted, 5000, `frame ${stream} ACK`);
      // stream 1 becomes ACTIVE (popped next tick); 2..9 fill the 8-deep queue.
      assert.equal(
        accepted.queue_position,
        stream === 1 ? 0 : stream - 2,
        `queue position for stream ${stream}`,
      );
      frames.push({ stream, fin: req });
    }

    // 1 active + 8 queued = capacity. The 10th REJs at the ACK phase.
    const overflow = device.get(Protocol.Command.Frame, {
      stream: 10,
      cameras: ["L", "R"],
      pulse: 2_000_000,
      settle_time: 0,
    });
    overflow.catch(() => {}); // FIN mirror of the ACK REJ — assertion below
    await assert.rejects(
      withTimeout(overflow.accepted, 5000, "overflow ACK"),
      /queue is full/,
      "9th concurrent frame REJs queue-full",
    );

    // Duplicate-pending REJ (stream 2 already has a queued request).
    const dup = device.get(Protocol.Command.Frame, {
      stream: 2,
      cameras: ["L", "R"],
      pulse: 2_000_000,
      settle_time: 0,
    });
    dup.catch(() => {});
    await assert.rejects(
      withTimeout(dup.accepted, 5000, "duplicate ACK"),
      /already has a pending frame/,
      "duplicate-pending REJ",
    );

    // TERMINATE-with-pending-frame REJ.
    await assert.rejects(
      device.set(Protocol.Command.MirrorStream, { op: "TERMINATE", id: 2 }),
      /frame request is pending/,
      "TERMINATE-with-pending REJ",
    );

    // Park a pending Actuate and a pending Trigger (two-phase, FIN far away)
    // so Enable(false) has every cancel class to exercise.
    const actuate = device.set(Protocol.Command.Actuate, {
      left: T1L,
      right: T1R,
      settle_time: 5_000_000,
    });
    actuate.catch(() => settleOrder.push("actuate"));
    await withTimeout(actuate.accepted, 5000, "parked actuate ACK");
    const trigger = device.set(Protocol.Command.Trigger, 5_000_000);
    trigger.catch(() => settleOrder.push("trigger"));
    await withTimeout(trigger.accepted, 5000, "parked trigger ACK");

    // Enable(false): teardown order off the wire — capture cancels (queue
    // order), then pending actuate, then pending trigger, then the ACK.
    const mark = sim.mark();
    await withTimeout(
      device.set(Protocol.System.Enable, false).then(() => settleOrder.push("enable")),
      5000,
      "disable ACK",
    );
    await sleep(100);
    assert.deepEqual(
      settleOrder,
      [...frames.map((f) => `frame${f.stream}`), "actuate", "trigger", "enable"],
      "teardown settles in firmware wire order",
    );
    for (const { stream } of frames)
      assert.match(String(finErrors.get(stream)), /System disabled/, `frame ${stream} REJ reason`);

    // Physical teardown: active-frame trigger pins released (Board.h V0.1
    // Line2 trigger pins: L = camera[1] (22), R = camera[2] (14)), then power-down
    // in reverse of enable (Mirrorcle guide p31): enable rail (pin 6) LOW
    // first, MEMS driven back to bias, FCLK stopped last.
    await sim.waitLine((l) => l === "pin 22 0", mark, 1000, "L trigger released");
    await sim.waitLine((l) => l === "pin 14 0", mark, 1000, "R trigger released");
    const rail = await sim.waitLine((l) => l === "pin 6 0", mark, 1000, "enable rail drop");
    const disableDac = await sim.waitLine((l) => l === "dac cs=LR 1F7530", mark, 1000, "MEMS disable bias");
    const fclkOff = await sim.waitLine((l) => l === "pwm pin=10 duty=0", mark, 1000, "FCLK off");
    assert(rail.index < disableDac.index, "enable rail drops before the MEMS is parked");
    assert(disableDac.index < fclkOff.index, "FCLK stops after the MEMS is parked");

    // While disabled, stream ops REJ with the not-enabled reason.
    await assert.rejects(
      device.set(Protocol.Command.MirrorStream, { op: "UPDATE", id: 1, left: ZERO, right: ZERO }),
      /system is not enabled/,
      "stream op REJ while disabled",
    );
    console.log("47-firmware-sim: §6 queue-full/duplicate/terminate REJs + teardown order OK.");
  }

  // --- 7: streams cleared by disable; one-Actuate/one-Trigger in-flight REJ ----
  {
    await device.set(Protocol.System.Enable, true);
    // Stream 1 died with the disable — the table was cleared, not preserved.
    await assert.rejects(
      device.set(Protocol.Command.MirrorStream, { op: "UPDATE", id: 1, left: ZERO, right: ZERO }),
      /Unknown stream id/,
      "disable cleared the stream table",
    );

    const actuate = device.set(Protocol.Command.Actuate, {
      left: T1L,
      right: T1R,
      settle_time: 100_000,
    });
    await withTimeout(actuate.accepted, 5000, "actuate ACK");
    await assert.rejects(
      device.set(Protocol.Command.Actuate, { left: T1L, right: T1R, settle_time: 0 }),
      /actuate request is already pending/,
      "second in-flight Actuate REJs",
    );
    const actuateFin = await withTimeout(actuate, 5000, "actuate FIN");
    assert(actuateFin.complete_time > 0, "actuate FIN stamps complete_time");

    const trigger = device.set(Protocol.Command.Trigger, 100_000);
    await withTimeout(trigger.accepted, 5000, "trigger ACK");
    await assert.rejects(
      device.set(Protocol.Command.Trigger, 1000),
      /trigger request is already pending/,
      "second in-flight Trigger REJs",
    );
    await withTimeout(trigger, 5000, "trigger FIN");
    console.log("47-firmware-sim: §7 one-in-flight Actuate/Trigger REJ OK.");
  }

  // --- 8: settle_time deferral on a stream SWITCH (v2.0.0) ---------------------
  {
    // A is created first -> takes the DAC (active); B exists but is not active.
    await device.set(Protocol.Command.MirrorStream, { op: "CREATE", id: 1, left: T1L, right: T1R });
    await device.set(Protocol.Command.MirrorStream, { op: "CREATE", id: 2, left: T2L, right: T2R });
    await sim.ctl("strobe L 500 2500");
    await sim.ctl("strobe R 700 2500");
    const SETTLE = 150_000; // µs
    const mcuNow = async () =>
      (await device!.get<BigInt>(Protocol.System.Timestamp)).valueOf() as bigint;

    // SWITCH (A -> B) with settle: the trigger is HELD for the settle window.
    // MCU-clock proof: t_trigger lands >= settle after a timestamp taken
    // BEFORE the request; the strobe machinery still runs off the REAL
    // trigger edge (exposure follows within ms, not within the settle window).
    const t0 = await mcuNow();
    const switchFrame = await withTimeout(
      device.get(Protocol.Command.Frame, {
        stream: 2,
        cameras: ["L", "R"],
        pulse: 2000,
        settle_time: SETTLE,
      }),
      5000,
      "switch frame FIN",
    );
    assert(
      switchFrame.t_trigger - t0 >= BigInt(SETTLE),
      `switch trigger deferred by settle (${switchFrame.t_trigger - t0} µs >= ${SETTLE})`,
    );
    assert(switchFrame.t_exposure - switchFrame.t_trigger < 50_000n, "exposure tracks the real edge");

    // Same-stream follow-up with the same settle_time: NOT a switch, NOT
    // deferred (well under the 150 ms window end-to-end).
    const t1 = await mcuNow();
    const sameStream = await withTimeout(
      device.get(Protocol.Command.Frame, {
        stream: 2,
        cameras: ["L", "R"],
        pulse: 2000,
        settle_time: SETTLE,
      }),
      5000,
      "same-stream frame FIN",
    );
    assert(
      sameStream.t_trigger - t1 < 100_000n,
      `same-stream frame undeferred (${sameStream.t_trigger - t1} µs < 100000)`,
    );

    // settle 0 parity: a SWITCH (B -> A) with settle_time 0 fires immediately.
    const t2 = await mcuNow();
    const zeroSettle = await withTimeout(
      device.get(Protocol.Command.Frame, {
        stream: 1,
        cameras: ["L", "R"],
        pulse: 2000,
        settle_time: 0,
      }),
      5000,
      "settle-0 frame FIN",
    );
    assert(
      zeroSettle.t_trigger - t2 < 100_000n,
      `settle 0 switch fires immediately (${zeroSettle.t_trigger - t2} µs < 100000)`,
    );
    console.log("47-firmware-sim: §8 settle_time deferral (switch / same-stream / zero) OK.");
  }

  // --- 9: clean shutdown ---------------------------------------------------------
  {
    await device.set(Protocol.System.Enable, false);
    device.release();
    device = null;
    const exited = once(sim.proc, "exit");
    await sim.ctl("quit");
    const [code] = (await withTimeout(exited, 5000, "sim exit")) as [number | null];
    assert.equal(code, 0, "sim exits 0 on quit");
    console.log("47-firmware-sim: §9 shutdown OK.");
  }

  console.log("47-firmware-sim: ALL OK");
  process.exit(0);
} finally {
  device?.release();
  if (sim.proc.exitCode === null) sim.proc.kill("SIGKILL");
}
