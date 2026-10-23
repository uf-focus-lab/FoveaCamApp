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
//     reused buffer; every other frame is passed through by HEADER: the
//     output `cv::Mat` shares the input's reference-counted buffer (a deep
//     copy made for this brick's tap alone, never written again), so the
//     pixels live as long as any holder keeps the header — the ring offer /
//     downstream tap copy straight out of it, and a pass-through costs no
//     extra copy.
//   - deviceTimestamp / systemTimestamp, the crop origin and the upstream
//     convertMs are forwarded UNCHANGED (trusted-time invariant: a flip pipe is
//     a transparent stand-in for its source pipe in the v4 slot header).
//
// ANCHORS (NAPI thread → mutex-guarded bounded pool, drop-oldest at
// `anchorCap`): `{ tStart, tEnd, flip }` — the exposure's two EDGES, both in
// the owner-applied trusted host-ns domain, the SAME domain as a frame's
// deviceTimestamp. Which edge the camera stamps a frame with is not assumed:
// per frame, the matching rule is PairStream's ROOT rule (`matchesFrame`,
// delta 0) over EVERY edge of every pooled anchor, narrowed to the NEAREST:
//   diff = |int64(frame.deviceTimestamp) − edge|   (two-sided, overflow-free)
//   candidate iff diff <= toleranceNs              (inclusive)
//   the smallest diff wins; ties → the older anchor (within one anchor, tStart)
// The frame flips iff a winner exists AND its anchor is marked `flip`; no
// winner → pass through unflipped and count `unmatched`. A frame processed
// before its anchor was pushed therefore passes unflipped (late anchor).
// Frames arrive in timestamp order, so after each frame the pool sheds every
// anchor whose BOTH edges are older than the winner's matched edge (no later
// frame can be nearer to them than to that edge) or, with no winner, every
// anchor with tEnd < ts − toleranceNs. The winner itself is kept (a frame at
// most one tolerance later could still be nearest to it — harmless, it ages
// out).
//
// Counters (atomic, read by the NAPI probe): frames, flipped, unmatched,
// anchorDrops, plus the live anchor pool size and the matched skew — the mean
// signed (frame stamp − matched edge) over the frames matched since the last
// RESETTING read (`takeMatchedSkewNs`; `peekMatchedSkewNs` leaves the window
// alone) — alongside the thread meter (input `frame`, output `flip`).

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
  int64_t tStart = 0; // trusted host-ns exposure start (the push's tExposure)
  int64_t tEnd = 0;   // trusted host-ns exposure end (tStart + pulse), >= tStart
  bool flip = false;  // a frame exposed by this trigger is flipped
};

// |a − b| without signed overflow: the true distance always fits a uint64.
inline uint64_t flipAbsDiff(int64_t a, int64_t b) {
  return a >= b ? static_cast<uint64_t>(a) - static_cast<uint64_t>(b)
                : static_cast<uint64_t>(b) - static_cast<uint64_t>(a);
}

class FlipStream : public ChainedStream {
public:
  using Ptr = std::shared_ptr<FlipStream>;
  // `source` = the upstream brick (convert / undistort / fovea / scale);
  // `sourceId` = its node id (topology edge). `name` = the pipe/node id.
  // `toleranceNs` = the match window (≥ 0); `anchorCap` = pool bound (≥ 1).
  // `anchorFrom` = the graph node id the anchors come from ("" = none), shown
  // as the row's second input (port `anchor`) in Topology.report().
  static Ptr create(Source source, std::string sourceId, std::string name,
                    int64_t toleranceNs, size_t anchorCap,
                    std::string anchorFrom) {
    return std::make_shared<FlipStream>(std::move(source), std::move(sourceId),
                                        std::move(name), toleranceNs,
                                        anchorCap, std::move(anchorFrom));
  }
  FlipStream(Source source, std::string sourceId, std::string name,
             int64_t toleranceNs, size_t anchorCap, std::string anchorFrom)
      : ChainedStream(std::move(source)), name_(name),
        sourceId_(std::move(sourceId)), anchorFrom_(std::move(anchorFrom)),
        toleranceNs_(toleranceNs),
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
  // Mean signed (frame stamp − matched edge) over the frames matched since
  // the last take, ns; 0 when none matched. `take` resets the window (the
  // session's `flipProbe`), `peek` does not (the 1 Hz `flipProbeAll` perf
  // fold must not steal the session's window).
  double takeMatchedSkewNs() {
    std::scoped_lock lk(anchorMutex_);
    const double mean = skewCount_ ? skewSum_ / double(skewCount_) : 0.0;
    skewSum_ = 0.0;
    skewCount_ = 0;
    return mean;
  }
  double peekMatchedSkewNs() {
    std::scoped_lock lk(anchorMutex_);
    return skewCount_ ? skewSum_ / double(skewCount_) : 0.0;
  }
  int64_t toleranceNs() const { return toleranceNs_; }
  const std::string &name() const { return name_; }
  const std::string &sourceId() const { return sourceId_; }
  const std::string &anchorFrom() const { return anchorFrom_; }

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
      // Pass-through by header: cv::Mat reference counting keeps the input's
      // buffer (deep-copied for this brick's tap alone, never written again)
      // alive for as long as `cf` or any downstream holder shares it.
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

