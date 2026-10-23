// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstdlib>
#include <napi.h>
#include <thread>
#include <unistd.h>

#include "CoreObject.h"
#include "Dispatcher.h"
#include "Pipe.h"
#include "ShmRing.h"

// Forward-declared (not #included) so the Aravis headers' global `Object`
// template doesn't collide with `Napi::Object` under this file's `using
// namespace Napi`. Defined in core/lib/Aravis/ConverterStream.cpp (the
// per-camera converter thread that replaced the inline-convert CaptureSink).
namespace Arv {
Napi::Value feedTestFrame(const Napi::CallbackInfo &info);
Napi::Value attachCameraPipe(const Napi::CallbackInfo &info);
Napi::Value detachCameraPipe(const Napi::CallbackInfo &info);
Napi::Value enableFakeCamera(const Napi::CallbackInfo &info);
Napi::Value converterProbeAll(const Napi::CallbackInfo &info);
// Undistort brick, defined in core/lib/Aravis/UndistortStream.cpp.
Napi::Value attachUndistortPipe(const Napi::CallbackInfo &info);
Napi::Value detachUndistortPipe(const Napi::CallbackInfo &info);
Napi::Value undistortProbeAll(const Napi::CallbackInfo &info);
Napi::Value pushHomography(const Napi::CallbackInfo &info);
Napi::Value setClockOffset(const Napi::CallbackInfo &info);
Napi::Value undistortStall(const Napi::CallbackInfo &info);
Napi::Value __paramRingSelfTest(const Napi::CallbackInfo &info);
// Native camera clock calibration read surface + THE host time authority.
// Defined in core/lib/Aravis/ClockCalibration.cpp.
Napi::Value steadyNowNsJs(const Napi::CallbackInfo &info);
Napi::Value clockStabilityAll(const Napi::CallbackInfo &info);
Napi::Value onClockMetrics(const Napi::CallbackInfo &info);
Napi::Value __clockCalSelfTest(const Napi::CallbackInfo &info);
Napi::Value __fireClockMetricsTest(const Napi::CallbackInfo &info);
// B-24 (real-2), defined in core/lib/Aravis/FoveaStream.cpp.
Napi::Value attachFoveaPipe(const Napi::CallbackInfo &info);
Napi::Value setFoveaRect(const Napi::CallbackInfo &info);
Napi::Value detachFoveaPipe(const Napi::CallbackInfo &info);
Napi::Value foveaProbeAll(const Napi::CallbackInfo &info);
// split-disparity-nodes: the RESIZE brick, defined in
// core/lib/Aravis/ScaleStream.cpp.
Napi::Value attachScalePipe(const Napi::CallbackInfo &info);
Napi::Value setScaleParams(const Napi::CallbackInfo &info);
Napi::Value detachScalePipe(const Napi::CallbackInfo &info);
Napi::Value scaleProbeAll(const Napi::CallbackInfo &info);
// mirror-link triangle flip: the per-frame VERTICAL FLIP brick keyed on
// trajectory-marker anchors, defined in core/lib/Aravis/FlipStream.cpp.
Napi::Value attachFlipPipe(const Napi::CallbackInfo &info);
Napi::Value pushFlipAnchor(const Napi::CallbackInfo &info);
Napi::Value flipProbe(const Napi::CallbackInfo &info);
Napi::Value flipProbeAll(const Napi::CallbackInfo &info);
Napi::Value detachFlipPipe(const Napi::CallbackInfo &info);
// stereo-disparity-and-heatmap-nodes: the two-input SGBM disparity brick,
// defined in core/lib/Aravis/StereoStream.cpp.
Napi::Value attachStereoPipe(const Napi::CallbackInfo &info);
Napi::Value attachStereoPaired(const Napi::CallbackInfo &info);
Napi::Value setStereoParams(const Napi::CallbackInfo &info);
Napi::Value detachStereoPipe(const Napi::CallbackInfo &info);
Napi::Value stereoProbeAll(const Napi::CallbackInfo &info);
// stereo-disparity-and-heatmap-nodes: the colormap brick, defined in
// core/lib/Aravis/HeatmapStream.cpp.
Napi::Value attachHeatmapPipe(const Napi::CallbackInfo &info);
Napi::Value setHeatmapParams(const Napi::CallbackInfo &info);
Napi::Value detachHeatmapPipe(const Napi::CallbackInfo &info);
Napi::Value heatmapProbeAll(const Napi::CallbackInfo &info);
// composite-node-and-center-select-fix: the two-input composite brick
// (anaglyph / L-vs-R difference), defined in core/lib/Aravis/CompositeStream.cpp.
Napi::Value attachCompositePipe(const Napi::CallbackInfo &info);
Napi::Value setCompositeParams(const Napi::CallbackInfo &info);
Napi::Value detachCompositePipe(const Napi::CallbackInfo &info);
Napi::Value compositeProbeAll(const Napi::CallbackInfo &info);
// capture-recorder-nodes Phase 1: RAW camera-source pipes (full-bit-depth
// sensor bytes for the recorder/capture nodes), defined in
// core/lib/Aravis/RawPipe.cpp.
Napi::Value attachRawPipe(const Napi::CallbackInfo &info);
Napi::Value detachRawPipe(const Napi::CallbackInfo &info);
Napi::Value rawProbeAll(const Napi::CallbackInfo &info);
// PACKED raw-12p camera pipes (verbatim wire payload via a pre-Frame ArvBuffer
// tap), defined in core/lib/Aravis/RawPipe.cpp.
Napi::Value attachRaw12pPipe(const Napi::CallbackInfo &info);
Napi::Value detachRaw12pPipe(const Napi::CallbackInfo &info);
Napi::Value raw12pProbeAll(const Napi::CallbackInfo &info);
// The intra-frame COMPRESSION brick (a native thread FIFO-reads a source pipe,
// zlib-compresses per frame, publishes an opaque /zlib blob), defined in
// core/lib/Aravis/CompressStream.cpp.
Napi::Value attachCompressPipe(const Napi::CallbackInfo &info);
Napi::Value detachCompressPipe(const Napi::CallbackInfo &info);
Napi::Value compressProbeAll(const Napi::CallbackInfo &info);
// pairing-nodes P-1: the per-stage L/R PAIRING brick — two in-process FIFO taps
// joined against FIN-derived anchors (root tolerance / exact key), batched pair
// records to JS. Always-running (create-only CoreObject). Defined in
// core/lib/Aravis/PairStream.cpp. `create*TestSource`/`pushPairTestFrame` are
// test-only synthetic ConvertedFrame producers (not part of the public d.ts).
Napi::Value createPairStream(const Napi::CallbackInfo &info);
Napi::Value createPairTestSource(const Napi::CallbackInfo &info);
Napi::Value pushPairTestFrame(const Napi::CallbackInfo &info);
Napi::Value releasePairTestSource(const Napi::CallbackInfo &info);
// Circular-scan ORBIT generator: a paced 1 kHz VoltPair producer whose
// `volt_out` drives the controller's native pos_in (the mirror-link scan off
// the JS event loop). Defined in core/src/OrbitStream.cpp.
Napi::Value createOrbitStream(const Napi::CallbackInfo &info);
}
// Consolidated NodeReport rows for every live native brick + pipe. Defined in
// core/src/Topology.cpp.
namespace Topology {
Napi::Value report(const Napi::CallbackInfo &info);
}

