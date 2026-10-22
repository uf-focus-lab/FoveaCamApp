# Core integration tests

Standalone, numbered TypeScript programs that exercise the built `core` native
addon (Aravis, Vision, Pipe/Shm, Controller, Recorder, …) end to end — the
native-side counterpart to the app's `vitest` session harness. Each file is an
independent program with its own `main`; there is no test framework and no
shared runner state. They are numbered in rough historical/dependency order,
not by suite.

These are **not** run by CI or `npm test`. They are the bench/rig tool: you run
the one you're working on (or the whole hardware-free sweep) by hand against a
freshly built addon.

## Running

1. Build the addon first (the tests load the compiled `.node` via the `core`
   package):

   ```bash
   cd core && make build
   ```

2. Run a test directly with plain Node — modern Node (>= 23.6, and the version
   this repo targets) **strips TypeScript types natively**, so no `ts-node` is
   needed:

   ```bash
   cd core
   node test/07-regression.ts
   ```

   > Ignore the `#!npx ts-node` shebang at the top of every test — run with
   > `node` (native type-stripping handles the types).

3. Or use the runner (`test/run.mjs`):

   ```bash
   cd core
   node test/run.mjs 07        # run 07-regression.ts
   node test/run.mjs 01        # a bare number matching several files runs all
   node test/run.mjs 01-frame  # pass more of the name to narrow
   node test/run.mjs           # run EVERY hardware-free test, stop on 1st fail
   node test/run.mjs all       # same as no argument
   ```

   The runner never builds core and never runs the rig-gated tests in its `all`
   sweep. It shells out to `node <file>.ts` per test with a 3-minute timeout.

## The split: hardware-free vs rig-gated

Derived from what each file actually acquires (its imports + header notes). The
runner encodes the same split in `RIG_GATED` — **keep the two in sync** when a
new hardware test lands.

### Rig-gated — need the physical bench

These call `Camera.list()` on a **real** Aravis camera (no `enableFakeCamera`
fake) or drive the Teensy controller over a **real** serial port. They no-op or
fail with no hardware attached, so the runner excludes them from `all`.

| Test | Needs |
|---|---|
| `01-camera-capture` | live camera |
| `01-frame-grab` | live camera |
| `02-serial-protocol` | Teensy over a real serial port |
| `03-ArUco-detector` | live camera |
| `04-ArUco-detector-stream` | live camera |
| `05-calibrate-camera` | live camera |

### Hardware-free — run anywhere with a built addon

Everything else (00, 06–52). Three families, all self-contained:

- **Fake-camera pipe/brick tests** — inject synthetic frames through the native
  `enableFakeCamera`/test-source hooks, then exercise the convert / undistort /
  fovea / scale / stereo / heatmap / composite / raw / compress / pair bricks,
  SHM ring, fan-out, topology, and lifecycle/teardown paths (e.g. `11`–`38`,
  `41`).
- **Pure-algorithm tests** — no camera, no serial: projection, regression, KCF,
  IMM predictor, ring payload math, bayer channel order, mcap writer, recorder
  brick, MatView zero-copy vision (`06`–`10`, `31`, `37`, `39`, `40`, `42`–`44`,
  `48`).
- **PTY-serial controller tests** — open a pseudo-terminal `Device` (a scripted
  serial peer, **not** real hardware) to test the compose/sink chain, the serial
  rate governor, and request pipelining (`45`, `46`, `52`); `47`, `49`, `50`
  and `51` drive the firmware simulator (`test/build/fovea-fw-sim`, built with
  `cd test && make build`) for the enable sequence, DAC recovery, strobe
  polarity, and the v2.2 schedule/trajectory surfaces.
