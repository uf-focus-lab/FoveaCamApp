// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { CoreObject, Stream } from "../types";
import type { CameraCalibration, Mat } from "core/Vision";
import type { Rect } from "core/Geometry";
import type { ProbeSnapshot } from "core/Pipe";

declare module "core/Aravis" {
  /** Path to the resolved native module injected by JS loader */
  export const __origin__: string;

  interface Range {
    min: number;
    max: number;
  }

  type AutoMode = "Off" | "Once" | "Continuous";
  type AcquisitionMode = "Continuous" | "SingleFrame" | "MultiFrame";

  export class Camera extends CoreObject<Camera> {
    static list(): Promise<Array<Camera>>;

    // Device identification
    readonly physical_id: string;
    readonly device_id: string;
    readonly vendor: string;
    readonly model: string;
    readonly serial: string;

    // Pixel format control. Options are filtered to native-supported camera
    // readout formats that Frame.view("BGRA8") can preview.
    pixel_format: PixelFormat;
    readonly pixel_format_options: PixelFormat[];

    // Acquisition control
    acquisition_mode: AcquisitionMode;
    frame_count: number;
    readonly frame_count_range: Range;

    // Frame rate control
    frame_rate_enable: boolean;
    readonly frame_rate_available: boolean;
    frame_rate: number;
    readonly frame_rate_range: Range;

    // Trigger control
    readonly trigger_options: string[];
    /** Convenience: sets TriggerMode=On + TriggerSelector/TriggerSource in
     *  one call (`arv_camera_set_trigger`). `mode` is one of
     *  `trigger_options` (e.g. "FrameStart", or "Off" to disable). */
    setTrigger(mode: string): void;
    clearTriggers(): void;
    softwareTrigger(): void;
    /** Hardware-quiescence failsafe: `arv_camera_stop_acquisition`
     *  (AcquisitionStop + TLParamsLocked=0 in Aravis's canonical order).
     *  Safe on an idle camera. The main-process janitor uses this to stop a
     *  camera left streaming by a crashed orchestrator — a locked camera
     *  rejects every config write with USB3Vision access-denied. */
    stopAcquisition(): void;
    trigger_source: string;
    readonly trigger_source_options: string[];

    // Generic GenICam feature access — for anything without a dedicated
    // accessor above, e.g. configuring a strobe/line output as
    // ExposureActive for synced capture (LineSelector + LineMode +
    // LineSource).
    getFeature(name: string): string;
    /** Read an integer GenICam node (e.g. `Width`/`Height`) — `getFeature` uses
     *  `arv_camera_get_string` and throws on integer nodes. */
    getFeatureInt(name: string): number;
    setFeature(name: string, value: string): void;
    /** Write an integer GenICam node (`arv_camera_set_integer`). A Number
     *  must be a safe integer; a BigInt is passed through as int64. */
    setFeatureInt(name: string, value: number | bigint): void;
    /** Read a boolean GenICam node (e.g. `LineInverter`) — `getFeature` uses
     *  `arv_camera_get_string` and throws "Not a ArvGcString" on IBoolean. */
    getFeatureBool(name: string): boolean;
    /** Write a boolean GenICam node (`arv_camera_set_boolean`), e.g.
     *  `LineInverter` — `setFeature` goes through the string API and fails
     *  on IBoolean nodes. */
    setFeatureBool(name: string, value: boolean): void;
    executeFeature(name: string): void;

    // Exposure control
    readonly exposure_time_available: boolean;
    readonly exposure_auto_available: boolean;
    exposure: number;
    readonly exposure_range: Range;
    exposure_auto: AutoMode;
    setExposureMode(mode: string): boolean;

    // Gain control
    readonly gain_available: boolean;
    readonly gain_auto_available: boolean;
    selectGain(selector: string): boolean;
    readonly gain_options: string[];
    gain: number;
    readonly gain_range: Range;
    gain_auto: AutoMode;

    // Black level control
    readonly black_level_available: boolean;
    readonly black_level_auto_available: boolean;
    selectBlackLevel(selector: string): boolean;
    readonly black_level_options: string[];
    black_level: number;
    readonly black_level_range: Range;
    black_level_auto: AutoMode;

    // Frame acquisition
    grab(timeout?: number): Promise<Frame>;

    /**
     * MANUAL clock-recalibration trigger. The
     * calibration LIFECYCLE is native: the camera's OWNER THREAD runs the
     * initial TimestampLatch pass at device initialization and a drift
     * re-run every 30 s — this method is a thin synchronous nudge onto the
     * same guarded routine (per-DEVICE mutex: serializes against this
     * camera's own drift pass; initial passes additionally serialize
     * bus-wide on a global mutex). BLOCKS the calling thread for ~n GenICam
     * control roundtrips. On success the offset is atomically OWNER-APPLIED:
     * every subsequent frame's `deviceTimestamp` (JS frames, SHM slot
     * headers, native taps, KCF results) is already in the `steadyNowNs`
     * host domain. Throws when the camera lacks the latch features (the
     * on-demand retry for models whose init pass failed — they stay at
     * offset 0, raw device counter).
     */
    calibrateClock(n?: number): CameraClockCalibration;

