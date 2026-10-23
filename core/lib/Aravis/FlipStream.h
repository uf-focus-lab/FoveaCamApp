// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// A per-frame VERTICAL FLIP brick keyed on trajectory-marker anchors, modelled
// on the RESIZE brick (ScaleStream): same ChainedStream tap / meter / demand /
// teardown contract. MirrorLink's triangular scan exposes one frame on the
// rising sweep and one on the falling sweep; the falling-sweep frame must reach
// every consumer (views, ring reader) with its rows reversed.
//   - Input is another brick's OwnedFrame tap (a fovea CONVERT pipe in
//     production; any ConvertedFrame producer resolves). Leaky/latest-wins;
//     demand propagation keeps the upstream chain awake.
//   - Output: same pixel format, same dims, same stride as the source frame.
//     A matched-`flip` frame is `cv::flip(src, dst, 0)` (rows reversed) into a
//     reused buffer; every other frame is passed through by HEADER (the
//     OwnedFrame already owns a deep copy made for this brick alone, so the
//     ring offer / downstream tap copy straight out of it — a pass-through
//     costs no extra copy).
//   - deviceTimestamp / systemTimestamp, the crop origin and the upstream
//     convertMs are forwarded UNCHANGED (trusted-time invariant: a flip pipe is
//     a transparent stand-in for its source pipe in the v4 slot header).
//
// ANCHORS (NAPI thread → mutex-guarded bounded pool, drop-oldest at
// `anchorCap`): `{ tExposure, flip }`, tExposure in the owner-applied trusted
// host-ns domain — the SAME domain as a frame's deviceTimestamp. Per frame, the
// matching rule is PairStream's ROOT rule (`matchesFrame`, delta 0) narrowed to
// the NEAREST anchor:
//   diff = |int64(frame.deviceTimestamp) − anchor.tExposure|   (two-sided)
//   candidate iff diff <= toleranceNs                          (inclusive)
//   the candidate with the smallest diff wins (ties → the older anchor)
// The frame flips iff a winner exists AND it is marked `flip`; no winner →
// pass through unflipped and count `unmatched`. Frames arrive in timestamp
// order, so after each frame the pool sheds every anchor OLDER than the winner
// and every anchor that can no longer match any later frame
// (tExposure < ts − toleranceNs). The winner itself is kept (a frame at most
// one tolerance later could still be nearest to it — harmless, it ages out).
//
// Counters (atomic, read by the NAPI probe): frames, flipped, unmatched, plus
// the live anchor pool size, alongside the thread meter (input `frame`, output
// `flip`).

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <iterator>
#include <mutex>
#include <string>

#include <opencv2/opencv.hpp>

#include "ConverterStream.h" // ChainedStream, ConvertedFrame, OwnedFrame, ...

namespace Arv {

// One trigger the brick may match a frame to (FlipAnchor in flip-pipe.ts).
struct FlipAnchor {
  int64_t tExposure = 0; // trusted host-ns exposure time (the match key)
  bool flip = false;     // a frame exposed by this trigger is flipped
};

class FlipStream : public ChainedStream {
public:
  using Ptr = std::shared_ptr<FlipStream>;
  // `source` = the upstream brick (convert / undistort / fovea / scale);
  // `sourceId` = its node id (topology edge). `name` = the pipe/node id.
  // `toleranceNs` = the match window (≥ 0); `anchorCap` = pool bound (≥ 1).
  static Ptr create(Source source, std::string sourceId, std::string name,
                    int64_t toleranceNs, size_t anchorCap) {
    return std::make_shared<FlipStream>(std::move(source), std::move(sourceId),
                                        std::move(name), toleranceNs,
                                        anchorCap);
  }
  FlipStream(Source source, std::string sourceId, std::string name,
             int64_t toleranceNs, size_t anchorCap)
      : ChainedStream(std::move(source)), name_(name),
        sourceId_(std::move(sourceId)), toleranceNs_(toleranceNs),
        anchorCap_(anchorCap ? anchorCap : 1),
        meter_(std::move(name), {"frame"}, {"flip"}, converterNowMs()) {}
  ~FlipStream() override {
    closeChain(); // wake a blocked tap read (ChainedStream contract)
    shutdown();
  }

