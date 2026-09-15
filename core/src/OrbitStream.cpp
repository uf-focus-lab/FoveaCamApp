// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// NATIVE circular-scan ORBIT generator — the mirror-link scan on its own paced
// thread instead of the orchestrator's JS event loop (a synchronous camera
// write or an allocation on that loop used to stall the 1 ms pacer and hold the
// mirrors mid-revolution). Per eye:
//
//   v(t) = slew(center) + J · amp · (cos φ, sin φ)
//   φ   += 2π · hz · dt        (measured dt — continuous across hz/amp changes)
//
// JS pushes the LINEARIZATION (`setPose`: per-eye center volts + the 2×2
// volts-per-radian Jacobian of the angle→volt chain around the scan center) on
// every geometry change, and the orbit parameters (`setOrbit`) on scan
// start/stop. The emitted circle is therefore exact to FIRST ORDER in the
// offset; the session's `scan_path` telemetry remains the exact chain.
//
// Shape mirrors the compose brick: a `Stream<VoltPair::Ptr>` producer whose
// `volt_out` (tag "volts") pipes into the controller's native `pos_in`; the
// asyncIterator stays as the JS fallback consumer.
// spec: docs/spec/core-streams.md#orbit-stream

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <string>

#include <napi.h>

#include <Threading/Guard.h>

#include "CoreObject.h"
#include "Iterator.h" // Sub::Queue / Sub::Iterator (JS fallback consumer)
#include "PortPipe.h"
#include "ThreadMeter.h"
#include "VoltPair.h"
#include "napi-helper.h"
#include "utils/thread.h"

using namespace Napi;

// Shared full-schema meter serializer (defined in ConverterStream.cpp).
namespace Arv {
Napi::Value meterSnapshotToJs(Napi::Env env, const Meter::Snapshot &s);
}

// VoltPair → JS is defined ONCE, by the compose brick (ComposeStream.cpp);
// declared here so the fallback iterator links against it.
template <>
Napi::Value convert(Napi::Env env, const VoltPair::Ptr &v) noexcept;
template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const VoltPair::Ptr &v) noexcept;

static int64_t orbitNowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
      .count();
}

/** Pacer period: 1 kHz, the cadence the JS pacer targeted. */
static constexpr int64_t kTickNs = 1000000;
/** Center-slew time constant / convergence epsilon — the @lib/slew constants
 *  (SLEW_TAU_MS, SLEW_EPSILON_V), ported so idle behavior is unchanged. */
static constexpr double kSlewTauMs = 8.0;
static constexpr double kSlewEpsilonV = 0.005;
static constexpr double kTwoPi = 6.283185307179586;

// Guarded brick state: the NAPI thread writes the pose + orbit params, the
// brick thread advances the slewed center. Channel order is {lx, ly, rx, ry}.
struct OrbitState {
  std::array<double, 4> target{};  // latest pushed center (volts)
  std::array<double, 4> center{};  // slewed toward `target`
  std::array<double, 4> jL{};      // row-major 2×2, volts per radian
  std::array<double, 4> jR{};
  bool posed = false;              // false until the first setPose
  double ampRad = 0;
  double hz = 0;
  bool enabled = false;
  bool phaseReset = false;         // consumed by the brick thread on enable
};

class OrbitStream : public ::Stream<VoltPair::Ptr> {
public:
  using Ptr = std::shared_ptr<OrbitStream>;
  static Ptr create(std::string name) {
    return std::make_shared<OrbitStream>(std::move(name));
  }
  explicit OrbitStream(std::string name)
      : name_(name),
        meter_(std::move(name), {"pose", "orbit"}, {"volt"}, orbitNowMs()) {}
  ~OrbitStream() { close(); }

  const std::string &name() const { return name_; }

  /** NAPI thread: the new linearization. The FIRST pose lands on the center
   *  directly — a swoop from the origin would be a visible flick. */
  void setPose(const std::array<double, 4> &center,
               const std::array<double, 4> &jL,
               const std::array<double, 4> &jR) {
    {
      auto ref = state_.ref();
      ref->target = center;
      ref->jL = jL;
      ref->jR = jR;
      if (!ref->posed) {
        ref->center = center;
        ref->posed = true;
      }
    }
    meter_.ingest("pose", orbitNowMs());
  }

  /** NAPI thread: scan start/stop + live amplitude/frequency. Phase restarts
   *  at 0 on each disabled→enabled transition and otherwise ACCUMULATES, so a
   *  slider nudge never steps the ring. */
  void setOrbit(double ampRad, double hz, bool enabled) {
    {
      auto ref = state_.ref();
      if (enabled && !ref->enabled)
        ref->phaseReset = true;
      ref->ampRad = ampRad;
      ref->hz = hz;
      ref->enabled = enabled;
    }
    meter_.ingest("orbit", orbitNowMs());
  }

  Meter::Snapshot probe() const { return meter_.probe(orbitNowMs()); }