    /**
     * The stored clock calibration + stability row for this camera, or null
     * until a calibration (owner-thread init/drift or manual) succeeds.
     * `ageNs` is computed at read time; `driftPpm` needs >= 2 runs in the
     * native ring (last 8 kept). All values in the `steadyNowNs` domain.
     */
    readonly clockCalibration: CameraClockStability | null;

    // Stream control
    /** Shared frame stream view — created LAZILY on first read (and cached):
     *  merely listing/opening cameras creates no native stream, and
     *  `release()` cascades to it (the stream would otherwise hold the device
     *  claim past release until GC). */
    readonly stream: Stream<Frame>;
  }

  export class Frame extends CoreObject<Frame> {
    readonly width: number;
    readonly height: number;
    /** Back-compat alias for `deviceTimestamp`. */
    readonly timestamp: bigint;
    /** Camera/device-clock timestamp from `arv_buffer_get_timestamp`. */
    readonly deviceTimestamp: bigint;
    /** Host system timestamp from `arv_buffer_get_system_timestamp`. */
    readonly systemTimestamp: bigint;
    /** Native-style alias for `deviceTimestamp`. */
    readonly device_timestamp: bigint;
    /** Native-style alias for `systemTimestamp`. */
    readonly system_timestamp: bigint;
    readonly raw: Mat;
    readonly raw_format: PixelFormat;
    view(): Promise<Mat>;
    view(
      format: PixelFormat8,
      buffer?: BufferLike | null,
    ): Promise<Mat<Uint8Array>>;
    view(
      format: PixelFormat16,
      buffer?: BufferLike | null,
    ): Promise<Mat<Uint16Array>>;
    save(path: string): void;
  }

  export type { Stream } from "../types";

  type PixelFormat8 =
    | "Mono8"
    | "RGB8"
    | "BGR8"
    | "RGBA8"
    | "BGRA8"
    | "BayerGR8"
    | "BayerRG8"
    | "BayerGB8"
    | "BayerBG8";

  type PixelFormat16 =
    "Mono16" | "BayerGR16" | "BayerRG16" | "BayerGB16" | "BayerBG16";

  /**
   * GenICam 12-bit packed wire formats. These appear only as a Frame's
   * `raw_format` (and as values selectable via `Camera.pixel_format`); the
   * native readout unpacks them into a 16-bit single-channel Mat. They are not
   * valid targets for `Frame.view()`.
   */
  type PixelFormat12p =
    "Mono12p" | "BayerGR12p" | "BayerRG12p" | "BayerGB12p" | "BayerBG12p";

  export type PixelFormat = PixelFormat8 | PixelFormat16 | PixelFormat12p;

  /**
   * Out-of-loop probe of every ACTIVE per-camera BGRA converter thread
   * → `{ [pipeId]: ProbeSnapshot }` — the same snapshot
   * shape as `Pipe.probeAll()` and the tracker meter, so it folds straight into
   * `perfSnapshot.workloads` and renders identically in the profiler. A parked
   * (refcount-0) or detached converter is absent from the map — no stale rows.
   */
  export function converterProbeAll(): Record<string, ProbeSnapshot>;

  /**
   * Attach the CONVERT brick: builds a per-camera converter thread targeting
   * the pipe's advertised pixelFormat and gates the SHM subscriber on the
   * pipe's consumer refcount (parks when no demand). The pipe must be
   * advertised first; `pipeId` is the graph node id (`camera/<serial>/convert`).
   * Throws on an unknown pipe.
   */
  export function attachCameraPipe(camera: Camera, pipeId: string): boolean;

  /** Detach + join the convert producer. Idempotent (false if unknown). */
  export function detachCameraPipe(pipeId: string): boolean;

  /** One clock-calibration result: `hostNs = rawDeviceNs +
   *  offsetNs`, everything in the `steadyNowNs` domain. `jitterNs` =
   *  p90 − min over the candidate offsets (the min-filter's confidence). */
  export interface CameraClockCalibration {
    offsetNs: bigint;
    jitterNs: bigint;
    samples: number;
    atNs: bigint;
  }

  /** The stability row: the most recent calibration + `ageNs` (steadyNowNs −
   *  atNs, at read time) and `driftPpm` ((Δoffset/Δat)×1e6 between the two
   *  most recent runs; null with fewer than 2). */
  export interface CameraClockStability extends CameraClockCalibration {
    ageNs: bigint;
    driftPpm: number | null;
  }

  /**
   * Bulk clock-stability read for the 1 Hz clocks poll: every camera with at
   * least one successful calibration → `{ [serial]: CameraClockStability }`.
   * Uncalibrated cameras (latch-unsupported, or init pass not run yet) are
   * absent. Cheap: one native map scan, no device I/O.
   */
  export function clockStabilityAll(): Record<string, CameraClockStability>;