// Hardware-free teardown-race self-test (core/test/38). Churns Stream
// destruction against concurrent Subscriber closes; a crash mid-run is the
// pre-fix proof, a clean return is the post-fix soak. Defined in
// core/lib/Stream/StreamSelfTest.cpp. Not part of the public d.ts.
Napi::Value streamTeardownRaceSelfTest(const Napi::CallbackInfo &info);

// native-recorder: hand-rolled C++ MCAP writer conformance surface (core/test/
// 39). Test-only `__mcap*` root exports that drive Record::McapWriter with the
// same inputs fed to @mcap/core for a byte-for-byte comparison. The live
// recorder brick drives McapWriter in C++ (no NAPI per frame). Defined in
// core/src/Record.cpp. Not part of the public d.ts.
namespace Rec {
Napi::Value __mcapOpen(const Napi::CallbackInfo &info);
Napi::Value __mcapRegisterSchema(const Napi::CallbackInfo &info);
Napi::Value __mcapRegisterChannel(const Napi::CallbackInfo &info);
Napi::Value __mcapAddMessage(const Napi::CallbackInfo &info);
Napi::Value __mcapAddMetadata(const Napi::CallbackInfo &info);
Napi::Value __mcapEnd(const Napi::CallbackInfo &info);
Napi::Value __mcapAbort(const Napi::CallbackInfo &info);
// Wave 2: the live RECORDER BRICK surface (`core.Recorder.*`) — the
// orchestrator's recorder-node host drives it; frames flow producer-tap →
// writer thread entirely in C++ (core/lib/Record/RecorderStream.cpp).
void exportRecorderNamespace(Napi::Env env, Napi::Object &exports);
} // namespace Rec