  /** Idempotent. Wakes the pacer and JOINS the thread before the stream ejects
   *  its subscribers (compose's close-first discipline). */
  void close() {
    if (closed_.exchange(true))
      return;
    {
      std::scoped_lock lock(sleepMutex_);
      closing_ = true;
    }
    sleepCv_.notify_all();
    shutdown();
  }

protected:
  void start() override { set_thread_name("orbit"); }
  void stop() override {}

  VoltPair::Ptr iterate() override {
    if (!pace())
      throw StopIteration();
    const auto now = std::chrono::steady_clock::now();
    const double dtMs =
        lastTickAt_.time_since_epoch().count() == 0
            ? kTickNs / 1e6
            : std::chrono::duration<double, std::milli>(now - lastTickAt_)
                  .count();
    lastTickAt_ = now;

    std::array<double, 4> center{}, jL{}, jR{};
    bool posed = false, enabled = false;
    double ampRad = 0, hz = 0;
    {
      auto ref = state_.ref();
      posed = ref->posed;
      if (ref->phaseReset) {
        phase_ = 0;
        ref->phaseReset = false;
      }
      slewCenter(*ref, dtMs);
      center = ref->center;
      jL = ref->jL;
      jR = ref->jR;
      ampRad = ref->ampRad;
      hz = ref->hz;
      enabled = ref->enabled;
    }
    if (!posed)
      return nullptr; // nothing commanded yet — the pace() sleep already idled

    double ox = 0, oy = 0;
    if (enabled) {
      phase_ = std::fmod(phase_ + kTwoPi * hz * (dtMs / 1000.0), kTwoPi);
      if (phase_ < 0)
        phase_ += kTwoPi;
      // The offset is EXACT — slewing it would lag the phase and shrink the ring.
      ox = ampRad * std::cos(phase_);
      oy = ampRad * std::sin(phase_);
    }
    const std::array<double, 4> v{
        center[0] + jL[0] * ox + jL[1] * oy,
        center[1] + jL[2] * ox + jL[3] * oy,
        center[2] + jR[0] * ox + jR[1] * oy,
        center[3] + jR[2] * ox + jR[3] * oy,
    };
    // Idle: emit only while the slew still moves the pose. The epsilon snap
    // makes a settled center bit-identical tick over tick, so the brick goes
    // quiet instead of re-pushing a pose the stream-update gate would dedupe.
    if (!enabled && emitted_ && v == lastEmitted_)
      return nullptr;
    lastEmitted_ = v;
    emitted_ = true;
    auto out = VoltPair::create();
    out->lx = v[0];
    out->ly = v[1];
    out->rx = v[2];
    out->ry = v[3];
    meter_.emit("volt", orbitNowMs());
    return out;
  }

private:
  /** Sleep out the tick on the steady clock. Returns false once `close()` has
   *  woken us — teardown never waits out a period. */
  bool pace() {
    const auto period = std::chrono::nanoseconds(kTickNs);
    const auto now = std::chrono::steady_clock::now();
    if (nextTickAt_.time_since_epoch().count() == 0 ||
        nextTickAt_ + period < now)
      nextTickAt_ = now + period; // first tick, or resync after a long stall
    else
      nextTickAt_ += period;
    std::unique_lock<std::mutex> lock(sleepMutex_);
    sleepCv_.wait_until(lock, nextTickAt_, [this] { return closing_; });
    return !closing_;
  }

  /** @lib/slew `slewStep` port: first-order approach with an epsilon SNAP. */
  static void slewCenter(OrbitState &st, double dtMs) {
    bool settled = true;
    for (int i = 0; i < 4; i++)
      settled =
          settled && std::abs(st.target[i] - st.center[i]) <= kSlewEpsilonV;
    if (settled) {
      st.center = st.target;
      return;
    }
    const double alpha = 1 - std::exp(-std::max(0.0, dtMs) / kSlewTauMs);
    for (int i = 0; i < 4; i++)
      st.center[i] += (st.target[i] - st.center[i]) * alpha;
  }

  const std::string name_;
  Meter::ThreadMeter meter_; // writer threads serialize per side (counters)
  Threading::Guard<OrbitState> state_;
  std::mutex sleepMutex_;
  std::condition_variable sleepCv_;
  bool closing_ = false;
  std::atomic<bool> closed_{false};
  // Brick thread only.
  std::chrono::steady_clock::time_point nextTickAt_{};
  std::chrono::steady_clock::time_point lastTickAt_{};
  double phase_ = 0;
  std::array<double, 4> lastEmitted_{};
  bool emitted_ = false;
};

// --- NAPI parse helpers -------------------------------------------------------
static void orbitParseCenter(const Napi::Value &l, const Napi::Value &r,
                             std::array<double, 4> &out) {
  if (!l.IsObject() || !r.IsObject())
    throw std::invalid_argument(
        "orbit setPose: `centerL` / `centerR` {x, y} required");
  auto lo = l.As<Napi::Object>();
  auto ro = r.As<Napi::Object>();
  out[0] = lo.Get("x").ToNumber().DoubleValue();
  out[1] = lo.Get("y").ToNumber().DoubleValue();
  out[2] = ro.Get("x").ToNumber().DoubleValue();
  out[3] = ro.Get("y").ToNumber().DoubleValue();
  for (double e : out)
    if (!std::isfinite(e))
      throw std::invalid_argument("orbit setPose: center volts must be finite");
}