  /** The clock-metrics PUSH row (`onClockMetrics`): the stability row plus
   *  the camera it belongs to. */
  export interface ClockMetricsRow extends CameraClockStability {
    serial: string;
  }

  /**
   * Arm (callback) / disarm (null) the clock-metrics PUSH channel: after
   * EVERY successful calibration — owner-thread init/drift or a manual
   * `calibrateClock` — the row is delivered to `cb` on the orchestrator
   * main thread via the native dispatcher. While disarmed the owner threads
   * skip the dispatch entirely (one lock-free atomic check — zero
   * cross-thread cost unobserved). Main-thread only; the slot disarms itself
   * at env teardown. ONE callback per process (last set wins).
   */
  export function onClockMetrics(cb: ((row: ClockMetricsRow) => void) | null): void;

  /** `undistortProbeAll` snapshot: the shared meter shape + the v2 variant
   *  surface. */
  export interface UndistortProbeSnapshot extends ProbeSnapshot {
    variant: "intrinsic" | "homography";
    /** The owning CAMERA's clock-calibration state (owner-applied dt):
     *  true once `calibrateClock` succeeded for the serial
     *  resolved at attach. False = frames carry the raw device counter and
     *  the H lookup runs uncalibrated. Irrelevant for `intrinsic`. */
    calibratedClock: boolean;
    /** Frames passed through UNTOUCHED (homography variant with an empty
     *  mirror-history ring) — nonzero means H samples aren't flowing yet. */
    passthrough: number;
  }

  /**
   * Out-of-loop probe of every ACTIVE undistort brick → `{ [pipeId]:
   * UndistortProbeSnapshot }` — the shared meter shape folds into
   * `perfSnapshot.workloads` identically. Parked/detached pipes are absent —
   * no stale rows.
   */
  export function undistortProbeAll(): Record<string, UndistortProbeSnapshot>;

  /** Variant selector for `attachUndistortPipe`: INTRINSIC (center camera —
   *  cached `initUndistortRectifyMap` maps
   *  from the plain persisted calibration JSON) or HOMOGRAPHY (L/R
   *  mirror-steered — per-frame `warpPerspective` with H looked up from the
   *  native mirror-history ring by the frame's host-ns time). */
  export type UndistortPipeOptions =
    | CameraCalibration // legacy positional form ⇒ intrinsic
    | { cal: CameraCalibration }
    | { homography: true; ringCapacity?: number };

  /**
   * Attach an UNDISTORT brick v2: consumes the
   * CONVERTER's in-process owned-frame tap — BGRA/converted input only, never
   * the raw Bayer stream. `source` is the convert brick's pipeId (preferred —
   * shares the live converter; demand propagates: this brick running keeps
   * the converter awake even with zero convert-pipe SHM consumers) or a
   * Camera (legacy — a private `<pipeId>#convert` converter is created).
   * Gated by the pipe's own consumer refcount (parks when no demand). The
   * pipe must be advertised first; `pipeId` is the graph node id.
   */
  export function attachUndistortPipe(
    source: Camera | string,
    pipeId: string,
    options: UndistortPipeOptions,
  ): boolean;

  /** Detach + join the undistort producer. Idempotent (false if unknown). */
  export function detachUndistortPipe(pipeId: string): boolean;

  /**
   * Push one mirror/H sample into a HOMOGRAPHY undistort brick's native
   * history ring: `h` is the 3×3 matrix,
   * row-major, 9 doubles; `hostNs` its host-clock timestamp. Designed for the
   * ~1 kHz actuation loop (mutex-guarded native ring; no per-frame JS). The
   * undistort thread warps each frame with the entry nearest ≤ (linearly
   * interpolated) its `deviceTimestamp` — which is already OWNER-APPLIED
   * host time on a calibrated camera (the camera stamps its dt at Frame
   * creation). Returns false for an unknown pipe or a
   * non-homography variant.
   */
  export function pushHomography(
    pipeId: string,
    hostNs: bigint,
    h: Float64Array,
  ): boolean;

  /**
   * @deprecated NO-OP, always returns 0 (timestamps are OWNER-APPLIED — the
   * camera stamps its calibrated dt at Frame creation, so per-brick offsets no
   * longer exist). Kept only until
   * the last JS caller migrates to `camera.calibrateClock` /
   * the owner-thread lifecycle; then this export is deleted.
   */
  export function setClockOffset(
    pipeIdOrSerial: string,
    offsetNs: bigint,
  ): number;

  /** Options for `attachFoveaPipe` (re-based on the undistort brick). */
  export interface FoveaPipeOptions {
    /** Initial crop rect, in SOURCE-frame pixels (the undistorted frame when
     *  chained on an undistort brick; the converted frame otherwise). */
    rect: Rect;
    /** LEGACY (Camera source only): plain persisted calibration JSON ⇒ a
     *  private `<pipeId>#convert` + `<pipeId>#undistort` intrinsic chain is
     *  built for this fovea. REJECTED with a string source — chain on an
     *  undistort pipe instead (the fused map-ROI path is retired). */
    cal?: CameraCalibration | null;
  }

