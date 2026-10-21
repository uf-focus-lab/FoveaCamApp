// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <Protocol/Packet.h>
#include <Protocol/Protocol.h>

#include "Board.h"
#include "Capture.h"
#include "Global.h"
#include "Streams.h"
#include "Trajectory.h" // v2.2.0 marker seam: completion sink

namespace Capture {

using Packet::Command::CAM_C;
using Packet::Command::CAM_L;
using Packet::Command::CAM_R;
using Packet::Command::Frame;
using Packet::Command::FrameResult;
using Packet::Command::MirrorPosition;
using Packet::Command::Timestamp;

static constexpr uint8_t QUEUE_CAPACITY = 8;
// Both trigger outputs Frame requests can drive today (C has no strobe cable —
// camera-side size constraints).
static constexpr uint8_t SUPPORTED_CAMERAS = CAM_L | CAM_R;
// Fixed margin added to `pulse` before a strobe REJ-timeout fires. Tune once a
// logic analyzer trace of real strobe timing is available.
static constexpr Timestamp STROBE_MARGIN_US = 5000;

struct Request {
  Protocol::Sequence seq;
  uint8_t stream;
  uint8_t cameras;
  Microseconds pulse;
  Microseconds settle_time; // v2.0 trigger hold, applied only on a switch
  uint32_t frame_id; // stable capture identity (see frameCounter)
  // v2.2.0 marker seam: origin. Host requests keep the defaults; a marker
  // request (enqueueMarker) carries stream = Streams::INVALID_ID, seq = 0.
  bool fromMarker = false;
  MarkerOrigin marker{};
};

// Monotonic capture counter: one id assigned per accepted CMD_FRAME request,
// reported in its FIN. 1-based (0 = none), wraps only at uint32 — the host's
// stable frame-association key, independent of the uint16 protocol seq.
static uint32_t frameCounter = 0;

// Per-channel round-half-up mean of two mirror positions — the 2-point
// exposure average (start latch + finish latch) reported in FIN.
static MirrorPosition averagePosition(const MirrorPosition &a,
                                      const MirrorPosition &b) {
  MirrorPosition out;
  for (uint8_t i = 0; i < 4; i++)
    out.ch[i] = static_cast<uint16_t>(
        (static_cast<uint32_t>(a.ch[i]) + b.ch[i] + 1) / 2);
  return out;
}

template <typename T, uint8_t N> struct Ring {
  T items[N];
  uint8_t head = 0;
  uint8_t count = 0;

  bool full() const { return count >= N; }
  bool empty() const { return count == 0; }
  uint8_t size() const { return count; }

  T &at(uint8_t index) { return items[(head + index) % N]; }

  bool push(const T &value) {
    if (full())
      return false;
    items[(head + count) % N] = value;
    count++;
    return true;
  }

  T pop() {
    T value = items[head];
    head = (head + 1) % N;
    count--;
    return value;
  }
};

static Ring<Request, QUEUE_CAPACITY> queue;

static bool busy = false;
static Request active;
static Timestamp triggerStart = 0;
static bool triggerDropped = false;
// v2.0 settle hold: set in startNext() when the popped request SWITCHES the
// active stream and carries settle_time > 0. While true the mirror has already
// moved but the trigger has NOT been asserted yet — tick() holds off every
// strobe/exposure step and fires the trigger once `now >= triggerDueAt`. 0 =
// current behavior (trigger fires immediately, awaitingSettle stays false).
static bool awaitingSettle = false;
static Timestamp triggerDueAt = 0;

// exposureLatched: set once by the ISR (see onStrobeEdge) when the first
// requested camera strobe-rises; only ever cleared by startNext() (main
// loop). Acts as the ISR→main-loop ordering guard for everything below it.
static volatile bool exposureLatched = false;
// Raw hardware microsecond sample taken *in the ISR* — not Global::time,
// whose (counter, anchor) update is a non-atomic read-modify-write also
// performed by loop(); an ISR calling Global::time.now() could preempt that
// update mid-flight and corrupt the counter. tick() (main-loop
// only) translates this into the wide Global::time domain once, below.
static volatile uint32_t exposureLatchRawMicros = 0;
static bool exposureLatchTranslated = false; // main-loop-only
static Timestamp exposureLatchTime = 0;      // main-loop-only, once translated
// Not volatile: only ever written by an ISR, then read by tick() after it
// observes exposureLatched==true — that (volatile) flag is the ordering
// guard, avoiding the deprecated volatile-struct-copy pattern.
static MirrorPosition exposureLeft;
static MirrorPosition exposureRight;
// Finish endpoint of the 2-point exposure average: the DAC target latched at
// each requested camera's strobe FALL (symmetric with the rise latch above),
// last fall wins. Same ISR-write / main-loop-read discipline as
// exposureLeft/Right — the volatile strobeHighMask store is the release
// barrier. exposureFinishValid guards the average against a path with no fall.
static MirrorPosition exposureFinishLeft;
static MirrorPosition exposureFinishRight;
static bool exposureFinishValid = false;
// Bit set while the corresponding camera's strobe input is currently high.
static volatile uint8_t strobeHighMask = 0;
// Bit set once the corresponding camera has strobe-risen at least once this
// request — distinct from strobeHighMask (current level): without this, a
// camera that never rises at all (e.g. unplugged/dead) never blocks
// completion, and once the *other* camera falls the request FINs as success
// with only one camera actually exposed.
static volatile uint8_t risenMask = 0;
// Requested camera bits this request is still waiting to see fall.
static volatile uint8_t awaitingFallMask = 0;

static inline bool queueFull() { return queue.full(); }

static inline bool duplicateStream(uint8_t stream) {
  for (uint8_t i = 0; i < queue.size(); i++)
    if (queue.at(i).stream == stream)
      return true;
  return busy && active.stream == stream;
}

static void writeTrigger(uint8_t cameras, uint8_t level) {
  if (cameras & CAM_L)
    Board::camera[1].trigger.write(level);
  if (cameras & CAM_R)
    Board::camera[2].trigger.write(level);
}

// Common strobe-edge handler for both cameras; `bit` identifies the camera
// in CameraMask terms, `pin` is that camera's Board::camera strobe pin.
static inline void onStrobeEdge(uint8_t bit, unsigned pin) {
  if (digitalReadFast(pin)) {
    strobeHighMask |= bit;
    risenMask |= bit;
    if (!exposureLatched && (awaitingFallMask & bit)) {
      // First requested camera to strobe-rise for this request: latch a raw
      // micros() sample (see exposureLatchRawMicros above — NOT
      // Global::time.now(), that's the whole point) + the mirror target
      // actually driving the DAC right now (Stream UPDATEs keep applying
      // independently of this ISR).
      exposureLatchRawMicros = micros();
      MirrorPosition left, right;
      Streams::snapshot(left, right);
      exposureLeft = left;
      exposureRight = right;
      exposureLatched = true;
    }
  } else {
    // Symmetric finish latch: snapshot the DAC target at each requested
    // camera's strobe FALL. Written BEFORE clearing the level bit so the
    // volatile strobeHighMask store below is the release barrier — once the
    // main loop observes exposure-over, this finish position is already
    // written. Each requested fall overwrites, so the last one (exposure fully
    // over) wins; this is the 2-point average's finish endpoint.
    if (exposureLatched && (awaitingFallMask & bit)) {
      Streams::snapshot(exposureFinishLeft, exposureFinishRight);
      exposureFinishValid = true;
    }
    strobeHighMask &= ~bit;
  }
}

static void onStrobeLeft() {
  onStrobeEdge(CAM_L, Board::camera[1].strobe.number);
}

static void onStrobeRight() {
  onStrobeEdge(CAM_R, Board::camera[2].strobe.number);
}

static FrameResult buildResult(const Request &req) {
  // 2-point exposure average (start latch + finish latch). If no finish was
  // latched (should not happen on the success path — exposure-over requires
  // every requested camera to have fallen), fall back to the start value.
  MirrorPosition left =
      exposureFinishValid ? averagePosition(exposureLeft, exposureFinishLeft)
                          : exposureLeft;
  MirrorPosition right =
      exposureFinishValid ? averagePosition(exposureRight, exposureFinishRight)
                          : exposureRight;
  return FrameResult{req.stream,       req.frame_id, triggerStart,
                     exposureLatchTime, left,         right};
}

static void sendResult(const Request &req) {
  FrameResult result = buildResult(req);
  auto packet = Frame::Create::FIN(req.seq);
  packet.setData(&result, sizeof(result));
  Protocol::send(packet);
}

// v2.2.0 marker seam: set by cancelAll() so a cancelled marker capture
// reports CANCELLED rather than STROBE_TIMEOUT.
static bool cancelling = false;

static void finishActive(const char *rejectReason) {
  // ---- v2.2.0 marker seam: marker captures complete as a SYN push ----------
  if (active.fromMarker) {
    using Packet::Command::TrajectoryFrame;
    FrameResult result{};
    uint8_t status = TrajectoryFrame::OK;
    if (rejectReason) {
      // Keep what was latched (trigger edge; exposure start if any).
      result.t_trigger = triggerStart;
      result.t_exposure = exposureLatchTranslated ? exposureLatchTime : 0;
      status = cancelling ? TrajectoryFrame::CANCELLED
                          : TrajectoryFrame::STROBE_TIMEOUT;
    } else {
      result = buildResult(active);
    }
    result.stream = active.marker.id;
    result.frame_id = active.frame_id;
    Trajectory::push(active.marker.id, active.marker.marker,
                     active.marker.cycle, status, result);
    busy = false;
    awaitingSettle = false;
    return;
  }
  // ---- end marker seam ----------------------------------------------------
  Streams::setPendingFrame(active.stream, false);
  if (rejectReason)
    Frame::reject(active.seq, rejectReason);
  else
    sendResult(active);
  busy = false;
  awaitingSettle = false; // never leave a stale hold across requests
}

static void startNext() {
  if (busy || queue.empty())
    return;
  active = queue.pop();
  busy = true;
  triggerDropped = false;
  exposureLatched = false;
  exposureLatchTranslated = false;
  exposureFinishValid = false;
  // Compound read-modify-write on ISR-shared volatiles: without disabling
  // interrupts, an onStrobeEdge() firing between the load and the store
  // could have its own update overwritten by this one.
  noInterrupts();
  strobeHighMask &= static_cast<uint8_t>(~active.cameras); // drop stale level
  risenMask &= static_cast<uint8_t>(~active.cameras);      // drop stale rise
  interrupts();
  awaitingFallMask = active.cameras;

  // Stream SWITCH detection (v2.0 settle): the currently-active DAC stream,
  // read BEFORE we re-point it, vs this request's stream. A change — including
  // the first request after INVALID_ID — means the mirror is about to move to
  // a new location. Same-stream consecutive frames are NOT a switch.
  // v2.2.0 marker seam: a marker capture never re-points the DAC (the running
  // trajectory owns it) and is never a switch (no settle hold).
  const bool isSwitch =
      !active.fromMarker && Streams::active() != active.stream;

  if (!active.fromMarker) {
    Streams::activate(active.stream);
    Streams::tick(); // commit the target before the trigger fires
  }

  if (isSwitch && active.settle_time > 0) {
    // Mirror committed above; DEFER the trigger. tick() asserts it once the
    // settle window elapses — pulse/exposure/timeout timing all start from the
    // real trigger edge, so settle is never subtracted from the exposure.
    awaitingSettle = true;
    triggerDueAt = Global::time.now() + active.settle_time;
  } else {
    awaitingSettle = false;
    triggerStart = Global::time.now();
    writeTrigger(active.cameras, HIGH);
  }
}

bool enqueue(Protocol::Sequence seq, uint8_t stream, uint8_t cameras,
            Microseconds pulse, Microseconds settle_time,
            Packet::Command::FrameAccepted &accepted, const char *&reason) {
  if (cameras == 0)
    cameras = SUPPORTED_CAMERAS;
  if (cameras & CAM_C) {
    reason = "Center camera (C) has no strobe cable connected";
    return false;
  }
  if (cameras & ~SUPPORTED_CAMERAS) {
    reason = "Invalid camera mask";
    return false;
  }
  if (!Streams::exists(stream)) {
    reason = "Unknown stream";
    return false;
  }
  if (duplicateStream(stream)) {
    reason = "Stream already has a pending frame request";
    return false;
  }
  if (queueFull()) {
    reason = "Frame queue is full";
    return false;
  }
  accepted.queue_position = queue.size();
  queue.push(Request{seq, stream, cameras, pulse, settle_time, ++frameCounter});
  Streams::setPendingFrame(stream, true);
  return true;
}

void init() {
  attachInterrupt(Board::camera[1].strobe.number, onStrobeLeft, CHANGE);
  attachInterrupt(Board::camera[2].strobe.number, onStrobeRight, CHANGE);
}

void tick() {
  if (busy) {
    if (awaitingSettle) {
      // v2.0 settle hold: mirror already committed, trigger not yet asserted.
      // Hold off ALL strobe/exposure/timeout logic until the window elapses,
      // then fire the trigger — from here on the request behaves identically
      // to the no-settle path (triggerStart is the real edge).
      if (Global::time.now() >= triggerDueAt) {
        awaitingSettle = false;
        triggerStart = Global::time.now();
        writeTrigger(active.cameras, HIGH);
      }
      return; // startNext() is a no-op while busy; nothing else to do
    }
    if (!triggerDropped &&
        Global::time.now() - triggerStart >= active.pulse) {
      writeTrigger(active.cameras, LOW);
      triggerDropped = true;
    }
    if (exposureLatched && !exposureLatchTranslated) {
      // Translate the ISR's raw micros() sample into the wide Global::time
      // domain here, in the main loop, where touching Global::time's
      // internal state can't race an ISR. Unsigned subtraction on
      // the raw 32-bit sample is wraparound-correct as long as this runs
      // within one micros() wrap of the latch (trivially true — at most one
      // loop() iteration later).
      uint32_t elapsedSinceLatch =
          static_cast<uint32_t>(micros()) - exposureLatchRawMicros;
      exposureLatchTime = Global::time.now() - elapsedSinceLatch;
      exposureLatchTranslated = true;
    }
    // Every requested camera must have both risen (risenMask) and returned
    // low (cleared from strobeHighMask) — requiring risenMask too is what
    // stops a camera that never strobes at all from producing a silent
    // "successful" FIN off the other camera's fall alone.
    bool exposureOver = exposureLatched && risenMask == active.cameras &&
                        (strobeHighMask & awaitingFallMask) == 0;
    bool timedOut =
        Global::time.now() - triggerStart > active.pulse + STROBE_MARGIN_US;
    if (exposureOver)
      finishActive(nullptr);
    else if (timedOut)
      finishActive("Strobe timeout");
  }
  startNext();
}

void cancelAll(const char *reason) {
  if (busy) {
    writeTrigger(active.cameras, LOW);
    cancelling = true; // v2.2.0 marker seam (CANCELLED status)
    finishActive(reason);
    cancelling = false;
  }
  while (!queue.empty()) {
    auto req = queue.pop();
    Streams::setPendingFrame(req.stream, false);
    Frame::reject(req.seq, reason);
  }
}

// ---- v2.2.0 trajectory-marker seam (CMD_TRAJECTORY) -------------------------

bool camerasSupported(uint8_t cameras) {
  return cameras != 0 && (cameras & ~SUPPORTED_CAMERAS) == 0;
}

bool enqueueMarker(const MarkerOrigin &origin, uint8_t cameras,
                   Microseconds pulse) {
  if (busy || !queue.empty() || !camerasSupported(cameras))
    return false;
  Request req{0, Streams::INVALID_ID, cameras, pulse, 0, ++frameCounter};
  req.fromMarker = true;
  req.marker = origin;
  queue.push(req);
  startNext(); // trigger edge NOW — the marker's phase is this tick
  return true;
}

} // namespace Capture
