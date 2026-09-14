# Behavior specifications

The authoritative per-feature contracts. Each page specifies observable behavior
and invariants; source files point back here via `// spec:` comments, so keep
file names and heading anchors stable when editing.

## Apps

- [Manual Control](./manual-control.md) — direct steering, capture passes, recording.
- [Disparity Scope](./disparity-scope.md) — closed-loop vergence, template matching, PID, autotune.
- [Multi-fovea](./multi-fovea.md) — multi-target tracking and mirror scheduling.
- [Split tracking](./split-tracking.md) — per-eye split steering and tracking.
- [MirrorLink](./mirror-link.md) — circular fovea scan with a one-revolution exposure override.
- [Intrinsic calibration](./calibrate-intrinsic.md) · [Extrinsic calibration](./calibrate-extrinsic.md) · [Calibration data](./calibration.md)
- [Viewer](./viewer.md) — standalone `.fcap` playback, timeline, export.
- [Projection split-view](./projection.md) — pane splitting and cross-window drag & drop.
- [Profiler graph](./profiler-graph.md) — the node-graph profiler window.
- [Windows](./windows.md) — window manager, lifecycle, crash diagnostics.

## Engine and infrastructure

- [Stream graph](./graph.md) — node composition, topology, metering.
- [Ring code](./ring-code.md) — the MirrorLink optical frame encoding and its reader.
- [Pipes](./pipes.md) · [core Pipe](./core-pipe.md) · [core port pipe](./core-port-pipe.md) — SHM frame transport.
- [core streams](./core-streams.md) · [core frame bricks](./core-frame-bricks.md) · [core trackers](./core-trackers.md) — native processing bricks.
- [Orchestrator protocol](./orchestrator-protocol.md) · [Orchestrator runtime](./orchestrator-runtime.md)
- [Capture & recording](./capture-recording.md) — capture nodes, the recorder sink, `.fcap` writing.
- [Controller](./controller.md) · [Serial protocol](./serial-protocol.md) — MEMS mirror control and the wire protocol.
- [Store](./store.md) — the config/document store.
- [Vision](./vision.md) — vision workers and predictors.