  /**
   * Attach a spawn/cancel-able FOVEA CROP brick: a PLAIN ROI copy of the
   * source brick's frames (chain convert → undistort → fovea — undistortion
   * happens once upstream; N foveas share it). `source` is an undistort pipeId
   * (preferred), a convert pipeId (raw crop), or a Camera (legacy — a private
   * chain is created, see `FoveaPipeOptions.cal`). Demand propagates: this
   * brick running keeps the whole upstream chain awake. The pipe is DYNAMIC
   * — advertise with `maxWidth`/`maxHeight`/`maxBytes`
   * (the ring footprint); every frame carries its ACTIVE w/h and FRAME-BOUND
   * crop origin in the v4 slot header (surfaced by the reader as
   * `width`/`height`/`originX`/`originY`). Steer live via `setFoveaRect`.
   * Spawn = advertise + attach + connect; cancel = disconnect + detach +
   * close + drop (broker epochs make reused ids safe).
   */
  export function attachFoveaPipe(
    source: Camera | string,
    pipeId: string,
    options: FoveaPipeOptions,
  ): boolean;

  /**
   * Live-steer a fovea crop (applied on the NEXT frame; clamped to the frame
   * domain + the ring's max footprint). No re-attach, no gate churn. Returns
   * false for an unknown pipe id.
   */
  export function setFoveaRect(pipeId: string, rect: Rect): boolean;

  /** Detach + join the fovea producer. Idempotent (false if unknown). */
  export function detachFoveaPipe(pipeId: string): boolean;

  /** `foveaProbeAll` snapshot: the shared meter shape + the last produced
   *  frame's FRAME-BOUND rect (byte-rate math for variable-size pipes). */
  export interface FoveaProbeSnapshot extends ProbeSnapshot {
    activeWidth: number;
    activeHeight: number;
    originX: number;
    originY: number;
    /** True when the fovea crops UNDISTORTED space (its source brick is an
     *  undistort node — shared or legacy-private). */
    undistorted: boolean;
  }

  /**
   * Out-of-loop probe of every ACTIVE fovea thread →
   * `{ [pipeId]: FoveaProbeSnapshot }` — keys AND meter names are the node
   * ids. Folds into `perfSnapshot.workloads`/`graphTopology()` identically.
   */
  export function foveaProbeAll(): Record<string, FoveaProbeSnapshot>;

  /**
   * Reactive resize spec for `attachScalePipe`/`setScaleParams`.
   * EXACTLY ONE field must be present;
   * providing zero or more than one throws. Output dims are recomputed PER
   * FRAME from these params + that frame's ACTIVE input dims (variable-size
   * sources like a slice/fovea pipe just work), then clamped to the ring's max
   * footprint.
   *   - `ratio`   — uniform scale factor (> 0).
   *   - `dwidth`  — target width (>= 1); height derived to PRESERVE the input
   *                 frame's aspect.
   *   - `dheight` — target height (>= 1); width derived to preserve aspect.
   *   - `dsize`   — explicit output {width, height} (each >= 1); aspect NOT
   *                 preserved.
   */
  export type ScaleParams =
    | { ratio: number }
    | { dwidth: number }
    | { dheight: number }
    | { dsize: { width: number; height: number } };

  /**
   * Attach a spawn/cancel-able RESIZE brick: a `cv::resize` of the source
   * brick's frames (INTER_AREA when shrinking, INTER_LINEAR when growing),
   * chained on any convert / undistort / fovea (slice) / scale pipe's
   * OwnedFrame tap (Leaky/latest-wins input; demand propagation keeps the
   * whole upstream chain awake). The pipe MUST be advertised first (unknown
   * pipe throws). The pipe is DYNAMIC — advertise with
   * `maxWidth`/`maxHeight`/`maxBytes` (the ring footprint); every frame carries
   * its ACTIVE out w/h and the source frame's crop origin — forwarded UNSCALED
   * in SOURCE full-res coords — in the v4 slot header (surfaced by the reader
   * as `width`/`height`/`originX`/`originY`). deviceTimestamp/systemTimestamp
   * are forwarded from the source frame (trusted-time: never restamped).
   * Retune live via `setScaleParams`. Throws on invalid/ambiguous params.
   */
  export function attachScalePipe(
    sourcePipeId: string,
    pipeId: string,
    params: ScaleParams,
  ): boolean;

  /**
   * Live-retune a scale pipe (applied on the NEXT frame; output dims recomputed
   * from the new params + each frame's active input dims, clamped to the ring's
   * max footprint). No re-attach. Returns false for an unknown pipe id; throws
   * on invalid/ambiguous params.
   */
  export function setScaleParams(pipeId: string, params: ScaleParams): boolean;

  /** Detach + join the scale producer. Idempotent (false if unknown). */
  export function detachScalePipe(pipeId: string): boolean;

