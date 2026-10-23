// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Flip NAPI seam: the native per-frame VERTICAL FLIP brick (FlipStream.h),
// chained on a convert / undistort / fovea / scale pipe's OwnedFrame tap.
// Modelled 1:1 on ScaleStream.cpp:
//   attachFlipPipe(sourcePipeId, pipeId, { toleranceNs: bigint, anchorCap? })
//     sourcePipeId = a live convert | undistort | fovea | scale pipe id (or a
//                    pairing test source — test-only, empty in production).
//   pushFlipAnchor(pipeId, { tExposure: bigint, flip: boolean })
//   flipProbe(pipeId)  — meter + { frames, flipped, unmatched, anchorPoolSize }
//                        (+ anchorDrops, toleranceNs), or null if unknown.
//   flipProbeAll()     — the same rows keyed by pipeId (perf/workload fold).
//   detachFlipPipe(pipeId) — idempotent.
// The gated `PipeOfferSubscriber` is MAX-BOUND against the advertised
// footprint (the session advertises the SOURCE pipe's own spec, so a fixed
// convert source fills it exactly). Probe keys AND meter names = the pipeId.
// spec: docs/spec/core-streams.md#flip-stream

#include <cmath>
#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "FlipStream.h"
#include "FoveaStream.h"     // findFovea
#include "PairStream.h"      // findPairTestSource (test-only synthetic source)
#include "ScaleStream.h"     // findScale
#include "UndistortStream.h" // findUndistort

using namespace Napi;