// Native crash-site tracing (teardown-hardening Task 3): std::set_terminate +
// SIGABRT/SIGSEGV/SIGBUS handlers that print a symbolicatable backtrace before
// re-raising (exit-code semantics preserved -> janitor still parks hardware).
// Called once at orchestrator boot. Defined in core/lib/CrashHandler.cpp.
Napi::Value installCrashHandler(const Napi::CallbackInfo &info);

using namespace Napi;

bool DEBUGGER_CONNECTED = false;

static FN(cleanup) {
  Cleanup::clear(static_cast<napi_env>(info.Env()));
  return info.Env().Undefined();
}

static Object init(Env env, Object exports) {
  try {
    VERBOSE("Initializing core module (ENV=%p, PID=%d)",
            static_cast<napi_env>(env), getpid());
    Dispatcher::init(env);
    // Aravis Module
    auto Aravis = Object::New(env);
    CORE_OBJECT_EXPORT(CameraObject, env, Aravis);
    CORE_OBJECT_EXPORT(FrameObject, env, Aravis);
    // B-16 no-hardware loopback hook: convert+offer a synthetic frame through
    // the real Pipe ring (see core/test/11-capture-pipe.ts). Test-only.
    Aravis.Set("feedTestFrame",
               Function::New<Arv::feedTestFrame>(env, "feedTestFrame"));
    // B-17 cut-over seam: A's registry attaches/detaches a camera→pipe producer.
    Aravis.Set("attachCameraPipe",
               Function::New<Arv::attachCameraPipe>(env, "attachCameraPipe"));
    Aravis.Set("detachCameraPipe",
               Function::New<Arv::detachCameraPipe>(env, "detachCameraPipe"));
    Aravis.Set("enableFakeCamera",
               Function::New<Arv::enableFakeCamera>(env, "enableFakeCamera"));
    // B-18: per-pipeId converter-thread meter snapshots (A splices into
    // perfSnapshot.workloads alongside Pipe.probeAll()).
    Aravis.Set("converterProbeAll",
               Function::New<Arv::converterProbeAll>(env, "converterProbeAll"));
    // B-23 (real-1g): undistort pipes — a native convert+remap thread per
    // (camera × spec.pixelFormat), maps built at attach from the persisted
    // CameraCalibration JSON; gated by the pipe's own consumer refcount.
    Aravis.Set("attachUndistortPipe",
               Function::New<Arv::attachUndistortPipe>(env, "attachUndistortPipe"));
    Aravis.Set("detachUndistortPipe",
               Function::New<Arv::detachUndistortPipe>(env, "detachUndistortPipe"));
    Aravis.Set("undistortProbeAll",
               Function::New<Arv::undistortProbeAll>(env, "undistortProbeAll"));
    // The homography-variant control surface — mirror/H history writes
    // (≤ ~1 kHz) + the device→host clock offset.
    Aravis.Set("pushHomography",
               Function::New<Arv::pushHomography>(env, "pushHomography"));
    Aravis.Set("setClockOffset",
               Function::New<Arv::setClockOffset>(env, "setClockOffset"));
    // Test-only: inject per-frame stall into an undistort brick so the
    // converter outruns it — drives the FIFO backpressure + high-water path
    // (core/test/22). Not part of the public d.ts surface.
    Aravis.Set("undistortStall",
               Function::New<Arv::undistortStall>(env, "undistortStall"));
    // Hardware-free native self-test of the ParamRing lookup semantics
    // (core/test/22). Not part of the public d.ts surface.
    Aravis.Set("__paramRingSelfTest", Function::New<Arv::__paramRingSelfTest>(
                                          env, "__paramRingSelfTest"));
    // unified-time: bulk camera clock-stability rows for the 1 Hz clocks
    // poll ({ [serial]: {offsetNs, jitterNs, samples, atNs, ageNs,
    // driftPpm|null} }) + the hardware-free min-filter self-test (test 24).
    Aravis.Set("clockStabilityAll", Function::New<Arv::clockStabilityAll>(
                                        env, "clockStabilityAll"));
    // The clock-metrics PUSH channel (CallbackSlot): arm with a callback,
    // disarm with null. Zero cross-thread cost while disarmed.
    Aravis.Set("onClockMetrics",
               Function::New<Arv::onClockMetrics>(env, "onClockMetrics"));
    Aravis.Set("__clockCalSelfTest", Function::New<Arv::__clockCalSelfTest>(
                                         env, "__clockCalSelfTest"));
    Aravis.Set("__fireClockMetricsTest",
               Function::New<Arv::__fireClockMetricsTest>(
                   env, "__fireClockMetricsTest"));
    // B-24 (real-2): spawn/cancel-able fovea crop pipes — fused map-ROI
    // convert+remap+crop per (camera × pipe), live-steerable rect, C-20
    // max-footprint dynamic geometry. Probe keys + meter names = pipeId.
    Aravis.Set("attachFoveaPipe",
               Function::New<Arv::attachFoveaPipe>(env, "attachFoveaPipe"));
    Aravis.Set("setFoveaRect",
               Function::New<Arv::setFoveaRect>(env, "setFoveaRect"));
    Aravis.Set("detachFoveaPipe",
               Function::New<Arv::detachFoveaPipe>(env, "detachFoveaPipe"));
    Aravis.Set("foveaProbeAll",
               Function::New<Arv::foveaProbeAll>(env, "foveaProbeAll"));
    // split-disparity-nodes: spawn/cancel-able RESIZE pipes — a native
    // cv::resize thread chained on any convert/undistort/fovea/scale pipe,
    // reactive {ratio|dwidth|dheight|dsize} params, C-20 max-footprint dynamic
    // geometry with the source crop origin forwarded unscaled.
    Aravis.Set("attachScalePipe",
               Function::New<Arv::attachScalePipe>(env, "attachScalePipe"));
    Aravis.Set("setScaleParams",
               Function::New<Arv::setScaleParams>(env, "setScaleParams"));
    Aravis.Set("detachScalePipe",
               Function::New<Arv::detachScalePipe>(env, "detachScalePipe"));
    Aravis.Set("scaleProbeAll",
               Function::New<Arv::scaleProbeAll>(env, "scaleProbeAll"));
    // mirror-link triangle flip: a pass-through copy of a convert pipe whose
    // frames are cv::flip(…, 0)'d (rows reversed) iff matched (nearest anchor
    // EDGE — tStart or tEnd — within toleranceNs, PairStream root rule) to a
    // marker anchor marked `flip`. Probe rows are all Numbers (JSON-safe).
    // docs/spec/core-streams.md#flip-stream
    Aravis.Set("attachFlipPipe",
               Function::New<Arv::attachFlipPipe>(env, "attachFlipPipe"));
    Aravis.Set("pushFlipAnchor",
               Function::New<Arv::pushFlipAnchor>(env, "pushFlipAnchor"));
    Aravis.Set("flipProbe", Function::New<Arv::flipProbe>(env, "flipProbe"));
    Aravis.Set("flipProbeAll",
               Function::New<Arv::flipProbeAll>(env, "flipProbeAll"));
    Aravis.Set("detachFlipPipe",
               Function::New<Arv::detachFlipPipe>(env, "detachFlipPipe"));
    // stereo-disparity-and-heatmap-nodes: the FIRST two-input brick — a native
    // cv::StereoSGBM thread pairing two convert/undistort/fovea/scale taps into
    // a CV_32F disparity pipe (reactive {numDisparities|blockSize|minDisparity})
    // + a colormap brick turning a 1-channel (F32/U8) input into a BGRA8 TURBO
    // heatmap. Both on-demand (park with no consumer).
    Aravis.Set("attachStereoPipe",
               Function::New<Arv::attachStereoPipe>(env, "attachStereoPipe"));
    Aravis.Set("attachStereoPaired",
               Function::New<Arv::attachStereoPaired>(env, "attachStereoPaired"));
    Aravis.Set("setStereoParams",
               Function::New<Arv::setStereoParams>(env, "setStereoParams"));
    Aravis.Set("detachStereoPipe",
               Function::New<Arv::detachStereoPipe>(env, "detachStereoPipe"));
    Aravis.Set("stereoProbeAll",
               Function::New<Arv::stereoProbeAll>(env, "stereoProbeAll"));
    Aravis.Set("attachHeatmapPipe",
               Function::New<Arv::attachHeatmapPipe>(env, "attachHeatmapPipe"));
    Aravis.Set("setHeatmapParams",
               Function::New<Arv::setHeatmapParams>(env, "setHeatmapParams"));
    Aravis.Set("detachHeatmapPipe",
               Function::New<Arv::detachHeatmapPipe>(env, "detachHeatmapPipe"));
    Aravis.Set("heatmapProbeAll",
               Function::New<Arv::heatmapProbeAll>(env, "heatmapProbeAll"));
    // composite-node-and-center-select-fix: the two-input composite brick —
    // a per-pixel BGRA op (anaglyph / L-vs-R difference) pairing two
    // convert/undistort/fovea/scale taps into a BGRA8 pipe (reactive
    // {mode}). On-demand (parks with no consumer).
    Aravis.Set("attachCompositePipe",
               Function::New<Arv::attachCompositePipe>(env, "attachCompositePipe"));
    Aravis.Set("setCompositeParams",
               Function::New<Arv::setCompositeParams>(env, "setCompositeParams"));
    Aravis.Set("detachCompositePipe",
               Function::New<Arv::detachCompositePipe>(env, "detachCompositePipe"));
    Aravis.Set("compositeProbeAll",
               Function::New<Arv::compositeProbeAll>(env, "compositeProbeAll"));
    // capture-recorder-nodes Phase 1: attach/detach a RAW camera-source pipe —
    // a gated Frame::Ptr subscriber on the camera Arv::Stream that publishes
    // full-bit-depth sensor bytes (`frame->raw`) into its ring. On-demand
    // (parks with no recorder/capture consumer). Probe keys = pipeId (node id).
    Aravis.Set("attachRawPipe",
               Function::New<Arv::attachRawPipe>(env, "attachRawPipe"));
    Aravis.Set("detachRawPipe",
               Function::New<Arv::detachRawPipe>(env, "detachRawPipe"));
    Aravis.Set("rawProbeAll",
               Function::New<Arv::rawProbeAll>(env, "rawProbeAll"));
    // PACKED raw-12p pipes — a pre-Frame ArvBuffer tap publishes the VERBATIM
    // wire payload (packed 12p when the sensor runs 12p readout). Same
    // consumer-gate/on-demand contract as raw.
    Aravis.Set("attachRaw12pPipe",
               Function::New<Arv::attachRaw12pPipe>(env, "attachRaw12pPipe"));
    Aravis.Set("detachRaw12pPipe",
               Function::New<Arv::detachRaw12pPipe>(env, "detachRaw12pPipe"));
    Aravis.Set("raw12pProbeAll",
               Function::New<Arv::raw12pProbeAll>(env, "raw12pProbeAll"));
    // Intra-frame COMPRESSION pipes — a native thread FIFO-reads a source pipe
    // and republishes each frame zlib-
    // compressed (opaque /zlib blob, ring-v5 payloadBytes). Gated by the output
    // pipe's own consumer refcount (parks with no consumer).
    Aravis.Set("attachCompressPipe",
               Function::New<Arv::attachCompressPipe>(env, "attachCompressPipe"));
    Aravis.Set("detachCompressPipe",
               Function::New<Arv::detachCompressPipe>(env, "detachCompressPipe"));
    Aravis.Set("compressProbeAll",
               Function::New<Arv::compressProbeAll>(env, "compressProbeAll"));
    // pairing-nodes P-1: the per-stage L/R pairing brick (create-only). Two
    // in-process FIFO taps joined against FIN anchors (root tolerance / exact
    // key); always-running; batched pair records via [Symbol.asyncIterator].
    Aravis.Set("createPairStream",
               Function::New<Arv::createPairStream>(env, "createPairStream"));
    // Test-only synthetic ConvertedFrame producers feeding a pairing brick with
    // EXPLICIT deviceTimestamps (core/test/33). Not part of the public d.ts.
    Aravis.Set("createPairTestSource",
               Function::New<Arv::createPairTestSource>(env, "createPairTestSource"));
    Aravis.Set("pushPairTestFrame",
               Function::New<Arv::pushPairTestFrame>(env, "pushPairTestFrame"));
    Aravis.Set("releasePairTestSource", Function::New<Arv::releasePairTestSource>(
                                            env, "releasePairTestSource"));
    // Circular-scan orbit brick (create-only): paced volts for the controller's
    // native pos_in, so a camera write on the JS loop cannot stall the scan.
    Aravis.Set("createOrbitStream",
               Function::New<Arv::createOrbitStream>(env, "createOrbitStream"));
    exports.Set("Aravis", Aravis);
    // Controller Module
    auto Controller = Object::New(env);
    CORE_OBJECT_EXPORT(ControllerModule, env, Controller);
    exports.Set("Controller", Controller);
    // Vision Module
    auto Vision = Object::New(env);
    CORE_OBJECT_EXPORT(MarkerDetectorObject, env, Vision);
    CORE_OBJECT_EXPORT(VisionNamespace, env, Vision);
    exports.Set("Vision", Vision);
    // Tracker Module
    auto Tracker = Object::New(env);
    CORE_OBJECT_EXPORT(TrackerNamespace, env, Tracker);
    exports.Set("Tracker", Tracker);
    // Regression Module
    CORE_OBJECT_EXPORT(RegressionObject, env, exports);
    // Geometry Module
    auto Geometry = Object::New(env);
    CORE_OBJECT_EXPORT(GeometryModule, env, Geometry);
    exports.Set("Geometry", Geometry);
    // Log Module
    auto Log = Object::New(env);
    CORE_OBJECT_EXPORT(LogModule, env, Log);
    exports.Set("Log", Log);
    // Shared-memory frame transport helpers
    auto Shm = Object::New(env);
    ShmRing::exportShmNamespace(env, Shm);
    exports.Set("Shm", Shm);
    // Producer/publisher pipe broker
    auto PipeNs = Object::New(env);
    Pipe::exportPipeNamespace(env, PipeNs);
    exports.Set("Pipe", PipeNs);
    // Consolidated node-topology reporting: one NodeReport[] for every live
    // native brick + advertised pipe.
    auto TopologyNs = Object::New(env);
    TopologyNs.Set("report", Function::New<Topology::report>(env, "report"));
    exports.Set("Topology", TopologyNs);
    // Native port/pipe substrate: registers the OutPort/InPort/PipeLink
    // CoreObjects + the hardware-free test hooks. Root-object-only namespace
    // (the Recorder precedent).
    {
      void exportPortNamespace(Napi::Env, Napi::Object &);
      auto PortNs = Object::New(env);
      exportPortNamespace(env, PortNs);
      exports.Set("Port", PortNs);
    }
    // Finalize
    // THE native host time authority: libc++ steady_clock
    // integer ns. Every clock-calibration offset is in THIS domain; JS
    // hostNowNs delegates here (hrtime is not guaranteed the same Darwin
    // clock domain — one authority only).
    exports.Set("steadyNowNs",
                Function::New<Arv::steadyNowNsJs>(env, "steadyNowNs"));
    // Test-only (core/test/38): hardware-free Stream teardown-race soak.
    exports.Set("__streamTeardownRaceSelfTest",
                Function::New<streamTeardownRaceSelfTest>(
                    env, "__streamTeardownRaceSelfTest"));
    // Test-only (core/test/39): hand-rolled MCAP writer conformance surface.
    exports.Set("__mcapOpen", Function::New<Rec::__mcapOpen>(env, "__mcapOpen"));
    exports.Set("__mcapRegisterSchema",
                Function::New<Rec::__mcapRegisterSchema>(env, "__mcapRegisterSchema"));
    exports.Set("__mcapRegisterChannel",
                Function::New<Rec::__mcapRegisterChannel>(env, "__mcapRegisterChannel"));
    exports.Set("__mcapAddMessage",
                Function::New<Rec::__mcapAddMessage>(env, "__mcapAddMessage"));
    exports.Set("__mcapAddMetadata",
                Function::New<Rec::__mcapAddMetadata>(env, "__mcapAddMetadata"));
    exports.Set("__mcapEnd", Function::New<Rec::__mcapEnd>(env, "__mcapEnd"));
    exports.Set("__mcapAbort", Function::New<Rec::__mcapAbort>(env, "__mcapAbort"));
    // native-recorder Wave 2: the live recorder brick (`core.Recorder.*`).
    Rec::exportRecorderNamespace(env, exports);
    // Native crash-site tracing — call once at orchestrator boot.
    exports.Set("installCrashHandler",
                Function::New<installCrashHandler>(env, "installCrashHandler"));
    exports.Set("cleanup", Function::New(env, cleanup));
    VERBOSE("Core module initialized");
    if (std::getenv("WAIT_DEBUGGER")) {
      INFO("WAIT_DEBUGGER is set. Waiting for debugger to connect (pid=%d)...",
           getpid());
      while (!DEBUGGER_CONNECTED)
        std::this_thread::yield();
    }
    return exports;
  }
  JS_EXCEPT(exports);
}

NODE_API_MODULE(core, init);