  /** `scaleProbeAll` snapshot: the shared meter shape + the last produced
   *  frame's ACTIVE out dims and forwarded crop origin (source full-res px). */
  export interface ScaleProbeSnapshot extends ProbeSnapshot {
    activeWidth: number;
    activeHeight: number;
    originX: number;
    originY: number;
  }

  /**
   * Out-of-loop probe of every ACTIVE scale thread → `{ [pipeId]:
   * ScaleProbeSnapshot }` — keys AND meter names are the node ids. Folds into
   * `perfSnapshot.workloads`/`graphTopology()` identically to `foveaProbeAll`.
   */
  export function scaleProbeAll(): Record<string, ScaleProbeSnapshot>;

  /**
   * Reactive matcher spec for `attachStereoPipe`/`setStereoParams`. All fields
   * optional; validated NAPI-side and applied on the next frame (matcher
   * rebuilt).
   *   - `numDisparities` — search range, rounded UP to a multiple of 16
   *                        (min 16; default 128).
   *   - `blockSize`      — matched block size, forced ODD (min 1; default 5).
   *   - `minDisparity`   — smallest disparity (default 0; any SIGNED value).
   *   - `algorithm`      — "sgbm" (default) | "bm" (classic StereoBM, faster,
   *                        weaker on low texture).
   *   - `mode`           — SGBM variant: "sgbm" | "3way" (default) | "hh".
   *   - `matchScale`     — 1 | 2 | 4 (default 4): match at 1/scale resolution
   *                        (window scaled alongside). Disparity VALUES stay in
   *                        FULL-RES left-frame pixel units; the emitted MAP
   *                        DIMENSIONS are at match scale (the reader carries
   *                        actual dims — consumers must not assume full-res).
   *   - `wls`            — cv::ximgproc WLS guided refine (+ `wlsLambda`,
   *                        default 8000, and `wlsSigma`, default 1.5). Roughly
   *                        doubles match cost (a second right-view match). On a
   *                        build without opencv_contrib it degrades to a no-op.
   */
  export interface StereoParams {
    numDisparities?: number;
    blockSize?: number;
    minDisparity?: number;
    algorithm?: "sgbm" | "bm";
    mode?: "sgbm" | "3way" | "hh";
    matchScale?: 1 | 2 | 4;
    wls?: boolean;
    wlsLambda?: number;
    wlsSigma?: number;
  }

  /**
   * Attach the FIRST two-input chained brick: a `cv::StereoSGBM` disparity
   * producer pairing the LEFT and RIGHT source bricks' OwnedFrame taps (any
   * convert / undistort / fovea / scale pipe; both resolved by id — a missing
   * pipe throws). LEFT is the pacing side (a tick per left arrival, matched with
   * the latest right frame). Output is a CV_32F disparity pipe (`Disparity32F`
   * / `F32`, channels 1) — advertise it with `maxWidth`/`maxHeight`/`maxBytes`
   * (F32 ⇒ 4 bytes/px). deviceTimestamp/systemTimestamp/origin are forwarded
   * from the LEFT frame (trusted-time). Unequal L/R dims → the frame is dropped
   * (a metered transient during steer/retune). On-demand: parks with no
   * consumer (or downstream tap). Retune live via `setStereoParams`.
   */
  export function attachStereoPipe(
    leftPipeId: string,
    rightPipeId: string,
    pipeId: string,
    params: StereoParams,
  ): boolean;

  /**
   * Attach the TRIGGER-MODE stereo brick: a `cv::StereoSGBM`
   * disparity producer driven by a live PAIRING brick (`pairStage`, e.g.
   * `"pair/undistort"`) whose records carry matched L/R frames per exposure pair
   * (a missing pairing brick throws). Output is the SAME CV_32F disparity pipe
   * (`Disparity32F` / `F32`, channels 1, LEFT-sized) as `attachStereoPipe` —
   * advertise it with `maxWidth`/`maxHeight`/`maxBytes` (F32 ⇒ 4 bytes/px).
   * deviceTimestamp/systemTimestamp/origin forwarded from the LEFT frame
   * (trusted-time). On-demand: parks with no consumer. Retune live via
   * `setStereoParams`. Throws for an unknown pipe id.
   */
  export function attachStereoPaired(
    pairStage: string,
    pipeId: string,
    params: StereoParams,
  ): boolean;

  /** Live-retune a stereo pipe (SGBM matcher rebuilt on the NEXT frame). No
   *  re-attach. Returns false for an unknown pipe id. */
  export function setStereoParams(pipeId: string, params: StereoParams): boolean;

  /** Detach + join the stereo producer. Idempotent (false if unknown). */
  export function detachStereoPipe(pipeId: string): boolean;

  /** `stereoProbeAll` snapshot: the shared meter shape ({left,right} inputs,
   *  {disparity} output) + the last produced frame's active out dims + the
   *  forwarded LEFT-frame crop origin. */
  export interface StereoProbeSnapshot extends ProbeSnapshot {
    activeWidth: number;
    activeHeight: number;
    originX: number;
    originY: number;
  }

