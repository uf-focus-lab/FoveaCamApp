// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The consolidated `Topology.report()` NAPI.
// Row builders + the pipe sweep live here; each brick family appends its own
// rows (see Topology.h). Everything runs on the NAPI thread; the only
// cross-thread reads are the seqlocked meter probes + PipeHub's own locking.

#include <Topology.h>

#include <Pipe.h>
#include <napi-helper.h>

using namespace Napi;

namespace Topology {

Object node(Env env, const std::string &id, const std::string &kind,
            const std::string &transport) {
  auto o = Object::New(env);
  o.Set("id", String::New(env, id));
  o.Set("kind", String::New(env, kind));
  o.Set("transport", String::New(env, transport));
  o.Set("inputs", Array::New(env));
  o.Set("output", env.Null());
  return o;
}

Object frameType(Env env, const std::string &pixelFormat,
                 const std::string &dtype) {
  auto t = Object::New(env);
  t.Set("kind", String::New(env, "frame"));
  t.Set("pixelFormat", String::New(env, pixelFormat));
  t.Set("dtype", String::New(env, dtype));
  return t;
}

void addInput(Env env, Object &node, const std::string &from,
              const std::string &port, Object type, int lossy) {
  auto inputs = node.Get("inputs").As<Array>();
  auto edge = Object::New(env);
  edge.Set("from", String::New(env, from));
  edge.Set("port", String::New(env, port));
  edge.Set("type", type);
  if (lossy >= 0) // explicit flag WINS over the JS pipe-producer default
    edge.Set("lossy", Boolean::New(env, lossy != 0));
  inputs.Set(inputs.Length(), edge);
}

bool decoratePipe(Env env, Object &node, const std::string &pipeId) {
  auto &hub = Pipe::PipeHub::instance();
  if (hub.sink(pipeId) == nullptr)
    return false;
  auto &pub = hub.publisher(pipeId);
  const auto &spec = pub.spec();
  node.Set("transport", String::New(env, "pipe"));
  node.Set("epoch", Number::New(env, static_cast<double>(pub.epoch())));
  node.Set("output", frameType(env, spec.pixelFormat, spec.dtype));
  auto pipe = Object::New(env);
  pipe.Set("consumers", Number::New(env, static_cast<double>(pub.consumers())));
  pipe.Set("bytesTotal",
           Number::New(env, static_cast<double>(pub.bytesTotal())));
  node.Set("pipe", pipe);
  return true;
}

// Topology.report() → NodeReport[] (graph-contract shape). Brick rows first
// (each family knows its ACTUAL inputs); then a plain row for every advertised
// pipe no brick claimed (synthetic/worker/kcf pipes — their producers report
// through their own probe surfaces until folded in, see Topology.h TODO).
Value report(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    auto rows = Array::New(env);
    std::set<std::string> seen;
    Arv::appendConverterReports(env, rows, seen);
    Arv::appendUndistortReports(env, rows, seen);
    Arv::appendFoveaReports(env, rows, seen);
    Arv::appendScaleReports(env, rows, seen);
    Arv::appendFlipReports(env, rows, seen);
    Arv::appendStereoReports(env, rows, seen);
    Arv::appendHeatmapReports(env, rows, seen);
    Arv::appendCompositeReports(env, rows, seen);
    Arv::appendRawReports(env, rows, seen);
    Arv::appendRaw12pReports(env, rows, seen);
    Arv::appendCompressReports(env, rows, seen);
    Arv::appendPairReports(env, rows, seen);
    PortPipe::appendLinkReports(env, rows); // native port links (edges-only)
    auto &hub = Pipe::PipeHub::instance();
    auto probes = hub.probeAll(); // publisher (offer-side) meters, keyed by id
    for (const auto &entry : hub.list()) {
      if (seen.count(entry.id))
        continue;
      auto row = node(env, entry.id, "pipe", "pipe");
      decoratePipe(env, row, entry.id);
      for (const auto &[id, snapshot] : probes)
        if (id == entry.id) {
          row.Set("stats", Arv::meterSnapshotToJs(env, snapshot));
          break;
        }
      rows.Set(rows.Length(), row);
    }
    return rows;
  }
  JS_EXCEPT(env.Undefined())
}

} // namespace Topology