static std::array<double, 4> orbitParseJ(const Napi::Value &v,
                                         const char *key) {
  if (!v.IsArray())
    throw std::invalid_argument(std::string("orbit setPose: `") + key +
                                "` must be a [4]-array (row-major 2x2)");
  auto a = v.As<Napi::Array>();
  if (a.Length() != 4)
    throw std::invalid_argument(std::string("orbit setPose: `") + key +
                                "` must have exactly 4 elements");
  std::array<double, 4> j{};
  for (uint32_t i = 0; i < 4; i++) {
    const double e = a.Get(i).ToNumber().DoubleValue();
    if (!std::isfinite(e))
      throw std::invalid_argument(std::string("orbit setPose: `") + key +
                                  "` must be finite");
    j[i] = e;
  }
  return j;
}

namespace Arv {

// =====================================================================
// OrbitObject — setPose / setOrbit / probe / volt_out / release /
// [asyncIterator]. Create-only (the factory below is the only constructor).
// =====================================================================
class OrbitObject : public CoreObject<OrbitObject, OrbitStream::Ptr> {
public:
  static inline const std::string name = "Orbit";
  static std::string describe(const OrbitObject *) { return "Orbit"; }
  // `release()` (and the env cleanup hook) drop the wrapper's stream ref, but a
  // live volt_out link pins the brick — stop the paced thread HERE so teardown
  // never leaves it running past the JS handle.
  static void destruct(OrbitObject *self) {
    if (self)
      self->core()->close();
  }

  static Napi::Function Init(Napi::Env env) {
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(OrbitObject, env),
            INSTANCE_METHOD(OrbitObject, setPose),
            INSTANCE_METHOD(OrbitObject, setOrbit),
            INSTANCE_METHOD(OrbitObject, probe),
            Napi::InstanceWrap<OrbitObject>::template InstanceAccessor<
                &OrbitObject::get_volt_out>("volt_out", napi_enumerable),
            // JS FALLBACK consumer (no v2 controller): the same async-generator
            // seam the compose brick offers.
            Napi::InstanceWrap<OrbitObject>::template InstanceMethod<
                &OrbitObject::asyncIterator>(asyncIterator),
        });
  }

  CORE_OBJECT_DECL(OrbitObject)

  OrbitObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  // setPose({ centerL: {x,y}, centerR: {x,y}, jL: [4], jR: [4] }).
  FN(setPose) {
    auto env = info.Env();
    try {
      JS_ASSERT(info[0].IsObject(), TypeError,
                "orbit setPose: params object required", env.Undefined());
      auto o = info[0].As<Napi::Object>();
      std::array<double, 4> center{};
      orbitParseCenter(o.Get("centerL"), o.Get("centerR"), center);
      core()->setPose(center, orbitParseJ(o.Get("jL"), "jL"),
                      orbitParseJ(o.Get("jR"), "jR"));
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  // setOrbit({ ampRad, hz, enabled }).
  FN(setOrbit) {
    auto env = info.Env();
    try {
      JS_ASSERT(info[0].IsObject(), TypeError,
                "orbit setOrbit: params object required", env.Undefined());
      auto o = info[0].As<Napi::Object>();
      const double amp = o.Get("ampRad").ToNumber().DoubleValue();
      const double hz = o.Get("hz").ToNumber().DoubleValue();
      JS_ASSERT(std::isfinite(amp) && std::isfinite(hz), TypeError,
                "orbit setOrbit: `ampRad` and `hz` must be finite",
                env.Undefined());
      core()->setOrbit(amp, hz, o.Get("enabled").ToBoolean().Value());
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(probe) {
    auto env = info.Env();
    try {
      return Arv::meterSnapshotToJs(env, core()->probe());
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(volt_out) {
    auto env = info.Env();
    try {
      if (voltOut_.IsEmpty()) {
        auto stream = core();
        auto port = PortPipe::makeOutPort<VoltPair::Ptr>(
            stream->name(), "volt", "volts", stream, stream.get());
        auto js = PortPipe::createOutPortJs(env, port);
        voltOut_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return voltOut_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(asyncIterator) {
    auto env = info.Env();
    try {
      auto stream = core().get();
      auto queue = Sub::Queue<VoltPair::Ptr>::create(stream);
      Napi::Value it =
          Sub::Iterator<Sub::Queue<VoltPair::Ptr>>::Create(env, queue);
      if (it.IsObject())
        it.As<Napi::Object>().Set("upstream", info.This());
      return it;
    }
    JS_EXCEPT(env.Undefined())
  }

private:
  Napi::ObjectReference voltOut_;
};

// Factory: createOrbitStream(name) — the graph node id doubles as the meter
// name (the compose/pair convention).
FN(createOrbitStream) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString(), TypeError,
              "createOrbitStream: name (string) required", env.Undefined());
    auto stream =
        OrbitStream::create(info[0].As<Napi::String>().Utf8Value());
    return OrbitObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

} // namespace Arv