  /**
   * Out-of-loop probe of every ACTIVE stereo thread → `{ [pipeId]:
   * StereoProbeSnapshot }` — keys AND meter names are the node ids.
   */
  export function stereoProbeAll(): Record<string, StereoProbeSnapshot>;

  /**
   * Reactive colormap spec for `attachHeatmapPipe`/`setHeatmapParams`. Both
   * fields optional
   * and INDEPENDENT: an absent bound is auto-derived from that frame's
   * min/max (`cv::minMaxLoc`). Values outside `[min,max]` are clamped.
   */
  export interface HeatmapParams {
    min?: number;
    max?: number;
  }

  /**
   * Attach a colormap brick: normalizes a 1-channel input (CV_32FC1 or CV_8UC1)
   * to [0,255] and maps it through `cv::COLORMAP_TURBO` → BGRA8 (alpha 255), so
   * the output matches every other BGRA8 pipe. Chained on a stereo disparity
   * pipe's OwnedFrame tap (or any convert / undistort / fovea / scale pipe —
   * `findStereo` FIRST). Active dims + origin + timestamps forwarded. An
   * unsupported input format is dropped (metered). On-demand: parks with no
   * consumer. Retune live via `setHeatmapParams`.
   */
  export function attachHeatmapPipe(
    sourcePipeId: string,
    pipeId: string,
    params: HeatmapParams,
  ): boolean;

  /** Live-retune a heatmap pipe (applied on the NEXT frame). No re-attach.
   *  Returns false for an unknown pipe id. */
  export function setHeatmapParams(
    pipeId: string,
    params: HeatmapParams,
  ): boolean;

  /** Detach + join the heatmap producer. Idempotent (false if unknown). */
  export function detachHeatmapPipe(pipeId: string): boolean;

  /** `heatmapProbeAll` snapshot: the shared meter shape + the last produced
   *  frame's active out dims and forwarded crop origin. */
  export interface HeatmapProbeSnapshot extends ProbeSnapshot {
    activeWidth: number;
    activeHeight: number;
    originX: number;
    originY: number;
  }

  /**
   * Out-of-loop probe of every ACTIVE heatmap thread → `{ [pipeId]:
   * HeatmapProbeSnapshot }` — keys AND meter names are the node ids.
   */
  export function heatmapProbeAll(): Record<string, HeatmapProbeSnapshot>;

  /**
   * Reactive composite spec for `attachCompositePipe`/`setCompositeParams`.
   * Validated NAPI-side and applied
   * on the next frame (just the mode enum — no matcher rebuild).
   *   - `anaglyph`   — out.R = LEFT.R; out.G = RIGHT.G; out.B = RIGHT.B
   *                    (red = LEFT eye, cyan = RIGHT eye).
   *   - `difference` — `cv::absdiff(L, R)` on the color channels (alpha 255).
   */
  export interface CompositeParams {
    mode?: "anaglyph" | "difference";
  }

  /**
   * Attach a two-input COMPOSITE brick: a per-pixel BGRA op pairing the LEFT
   * and RIGHT source bricks' OwnedFrame taps (any convert / undistort / fovea /
   * scale pipe; both resolved by id — a missing pipe throws). LEFT is the
   * pacing side (a tick per left arrival, matched with the latest right frame).
   * Output is a BGRA8 pipe (`BGRA8` / `U8`, channels 4, alpha 255) — advertise
   * it with `maxWidth`/`maxHeight`/`maxBytes` (4 bytes/px). deviceTimestamp/
   * systemTimestamp/origin are forwarded from the LEFT frame (trusted-time).
   * Unequal L/R dims or a non-BGRA input → the frame is dropped (a metered
   * transient during steer/retune). On-demand: parks with no consumer. Retune
   * live via `setCompositeParams`.
   */
  export function attachCompositePipe(
    leftPipeId: string,
    rightPipeId: string,
    pipeId: string,
    params: CompositeParams,
  ): boolean;

  /** Live-retune a composite pipe (mode applied on the NEXT frame). No
   *  re-attach. Returns false for an unknown pipe id. */
  export function setCompositeParams(
    pipeId: string,
    params: CompositeParams,
  ): boolean;

  /** Detach + join the composite producer. Idempotent (false if unknown). */
  export function detachCompositePipe(pipeId: string): boolean;

  /** `compositeProbeAll` snapshot: the shared meter shape ({left,right} inputs,
   *  {composite} output) + the last produced frame's active out dims + the
   *  forwarded LEFT-frame crop origin. */
  export interface CompositeProbeSnapshot extends ProbeSnapshot {
    activeWidth: number;
    activeHeight: number;
    originX: number;
    originY: number;
  }

  /**
   * Out-of-loop probe of every ACTIVE composite thread → `{ [pipeId]:
   * CompositeProbeSnapshot }` — keys AND meter names are the node ids.
   */
  export function compositeProbeAll(): Record<string, CompositeProbeSnapshot>;

