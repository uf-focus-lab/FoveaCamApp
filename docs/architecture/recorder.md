# The `.fcap` recorder container and viewer

> Source of truth: `app/orchestrator/recorder-node.ts` (the recorder THREAD
> NODE — one worker: FIFO pipe consume + MCAP encode/write) +
> `app/orchestrator/capture-node.ts` (its capture sibling),
> `app/orchestrator/recorder/*` (the container/writer contract surface),
> `app/modules/manual-control/recording.ts` (streams map + extras callback),
> `app/modules/multi-fovea/recording.ts`, `app/orchestrator/raw-pipe.ts`,
> `app/orchestrator/compress-pipe.ts`, `app/src/viewer/decode.ts`, the
> STANDALONE viewer: `app/src/viewer/*` (worker + protocol + source/player/
> decode) + `app/src/windows/ViewerWindow.vue` +
> `app/electron/preload-viewer.ts`.

## 1. Container

A recording is one **MCAP** file with the **`.fcap`** extension (the value
lives in `app/orchestrator/recorder/schema.ts`'s `FOVEA_EXTENSION` export).
Legacy
`.fovea` recordings stay **readable** — the viewer open filter, macOS
`open-file`, and the Windows/Linux arg association (`electron/main.ts`) all
accept both `.fcap` and `.fovea`. The container holds channels per recorded
stream,
schemas pinned by the writer (the schema contract is the compatibility
promise for offline consumers — change it deliberately or not at all).
Per-frame metadata binds each fovea frame to its **voltage provenance**:

- `volt.source: "fin-averaged"` — a hardware-triggered capture matched to
  this frame: the FIN's exposure-AVERAGED mirror voltage + `frame_id`
  (`serial-protocol.md`), the authoritative binding.
- `volt.source: "live-snapshot"` — free-run frames stamped with the session's
  current commanded volts.

Angles/homography snapshots ride the same per-frame metadata so recorded
frames are reconstructable without the live calibration.

**Channel/payload facts (VERBATIM from the pipe advert — the recorder never
interprets bytes):** each frame
channel's `metadata` carries `{dtype, width, height, channels, pixelFormat,
significantBits, stride}` copied straight from the source pipe. `pixelFormat`
is **opaque** and may be a **packed** wire format (`BayerRG12p` — the
`camera/<serial>/raw12p` container option, 2 samples in 3 bytes, `dtype:"U8"`)
and/or carry a `/codec` **compression suffix** (`BayerRG12p/zlib`); offline
readers split on `/` and decompress right-to-left before interpreting the
base format (per-frame independent blobs, so the container stays seekable —
the exact compressed length rides the ring-v5 slot header, not a dim
computation). Whole-byte formats (the fake rig runs `Mono8`) pack to their
own byte count.

**Non-frame records (multi-fovea):**

- `fovea:wide-camera` (`WIDE_CAMERA_METADATA_NAME`) — a single metadata record
  written once at start: the wide/center camera's intrinsics + distortion.
  The wide camera is static, so there
  are NO per-frame wide extras.
- `fovea.descriptor/v1` **data channels** — one JSON channel per live target
  (`fovea/<target>`), churned in/out with target arm/disarm. Each doc is
  `{tNs, bbox, frames:{left,center,right}}` where the `frames` values are
  per-stream MCAP **sequence pointers** into the recorded raw streams, and
  are **null-able**: `left`/`right` are non-null only when a trigger-mode
  pairing record bound the observation's exposures (free-run recordings
  always carry `left:null, right:null`);
  `center` is the NEAREST recorded wide frame by timestamp and is explicitly
  UNSYNCHRONIZED (multi-fovea free-runs the wide camera by choice; the V0.1
  board does cable its trigger). Fovea imagery is reconstructed offline from the pointed-at raw
  frames + per-frame params; it is never re-encoded.

**Channel/schema table** (pinned from `docs/schema/fovea.ts`, re-exported by
`orchestrator/recorder/schema.ts` — the writer registers exactly these):

| Channel/topic | Schema | Encoding | Payload |
|---|---|---|---|
| one per recorded stream (topic = stream name, e.g. `camera/<serial>/raw12p`) | `fovea.raw_frame/v1` | `x-fovea-raw` | frame bytes VERBATIM from the pipe; channel metadata = `FRAME_METADATA_KEYS` copied from the advert |
| `telemetry` | `fovea.frame_meta/v1` | `json` | per-frame `{stream, seq, t, ...extras}` (volt/angle/affine — the legacy `.meta` sidecar's `x` payload); correlate by stream+seq |
| `fovea/<target-id>` (one per live target, churned with arm/disarm) | `fovea.descriptor/v1` | `json` | `{tNs, bbox, frames:{left,center,right}}` — see below |

Metadata records (not channels): `fovea:session` (ISO wall-clock anchor at
start), `fovea:wide-camera` (below), `fovea:finalize` (durationSec, written
at finalize — its presence marks a clean close).

## 2. Write path

Recording runs in a dedicated worker thread; the session hands frames off and
the worker owns encoding + file I/O. Backpressure is drop-accounted, never
blocking: a `recorder:<name>` workload meter (`metering.md`) counts
throughput and reason-bucketed drops, so a recording that can't keep up is
visible in the profiler instead of stalling the frame path.

## 3. Viewer (STANDALONE)

`.fcap`/`.fovea` files open in a **viewer window** — 0..N windows, exactly one
per file (`fileKey` dedupe, `windows.md`). The viewer is STANDALONE: it never
talks to the orchestrator.
Its dedicated preload (`preload-viewer.cjs`) spawns a `worker_threads` worker
(`viewer-worker.js`, source `app/src/viewer/worker.ts`) INSIDE the window's
process that hosts the whole data layer — MCAP read (`source.ts`, indexed +
footerless streaming fallback), frame decode (`decode.ts`, loads `core/Vision`
lazily — the one exception to the core-free-renderer boundary), and
timestamp-paced playback (`player.ts`). Decoded Mats cross worker → preload →
window over transferred buffers (zero copies) and render through FrameView's
ImageData path; playback state (position/play/seek) is window-local. Playback
therefore survives orchestrator restarts and never competes with live control
loops. Auto-open on `recording:finished` and Cmd/Ctrl-O both route through
main.ts's `manager.openViewer` (one window per file).

## 4. Python access

Offline analysis reads `.fcap` (or legacy `.fovea`) directly with any MCAP
library — the schema
contract in §1 is the stability promise. The bench tooling under
`playground/bench-recorder/` exercises the container end-to-end.
