// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <type_traits>

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

// ---------------------------------------------------------------------------
// Camera lines (V0.1 board, see Board.h "Cameras")
// ---------------------------------------------------------------------------
//
// Every camera's `trigger` (-> camera Line3) and `strobe` (<- camera Line2,
// ExposureActive) is cabled, the center camera included, so all three are
// triggerable. Board::camera[i] is the camera of CameraMask bit (1 << i).
static_assert(Board::CAMERA_COUNT == 3, "Board::camera must list C, L, R");
static_assert(CAM_C == (1u << 0) && CAM_L == (1u << 1) && CAM_R == (1u << 2),
              "Board::camera index must equal the CameraMask bit position");
static constexpr uint8_t SUPPORTED_CAMERAS = CAM_C | CAM_L | CAM_R;
// Mask used when a request carries cameras == 0: the two foveal cameras, i.e.
// exactly the pre-V0.1 behavior. A host that wants C asks for it explicitly.
static constexpr uint8_t DEFAULT_CAMERAS = CAM_L | CAM_R;
static_assert((DEFAULT_CAMERAS & ~SUPPORTED_CAMERAS) == 0, "default mask");

// Strobe polarity. Board::STROBE_ACTIVE_LEVEL is the level `strobe` reads
// while the camera exposes; every edge decision below goes through
// strobeAsserted() and never compares against a literal HIGH/LOW. Throughout
// this file "rise" means the line becomes ASSERTED (exposure start) and
// "fall" means it becomes RELEASED (exposure finish), whatever the electrical
// polarity — flipping the Board constant is the whole polarity change.
static_assert(Board::STROBE_ACTIVE_LEVEL == HIGH ||
                  Board::STROBE_ACTIVE_LEVEL == LOW,
              "STROBE_ACTIVE_LEVEL must be HIGH or LOW");

// Pin-direction safety. The strobe pin reads camera Line2's open-drain
// output and must never be driven against it; the same goes for the unused
// opto pair. Board::Pin::write() already refuses to compile on a non-output
// Pin, so pinning the pin MODES here makes "nothing writes `strobe`/`opto_*`"
// a compile-time property — if someone re-types one of them as an output in
// Board.h, this file stops building.
namespace detail {
template <typename P> struct PinMode;
template <unsigned M, unsigned V> struct PinMode<Board::Pin<M, V>> {
  static constexpr unsigned value = M;
};
template <typename P>
constexpr bool isOutputPin() {
  using Mode = PinMode<typename std::remove_cv<P>::type>;
  return Mode::value == OUTPUT || Mode::value == OUTPUT_OPENDRAIN;
}
} // namespace detail
static_assert(detail::isOutputPin<decltype(Board::CameraPinout::trigger)>(),
              "camera trigger (Line3) must be an output");
static_assert(!detail::isOutputPin<decltype(Board::CameraPinout::strobe)>(),
              "camera strobe (Line2 open-drain input) must never be an output");
static_assert(
    !detail::isOutputPin<decltype(Board::CameraPinout::opto_trigger)>(),
    "unused opto trigger (Line0) must stay undriven");
static_assert(
    !detail::isOutputPin<decltype(Board::CameraPinout::opto_strobe)>(),
    "unused opto strobe (Line1) must stay undriven");

// True while camera `pin`'s strobe line reads its active (exposing) level.
// ISR-safe: a single fast port read. Normalised to HIGH/LOW before comparing
// so a raw masked port value can never be mistaken for a level.
static inline bool strobeAsserted(unsigned pin) {
  return (digitalReadFast(pin) ? HIGH : LOW) == Board::STROBE_ACTIVE_LEVEL;
}

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
// requested camera strobe-rises (line becomes asserted); only ever cleared
// by startNext() (main loop). Acts as the ISR→main-loop ordering guard for
// everything below it.
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
// exposureLeft/Right — the volatile strobeAssertedMask store is the release
// barrier. exposureFinishValid guards the average against a path with no fall.
// (Rise/fall = asserted/released, see strobeAsserted() above.)
static MirrorPosition exposureFinishLeft;
static MirrorPosition exposureFinishRight;
static bool exposureFinishValid = false;
// Bit set while the corresponding camera's strobe input is currently asserted
// (at Board::STROBE_ACTIVE_LEVEL).
static volatile uint8_t strobeAssertedMask = 0;
// Bit set once the corresponding camera has strobe-risen at least once this
// request — distinct from strobeAssertedMask (current level): without this, a
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