  /**
   * Attach a RAW camera-source pipe. A gated
   * `Frame::Ptr` subscriber on the camera's `Arv::Stream` publishes
   * FULL-BIT-DEPTH sensor bytes (`frame->raw`) into the pipe `pipeId`'s ring —
   * the path the recorder/capture nodes consume (NOT the 8-bit BGRA8 preview).
   * The pipe's advertised `channels`/`bytesPerFrame` must match the sensor mat
   * (a size/format change ⇒ re-advertise); the `pixelFormat` string is opaque
   * to the copy (bytes are published verbatim). ON-DEMAND: parks with no
   * consumer (zero capture-thread cost). Throws for an unknown pipe id.
   * NOTE: packed 12p is UNPACKED to a 16-bit container by `Frame` construction
   * before any subscriber sees it, so the raw pipe carries the full-depth
   * container, not literally-packed bytes.
   */
  export function attachRawPipe(camera: unknown, pipeId: string): boolean;

  /** Detach + join the raw producer. Idempotent (false if unknown). */
  export function detachRawPipe(pipeId: string): boolean;

  /**
   * Out-of-loop probe of every attached raw pipe → `{ [pipeId]: ProbeSnapshot }`
   * ({frame} input / {shm} output) — keys AND meter names are the node ids.
   * Present while attached (even parked → zero counts).
   */
  export function rawProbeAll(): Record<string, ProbeSnapshot>;

  /**
   * Subscribe a gated PACKED raw-12p producer to
   * the camera's `Arv::Stream`. Unlike `attachRawPipe` (which publishes the
   * UNPACKED 16-bit `frame->raw`), this taps the ArvBuffer BEFORE Frame
   * construction and publishes the VERBATIM wire payload — packed Bayer-12p when
   * the sensor runs 12p readout, otherwise whatever whole-byte format is
   * negotiated. FORMAT-AGNOSTIC (no packing assumption). Advertise the pipe in
   * the PACKED representation: `bytesPerFrame` = the actual payload size, `stride`
   * = packed bytes per row (12p even width = width*3/2), `maxWidth`/`maxHeight`/
   * `maxBytes` sized to the packed footprint, `channels` = 1, `dtype` = "U8".
   * ON-DEMAND: parks with no consumer (zero capture-thread cost). Throws for an
   * unknown pipe id.
   */
  export function attachRaw12pPipe(camera: unknown, pipeId: string): boolean;

  /** Detach the packed raw-12p producer. Idempotent (false if unknown). */
  export function detachRaw12pPipe(pipeId: string): boolean;

  /**
   * Out-of-loop probe of every attached raw-12p pipe → `{ [pipeId]: ProbeSnapshot }`
   * ({frame} input / {shm} output). Keys AND meter names are the node ids;
   * present while attached (even parked → zero counts).
   */
  export function raw12pProbeAll(): Record<string, ProbeSnapshot>;

  /** Construction options for `attachCompressPipe`. */
  export interface CompressOptions {
    /** zlib compression level: 0 (store) … 9 (max), or -1 / omitted =
     *  `Z_DEFAULT_COMPRESSION`. */
    level?: number;
  }

  /**
   * Attach an intra-frame COMPRESSION brick.
   * A native thread FIFO-reads the ALREADY-ADVERTISED `sourcePipeId` (raw12p,
   * raw, convert, undistort, …) and republishes each frame zlib-compressed into
   * `pipeId` — a per-frame INDEPENDENT blob (every output frame decompresses
   * alone, keeping the container seekable). The output pipe's advert must carry
   * the source format with a `/zlib` suffix (`BayerRG12p/zlib`), the SAME
   * width/height/channels/significantBits as the source, and `maxBytes` sized for
   * the worst case (`compressBound(sourceMaxBytes)`); the blob is published via
   * the ring-v5 opaque-payload path (`payloadBytes` = the exact compressed
   * length) and the SOURCE frame's identity (width/height/origin + device/system
   * timestamps) is forwarded per frame. ON-DEMAND: gated by the output pipe's own
   * consumer refcount (the 0→1 edge connects the source + spawns the runner,
   * →0 joins it + disconnects the source). Throws for an unknown source or output
   * pipe id.
   */
  export function attachCompressPipe(
    sourcePipeId: string,
    pipeId: string,
    options?: CompressOptions,
  ): boolean;

  /** Detach the compression brick (join the runner + release the source
   *  connection). Idempotent (false if unknown). */
  export function detachCompressPipe(pipeId: string): boolean;

  /**
   * Out-of-loop probe of every attached compression pipe →
   * `{ [pipeId]: ProbeSnapshot }` ({frame} input / {shm} output). Keys AND meter
   * names are the node ids; present while attached (even parked → zero counts).
   */
  export function compressProbeAll(): Record<string, ProbeSnapshot>;