  // Nearest anchor EDGE (tStart or tEnd) within ±toleranceNs of `ts`
  // (PairStream root rule, delta 0; ties → the older anchor, then tStart),
  // then prune what can never match a later frame. Brick thread only.
  Match matchAndPrune(int64_t ts) {
    std::scoped_lock lk(anchorMutex_);
    const uint64_t tol = static_cast<uint64_t>(toleranceNs_); // >= 0 (NAPI)
    auto best = anchors_.end();
    uint64_t bestDiff = 0;
    int64_t bestEdge = 0;
    for (auto it = anchors_.begin(); it != anchors_.end(); ++it) {
      const int64_t edges[2] = {it->tStart, it->tEnd};
      for (const int64_t edge : edges) {
        const uint64_t diff = flipAbsDiff(ts, edge);
        if (diff > tol)
          continue;
        // Strict `<`: iteration is oldest anchor first and tStart before
        // tEnd, so a tie keeps the older anchor / the earlier edge.
        if (best == anchors_.end() || diff < bestDiff) {
          best = it;
          bestDiff = diff;
          bestEdge = edge;
        }
      }
    }
    // Prune (frames arrive in timestamp order). With a winner: an anchor
    // whose BOTH edges (i.e. its tEnd) lie before the matched edge can never
    // be nearer to a later frame than that edge is. With no winner: an anchor
    // whose tEnd is below ts − toleranceNs can never match again.
    Match m = Match::None;
    if (best != anchors_.end()) {
      m = best->flip ? Match::Flip : Match::Pass;
      // Signed skew: bestDiff <= tol <= INT64_MAX, so it fits an int64.
      const int64_t skew = ts >= bestEdge ? static_cast<int64_t>(bestDiff)
                                          : -static_cast<int64_t>(bestDiff);
      skewSum_ += static_cast<double>(skew);
      ++skewCount_;
      for (auto it = anchors_.begin(); it != anchors_.end();)
        it = (it->tEnd < bestEdge) ? anchors_.erase(it) : std::next(it);
    } else {
      for (auto it = anchors_.begin(); it != anchors_.end();)
        it = (it->tEnd < ts && flipAbsDiff(ts, it->tEnd) > tol)
                 ? anchors_.erase(it)
                 : std::next(it);
    }
    return m;
  }

  const std::string name_;
  const std::string sourceId_;   // upstream brick's node id (topology edge)
  const std::string anchorFrom_; // anchor producer's node id ("" = unreported)
  const int64_t toleranceNs_;
  const size_t anchorCap_;
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat buf_;              // reused flipped output (this thread only)

  // Anchor pool: NAPI writer (pushAnchor) + brick reader (matchAndPrune).
  // The skew accumulator shares the lock (brick writes, NAPI take/peek).
  std::mutex anchorMutex_;
  std::deque<FlipAnchor> anchors_;
  double skewSum_ = 0.0;
  uint64_t skewCount_ = 0;

  std::atomic<uint64_t> frames_{0}, flipped_{0}, unmatched_{0},
      anchorDrops_{0};
};

// Cross-brick lookup: the live flip brick bound to `pipeId`, or nullptr.
// Defined in FlipStream.cpp (owns the registry); NAPI-thread only.
FlipStream::Ptr findFlip(const std::string &pipeId);

} // namespace Arv
