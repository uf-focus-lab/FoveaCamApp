// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// ONE consolidated
// `Topology.report()` NAPI returning a `NodeReport[]` row for every live
// native brick (convert/undistort/fovea) + every advertised SHM pipe — the
// same shape the JS side defines in `graph-contract.ts` (`NodeReport`):
//   { id, kind, transport: "pipe"|"native", inputs: [{from, port, type}],
//     output, epoch?, stats, pipe?: {consumers, bytesTotal} }
// `inputs` reflect the ACTUAL channel connections (convert←camera,
// undistort←convert, fovea←undistort) — no hand-declared edges. The existing
// `probeAll`/`Pipe.list` exports stay intact.
// TODO: fold the KCF/multi-KCF tracker streams in once their handles live in
// an id-keyed native registry (today they are JS-held CoreObjects reporting
// through their own probe surface).
//
// Assembly runs entirely ON the NAPI thread: each brick family appends its
// rows (it owns its registry + knows its actual inputs), recording covered
// pipe ids in `seen`; Topology.cpp then appends plain pipe rows for every
// advertised pipe no brick claimed (synthetic/worker/kcf pipes).

#include <set>
#include <string>

#include <napi.h>

#include "ThreadMeter.h"

namespace Topology {

// One NodeReport row skeleton ({id, kind, transport, inputs: []}).
Napi::Object node(Napi::Env env, const std::string &id, const std::string &kind,
                  const std::string &transport);
// StreamType tag for a frame stream: {kind: "frame", pixelFormat, dtype}.
Napi::Object frameType(Napi::Env env, const std::string &pixelFormat,
                       const std::string &dtype);
// Append one ACTUAL input edge {from, port, type} to the row's `inputs`.
// `lossy`: -1 = leave the field absent (JS fold defaults it from the
// producer's transport); 0 = explicit `lossy:false` (a lossless FIFO edge —
// must WIN over the pipe-producer default); 1 = explicit `lossy:true`.
void addInput(Napi::Env env, Napi::Object &node, const std::string &from,
              const std::string &port, Napi::Object type, int lossy = -1);
// If `pipeId` is a live advertised pipe: stamp the row transport="pipe" +
// {epoch, pipe: {consumers, bytesTotal}, output(from the pipe spec)} and
// return true. Otherwise leave the row native-only and return false.
bool decoratePipe(Napi::Env env, Napi::Object &node, const std::string &pipeId);

// The consolidated NAPI entry (exported as `Topology.report`).
Napi::Value report(const Napi::CallbackInfo &info);

} // namespace Topology

namespace Arv {

// Meter::Snapshot → the shared JS WorkloadSnapshot shape (ConverterStream.cpp).
Napi::Value meterSnapshotToJs(Napi::Env env, const Meter::Snapshot &s);

// Per-family row appenders (each defined next to its registry). They add every
// pipe id they cover to `seen` so Topology.cpp's pipe sweep skips them.
void appendConverterReports(Napi::Env env, Napi::Array &rows,
                            std::set<std::string> &seen);
void appendUndistortReports(Napi::Env env, Napi::Array &rows,
                            std::set<std::string> &seen);
void appendFoveaReports(Napi::Env env, Napi::Array &rows,
                        std::set<std::string> &seen);
void appendScaleReports(Napi::Env env, Napi::Array &rows,
                        std::set<std::string> &seen);
// The marker-keyed vertical FLIP brick (kind "flip", source-pipe input edge,
// same frame type out).
void appendFlipReports(Napi::Env env, Napi::Array &rows,
                       std::set<std::string> &seen);
// The two-input SGBM brick (kind "stereo", left/right input edges) + the
// colormap brick (kind "heatmap").
void appendStereoReports(Napi::Env env, Napi::Array &rows,
                         std::set<std::string> &seen);
void appendHeatmapReports(Napi::Env env, Napi::Array &rows,
                          std::set<std::string> &seen);
// The two-input composite brick (kind "composite", left/right BGRA8 input
// edges, BGRA8 output).
void appendCompositeReports(Napi::Env env, Napi::Array &rows,
                            std::set<std::string> &seen);
// The RAW camera-source pipe (kind "raw", camera/<serial> input edge,
// full-bit-depth sensor-format output).
void appendRawReports(Napi::Env env, Napi::Array &rows,
                      std::set<std::string> &seen);
// The PACKED raw-12p camera-source pipe (kind "raw12p", camera/<serial> input
// edge, verbatim wire-format payload output).
void appendRaw12pReports(Napi::Env env, Napi::Array &rows,
                         std::set<std::string> &seen);
// The intra-frame COMPRESSION pipe (kind "compress", source-pipe input edge,
// `<sourceFormat>/zlib` opaque output).
void appendCompressReports(Napi::Env env, Napi::Array &rows,
                           std::set<std::string> &seen);
// The per-stage L/R PAIRING brick (kind "pair", THREE input edges
// left/right/anchor, record output). Always-running, weak-ref registry.
void appendPairReports(Napi::Env env, Napi::Array &rows,
                       std::set<std::string> &seen);

} // namespace Arv

namespace PortPipe {

// One EDGES-ONLY row ({id: toId, kind: "", edgesOnly: true, inputs: [the link
// edge]}) per live native port link - the JS fold unions the edge into the
// consumer's node, so piped edges show on the profiler graph without any
// session-side registerGraphWiring shim.
void appendLinkReports(Napi::Env env, Napi::Array &rows);

} // namespace PortPipe
