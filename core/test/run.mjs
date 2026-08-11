#!/usr/bin/env node
// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Tiny runner for the numbered core integration tests (see README.md). Modern
// Node strips TypeScript types natively (node >= 23.6 / `process.features.
// typescript`), so each test is just `node <file>.ts` — the `#!npx ts-node`
// shebangs on the files are stale and unused.
//
//   node test/run.mjs            run every HARDWARE-FREE test, sequentially,
//                                stopping on the first failure.
//   node test/run.mjs 07         run the test(s) whose number/name matches
//                                `07` (here `07-regression.ts`). A bare number
//                                that matches several files (01, 10, 11) runs
//                                all of them; pass more of the name to narrow
//                                (e.g. `01-frame`).
//   node test/run.mjs all        same as no argument.
//
// It NEVER builds core — build first with `cd core && make build`.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));

// Tests that acquire REAL hardware — a live Aravis camera (`Camera.list()` with
// no `enableFakeCamera` fake) or the Teensy controller over a REAL serial port
// (`serialport`, not a test pty). Derived from each file's imports/header (see
// README.md "The split"). A NEW hardware test must be added here; everything
// else is treated as hardware-free.
const RIG_GATED = new Set([
  "01-camera-capture",
  "01-frame-grab",
  "02-serial-protocol",
  "03-ArUco-detector",
  "04-ArUco-detector-stream",
  "05-calibrate-camera",
]);

// Hardware-free but currently BLOCKED (does not pass standalone) — excluded from
// the "all" sweep so one known-broken test can't wedge the whole run. Add a test
// stem here to quarantine it; run it explicitly by number when working the fix.
const KNOWN_BLOCKED = new Set([
  // Fails on a REAL defect, not a broken test: the firmware latches an
  // active-HIGH strobe while the pin is pulled up against the camera's
  // open-collector output. Un-quarantine with the polarity fix.
  "50-strobe-polarity",
]);

const PER_TEST_TIMEOUT_MS = 180_000;

const all = readdirSync(DIR)
  .filter((f) => /^\d.*\.ts$/.test(f))
  .sort();
const stem = (f) => f.replace(/\.ts$/, "");

function run(file) {
  process.stdout.write(`\n\x1b[1m▶ ${file}\x1b[0m\n`);
  const r = spawnSync("node", [join(DIR, file)], {
    stdio: "inherit",
    timeout: PER_TEST_TIMEOUT_MS,
  });
  const ok = r.status === 0 && !r.error;
  const why = r.error ? r.error.code || r.error.message : `exit ${r.status}`;
  process.stdout.write(
    ok ? `\x1b[32m✓ ${file}\x1b[0m\n` : `\x1b[31m✗ ${file} (${why})\x1b[0m\n`,
  );
  return ok;
}

function matchesFor(arg) {
  const exact = all.filter((f) => stem(f) === arg);
  if (exact.length) return exact;
  const prefix = all.filter((f) => f.startsWith(arg + "-") || stem(f).startsWith(arg));
  if (prefix.length) return prefix;
  return all.filter((f) => f.includes(arg));
}

const arg = process.argv[2];

if (arg && arg !== "all") {
  const targets = matchesFor(arg);
  if (!targets.length) {
    console.error(`No test matches "${arg}". Available:`);
    for (const f of all) console.error(`  ${stem(f)}`);
    process.exit(2);
  }
  let failed = false;
  for (const f of targets) if (!run(f)) failed = true;
  process.exit(failed ? 1 : 0);
}

// Default: every hardware-free test, sequentially, stop on first failure.
const free = all.filter((f) => !RIG_GATED.has(stem(f)) && !KNOWN_BLOCKED.has(stem(f)));
console.log(
  `Running ${free.length} hardware-free tests (skipping ${RIG_GATED.size} rig-gated, ` +
    `${KNOWN_BLOCKED.size} known-blocked). Build core first if you haven't.`,
);
let passed = 0;
for (const f of free) {
  if (!run(f)) {
    console.error(`\n\x1b[31mStopped on first failure: ${f}\x1b[0m`);
    console.error(`(${passed}/${free.length} passed before this)`);
    process.exit(1);
  }
  passed++;
}
console.log(`\n\x1b[32mAll ${passed} hardware-free tests passed.\x1b[0m`);
