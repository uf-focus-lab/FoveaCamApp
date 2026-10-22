export const FOVEA_EXTENSION = ".fovea";
export const FOVEA_PROFILE = "fovea";
export const FOVEA_LIBRARY = "FoveaCamApp";

export const TELEMETRY_TOPIC = "telemetry";
export const RAW_FRAME_SCHEMA_NAME = "fovea.raw_frame/v1";
export const TELEMETRY_SCHEMA_NAME = "fovea.frame_meta/v1";
/** Multi-fovea descriptor (data) channel schema — one JSON channel per live
 *  target (`fovea/<target-id>`), churned in/out with targets. Fovea imagery is
 *  reconstructed OFFLINE from the raw streams + per-frame params; these
 *  descriptors carry only the geometry + frame pointers, never pixels. */
export const DESCRIPTOR_SCHEMA_NAME = "fovea.descriptor/v1";
export const JSON_SCHEMA_ENCODING = "jsonschema";
export const RAW_FRAME_MESSAGE_ENCODING = "x-fovea-raw";
export const TELEMETRY_MESSAGE_ENCODING = "json";
export const DESCRIPTOR_MESSAGE_ENCODING = "json";

export const SESSION_METADATA_NAME = "fovea:session";
export const FINALIZE_METADATA_NAME = "fovea:finalize";
/** Global singleton written once at start:
 *  the wide camera's intrinsics + distortion. The wide camera is static, so it
 *  applies to every wide frame and there are NO per-frame wide extras. Also
 *  carries (additively) the triple's stereo `baseline_mm` when known — the
 *  viewer's footprint-overlay vergence-plane depth readout reads it (absent on
 *  older containers → the depth shows "—"). */
export const WIDE_CAMERA_METADATA_NAME = "fovea:wide-camera";

export const DEFAULT_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_MAX_QUEUED_FRAMES = 8;

export const RAW_FRAME_SCHEMA_DATA = JSON.stringify({
  description:
    "Frame payload exactly as it arrived on the pipe — VERBATIM, never " +
    "unpacked/decoded/decompressed. The channel metadata (pixelFormat, width, " +
    "height, stride, significantBits, dtype, channels) is copied verbatim from " +
    "the pipe advert; `pixelFormat` is OPAQUE and may carry codec suffixes " +
    "(e.g. \"BayerRG12p/bz2\"). Those fields are the authoritative decode props.",
});

export const TELEMETRY_SCHEMA_DATA = JSON.stringify({
  description:
    "Per-frame JSON metadata document: {stream, seq, t, ...extras} — " +
    "extras are the legacy .meta sidecar's `x` payload (volt/angle/affine). " +
    "`volt.source` names the provenance: `fin-averaged` (TRIGGER mode — the " +
    "exposure-averaged FIN voltage), `history-interpolated` (FREE-RUN — the " +
    "mirror voltage at the frame's exposure host-ns, linearly interpolated " +
    "from the orchestrator's actuation history), or `live-snapshot`. `affine` " +
    "is the 3x3 row-major homography A2H(angle) for the stream (intended map: " +
    "fovea frame corners into wide/undistorted pixels — the viewer footprint " +
    "quad; the H-vs-inverse orientation shares the homography-feeder OPEN " +
    "question and is rig-unverified — see fovea-footprint-overlay.md). " +
    "Correlate with the frame by stream+seq (or logTime).",
});

export const DESCRIPTOR_SCHEMA_DATA = JSON.stringify({
  description:
    "Multi-fovea target descriptor: {tNs, bbox:{x,y,width,height}, " +
    "frames:{left,center,right}} where `frames` values are per-stream mcap " +
    "sequence pointers into the raw camera channels the observation " +
    "corresponds to, OR NULL when no frame binds (wave I-2): `left`/`right` " +
    "are non-null only when a trigger-mode pair record bound this " +
    "observation's exposures (pairing-nodes ruling 1 — free-run recordings " +
    "always carry left:null, right:null); `center` is the NEAREST recorded " +
    "wide frame by timestamp and is explicitly UNSYNCHRONIZED (the wide " +
    "camera free-runs in multi-fovea by choice). `bbox` is in " +
    "wide (undistorted) pixel coordinates from the tracker batch. One " +
    "channel per live target; the fovea imagery is reconstructed offline " +
    "from the pointed-at raw frames + per-frame params.",
});

// All copied VERBATIM from the pipe advert — the recorder never interprets
// them. `stride` (bytes/row) is the advert's own number (packed 12p / codec
// payloads own it, not a dtype computation).
export const FRAME_METADATA_KEYS = [
  "dtype",
  "shape",
  "width",
  "height",
  "channels",
  "pixelFormat",
  "significantBits",
  "stride",
] as const;