  /**
   * Construction options for `createPairStream`. `mode`
   * selects the join: `root` tolerance-matches raw camera arrivals against the
   * FIN anchor (`|deviceTimestamp + sideDelta − tExposure| ≤ toleranceNs`,
   * `matchPair` semantics), `exact` joins L/R on identical `deviceTimestamp`
   * with an anchor for that key. All pools are bounded drop-oldest.
   */
  export interface PairStreamOptions {
    /** Join mode. Default `"root"`. */
    mode?: "root" | "exact";
    /** Graph node id (`pair/<stage>`). Default `"pair/default"`. */
    stage?: string;
    /** The enrichment node id for the `anchor` topology edge. Default
     *  `"controller"` (use `"controller/anchors"`). */
    anchorFrom?: string;
    /** Root-mode match window in ns (default 4e6 = 4 ms). */
    toleranceNs?: bigint;
    /** Per-side residual delta (trigger-path latency) folded into the root
     *  match; default 0 (calibrated owners are already in host-ns). */
    leftDeltaNs?: bigint;
    rightDeltaNs?: bigint;
    /** Bounded pool caps (drop-oldest). Defaults: 64 / 64 / 64. */
    anchorCap?: number;
    pendingCap?: number;
    completedCap?: number;
  }

  /** A FIN-derived anchor pushed via `PairStream.pushAnchor`. `payload` is
   *  opaque to the brick (the enrichment node packs volts/angles/H; echoed
   *  back verbatim in the pair record). */
  export interface PairAnchor {
    tExposure: bigint;
    stream?: number;
    payload?: Float64Array;
  }

  /** A RESOLVED anchor pushed via `PairStream.pushResolvedAnchor` — the
   *  root→downstream key delivery. The ROOT brick's
   *  completed pair yields the two matched frames' per-side deviceTimestamps
   *  (`leftKey`/`rightKey`); the session forwards them (loop-safe, FIN rate) so
   *  a DOWNSTREAM `exact` brick joins the NEXT stage's frames by per-side key
   *  equality. Frames are NEVER re-stamped (trusted-time): the keys ARE the
   *  frames' own passed-through timestamps. `anchorId` carries origin provenance
   *  (echoed into the downstream record); omit to assign a fresh one. */
  export interface PairResolvedAnchor {
    anchorId?: number;
    tExposure?: bigint;
    stream?: number;
    leftKey: bigint;
    rightKey: bigint;
    payload?: Float64Array;
  }

  /** One matched frame's IDENTITY in a pair record (never the pixel buffer). */
  export interface PairFrameId {
    deviceTimestamp: bigint;
    width: number;
    height: number;
    originX: number;
    originY: number;
    seq: number;
  }

  /** One completed pair (batched async-iterator element carries `records`). */
  export interface PairRecord {
    anchorId: number;
    tExposure: bigint;
    stream: number;
    payload: Float64Array;
    left: PairFrameId;
    right: PairFrameId;
  }

  /** A batch of completed pairs (MultiKcf batching pattern — zero per-frame JS
   *  work; a zero-subscriber brick still consumes + drops immediately). */
  export interface PairBatch {
    records: PairRecord[];
  }

  /** `PairStream.probe()` snapshot: the shared meter ({left,right} inputs /
   *  {pair} output) + per-pool drop counters and the live anchor pool size. */
  export interface PairProbeSnapshot extends ProbeSnapshot {
    anchorDrops: number;
    leftDrops: number;
    rightDrops: number;
    completedDrops: number;
    pairsProduced: number;
    anchorPoolSize: number;
    mode: "root" | "exact";
  }

  /** The per-stage L/R PAIRING brick handle. ALWAYS-RUNNING
   *  (created with the trigger topology, exempt from consumer-refcount teardown)
   *  and record-output: consumers get RECORDS via the async iterator, never the
   *  pinned buffers. Release with `release()`. */
  export interface PairStreamHandle extends AsyncIterable<PairBatch> {
    /** Push a FIN-derived anchor (drop-oldest at `anchorCap`). Returns the
     *  brick-assigned monotonic anchor id. Root mode: the tolerance-match key. */
    pushAnchor(anchor: PairAnchor): number;
    /** Push a RESOLVED anchor for a DOWNSTREAM `exact` brick (root→downstream key
     *  delivery). Joins the next stage's L/R by per-side
     *  `leftKey`/`rightKey` equality. Returns the (origin or assigned) anchor id. */
    pushResolvedAnchor(anchor: PairResolvedAnchor): number;
    probe(): PairProbeSnapshot;
    /** Drop the brick (join its thread). Idempotent. */
    release(): void;
    ref(): PairStreamHandle;
    readonly id: string;
  }

  /**
   * Create the per-stage L/R pairing brick over two live source bricks (convert
   * / undistort / fovea / scale, resolved by id — a missing source throws). Two
   * in-process FIFO taps are joined against FIN-derived anchors on the brick's
   * own thread; always-running (does NOT park on zero subscribers). Trigger
   * mode only — anchors are REAL exposure outcomes.
   */
  export function createPairStream(
    leftId: string,
    rightId: string,
    options?: PairStreamOptions,
  ): PairStreamHandle;
}