namespace Arv {

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct FlipBinding {
  FlipStream::Ptr stream;                          // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t maxW = 0;
  uint32_t maxH = 0;
};

static std::mutex g_mutex;
static std::map<std::string, FlipBinding> g_pipes;

FlipStream::Ptr findFlip(const std::string &pipeId) {
  std::scoped_lock lock(g_mutex);
  auto it = g_pipes.find(pipeId);
  return it != g_pipes.end() ? it->second.stream : nullptr;
}

// Probe row: meter snapshot + the brick's counters.
static Napi::Object flipProbeRow(Napi::Env env, const FlipStream::Ptr &s) {
  auto o = meterSnapshotToJs(env, s->probe()).As<Napi::Object>();
  o.Set("frames", Napi::Number::New(env, static_cast<double>(s->frames())));
  o.Set("flipped", Napi::Number::New(env, static_cast<double>(s->flipped())));
  o.Set("unmatched",
        Napi::Number::New(env, static_cast<double>(s->unmatched())));
  o.Set("anchorPoolSize",
        Napi::Number::New(env, static_cast<double>(s->anchorPoolSize())));
  o.Set("anchorDrops",
        Napi::Number::New(env, static_cast<double>(s->anchorDrops())));
  o.Set("toleranceNs", convert(env, s->toleranceNs())); // int64 -> BigInt
  return o;
}

// ---- attach: resolve the source brick (any ConvertedFrame producer), gate --
FN(attachFlipPipe) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString(), TypeError,
              "attachFlipPipe: sourcePipeId (string) required", env.Undefined());
    JS_ASSERT(info[1].IsString(), TypeError,
              "attachFlipPipe: pipeId (string) required", env.Undefined());
    const auto srcId = info[0].As<Napi::String>().Utf8Value();
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[2].IsObject(), TypeError,
              "attachFlipPipe: options object required", env.Undefined());
    const auto opts = info[2].As<Napi::Object>();
    JS_ASSERT(opts.Has("toleranceNs") && !opts.Get("toleranceNs").IsUndefined(),
              TypeError, "attachFlipPipe: `toleranceNs` (bigint ns) required",
              env.Undefined());
    const int64_t toleranceNs = convert<int64_t>(opts.Get("toleranceNs"));
    JS_ASSERT(toleranceNs >= 0, RangeError,
              "attachFlipPipe: `toleranceNs` must be >= 0", env.Undefined());
    size_t anchorCap = 16;
    if (opts.Has("anchorCap") && !opts.Get("anchorCap").IsUndefined()) {
      JS_ASSERT(opts.Get("anchorCap").IsNumber(), TypeError,
                "attachFlipPipe: `anchorCap` must be a number", env.Undefined());
      const double cap = opts.Get("anchorCap").As<Napi::Number>().DoubleValue();
      JS_ASSERT(cap >= 1 && std::isfinite(cap), RangeError,
                "attachFlipPipe: `anchorCap` must be >= 1", env.Undefined());
      anchorCap = static_cast<size_t>(cap);
    }

    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "attachFlipPipe: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    // Footprint cap: the ring is sized to max (defaults to nominal).
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    // Resolve the tap SOURCE by pipeId (ids never collide across families, so
    // order is cosmetic; the test source registry is empty in production).
    ChainedStream::Source source;
    if (auto conv = findConverter(srcId))
      source = conv;
    else if (auto und = findUndistort(srcId))
      source = und;
    else if (auto fov = findFovea(srcId))
      source = fov;
    else if (auto sc = findScale(srcId))
      source = sc;
    else if (auto t = findPairTestSource(srcId))
      source = t;
    else
      JS_THROW(Error,
               "attachFlipPipe: no convert/undistort/fovea/scale brick on "
               "pipe " + srcId,
               env.Undefined());

    auto stream = FlipStream::create(std::move(source), srcId, pipeId,
                                     toleranceNs, anchorCap);
    FlipBinding replaced; // a re-attach's old binding, destructed OUTSIDE the lock
    {
      std::scoped_lock lock(g_mutex);
      auto &b = g_pipes[pipeId];
      replaced.subscriber = std::move(b.subscriber); // gated sub on the old stream
      replaced.stream = std::move(b.stream);
      b.stream = std::move(stream);
      b.sink = sink;
      b.maxW = maxW;
      b.maxH = maxH;
    }
    // Register the gate OUTSIDE the lock (fires immediately with the current
    // consumer state, re-locking g_mutex).
    hub.setConsumerGate(pipeId, [pipeId](bool active) {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it == g_pipes.end())
        return;
      auto &b = it->second;
      if (active && !b.subscriber)
        b.subscriber = std::make_unique<PipeOfferSubscriber>(
            b.stream.get(), b.sink, b.maxW, b.maxH, /*maxBound=*/true);
      else if (!active && b.subscriber)
        b.subscriber.reset();
    });
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- anchors: FIN-rate marker pushes -----------------------------------------
FN(pushFlipAnchor) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString(), TypeError,
              "pushFlipAnchor: pipeId (string) required", env.Undefined());
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[1].IsObject(), TypeError,
              "pushFlipAnchor: anchor object required", env.Undefined());
    const auto o = info[1].As<Napi::Object>();
    JS_ASSERT(o.Has("tExposure") && !o.Get("tExposure").IsUndefined(), TypeError,
              "pushFlipAnchor: `tExposure` (bigint ns) required",
              env.Undefined());
    JS_ASSERT(o.Has("flip") && o.Get("flip").IsBoolean(), TypeError,
              "pushFlipAnchor: `flip` (boolean) required", env.Undefined());
    FlipAnchor a;
    a.tExposure = convert<int64_t>(o.Get("tExposure"));
    a.flip = o.Get("flip").As<Napi::Boolean>().Value();
    auto stream = findFlip(pipeId);
    if (!stream)
      return Boolean::New(env, false);
    stream->pushAnchor(a);
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding --------------
FN(detachFlipPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    FlipBinding removed; // destructed OUTSIDE the lock (unsubscribe + join)
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it != g_pipes.end()) {
        removed = std::move(it->second);
        g_pipes.erase(it);
      }
    }
    return Boolean::New(env, removed.stream != nullptr);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- probes: keyed by pipeId (= node id), meter name == key ----------------
FN(flipProbe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    auto stream = findFlip(pipeId);
    if (!stream)
      return env.Null();
    return flipProbeRow(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

FN(flipProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    out.Set(pipeId, flipProbeRow(env, b.stream));
  }
  return out;
}

// ---- Topology.report() rows -------------------------------------------------
void appendFlipReports(Napi::Env env, Napi::Array &rows,
                       std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto row = Topology::node(env, pipeId, "flip", "native");
    Topology::addInput(env, row, b.stream->sourceId(), "frame",
                       Topology::frameType(env, "RGBA8", "U8"));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, "RGBA8", "U8"));
    row.Set("stats", meterSnapshotToJs(env, b.stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
