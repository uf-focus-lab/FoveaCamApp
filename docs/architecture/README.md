# Architecture overview

FoveaCam Duo is an Electron application driving a stereo camera rig with
MEMS-mirror foveation: three GigE cameras (left/right foveal + center wide),
a serial MEMS controller, and real-time vision. The design principle
throughout: **the orchestrator is a thin coordinator** — per-frame pixel work
runs on free-running native (C++) threads and worker threads; the
orchestrator JS event loop only brokers resources, runs control loops, and
forwards results.

```
┌─ Electron main ──────────────────────────────────────────────┐
│ window manager · manifest restore · port broker              │
└──────────────┬──────────────────────────────┬────────────────┘
   MessagePort │ per window                   │ utilityProcess
┌─ renderer(s) ┴─────────────┐   ┌─ orchestrator ──────────────┐
│ Vue windows (core-free)    │   │ sessions · registry · store │
│ usePipeFrame ← SHM pipes ←─┼───┼─ C++ threads: capture sinks,│
│ session channel (frames/   │   │  converters, undistort, KCF │
│ telemetry/commands)        │   │ worker_threads: vision,     │
└────────────────────────────┘   │  recorder                   │
                                 │ serial controller (MEMS)    │
                                 └─────────────────────────────┘
```

Read in this order:

1. [`processes.md`](./processes.md) — process/thread map, boundaries, preload rules, build entries.
2. [`sessions.md`](./sessions.md) — the contract/session/hub model, resource scopes, the store.
3. [`stream-graph.md`](./stream-graph.md) — the typed stream node graph: pipes, bricks, composition.
4. [`windows.md`](./windows.md) — window taxonomy, manager, stable window identity.
5. [`metering.md`](./metering.md) — workload meters, native probes, the profiler.
6. [`recorder.md`](./recorder.md) — the `.fcap` MCAP container (legacy `.fovea` readable), the standalone viewer, Python access.
7. [`serial-protocol.md`](./serial-protocol.md) — MEMS controller protocol (v1 + v2 streams/frames, v2.2 timestamped keyframes and uploaded trajectories).

## Invariant glossary

Code comments cite these ids; the defining discussion is in the linked doc.

| Id | One line | Doc |
|---|---|---|
| V1 | Never release camera leases while a capture/recording is mid-flight — drain first | `sessions.md` |
| V4 | One-shot frame topics replay a cached last payload to late subscribers | `sessions.md` |
| V8 | SHM seqlock requires both memory fences — torn frames validate without them | `stream-graph.md` |
| V9 | Slot metadata must be copied inside the validated seqlock window | `stream-graph.md` |
| V11 | Preloads: one build per entry — sandboxed preloads cannot require sibling chunks | `processes.md` |
| V11b | Preloads emit CJS named `.cjs` (unsandboxed preloads load `.mjs` as real ESM) | `processes.md` |
| V11c | No `createRequire(import.meta.url)` in preloads (vite CJS shim resolves to the dev-server URL) | `processes.md` |
| V12 | Opening the profiler must not activate control sessions — passive subscription | `sessions.md` |
| FW5 | Never mix awaited `Actuate` writes with an active CMD_STREAM — corrupts `Streams::snapshot` | `serial-protocol.md` |

## Other load-bearing facts

- **Aravis is per-process exclusive** — all camera access lives in the
  orchestrator process. A control loop that needs frames gets them there
  (native thread or worker), never in a renderer.
- **Meters observe, never gate** (`metering.md`) — instrumentation can never
  throw into or slow a hot path.
- **Frame buffers are reused** — extract what you need from a frame before
  releasing it; SHM consumers reuse pre-allocated buffers, never per-frame
  allocation (`stream-graph.md`).