  // NAPI thread: push one marker anchor (drop-oldest at anchorCap). Anchors
  // arrive at FIN rate in trigger order; the pool is kept in push order.
  void pushAnchor(const FlipAnchor &a) {
    std::scoped_lock lk(anchorMutex_);
    anchors_.push_back(a);
    while (anchors_.size() > anchorCap_) {
      anchors_.pop_front();
      anchorDrops_.fetch_add(1, std::memory_order_relaxed);
    }
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  uint64_t frames() const { return frames_.load(std::memory_order_relaxed); }
  uint64_t flipped() const { return flipped_.load(std::memory_order_relaxed); }
  uint64_t unmatched() const {
    return unmatched_.load(std::memory_order_relaxed);
  }
  uint64_t anchorDrops() const {
    return anchorDrops_.load(std::memory_order_relaxed);
  }
  size_t anchorPoolSize() {
    std::scoped_lock lk(anchorMutex_);
    return anchors_.size();
  }
  int64_t toleranceNs() const { return toleranceNs_; }
  const std::string &name() const { return name_; }
  const std::string &sourceId() const { return sourceId_; }

protected:
  void stop() override {
    ChainedStream::stop();
    // Parked (stream thread — single-writer over buf_): drop the reused flip
    // buffer instead of retaining it for the lease lifetime.
    buf_.release();
  }

  ConvertedFrame::Ptr process(const OwnedFrame::Ptr &in) override {
    const int64_t t = converterNowMs();
    if (const uint64_t gap = seqGap(in)) // tap outran this brick (latest-wins)
      meter_.drop(gap);
    meter_.ingest("frame", t);

    meter_.begin(t);
    if (in->mat.empty()) {
      meter_.end(converterNowMs());
      return nullptr;
    }
    const int64_t ts = static_cast<int64_t>(in->deviceTimestamp);
    const Match m = matchAndPrune(ts);
    frames_.fetch_add(1, std::memory_order_relaxed);

    auto cf = ConvertedFrame::create();
    if (m == Match::Flip) {
      cv::flip(in->mat, buf_, 0); // flipCode 0: about the x axis (rows reversed)
      cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
      flipped_.fetch_add(1, std::memory_order_relaxed);
    } else {
      // Pass-through by header: `in` OWNS its buffer (deep-copied for this
      // brick's tap alone) and outlives the synchronous dispatch of `cf`.
      cf->mat = in->mat;
      if (m == Match::None)
        unmatched_.fetch_add(1, std::memory_order_relaxed);
    }
    meter_.end(converterNowMs());

    cf->format = in->format;
    cf->deviceTimestamp = in->deviceTimestamp; // trusted-time: never restamp
    cf->systemTimestamp = in->systemTimestamp;
    cf->convertMs = in->upstreamMs; // the source's own convert cost, unchanged
    cf->originX = in->originX;      // v4 slot header fields forwarded as-is
    cf->originY = in->originY;
    meter_.emit("flip", converterNowMs());
    return cf;
  }

private:
  enum class Match { None, Pass, Flip };

  // Nearest anchor within ±toleranceNs of `ts` (PairStream root rule, delta 0;
  // ties → the older anchor), then prune what can never match a later frame.
  Match matchAndPrune(int64_t ts) {
    std::scoped_lock lk(anchorMutex_);
    auto best = anchors_.end();
    int64_t bestDiff = 0;
    for (auto it = anchors_.begin(); it != anchors_.end(); ++it) {
      const int64_t diff =
          ts > it->tExposure ? ts - it->tExposure : it->tExposure - ts;
      if (diff > toleranceNs_)
        continue;
      if (best == anchors_.end() || diff < bestDiff) {
        best = it;
        bestDiff = diff;
      }
    }
    // Prune: frames arrive in timestamp order, so an anchor older than the
    // winner can never be nearest to a later frame, and with no winner an
    // anchor below ts − toleranceNs can never match again.
    Match m = Match::None;
    int64_t cutoff = ts - toleranceNs_;
    if (best != anchors_.end()) {
      m = best->flip ? Match::Flip : Match::Pass;
      cutoff = best->tExposure; // ≥ ts − toleranceNs (it is within tolerance)
    }
    for (auto it = anchors_.begin(); it != anchors_.end();)
      it = (it->tExposure < cutoff) ? anchors_.erase(it) : std::next(it);
    return m;
  }

  const std::string name_;
  const std::string sourceId_; // upstream brick's node id (topology edge)
  const int64_t toleranceNs_;
  const size_t anchorCap_;
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat buf_;              // reused flipped output (this thread only)

  // Anchor pool: NAPI writer (pushAnchor) + brick reader (matchAndPrune).
  std::mutex anchorMutex_;
  std::deque<FlipAnchor> anchors_;

  std::atomic<uint64_t> frames_{0}, flipped_{0}, unmatched_{0},
      anchorDrops_{0};
};

// Cross-brick lookup: the live flip brick bound to `pipeId`, or nullptr.
// Defined in FlipStream.cpp (owns the registry); NAPI-thread only.
FlipStream::Ptr findFlip(const std::string &pipeId);

} // namespace Arv