// Drives the trigger (camera Line3) of every camera in `cameras`. HIGH =
// asserted: the host programs TriggerActivation=LevelHigh in TriggerWidth
// exposure mode (the HIGH pulse IS the exposure), RisingEdge in the Timed
// fallback. Only ever touches `.trigger` — see the pin-direction asserts above.
static void writeTrigger(uint8_t cameras, uint8_t level) {
  for (unsigned i = 0; i < Board::CAMERA_COUNT; i++)
    if (cameras & (1u << i))
      Board::camera[i].trigger.write(level);
}

// Common strobe-edge handler for all cameras (attached on CHANGE); `bit`
// identifies the camera in CameraMask terms, `pin` is that camera's
// Board::camera strobe pin. Asserted -> exposure-start latch, released ->
// exposure-finish latch, per Board::STROBE_ACTIVE_LEVEL.
static inline void onStrobeEdge(uint8_t bit, unsigned pin) {
  if (strobeAsserted(pin)) {
    strobeAssertedMask |= bit;
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
    // camera's strobe FALL (line released). Written BEFORE clearing the level
    // bit so the volatile strobeAssertedMask store below is the release
    // barrier — once the main loop observes exposure-over, this finish
    // position is already written. Each requested fall overwrites, so the last one (exposure fully
    // over) wins; this is the 2-point average's finish endpoint.
    if (exposureLatched && (awaitingFallMask & bit)) {
      Streams::snapshot(exposureFinishLeft, exposureFinishRight);
      exposureFinishValid = true;
    }
    strobeAssertedMask &= ~bit;
  }
}

// One ISR per camera (attachInterrupt takes a plain function pointer).
template <unsigned I> static void onStrobe() {
  onStrobeEdge(static_cast<uint8_t>(1u << I), Board::camera[I].strobe.number);
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

// REJ reason for a strobe timeout. A requested strobe still reading ASSERTED
// at timeout means the line never returned to idle — the signature of a
// polarity mismatch (LineInverter=false makes the open-drain line idle LOW =
// "asserted" to this active-LOW firmware) or a camera holding Line2 low for
// another reason (LineSource not ExposureActive, or Line2 left as a 3.3 V
// output sink). Both strings start with "Strobe timeout" (host-matched).
static const char *strobeTimeoutReason(uint8_t cameras) {
  for (unsigned i = 0; i < Board::CAMERA_COUNT; i++)
    if ((cameras & (1u << i)) && strobeAsserted(Board::camera[i].strobe.number))
      return "Strobe timeout: line stuck at active level "
             "(check Line2 ExposureActive / LineInverter / STROBE_ACTIVE_LEVEL)";
  return "Strobe timeout";
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
  strobeAssertedMask &= static_cast<uint8_t>(~active.cameras); // stale level
  risenMask &= static_cast<uint8_t>(~active.cameras);          // stale rise
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
    cameras = DEFAULT_CAMERAS;
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
  // CHANGE on every camera's strobe: onStrobeEdge() reads the level and maps
  // it through STROBE_ACTIVE_LEVEL, so the attach mode is polarity-agnostic.
  attachInterrupt(Board::camera[0].strobe.number, onStrobe<0>, CHANGE); // C
  attachInterrupt(Board::camera[1].strobe.number, onStrobe<1>, CHANGE); // L
  attachInterrupt(Board::camera[2].strobe.number, onStrobe<2>, CHANGE); // R
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
    // Every requested camera must have both risen (risenMask) and been
    // released again (cleared from strobeAssertedMask) — requiring risenMask
    // too is what stops a camera that never strobes at all from producing a
    // silent "successful" FIN off the other camera's fall alone. risenMask is
    // compared under the request's mask: the ISRs record every camera's edges
    // (C free-running, or a camera left over from a previous request), and a
    // stray bit outside active.cameras must not block completion.
    bool exposureOver = exposureLatched &&
                        (risenMask & active.cameras) == active.cameras &&
                        (strobeAssertedMask & awaitingFallMask) == 0;
    bool timedOut =
        Global::time.now() - triggerStart > active.pulse + STROBE_MARGIN_US;
    if (exposureOver)
      finishActive(nullptr);
    else if (timedOut)
      finishActive(strobeTimeoutReason(active.cameras));
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
