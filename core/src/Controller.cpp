// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <array>
#include <atomic>
#include <map>
#include <optional>

#include <napi.h>
#include <poll.h>
#include <stdexcept>
#include <sys/fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>
#include <vector>
#if defined(__APPLE__)
#include <util.h> // openpty (test-only __serialTestPty)
#else
#include <pty.h>
#endif

#include <Aravis/Camera.h>
#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <COBS/RX.h>
#include <COBS/TX.h>
#include <Protocol/Packet.h>
#include <Threading/Guard.h>
#include <convert.h>
#include <pointer.h>

#include "Cleanup.h"
#include "CoreObject.h" // MirrorSink CoreObject (native pos_in)
#include "Dispatcher.h"
#include "PortPipe.h"  // native pos_in sink
#include "VoltPair.h"  // the compose -> pos_in payload
#include "Protocol/Protocol.h"
#include "Protocol/Version.h"
#include "napi-helper.h"
#include "utils/debug.h"

using namespace Napi;

using SymbolRegistry = Isolated<Napi::Reference<Napi::Symbol>>;

static SymbolRegistry bufferAccessor;
static SymbolRegistry propNameAccessor;
// Cached decoders for CMD_FRAME's asymmetric ACK/FIN payloads (FrameAccepted
// / FrameResult), set once in Command::Init and used by DeviceObject::send
// to override the request-encoder factory when decoding responses.
static Isolated<Napi::Reference<Napi::Function>> frameAcceptedFactory;
static Isolated<Napi::Reference<Napi::Function>> frameResultFactory;

inline std::string hexFormat(const void *data, size_t size) {
  std::stringstream ss;
  const uint8_t *ptr = static_cast<const uint8_t *>(data);
  for (size_t i = 0; i < size; i++) {
    if (i != 0)
      ss << " ";
    ss << std::hex << std::uppercase << std::setfill('0') << std::setw(2)
       << static_cast<unsigned>(ptr[i]);
  }
  return ss.str();
}

inline std::string hexPreview(const void *data, size_t size,
                              size_t limit = 8) {
  return hexFormat(data, std::min(size, limit));
}

template <typename PendingMap>
inline std::string pendingSequences(const PendingMap &pending) {
  std::stringstream ss;
  ss << "[";
  bool first = true;
  for (const auto &[seq, _] : pending) {
    if (!first)
      ss << ",";
    first = false;
    ss << seq;
  }
  ss << "]";
  return ss.str();
}

static bool access(SymbolRegistry &registry, Napi::Value &value) {
  auto env = value.Env();
  auto accessor = registry.get(env).Value();
  if (value.IsObject() && value.As<Napi::Object>().Has(accessor)) {
    value = value.As<Napi::Object>().Get(accessor);
    return true;
  } else {
    return false;
  }
}

using Protocol::Method;
using Protocol::Property;

static Napi::Value getBuffer(Napi::Value value) {
  auto env = value.Env();
  auto accessor = bufferAccessor.get(env).Value();
  std::ignore = access(bufferAccessor, value);
  return value;
}

static Property getProperty(Napi::Value value) {
  auto env = value.Env();
  if (!access(propNameAccessor, value))
    throw JS::TypeError(env, "Packet missing [[PropertyName]] attribute");
  if (!value.IsString())
    throw JS::TypeError(env, "Attribute [[PropertyName]] must be a string");
  return convert<Property>(value.As<Napi::String>().Utf8Value());
}

template <Property P, FN(cb)>
Function factory(Napi::Env env, std::string name,
                 void cfg(Napi::Function &) = nullptr) {
  auto fn = Function::New(env, cb, "Packet[" + name + "]");
  if (cfg)
    cfg(fn);
  // Inject [[PropertyName]] property
  {
    auto symbol = propNameAccessor.get(env).Value();
    fn.DefineProperty(PropertyDescriptor::Value(
        symbol, String::New(env, convert<std::string>(P))));
  }
  fn.Freeze();
  return fn;
}

static inline Napi::Object inject(const Napi::CallbackInfo &info,
                                  Napi::Value value, const void *data,
                                  size_t size) {
  auto env = value.Env();
  napi_value obj;
  if (value.IsObject() && !value.IsNull()) {
    obj = value.As<Napi::Object>();
  } else {
    napi_coerce_to_object(env, value, &obj);
  }
  auto ret = Napi::Object(env, obj);
  auto buffer = Napi::ArrayBuffer::New(ret.Env(), size);
  std::memcpy(buffer.Data(), data, size);
  {
    // Inject [[Buffer]] property
    auto symbol = bufferAccessor.get(env).Value();
    ret.DefineProperty(PropertyDescriptor::Value(symbol, buffer));
  }
  ret.Freeze();
  return ret;
}

template <typename S>
inline Napi::Object inject(const Napi::CallbackInfo &info, Napi::Value value,
                           const S &data) {
  return inject(info, value, &data, sizeof(S));
}

#define EXPECT_EXACTLY_ONE_ARGUMENT(NAME)                                      \
  auto env = info.Env();                                                       \
  if (info.Length() != 1)                                                      \
    JS_THROW(TypeError, NAME " expects exactly one argument",                  \
             env.Undefined());                                                 \
  auto &arg = info[0];

static FN(BooleanPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Boolean>");
  uint8_t boolean;
  if (isBufferLike(arg)) {
    bufferView(arg) >> boolean;
  } else {
    boolean = arg.ToBoolean().Value() ? 1 : 0;
  }
  return inject(info, Boolean::New(env, boolean), boolean);
}

static FN(StringPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<String>");
  std::string str;
  if (arg.IsString()) {
    str = arg.As<Napi::String>().Utf8Value();
  } else if (isBufferLike(arg)) {
    auto buffer = bufferView<char>(arg);
    str = std::string(buffer.data, buffer.size);
  } else {
    JS_THROW(TypeError, "Argument must be a string or buffer like",
             env.Undefined());
  }
  return inject(info, String::New(env, str), str.data(), str.size());
}

template <typename E> static FN(EnumPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Enum>");
  E opt_value;
  std::string opt_name;
  if (arg.IsString()) {
    opt_name = arg.As<Napi::String>().Utf8Value();
    opt_value = convert<E>(opt_name);
  } else if (isBufferLike(arg)) {
    bufferView(arg) >> opt_value;
    opt_name = convert<std::string>(opt_value);
  } else {
    JS_THROW(TypeError, "Argument must be a string or buffer like",
             env.Undefined());
  }
  return inject(info, String::New(env, opt_name), opt_value);
}

static FN(Uint16Packet) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Uint16>");
  uint16_t value;
  if (arg.IsNumber()) {
    auto v = arg.As<Napi::Number>().Uint32Value();
    JS_ASSERT(v <= 0xFFFF, RangeError, "Number out of range for uint16 value",
              env.Undefined());
    value = static_cast<uint16_t>(v);
  } else if (isBufferLike(arg)) {
    bufferView(arg) >> value;
  } else {
    JS_THROW(TypeError, "Argument must be a string or buffer like",
             env.Undefined());
  }
  return inject(info, Number::New(env, value), value);
}

// uint32 payloads — Command::Trigger's wire shape is `Microseconds duration`
// (uint32, lib/Protocol/Packet.h:94/110). It MUST be registered through
// Uint32Packet, not Uint16: the firmware's exact-size FixedSizePacket::inflate
// REJects a mismatched-width payload, so a 2-byte encoding never actuates.
static FN(Uint32Packet) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Uint32>");
  uint32_t value;
  if (arg.IsNumber()) {
    const auto v = arg.As<Napi::Number>().DoubleValue();
    JS_ASSERT(v >= 0 && v <= 0xFFFFFFFF && v == std::floor(v), RangeError,
              "Number out of range for uint32 value", env.Undefined());
    value = static_cast<uint32_t>(v);
  } else if (isBufferLike(arg)) {
    bufferView(arg) >> value;
  } else {
    JS_THROW(TypeError, "Argument must be a number or buffer like",
             env.Undefined());
  }
  return inject(info, Number::New(env, value), value);
}

// uint64 payloads decode/encode as JS BigInt (a Number or BigInt is accepted
// on input — convert<uint64_t> handles both). Used by System::Timestamp: the
// MCU's µs clock is a wire uint64 that must round-trip losslessly, like
// FrameResult's t_trigger/t_exposure.
static FN(Uint64Packet) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Uint64>");
  uint64_t value;
  if (isBufferLike(arg)) {
    bufferView(arg) >> value;
  } else {
    try {
      value = convert<uint64_t>(arg);
    }
    JS_EXCEPT(env.Undefined())
  }
  return inject(info, convert(env, value), value);
}

template <typename T>
inline void propertyMap(Napi::Object const &obj, std::string key, T &val,
                        bool optional = true) {
  if (obj.Has(key)) {
    val = convert<T>(obj.Get(key));
  } else if (!optional) {
    throw JS::TypeError(obj.Env(), "Missing required property: " + key);
  }
}

namespace System {
static FN(VersionPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Version>");
  Packet::System::Version version;
  if (isBufferLike(arg)) {
    bufferView(arg) >> version;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "major", version.major, false);
      propertyMap(obj, "minor", version.minor, false);
      propertyMap(obj, "patch", version.patch, false);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("major", Number::New(env, version.major));
  object.Set("minor", Number::New(env, version.minor));
  object.Set("patch", Number::New(env, version.patch));
  return inject(info, object, version);
}

static void VersionPacketStaticProps(Napi::Function &fn) {
  fn.Set("major", Number::New(fn.Env(), Protocol::Version::Major));
  fn.Set("minor", Number::New(fn.Env(), Protocol::Version::Minor));
  fn.Set("patch", Number::New(fn.Env(), Protocol::Version::Patch));
}

static Napi::Object Init(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("Info",
          factory<Property::SYS_INFO, StringPacket>(env, "System::Info"));
  obj.Set("Version", factory<Property::SYS_VERSION, VersionPacket>(
                         env, "System::Version", VersionPacketStaticProps));
  obj.Set("Reset",
          factory<Property::SYS_RESET, EnumPacket<Packet::System::Reset::Type>>(
              env, "System::Reset"));
  obj.Set("Enable",
          factory<Property::SYS_ENABLE, BooleanPacket>(env, "System::Enable"));
  // Clock-calibration property (unified-time proposal, Rulings 4): GET reads
  // the MCU's parse-time-stamped uint64 µs clock as a BigInt; SET resets the
  // counter (payload = new counter value, normally 0n) and the ACK echoes the
  // fresh clock. Single-phase — request shape == response shape, so this one
  // factory decodes both directions.
  obj.Set("Timestamp", factory<Property::SYS_TIMESTAMP, Uint64Packet>(
                           env, "System::Timestamp"));
  obj.Freeze();
  return obj;
};
}; // namespace System

namespace Config {
static Napi::Object Init(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("Log",
          factory<Property::CFG_LOG, EnumPacket<Packet::Config::Log::Level>>(
              env, "Config::Log"));
  obj.Set("LPF", factory<Property::CFG_LPF, Uint16Packet>(env, "Config::LPF"));
  obj.Set("Bias",
          factory<Property::CFG_BIAS, Uint16Packet>(env, "Config::Bias"));
  obj.Freeze();
  return obj;
};
}; // namespace Config

namespace Command {

inline void assignMirrorPosition(Napi::Value const &val,
                                 Packet::Command::MirrorPosition &pos) {
  if (isBufferLike(val))
    bufferView(val) >> pos;
  else if (val.IsArray() && val.As<Napi::Array>().Length() <= 4) {
    const auto &arr = val.As<Napi::Array>();
    for (unsigned i = 0; i < 4; i++) {
      auto v = arr.Get(i);
      pos.ch[i] = convert<uint16_t>(v);
    }
  } else {
    throw JS::TypeError(
        val.Env(),
        "MirrorPosition must be an array of integers or buffer like");
  }
}

inline Napi::Array mirrorPositionToArray(
    Napi::Env env, const Packet::Command::MirrorPosition &pos) {
  auto arr = Napi::Array::New(env, 4);
  for (unsigned i = 0; i < 4; i++)
    arr.Set(i, Number::New(env, pos.ch[i]));
  return arr;
}

// CameraMask <-> JS: a number (raw bitmask) or an array of camera-name
// strings ("C"/"L"/"R"); undefined/omitted means "firmware default"
// (CAM_L | CAM_R — C is REJected until it has a strobe cable).
inline uint8_t parseCameraMask(Napi::Value const &val) {
  if (val.IsUndefined() || val.IsNull())
    return 0;
  if (val.IsNumber())
    return convert<uint8_t>(val);
  if (val.IsArray()) {
    uint8_t mask = 0;
    const auto &arr = val.As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      auto name = arr.Get(i).ToString().Utf8Value();
      if (name == "C")
        mask |= Packet::Command::CAM_C;
      else if (name == "L")
        mask |= Packet::Command::CAM_L;
      else if (name == "R")
        mask |= Packet::Command::CAM_R;
      else
        throw JS::TypeError(val.Env(), "Unknown camera name: " + name);
    }
    return mask;
  }
  throw JS::TypeError(val.Env(),
                      "cameras must be a number or array of camera names");
}

inline Napi::Array cameraMaskToArray(Napi::Env env, uint8_t mask) {
  auto arr = Napi::Array::New(env);
  uint32_t i = 0;
  if (mask & Packet::Command::CAM_C)
    arr.Set(i++, String::New(env, "C"));
  if (mask & Packet::Command::CAM_L)
    arr.Set(i++, String::New(env, "L"));
  if (mask & Packet::Command::CAM_R)
    arr.Set(i++, String::New(env, "R"));
  return arr;
}

static FN(ActuatePacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Actuate>");
  Packet::Command::Actuate command = {.settle_time = 0};
  if (isBufferLike(arg)) {
    bufferView(arg) >> command;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      assignMirrorPosition(obj.Get("left"), command.left);
      assignMirrorPosition(obj.Get("right"), command.right);
      if (obj.Has("settle_time"))
        command.settle_time =
            convert<Packet::Command::Microseconds>(obj.Get("settle_time"));
      if (obj.Has("complete_time"))
        command.complete_time =
            convert<Packet::Command::Microseconds>(obj.Get("complete_time"));
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("left", mirrorPositionToArray(env, command.left));
  object.Set("right", mirrorPositionToArray(env, command.right));
  object.Set("settle_time", Number::New(env, command.settle_time));
  object.Set("complete_time", Number::New(env, command.complete_time));
  return inject(info, object, command);
}

// CMD_STREAM: create/update/terminate a named mirror-position target.
// Single-phase (ACK echoes the same shape back, no FIN).
static FN(MirrorStreamPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<MirrorStream>");
  Packet::Command::MirrorStream command{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> command;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      std::string op_name;
      propertyMap(obj, "op", op_name, false);
      command.op = convert<Packet::Command::MirrorStream::Op>(op_name);
      propertyMap(obj, "id", command.id, false);
      if (obj.Has("left"))
        assignMirrorPosition(obj.Get("left"), command.left);
      if (obj.Has("right"))
        assignMirrorPosition(obj.Get("right"), command.right);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("op", String::New(env, convert<std::string>(command.op)));
  object.Set("id", Number::New(env, command.id));
  object.Set("left", mirrorPositionToArray(env, command.left));
  object.Set("right", mirrorPositionToArray(env, command.right));
  return inject(info, object, command);
}

// CMD_FRAME GET request payload (stream/cameras/pulse). Two-phase: ACK
// carries FrameAccepted, FIN carries FrameResult (both decoded via their own
// factories below, NOT this one — see DeviceObject::send).
static FN(FramePacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Frame>");
  Packet::Command::Frame command{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> command;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "stream", command.stream, false);
      command.cameras =
          obj.Has("cameras") ? parseCameraMask(obj.Get("cameras")) : 0;
      command.pulse =
          obj.Has("pulse")
              ? convert<Packet::Command::Microseconds>(obj.Get("pulse"))
              : 0;
      // v2.0 trigger settle hold (µs) — held only on a stream switch, MCU
      // side (Capture.cpp). Absent/0 reproduces the pre-v2.0 wire byte-for-
      // byte once both ends are rebuilt (mirrors ActuatePacket's settle_time).
      command.settle_time =
          obj.Has("settle_time")
              ? convert<Packet::Command::Microseconds>(obj.Get("settle_time"))
              : 0;
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("stream", Number::New(env, command.stream));
  object.Set("cameras", cameraMaskToArray(env, command.cameras));
  object.Set("pulse", Number::New(env, command.pulse));
  object.Set("settle_time", Number::New(env, command.settle_time));
  return inject(info, object, command);
}

// CMD_FRAME ACK payload: queue position (0 = about to start now).
static FN(FrameAcceptedPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<FrameAccepted>");
  Packet::Command::FrameAccepted result{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> result;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "queue_position", result.queue_position, false);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("queue_position", Number::New(env, result.queue_position));
  return inject(info, object, result);
}

// CMD_FRAME FIN payload: latched at exposure start. Timestamps are BigInt
// (uint64 µs, matching Global::time on the firmware side).
static FN(FrameResultPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<FrameResult>");
  Packet::Command::FrameResult result{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> result;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      propertyMap(obj, "stream", result.stream, false);
      propertyMap(obj, "frame_id", result.frame_id);
      if (obj.Has("t_trigger"))
        result.t_trigger =
            convert<Packet::Command::Timestamp>(obj.Get("t_trigger"));
      if (obj.Has("t_exposure"))
        result.t_exposure =
            convert<Packet::Command::Timestamp>(obj.Get("t_exposure"));
      if (obj.Has("left"))
        assignMirrorPosition(obj.Get("left"), result.left);
      if (obj.Has("right"))
        assignMirrorPosition(obj.Get("right"), result.right);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("stream", Number::New(env, result.stream));
  object.Set("frame_id", Number::New(env, result.frame_id));
  object.Set("t_trigger", convert(env, result.t_trigger));
  object.Set("t_exposure", convert(env, result.t_exposure));
  object.Set("left", mirrorPositionToArray(env, result.left));
  object.Set("right", mirrorPositionToArray(env, result.right));
  return inject(info, object, result);
}

// ---- v2.2.0: CMD_SCHEDULE / CMD_TRAJECTORY ---------------------------------
// spec: docs/spec/serial-protocol.md#schedule, #trajectory

// Reads `key` off `obj` by value (never a reference into a packed wire
// struct). Missing/undefined -> `fallback`, or a TypeError when required.
template <typename T>
inline T readField(const Napi::Object &obj, const char *key,
                   std::optional<T> fallback = std::nullopt) {
  if (obj.Has(key) && !obj.Get(key).IsUndefined())
    return convert<T>(obj.Get(key));
  if (fallback)
    return *fallback;
  throw JS::TypeError(obj.Env(),
                      std::string("Missing required property: ") + key);
}

inline Napi::Object frameResultToObject(
    Napi::Env env, const Packet::Command::FrameResult &result) {
  auto object = Napi::Object::New(env);
  object.Set("stream", Number::New(env, result.stream));
  object.Set("frame_id", Number::New(env, result.frame_id));
  object.Set("t_trigger", convert(env, result.t_trigger));
  object.Set("t_exposure", convert(env, result.t_exposure));
  object.Set("left", mirrorPositionToArray(env, result.left));
  object.Set("right", mirrorPositionToArray(env, result.right));
  return object;
}

// CMD_SCHEDULE: one timestamped keyframe on an existing stream. Single-phase
// (the ACK echoes the same shape). `t_apply` is MCU µs — pass a BigInt (a
// Number is truncated to 32 bits by convert<uint64_t>).
static FN(SchedulePacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Schedule>");
  using Packet::Command::Schedule;
  Schedule command{};
  if (isBufferLike(arg)) {
    bufferView(arg) >> command;
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      command.stream = readField<uint8_t>(obj, "stream");
      command.t_apply = readField<Packet::Command::Timestamp>(obj, "t_apply");
      uint8_t flags = readField<uint8_t>(obj, "flags", uint8_t(0));
      if (readField<bool>(obj, "interpolate", false))
        flags |= Schedule::INTERPOLATE;
      command.flags = flags;
      assignMirrorPosition(obj.Get("left"), command.left);
      assignMirrorPosition(obj.Get("right"), command.right);
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("stream", Number::New(env, command.stream));
  object.Set("flags", Number::New(env, command.flags));
  object.Set("interpolate", Napi::Boolean::New(
                                env, command.flags & Schedule::INTERPOLATE));
  object.Set("t_apply", convert(env, command.t_apply));
  object.Set("left", mirrorPositionToArray(env, command.left));
  object.Set("right", mirrorPositionToArray(env, command.right));
  return inject(info, object, command);
}

using TrajectoryOp = Packet::Command::Trajectory::Op;

inline const char *trajectoryOpName(uint8_t op) {
  switch (op) {
  case TrajectoryOp::BEGIN:
    return "BEGIN";
  case TrajectoryOp::DATA:
    return "DATA";
  case TrajectoryOp::MARK:
    return "MARK";
  case TrajectoryOp::COMMIT:
    return "COMMIT";
  case TrajectoryOp::START:
    return "START";
  case TrajectoryOp::STOP:
    return "STOP";
  case TrajectoryOp::DELETE:
    return "DELETE";
  default:
    return nullptr;
  }
}

inline uint8_t parseTrajectoryOp(Napi::Env env, const std::string &name) {
  for (uint8_t op = TrajectoryOp::BEGIN; op <= TrajectoryOp::DELETE; op++)
    if (name == trajectoryOpName(op))
      return op;
  throw JS::TypeError(env, "Unknown trajectory op: " + name);
}

template <typename T> inline void appendBytes(std::vector<uint8_t> &out,
                                              const T &value) {
  const auto *p = reinterpret_cast<const uint8_t *>(&value);
  out.insert(out.end(), p, p + sizeof(T));
}

// CMD_TRAJECTORY SET: op-tagged, variable size (see Packet.h). Encodes
//   {op:"BEGIN", id, sample_count, period, step?}
//   {op:"DATA", id, first_index, samples:[{t_offset, left, right}]}  (<= 12)
//   {op:"MARK", id, marker, t_offset, cameras?, pulse}  (no cameras = clear)
//   {op:"START", id, t_start? (BigInt MCU µs, 0n = now), cycles? (0 = forever)}
//   {op:"COMMIT"|"STOP"|"DELETE", id}
// and decodes the ACK echo (the op's fixed header; DATA without samples).
static FN(TrajectoryPacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<Trajectory>");
  namespace C = Packet::Command;
  std::vector<uint8_t> bytes;
  if (isBufferLike(arg)) {
    const auto view = bufferView(arg);
    bytes.assign(view.data, view.data + view.size);
    if (bytes.size() < sizeof(C::TrajectoryRef) ||
        C::Trajectory::headerSize(bytes[0]) == 0 ||
        bytes.size() < C::Trajectory::headerSize(bytes[0]))
      JS_THROW(TypeError, "Malformed Trajectory payload", env.Undefined());
  } else if (arg.IsObject() && !arg.IsNull()) {
    const auto &obj = arg.As<Napi::Object>();
    try {
      const uint8_t op =
          parseTrajectoryOp(env, readField<std::string>(obj, "op"));
      const uint8_t id = readField<uint8_t>(obj, "id");
      switch (op) {
      case TrajectoryOp::BEGIN: {
        C::TrajectoryBegin b{};
        b.op = op;
        b.id = id;
        b.sample_count = readField<uint16_t>(obj, "sample_count");
        b.period = readField<uint32_t>(obj, "period");
        uint8_t flags = readField<uint8_t>(obj, "flags", uint8_t(0));
        if (readField<bool>(obj, "step", false))
          flags |= C::Trajectory::STEP;
        b.flags = flags;
        appendBytes(bytes, b);
        break;
      }
      case TrajectoryOp::DATA: {
        if (!obj.Has("samples") || !obj.Get("samples").IsArray())
          throw JS::TypeError(env, "DATA requires a samples array");
        const auto arr = obj.Get("samples").As<Napi::Array>();
        if (arr.Length() == 0 || arr.Length() > C::Trajectory::CHUNK_SAMPLES)
          throw JS::TypeError(env, "DATA carries 1..12 samples per chunk");
        C::TrajectoryData d{};
        d.op = op;
        d.id = id;
        d.first_index = readField<uint16_t>(obj, "first_index");
        d.count = static_cast<uint8_t>(arr.Length());
        appendBytes(bytes, d);
        for (uint32_t i = 0; i < arr.Length(); i++) {
          const auto s = arr.Get(i);
          if (!s.IsObject())
            throw JS::TypeError(env, "DATA samples must be objects");
          const auto so = s.As<Napi::Object>();
          C::TrajectorySample sample{};
          sample.t_offset = readField<uint32_t>(so, "t_offset");
          assignMirrorPosition(so.Get("left"), sample.left);
          assignMirrorPosition(so.Get("right"), sample.right);
          appendBytes(bytes, sample);
        }
        break;
      }
      case TrajectoryOp::MARK: {
        C::TrajectoryMark m{};
        m.op = op;
        m.id = id;
        m.marker = readField<uint8_t>(obj, "marker");
        m.t_offset = readField<uint32_t>(obj, "t_offset", uint32_t(0));
        m.cameras =
            obj.Has("cameras") ? parseCameraMask(obj.Get("cameras")) : 0;
        m.pulse = readField<uint32_t>(obj, "pulse", uint32_t(0));
        appendBytes(bytes, m);
        break;
      }
      case TrajectoryOp::START: {
        C::TrajectoryStart st{};
        st.op = op;
        st.id = id;
        st.t_start = readField<C::Timestamp>(obj, "t_start", C::Timestamp(0));
        st.cycles = readField<uint32_t>(obj, "cycles", uint32_t(0));
        appendBytes(bytes, st);
        break;
      }
      default: { // COMMIT / STOP / DELETE
        C::TrajectoryRef r{};
        r.op = op;
        r.id = id;
        appendBytes(bytes, r);
        break;
      }
      }
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "Argument must be an object or buffer like",
             env.Undefined());
  }
  // Decode `bytes` back into the JS shape (both directions share it).
  auto object = Napi::Object::New(env);
  const uint8_t op = bytes[0];
  object.Set("op", String::New(env, trajectoryOpName(op)));
  object.Set("id", Number::New(env, bytes[1]));
  auto read = [&](auto &out) {
    std::memcpy(&out, bytes.data(), sizeof(out));
  };
  switch (op) {
  case TrajectoryOp::BEGIN: {
    C::TrajectoryBegin b;
    read(b);
    object.Set("sample_count", Number::New(env, b.sample_count));
    object.Set("period", Number::New(env, b.period));
    object.Set("flags", Number::New(env, b.flags));
    object.Set("step",
               Napi::Boolean::New(env, b.flags & C::Trajectory::STEP));
    break;
  }
  case TrajectoryOp::DATA: {
    C::TrajectoryData d;
    read(d);
    object.Set("first_index", Number::New(env, d.first_index));
    auto samples = Napi::Array::New(env);
    const size_t have =
        (bytes.size() - sizeof(d)) / sizeof(C::TrajectorySample);
    for (size_t i = 0; i < have && i < d.count; i++) {
      C::TrajectorySample s;
      std::memcpy(&s, bytes.data() + sizeof(d) + i * sizeof(s), sizeof(s));
      auto so = Napi::Object::New(env);
      so.Set("t_offset", Number::New(env, s.t_offset));
      so.Set("left", mirrorPositionToArray(env, s.left));
      so.Set("right", mirrorPositionToArray(env, s.right));
      samples.Set(static_cast<uint32_t>(i), so);
    }
    object.Set("count", Number::New(env, d.count));
    object.Set("samples", samples);
    break;
  }
  case TrajectoryOp::MARK: {
    C::TrajectoryMark m;
    read(m);
    object.Set("marker", Number::New(env, m.marker));
    object.Set("t_offset", Number::New(env, m.t_offset));
    object.Set("cameras", cameraMaskToArray(env, m.cameras));
    object.Set("pulse", Number::New(env, m.pulse));
    break;
  }
  case TrajectoryOp::START: {
    C::TrajectoryStart st;
    read(st);
    object.Set("t_start", convert(env, st.t_start));
    object.Set("cycles", Number::New(env, st.cycles));
    break;
  }
  default:
    break;
  }
  return inject(info, object, bytes.data(), bytes.size());
}

inline const char *trajectoryStatusName(uint8_t status) {
  using S = Packet::Command::TrajectoryFrame;
  switch (status) {
  case S::OK:
    return "OK";
  case S::STROBE_TIMEOUT:
    return "STROBE_TIMEOUT";
  case S::BUSY:
    return "BUSY";
  case S::CANCELLED:
    return "CANCELLED";
  case S::ENDED:
    return "ENDED";
  default:
    return "UNKNOWN";
  }
}

// SYN CMD_TRAJECTORY push payload (decode-only; register with
// Device.onPush(Protocol.Command.TrajectoryFrame, cb)). Timestamps are BigInt
// MCU µs; `marker` is null for the run-level ENDED / CANCELLED pushes.
static FN(TrajectoryFramePacket) {
  EXPECT_EXACTLY_ONE_ARGUMENT("Packet<TrajectoryFrame>");
  Packet::Command::TrajectoryFrame frame{};
  if (isBufferLike(arg)) {
    try {
      bufferView(arg) >> frame;
    }
    JS_EXCEPT(env.Undefined())
  } else {
    JS_THROW(TypeError, "TrajectoryFrame decodes a buffer like payload only",
             env.Undefined());
  }
  auto object = Napi::Object::New(env);
  object.Set("id", Number::New(env, frame.id));
  if (frame.marker == Packet::Command::TrajectoryFrame::NO_MARKER)
    object.Set("marker", env.Null());
  else
    object.Set("marker", Number::New(env, frame.marker));
  object.Set("cycle", Number::New(env, frame.cycle));
  object.Set("status", String::New(env, trajectoryStatusName(frame.status)));
  object.Set("result", frameResultToObject(env, frame.result));
  return inject(info, object, frame);
}

static Napi::Object Init(Napi::Env env) {
  auto obj = Napi::Object::New(env);
  obj.Set("Actuate", factory<Property::CMD_ACTUATE, ActuatePacket>(
                         env, "Command::Actuate"));
  obj.Set("Trigger", factory<Property::CMD_TRIGGER, Uint32Packet>(
                         env, "Command::Trigger"));
  obj.Set("MirrorStream", factory<Property::CMD_STREAM, MirrorStreamPacket>(
                              env, "Command::MirrorStream"));
  auto frame =
      factory<Property::CMD_FRAME, FramePacket>(env, "Command::Frame");
  auto frameAccepted = factory<Property::CMD_FRAME, FrameAcceptedPacket>(
      env, "Command::FrameAccepted");
  auto frameResult = factory<Property::CMD_FRAME, FrameResultPacket>(
      env, "Command::FrameResult");
  obj.Set("Frame", frame);
  obj.Set("FrameAccepted", frameAccepted);
  obj.Set("FrameResult", frameResult);
  // v2.2.0 (single-phase SETs; TrajectoryFrame is the SYN push decoder for
  // Device.onPush).
  obj.Set("Schedule", factory<Property::CMD_SCHEDULE, SchedulePacket>(
                          env, "Command::Schedule"));
  obj.Set("Trajectory", factory<Property::CMD_TRAJECTORY, TrajectoryPacket>(
                            env, "Command::Trajectory"));
  obj.Set("TrajectoryFrame",
          factory<Property::CMD_TRAJECTORY, TrajectoryFramePacket>(
              env, "Command::TrajectoryFrame"));
  // DeviceObject::send substitutes these for CMD_FRAME's ACK/FIN decode,
  // since (unlike Actuate/Trigger/MirrorStream) its response shapes differ
  // from the request shape.
  frameAcceptedFactory.get(env) = Napi::Persistent(frameAccepted);
  frameResultFactory.get(env) = Napi::Persistent(frameResult);
  obj.Freeze();
  return obj;
};
}; // namespace Command

// Protocol v2 two-phase properties: ACK resolves `.accepted`, FIN resolves
// the terminal value. Deliberately narrower than a blanket "everything
// but CMD_*" — CMD_STREAM is protocol-level single-phase (ACK/REJ only, no
// FIN ever sent); treating it as
// two-phase here would leave every CMD_STREAM request's pending-map entry
// stuck until the connection closes, since no FIN would ever arrive to erase
// it. Gated additionally per-device by `DeviceObject::v2_capable` —
// this only says which properties *could* be two-phase on v2 firmware, not
// whether *this* connection has confirmed it's talking to v2 firmware.
static inline bool isTwoPhase(Property p) {
  return p == Property::CMD_ACTUATE || p == Property::CMD_TRIGGER ||
        p == Property::CMD_FRAME;
}

class PendingRequest : public Shared<PendingRequest> {
public:
  const Napi::Env env;

private:
  bool accepted_settled = false;
  bool completed_settled = false;
  Dispatcher::Future completed_future = {env};
  // Only constructed for two-phase requests (see isTwoPhase) — never
  // resolving/rejecting an unused Future avoids both the extra uv uv_async
  // ref-count churn and (more importantly) an unhandled-rejection warning
  // for single-phase requests, which have no use for it.
  std::optional<Dispatcher::Future> accepted_future;

public:
  const uint16_t sequence;
  const Property property;
  const bool two_phase;
  // ACK-RTT sample (serial-rate-governor.md Part 1): send time (steady ns) +
  // a first-response latch (rx thread only — single reader thread).
  int64_t sentNs = 0;
  bool rttRecorded = false;
  // Decodes the ACK payload; for everything except CMD_FRAME this is the
  // same function as fin_factory (the request shape IS the response shape —
  // see Command::ActuatePacket/MirrorStreamPacket). CMD_FRAME's ACK
  // (FrameAccepted) and FIN (FrameResult) shapes differ, so DeviceObject::
  // send supplies two distinct factories for it.
  Napi::Reference<Napi::Function> ack_factory;
  Napi::Reference<Napi::Function> fin_factory;

  PendingRequest(Napi::Env env, uint16_t sequence, Property property,
                 bool two_phase,
                 Napi::Function ackFn, Napi::Function finFn)
      : env(env), sequence(sequence), property(property), two_phase(two_phase),
        ack_factory(Napi::Persistent(ackFn)),
        fin_factory(Napi::Persistent(finFn)) {
    if (two_phase)
      accepted_future.emplace(env);
  }

  ~PendingRequest() {
    try {
      auto timeout = [&] { return Napi::Error::New(env, "Request timeout").Value(); };
      if ((two_phase && !accepted_settled) || !completed_settled) {
        std::string unsettled;
        if (two_phase && !accepted_settled)
          unsettled = "accepted";
        if (!completed_settled) {
          if (!unsettled.empty())
            unsettled += "|";
          unsettled += "completed";
        }
        VERBOSE("trace drop seq=%u unsettled=%s", sequence,
                unsettled.c_str());
      }
      if (two_phase && !accepted_settled) {
        accepted_settled = true;
        accepted_future->Reject(timeout());
      }
      if (!completed_settled) {
        completed_settled = true;
        completed_future.Reject(timeout());
      }
    } catch (...) {
      // Allow silently fail during module cleanup
    }
  }

  // ACK: for single-phase properties this IS the terminal resolution
  // (matches the pre-v2 behavior exactly); for two-phase properties it only
  // resolves `.accepted` — the entry stays pending for FIN.
  inline void ResolveAck(Napi::Value value) {
    const char *phase = two_phase ? "accepted" : "completed";
    try {
      auto decoded =
          ack_factory.IsEmpty() ? value : ack_factory.Value().Call({value});
      if (two_phase) {
        accepted_future->Resolve(decoded);
        accepted_settled = true;
      } else {
        completed_future.Resolve(decoded);
        completed_settled = true;
      }
      VERBOSE("trace resolve seq=%u phase=%s ok", sequence, phase);
    } catch (const Napi::Error &e) {
      ERROR("trace resolve seq=%u phase=%s FAILED: %s", sequence, phase,
            e.Message().c_str());
      Reject(e.Value());
    } catch (const std::exception &e) {
      ERROR("trace resolve seq=%u phase=%s FAILED: %s", sequence, phase,
            e.what());
      Reject(Napi::Error::New(env, e.what()).Value());
    } catch (...) {
      ERROR("trace resolve seq=%u phase=%s FAILED: unknown error", sequence,
            phase);
      Reject(Napi::Error::New(env, "Unknown response decode/resolve error")
                 .Value());
    }
  }
  // FIN: only ever sent for two-phase properties.
  inline void ResolveFin(Napi::Value value) {
    try {
      auto decoded =
          fin_factory.IsEmpty() ? value : fin_factory.Value().Call({value});
      completed_future.Resolve(decoded);
      completed_settled = true;
      VERBOSE("trace resolve seq=%u phase=completed ok", sequence);
    } catch (const Napi::Error &e) {
      ERROR("trace resolve seq=%u phase=completed FAILED: %s", sequence,
            e.Message().c_str());
      Reject(e.Value());
    } catch (const std::exception &e) {
      ERROR("trace resolve seq=%u phase=completed FAILED: %s", sequence,
            e.what());
      Reject(Napi::Error::New(env, e.what()).Value());
    } catch (...) {
      ERROR("trace resolve seq=%u phase=completed FAILED: unknown error",
            sequence);
      Reject(Napi::Error::New(env, "Unknown response decode/resolve error")
                 .Value());
    }
  }
  // Rejects whichever phase(s) are still outstanding (REJ is terminal at
  // either phase).
  inline void Reject(Napi::Value reason) {
    if (two_phase && !accepted_settled) {
      accepted_settled = true;
      accepted_future->Reject(reason);
    }
    if (!completed_settled) {
      completed_settled = true;
      completed_future.Reject(reason);
    }
  }
  inline Napi::Promise CompletedPromise() { return completed_future.Promise(); }
  inline Napi::Promise AcceptedPromise() { return accepted_future->Promise(); }
};

extern int SerialOpen(const Napi::CallbackInfo &info) noexcept;

// Shared serial WRITE seam (native-compose-controller.md): the fd + ONE write
// mutex shared between the DeviceObject (NAPI thread: send / fireAndForget /
// destroy) and native mirror sinks (port-link delivery threads). Every
// ::write on the fd holds `mtx`, so frames from the two writers can never
// interleave. `open` flips false in DeviceObject::destroy BEFORE the fd
// closes — a sink write after disconnect is a counted no-op, never a race.
struct SerialWriteSeam : Shared<SerialWriteSeam> {
  explicit SerialWriteSeam(int fd) : fd(fd) {}
  const int fd;
  std::mutex mtx;
  std::atomic<bool> open{true};
  COBS::TX tx; // sink-side encoder (guarded by mtx; Device keeps its own)

  // ---- Part 1 pressure instrumentation (serial-rate-governor.md) ----------
  // EAGAIN / short-write events on the O_NONBLOCK fd — each is a discrete
  // overflow event (the governor's hard backoff signal).
  std::atomic<uint64_t> txSoftFail{0};
  std::atomic<uint32_t> outqHighWater{0};
  std::atomic<bool> outqSupported{true};
  // Fairness reserve: send times (steady ns) of the OLDEST and NEWEST pending
  // requests (0 = none) + count — maintained by DeviceObject's send/rx paths.
  // BOTH ends are tracked so a zombie entry (a request that never resolved —
  // the pending map is only swept on resolution) outside the defer window
  // can't mask a FRESH request inside it, and vice versa.
  std::atomic<int64_t> oldestPendingNs{0};
  std::atomic<int64_t> newestPendingNs{0};
  std::atomic<uint32_t> pendingCount{0};
  // Governor mirror (written by the active MirrorSink's evaluation, read by
  // Device.stats → controller telemetry → the profiler "Serial pressure"
  // block — every new stat here surfaces in the profiler).
  std::atomic<double> govEffectiveRateHz{0};
  std::atomic<double> govCeilingHz{0};
  std::atomic<int> govState{-1}; // -1 none/off, 0 steady, 1 seeking, 2 backoff

  // TEST overrides (core/test/46 — deterministic pressure scripting).
  std::atomic<int32_t> testOutqOverride{-1}; // <0 = disabled

  // ACK-RTT rolling window (rx thread writes; probes copy) + the connect-time
  // baseline (median of the first samples) the inflation gate compares against.
  static constexpr size_t kRttWindow = 128;
  static constexpr size_t kRttBaselineSamples = 8;
  std::mutex rttMtx;
  double rttRing[kRttWindow] = {};
  size_t rttHead = 0, rttCount = 0;
  double rttBaselineP50 = 0;
  std::vector<double> rttFirst;

  void recordRtt(double ms) {
    std::scoped_lock lk(rttMtx);
    rttRing[rttHead] = ms;
    rttHead = (rttHead + 1) % kRttWindow;
    if (rttCount < kRttWindow)
      rttCount++;
    if (rttBaselineP50 <= 0) {
      rttFirst.push_back(ms);
      if (rttFirst.size() >= kRttBaselineSamples) {
        auto v = rttFirst;
        std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
        rttBaselineP50 = v[v.size() / 2];
        rttFirst.clear();
        rttFirst.shrink_to_fit();
      }
    }
  }

  struct RttStats {
    double p50 = 0, p95 = 0, max = 0, baselineP50 = 0;
    uint64_t count = 0;
  };
  RttStats rttStats() {
    RttStats out;
    std::vector<double> v;
    {
      std::scoped_lock lk(rttMtx);
      out.count = rttCount;
      out.baselineP50 = rttBaselineP50;
      if (rttCount == 0)
        return out;
      v.assign(rttRing, rttRing + rttCount);
    }
    std::sort(v.begin(), v.end());
    out.p50 = v[v.size() / 2];
    out.p95 = v[std::min(v.size() - 1, (v.size() * 95) / 100)];
    out.max = v.back();
    return out;
  }

  /** Kernel tty output-queue depth (TIOCOUTQ — where CDC-ACM NAK
   *  backpressure materializes). Platform-guarded; degrades to 0 with
   *  `outqSupported=false` rather than failing. Test override wins. */
  int readOutq() {
    const int32_t t = testOutqOverride.load(std::memory_order_acquire);
    if (t >= 0) {
      noteOutq(static_cast<uint32_t>(t));
      return t;
    }
#ifdef TIOCOUTQ
    int q = 0;
    if (::ioctl(fd, TIOCOUTQ, &q) == 0) {
      noteOutq(static_cast<uint32_t>(q < 0 ? 0 : q));
      return q < 0 ? 0 : q;
    }
    outqSupported.store(false, std::memory_order_release);
#else
    outqSupported.store(false, std::memory_order_release);
#endif
    return 0;
  }
  void noteOutq(uint32_t q) {
    uint32_t hw = outqHighWater.load(std::memory_order_relaxed);
    while (q > hw &&
           !outqHighWater.compare_exchange_weak(hw, q, std::memory_order_relaxed))
      ;
  }

  // ---- framing-safe writes --------------------------------------------------
  // The fd is O_NONBLOCK: a PARTIAL ::write would leave a truncated COBS
  // frame on the wire — the next frame's bytes then concatenate into it and
  // BOTH are lost to the checksum (silent 2-packet corruption). Now every
  // writer goes through writeBytes(): a short write saves the unwritten
  // REMAINDER, and the next write attempt flushes that tail FIRST — the
  // in-flight frame always COMPLETES (framing integrity) before any new frame
  // starts; a frame that cannot even start (EAGAIN at byte 0 / stuck tail) is
  // dropped whole. Every EAGAIN/short-write bumps `txSoftFail`. Bounded,
  // non-blocking — never stalls a link delivery thread on drain.
  std::vector<uint8_t> tail_; // unwritten remainder of the last frame (mtx)

  /** Flush the pending tail (mtx held). True = tail empty. */
  bool flushTailLocked() {
    while (!tail_.empty()) {
      const ssize_t n = ::write(fd, tail_.data(), tail_.size());
      if (n <= 0)
        return false; // EAGAIN / error — retry on the next write attempt
      tail_.erase(tail_.begin(), tail_.begin() + n);
    }
    return true;
  }

  enum class WriteResult { Written, Queued, Dropped, Closed };

  /** Write one complete COBS frame. `Written` = fully on the wire; `Queued` =
   *  partially written, remainder tailed (WILL complete — framing intact);
   *  `Dropped` = frame never started (no corruption). (mtx taken here.) */
  WriteResult writeBytes(const uint8_t *data, size_t len) {
    std::scoped_lock lk(mtx);
    if (!open.load(std::memory_order_acquire))
      return WriteResult::Closed;
    if (!flushTailLocked()) {
      txSoftFail.fetch_add(1, std::memory_order_relaxed);
      return WriteResult::Dropped; // old frame still stuck — coalesce this one
    }
    const ssize_t n = ::write(fd, data, len);
    if (n == static_cast<ssize_t>(len))
      return WriteResult::Written;
    if (n <= 0) {
      txSoftFail.fetch_add(1, std::memory_order_relaxed);
      return WriteResult::Dropped; // frame never started — framing intact
    }
    // Partial: tail the remainder so the frame completes on the next attempt.
    tail_.assign(data + n, data + len);
    txSoftFail.fetch_add(1, std::memory_order_relaxed);
    return WriteResult::Queued;
  }

  // Encode + write one CMD_STREAM UPDATE (seq 0, fire-and-forget). Returns
  // false when the seam is closed or the frame was dropped (counted).
  bool writeMirrorUpdate(uint8_t id, const uint16_t chL[4],
                         const uint16_t chR[4]) {
    ::Packet::Command::MirrorStream cmd{};
    cmd.op = ::Packet::Command::MirrorStream::UPDATE;
    cmd.id = id;
    for (int i = 0; i < 4; i++) {
      cmd.left.ch[i] = chL[i];
      cmd.right.ch[i] = chR[i];
    }
    Protocol::RawPacket packet(Method::SET, Property::CMD_STREAM, 0);
    packet.setData(reinterpret_cast<const uint8_t *>(&cmd), sizeof(cmd));
    std::vector<uint8_t> frame;
    {
      std::scoped_lock lk(mtx);
      if (!open.load(std::memory_order_acquire))
        return false;
      if (!tx.encode(packet.finalize()))
        return false;
      frame.assign(tx.data(), tx.data() + tx.size());
    }
    const WriteResult r = writeBytes(frame.data(), frame.size());
    return r == WriteResult::Written || r == WriteResult::Queued;
  }

  void close() { open.store(false, std::memory_order_release); }
};

class DeviceObject : public ObjectWrap<DeviceObject> {
public:
  static Function Init(Napi::Env env) {
    return DefineClass(env, "Protocol",
                       {
                           INSTANCE_GETTER(DeviceObject, connected),     //
                           INSTANCE_GETTER(DeviceObject, v2Capable),     //
                           INSTANCE_GETTER(DeviceObject, stats),         //
                           INSTANCE_METHOD(DeviceObject, get),           //
                           INSTANCE_METHOD(DeviceObject, set),           //
                           INSTANCE_METHOD(DeviceObject, fireAndForget), //
                           INSTANCE_METHOD(DeviceObject, verifyVersion), //
                           INSTANCE_METHOD(DeviceObject, onPush),        //
                           INSTANCE_METHOD(DeviceObject, __testPressure), //
                           INSTANCE_METHOD(DeviceObject, release),       //
                       });
  }

  DeviceObject(const CallbackInfo &info)
      : ObjectWrap<DeviceObject>(info), env(info.Env()), fd(SerialOpen(info)),
        seam_(SerialWriteSeam::create(fd)), tx(), rx(),
        rx_thread(&DeviceObject::rxLoop, this) {}

  /** The shared write seam (fd + write mutex) native mirror sinks attach to. */
  SerialWriteSeam::Ptr writeSeam() const { return seam_; }

  static int64_t seamSteadyNs() {
    using namespace std::chrono;
    return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch())
        .count();
  }

  /** Recompute the fairness-reserve view of the pending map (oldest send time
   *  + count) into the seam atomics. Called after every pending add/retire —
   *  the map is tiny (in-flight requests), the scan is O(n). */
  void notePendingChanged() {
    auto p = pending.ref();
    int64_t oldest = 0, newest = 0;
    uint32_t n = 0;
    for (const auto &[seq, pr] : *p) {
      (void)seq;
      n++;
      if (pr->sentNs > 0 && (oldest == 0 || pr->sentNs < oldest))
        oldest = pr->sentNs;
      if (pr->sentNs > newest)
        newest = pr->sentNs;
    }
    seam_->pendingCount.store(n, std::memory_order_release);
    seam_->oldestPendingNs.store(oldest, std::memory_order_release);
    seam_->newestPendingNs.store(newest, std::memory_order_release);
  }

  ~DeviceObject() {
    Cleanup::remove(env, cleanup_hook);
    destroy();
  }

  void destroy() noexcept {
    if (flag_term)
      return;
    // Close the write seam FIRST: any native mirror sink still piped in stops
    // writing before the fd goes away (native-compose-controller.md — the
    // quiesce/disconnect invariant). Holding the mutex for our own disable
    // write below serializes against an in-flight sink write.
    seam_->close();
    if (fd >= 0) {
      // Write disable command
      Protocol::RawPacket packet(Method::SET, Property::SYS_ENABLE, 0);
      uint8_t enable = 0;
      packet.setData(&enable, sizeof(enable));
      std::scoped_lock lk(seam_->mtx);
      tx.encode(packet.finalize());
      ::write(fd, tx.data(), tx.size());
      // Wait a moment for the device to respond
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    flag_term = true;
    if (rx_thread.joinable())
      rx_thread.join();
    if (fd >= 0) {
      // Release exclusive access before closing (macOS/BSD)
#ifdef TIOCNXCL
      ioctl(fd, TIOCNXCL);
#endif
      ::close(fd);
    }
  }

private:
  const Napi::Env env;
  Cleanup::UID cleanup_hook =
      Cleanup::add(env, [this] { this->destroy(); }, "DeviceObject");
  bool flag_term = false;
  const int fd;
  const SerialWriteSeam::Ptr seam_; // shared write mutex (native sinks attach)
  COBS::TX tx;
  COBS::RX rx;
  Threading::Guard<Map<uint16_t, PendingRequest::Ptr>> pending;
  // v2.2.0: JS callbacks for non-LOG SYN pushes (e.g. CMD_TRAJECTORY
  // TrajectoryFrame), keyed by property and registered with onPush(). The
  // handler map is touched ONLY on the JS thread (onPush + the dispatched
  // delivery task); the rx thread only copies the shared pointer. Declared
  // before rx_thread so it exists before the first packet can arrive.
  struct PushRegistry : Shared<PushRegistry> {
    struct Handler {
      Napi::Reference<Napi::Function> decode;
      Napi::Reference<Napi::Function> callback;
    };
    std::map<uint8_t, Handler> handlers;
  };
  const PushRegistry::Ptr push_ = PushRegistry::create();
  std::thread rx_thread;
  struct {
    std::atomic<uint64_t> txBytes = 0;
    std::atomic<uint64_t> rxBytes = 0;
    std::atomic<uint64_t> txPackets = 0;
    std::atomic<uint64_t> rxPackets = 0;
  } counters;
  // Napi::FunctionReference __tx__;
  uint16_t __sequence__ = 0;
  inline uint16_t sequence() {
    if (__sequence__ == 0)
      __sequence__ = 1;
    return __sequence__++;
  }

  // Safe-by-default: stays
  // false — meaning every property, including CMD_ACTUATE/TRIGGER/FRAME,
  // resolves on ACK exactly like v1 firmware always behaved — until
  // verifyVersion() confirms firmware major >= Protocol::Version::Major.
  // Without this, a rebuilt (v2) host talking to old (v1) firmware would
  // hang forever awaiting a FIN the firmware never sends.
  bool v2_capable = false;

  GET(connected) { return Napi::Boolean::New(env, !flag_term); }
  GET(v2Capable) { return Napi::Boolean::New(env, v2_capable); }
  GET(stats) {
    auto obj = Napi::Object::New(env);
    obj.Set("txBytes", Napi::Number::New(env, counters.txBytes.load()));
    obj.Set("rxBytes", Napi::Number::New(env, counters.rxBytes.load()));
    obj.Set("txPackets", Napi::Number::New(env, counters.txPackets.load()));
    obj.Set("rxPackets", Napi::Number::New(env, counters.rxPackets.load()));
    // ---- Part 1 pressure block (serial-rate-governor.md; poll-on-read at
    // the caller's stats cadence — the controller session's probe) ----------
    obj.Set("outqBytes", Napi::Number::New(env, seam_->readOutq()));
    obj.Set("outqHighWater",
            Napi::Number::New(env, seam_->outqHighWater.load()));
    obj.Set("outqSupported",
            Napi::Boolean::New(env, seam_->outqSupported.load()));
    obj.Set("txSoftFail",
            Napi::Number::New(
                env, static_cast<double>(seam_->txSoftFail.load())));
    const auto rtt = seam_->rttStats();
    auto r = Napi::Object::New(env);
    r.Set("p50", Napi::Number::New(env, rtt.p50));
    r.Set("p95", Napi::Number::New(env, rtt.p95));
    r.Set("max", Napi::Number::New(env, rtt.max));
    r.Set("count", Napi::Number::New(env, static_cast<double>(rtt.count)));
    r.Set("baselineP50", Napi::Number::New(env, rtt.baselineP50));
    obj.Set("ackRttMs", r);
    // Governor mirror (the active MirrorSink evaluation publishes these —
    // state "off" = no governed sink attached / governor disabled).
    const int gs = seam_->govState.load(std::memory_order_acquire);
    auto g = Napi::Object::New(env);
    g.Set("effectiveRateHz",
          Napi::Number::New(env, seam_->govEffectiveRateHz.load()));
    g.Set("ceilingHz", Napi::Number::New(env, seam_->govCeilingHz.load()));
    g.Set("state", Napi::String::New(env, gs == 0   ? "steady"
                                          : gs == 1 ? "seeking"
                                          : gs == 2 ? "backoff"
                                                    : "off"));
    obj.Set("governor", g);
    return obj;
  }

  // TEST-ONLY (core/test/46): deterministic pressure scripting — force the
  // outq gauge, inject synthetic RTT samples, bump the soft-fail counter.
  FN(__testPressure) {
    try {
      auto o = info[0].As<Napi::Object>();
      if (o.Has("outq") && o.Get("outq").IsNumber())
        seam_->testOutqOverride.store(
            o.Get("outq").As<Napi::Number>().Int32Value(),
            std::memory_order_release);
      if (o.Has("rttMs") && o.Get("rttMs").IsNumber()) {
        const double ms = o.Get("rttMs").As<Napi::Number>().DoubleValue();
        const int n = o.Has("rttCount") && o.Get("rttCount").IsNumber()
                          ? o.Get("rttCount").As<Napi::Number>().Int32Value()
                          : 1;
        for (int i = 0; i < n; i++)
          seam_->recordRtt(ms);
      }
      if (o.Has("softFail") && o.Get("softFail").IsNumber())
        seam_->txSoftFail.fetch_add(
            static_cast<uint64_t>(
                o.Get("softFail").As<Napi::Number>().DoubleValue()),
            std::memory_order_relaxed);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  void recordTx(ssize_t bytes) {
    if (bytes <= 0)
      return;
    counters.txBytes.fetch_add(static_cast<uint64_t>(bytes));
    counters.txPackets.fetch_add(1);
  }

  inline void handleRawPacket(Protocol::RawPacket &&packet) noexcept {
    try {
      auto header = packet.validate();
      if (header == Protocol::INVALID)
        throw std::invalid_argument("Corrupted packet");
      counters.rxPackets.fetch_add(1);
      const auto method = Protocol::method(header);
      const auto property = Protocol::property(header);
      const auto &sequence = packet.header().sequence;
      VERBOSE("recv %s:%s (seq=%u) payload %zu bytes",
              convert<std::string>(method).c_str(),
              convert<std::string>(property).c_str(), sequence,
              packet.dataSize());
      auto p = pending.ref();
      if (p->has(sequence)) {
        auto pr = p->at(sequence);
        // Two-phase requests keep their pending-map entry across the ACK —
        // only FIN/REJ retire it (see PendingRequest::two_phase).
        bool retire = !(pr->two_phase && method == Method::ACK &&
                        property == pr->property);
        // ACK-RTT sample: the FIRST response for this request —
        // queue pressure inflates this before anything drops. rx thread only.
        if (!pr->rttRecorded && pr->sentNs > 0) {
          pr->rttRecorded = true;
          seam_->recordRtt(
              static_cast<double>(seamSteadyNs() - pr->sentNs) / 1e6);
        }
        VERBOSE("trace rx seq=%u %s:%s matched=1 retire=%d pending=%s",
                sequence, convert<std::string>(method).c_str(),
                convert<std::string>(property).c_str(), retire ? 1 : 0,
                pendingSequences(*p).c_str());
        Dispatcher::dispatch(env, [pr, method, property, sequence,
                                   packet = std::move(packet)](napi_env env) {
          auto payload = ArrayBuffer::New(env, packet.dataSize());
          std::memcpy(payload.Data(), packet.data(), packet.dataSize());
          const char *branch =
              method == Method::ACK && property == pr->property
                  ? "ack"
                  : method == Method::FIN && property == pr->property
                        ? "fin"
                        : method == Method::REJ ? "rej" : "unexpected";
          VERBOSE(
              "trace task seq=%u branch=%s two_phase=%d payload=%zu first8=%s",
              sequence, branch, pr->two_phase ? 1 : 0, packet.dataSize(),
              hexPreview(packet.data(), packet.dataSize()).c_str());
          try {
            if (method == Method::ACK && property == pr->property) {
              pr->ResolveAck(payload);
            } else if (method == Method::FIN && property == pr->property) {
              pr->ResolveFin(payload);
            } else if (method == Method::REJ) {
              // REJ packets always have a string payload
              auto reason =
                  std::string((char *)payload.Data(), payload.ByteLength());
              pr->Reject(Napi::Error::New(pr->env, reason).Value());
            } else {
              pr->Reject(
                  Napi::Error::New(pr->env,
                                   "Unexpected response " +
                                       convert<std::string>(method) + ":" +
                                       convert<std::string>(property))
                      .Value());
            }
          } catch (const Napi::Error &e) {
            ERROR("trace task seq=%u branch=%s FAILED: %s", sequence, branch,
                  e.Message().c_str());
            pr->Reject(e.Value());
          } catch (const std::exception &e) {
            ERROR("trace task seq=%u branch=%s FAILED: %s", sequence, branch,
                  e.what());
            pr->Reject(Napi::Error::New(pr->env, e.what()).Value());
          } catch (...) {
            ERROR("trace task seq=%u branch=%s FAILED: unknown error",
                  sequence, branch);
            pr->Reject(Napi::Error::New(pr->env, "Unknown response error")
                           .Value());
          }
        });
        if (retire) {
          p->erase(sequence);
          // Release the pending guard BEFORE the bookkeeping —
          // notePendingChanged() re-acquires the same non-recursive mutex;
          // calling it under `p` self-deadlocked the rx thread after the
          // first retired response (caught by the fw-sim harness, test 47:
          // every subsequent get()/set() then blocked the JS main thread).
          p.release();
          notePendingChanged(); // fairness reserve bookkeeping (Part 2)
        }
      } else if (method == Method::SYN && property == Property::LOG) {
        // Unsolicited log packet
        std::string log_msg((char *)packet.data(), packet.dataSize());
        __LOG__("%s", "PORT ", GREEN, "Device", log_msg.c_str());
      } else if (method == Method::SYN) {
        // v2.2.0: every other push (CMD_TRAJECTORY TrajectoryFrame, ...) is
        // delivered to the JS callback registered with onPush(factory, cb),
        // decoded by that factory on the JS thread. Unregistered pushes are
        // dropped (VERBOSE). The LOG branch above is unchanged.
        auto registry = push_;
        Dispatcher::dispatch(env, [registry, property,
                                   packet = std::move(packet)](napi_env env) {
          auto it = registry->handlers.find(static_cast<uint8_t>(property));
          if (it == registry->handlers.end() ||
              it->second.callback.IsEmpty()) {
            VERBOSE("drop unhandled push SYN:%s (%zu bytes)",
                    convert<std::string>(property).c_str(),
                    packet.dataSize());
            return;
          }
          try {
            auto payload = ArrayBuffer::New(env, packet.dataSize());
            std::memcpy(payload.Data(), packet.data(), packet.dataSize());
            auto decoded = it->second.decode.IsEmpty()
                               ? Napi::Value(payload)
                               : it->second.decode.Value().Call({payload});
            it->second.callback.Value().Call({decoded});
          } catch (const Napi::Error &e) {
            ERROR("push SYN:%s handler failed: %s",
                  convert<std::string>(property).c_str(),
                  e.Message().c_str());
          } catch (const std::exception &e) {
            ERROR("push SYN:%s handler failed: %s",
                  convert<std::string>(property).c_str(), e.what());
          }
        });
      } else if (sequence != 0) {
        VERBOSE("trace rx seq=%u %s:%s matched=0 retire=0 pending=%s",
                sequence, convert<std::string>(method).c_str(),
                convert<std::string>(property).c_str(),
                pendingSequences(*p).c_str());
        WARN("Unmatched packet %s:%s (seq=%u) %s",
             convert<std::string>(method).c_str(),
             convert<std::string>(property).c_str(), sequence,
             hexFormat(packet.data(), packet.dataSize()).c_str());
      }
    } catch (std::invalid_argument &e) {
      WARN("Bad rx data: %s", e.what());
    }
  }

  // rx poll cadence: bounds shutdown latency (destroy() joins within one
  // timeout) and paces the idle-tick work below. The fd is O_NONBLOCK — the
  // old read→EAGAIN→continue loop burned ~100% of a core whenever a
  // controller was connected.
  static constexpr int RX_POLL_TIMEOUT_MS = 50;
  // Pending-map sweep: entries whose response never came (device wedged /
  // unplugged mid-request) would otherwise pin their PendingRequest (+ JS
  // refs) forever. Every JS-side timeout (scheduler accepted/completion
  // timers, session guards) fires far below this, so a swept promise has
  // long been abandoned by its caller; rejecting matches the REJ path.
  static constexpr int64_t PENDING_SWEEP_TTL_NS = 30ll * 1000 * 1000 * 1000;
  static constexpr int64_t PENDING_SWEEP_PERIOD_NS = 1ll * 1000 * 1000 * 1000;
  int64_t lastSweepNs_ = 0; // rx thread only

  /** Reject + erase pending entries older than the TTL. Runs on the rx
   *  thread's idle (poll-timeout) tick, at most once per sweep period. The
   *  guard is NEVER held across notePendingChanged()/Dispatcher (the b5b1f30
   *  retire-deadlock rule); rejection is dispatched to the JS thread so the
   *  PendingRequest's futures (and destructor) only ever settle there. */
  void sweepPending() {
    const int64_t now = seamSteadyNs();
    if (now - lastSweepNs_ < PENDING_SWEEP_PERIOD_NS)
      return;
    lastSweepNs_ = now;
    std::vector<PendingRequest::Ptr> expired;
    {
      auto p = pending.ref();
      for (auto it = p->begin(); it != p->end();) {
        const auto &pr = it->second;
        if (pr->sentNs > 0 && now - pr->sentNs > PENDING_SWEEP_TTL_NS) {
          expired.push_back(pr);
          it = p->erase(it);
        } else {
          ++it;
        }
      }
    }
    if (expired.empty())
      return;
    notePendingChanged();
    for (auto &pr : expired) {
      WARN("Sweeping pending request seq=%u (%s) — no response in 30 s",
           pr->sequence, convert<std::string>(pr->property).c_str());
      Dispatcher::dispatch(env, [pr](napi_env) {
        pr->Reject(
            Napi::Error::New(pr->env, "Request timeout (no device response)")
                .Value());
      });
    }
  }

  void rxLoop() {
    VERBOSE("Device::rxLoop started for fd %d", fd);
    std::array<char, 256> bytes;
    while (!flag_term) {
      // Sleep in poll(2) until bytes (or error/hangup) arrive — the loop no
      // longer spins on the O_NONBLOCK fd. A timeout wake doubles as the
      // idle tick for the pending-map sweep.
      pollfd pfd{fd, POLLIN, 0};
      const int ready = ::poll(&pfd, 1, RX_POLL_TIMEOUT_MS);
      if (flag_term)
        break;
      if (ready == 0) {
        sweepPending();
        continue;
      }
      if (ready < 0) {
        if (errno == EINTR)
          continue;
        ERROR("poll on serial port failed: %s", std::strerror(errno));
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        continue;
      }
      auto count = ::read(fd, bytes.data(), bytes.size());
      if (count < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
          continue; // raced the poll wake — just poll again
        ERROR("Failed to read from serial port: %s", std::strerror(errno));
        // Persistent error (EIO on unplug, …): don't spin/spam — the poll
        // above returns immediately on POLLERR/POLLHUP, so pace the retries.
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        continue;
      } else if (count == 0) {
        std::this_thread::yield();
        continue;
      }
      counters.rxBytes.fetch_add(static_cast<uint64_t>(count));
      VERBOSE("Device::recv() %u buffered bytes + chunk %zd bytes", rx.len(),
              count);
      for (ssize_t i = 0; i < count; i++) {
        const auto byte = bytes[static_cast<size_t>(i)];
        VERBOSE("Device::recv() %u bytes + incoming 0x%s", rx.len(),
                hexFormat(&byte, 1).c_str());
        if (rx.recv(byte))
          handleRawPacket(Protocol::RawPacket(rx.get()));
      }
    }
  }

  Napi::Value send(uint16_t sequence, Property property,
                   const Napi::Function &factory, Protocol::RawPacket &packet) {
    try {
      if (tx.encode(packet.finalize())) {
        // CMD_FRAME's ACK (FrameAccepted) and FIN (FrameResult) payloads
        // differ in shape from each other and from the request `factory`
        // (Command::Frame) — substitute the dedicated decoders cached by
        // Command::Init. Every other property's ACK/FIN (if any) echoes the
        // request shape, so `factory` decodes both.
        auto ackFactory = factory;
        auto finFactory = factory;
        if (property == Property::CMD_FRAME) {
          ackFactory = frameAcceptedFactory.get(env).Value();
          finFactory = frameResultFactory.get(env).Value();
        }
        // Register the pending request before writing. V2 firmware can ACK+FIN
        // a zero-settle ACTUATE quickly enough that a write-first order drops
        // the response as "unmatched" on the rx thread.
        bool two_phase = isTwoPhase(property) && v2_capable;
        auto pr = PendingRequest::create(env, sequence, property, two_phase,
                                         ackFactory, finFactory);
        auto completed = pr->CompletedPromise();
        if (pr->two_phase) {
          auto accepted = pr->AcceptedPromise();
          // Attach a no-op catch so an app that only awaits the returned
          // (completed) promise — never touching `.accepted` — doesn't
          // trigger an unhandled-rejection warning if the request REJects
          // at the ACK phase (both promises reject in that case, see
          // PendingRequest::Reject). The caller can still attach its own
          // handler(s) to the same `.accepted` promise independently.
          auto noop = Napi::Function::New(
              env, [](const Napi::CallbackInfo &) { return; });
          accepted.Get("catch").As<Napi::Function>().Call(accepted, {noop});
          completed.Set("accepted", accepted);
        }
        pr->sentNs = seamSteadyNs(); // ACK-RTT sample start (Part 1)
        pending.ref()->set(sequence, pr);
        notePendingChanged(); // fairness reserve bookkeeping (Part 2)
        VERBOSE("trace tx seq=%u %s:%s two_phase=%d v2_capable=%d bytes=%u",
                sequence,
                convert<std::string>(Protocol::method(packet.header().header))
                    .c_str(),
                convert<std::string>(property).c_str(), two_phase ? 1 : 0,
                v2_capable ? 1 : 0, tx.size());
        VERBOSE("send %u bytes: %s", tx.size(),
                hexFormat(tx.data(), tx.size()).c_str());
        // Framing-safe seam write: a short write TAILS the remainder (the
        // frame still completes — keep the request pending); a frame that
        // never started is a clean drop → throws to the caller.
        const auto wr = seam_->writeBytes(tx.data(), tx.size());
        if (wr == SerialWriteSeam::WriteResult::Dropped ||
            wr == SerialWriteSeam::WriteResult::Closed) {
          pending.ref()->erase(sequence);
          notePendingChanged();
          JS_THROW(Error,
                   "Failed to write to serial port: " +
                       std::string(std::strerror(errno)),
                   env.Undefined());
        }
        recordTx(static_cast<ssize_t>(tx.size()));
        return completed;
      } else {
        throw JS::Error(env, "Failed to encode packet");
      }
    }
    JS_EXCEPT(env.Null())
  }

  FN(get) {
    auto env = info.Env();
    if (info.Length() < 1)
      JS_THROW(TypeError, "Device::get expects at least one argument",
               env.Undefined());
    const auto &factory = info[0].As<Napi::Function>();
    const auto property = getProperty(factory);
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::GET, property, sequence);
    if (info.Length() > 1) {
      // Most GETs are payload-less reads; CMD_FRAME's GET is a request
      // carrying {stream, cameras, pulse} — same optional-payload shape as
      // set() below.
      auto buffer = getBuffer(factory.Call({info[1]}));
      if (!isBufferLike(buffer))
        JS_THROW(TypeError,
                 "Packet factory must return an array buffer like object",
                 env.Undefined());
      packet.setData(bufferView(buffer));
    }
    return send(sequence, property, factory, packet);
  }

  FN(set) {
    auto env = info.Env();
    if (info.Length() < 1)
      JS_THROW(TypeError, "Device::set expects at least one argument",
               env.Undefined());
    const auto &factory = info[0].As<Napi::Function>();
    const auto property = getProperty(factory);
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::SET, property, sequence);
    if (info.Length() > 1) {
      auto buffer = getBuffer(factory.Call({info[1]}));
      if (!isBufferLike(buffer))
        JS_THROW(TypeError,
                 "Packet factory must return an array buffer like object",
                 env.Undefined());
      packet.setData(bufferView(buffer));
    }
    return send(sequence, property, factory, packet);
  }

  // Protocol::Sequence == 0 fire-and-forget: the firmware performs the SET but
  // sends no ACK/FIN/REJ at all —
  // used for high-rate stream position updates (CMD_STREAM UPDATE, ~1kHz).
  // No pending-map entry, no promise; a write failure throws synchronously.
  FN(fireAndForget) {
    auto env = info.Env();
    if (info.Length() < 1)
      JS_THROW(TypeError, "Device::fireAndForget expects at least one argument",
               env.Undefined());
    const auto &factory = info[0].As<Napi::Function>();
    const auto property = getProperty(factory);
    Protocol::RawPacket packet(Method::SET, property, 0);
    if (info.Length() > 1) {
      auto buffer = getBuffer(factory.Call({info[1]}));
      if (!isBufferLike(buffer))
        JS_THROW(TypeError,
                 "Packet factory must return an array buffer like object",
                 env.Undefined());
      packet.setData(bufferView(buffer));
    }
    try {
      if (!tx.encode(packet.finalize()))
        throw JS::Error(env, "Failed to encode packet");
      VERBOSE("trace tx seq=0 SET:%s two_phase=0 v2_capable=%d bytes=%u",
              convert<std::string>(property).c_str(), v2_capable ? 1 : 0,
              tx.size());
      // Framing-safe seam write: Dropped = the frame never
      // started (framing intact) → throws; Queued = tailed,
      // completes on the next write attempt (fire-and-forget: success).
      const auto wr = seam_->writeBytes(tx.data(), tx.size());
      if (wr == SerialWriteSeam::WriteResult::Dropped ||
          wr == SerialWriteSeam::WriteResult::Closed)
        JS_THROW(Error,
                 "Failed to write to serial port: " +
                     std::string(std::strerror(errno)),
                 env.Undefined());
      recordTx(static_cast<ssize_t>(tx.size()));
    }
    JS_EXCEPT(env.Undefined())
    return env.Undefined();
  }

  // Fetches SYS_VERSION and
  // sets v2_capable = (firmware.major >= Protocol::Version::Major). Until
  // this resolves (or if it's never called), v2_capable stays false and
  // every property behaves single-phase — safe against v1 firmware, just
  // not two-phase-accurate against v2 firmware. Returns the decoded version
  // plus the `compatible` verdict; never rejects on a *version mismatch*
  // (only on a transport/REJ failure), a "recommended"-style fallback over an
  // outright refusal.
  FN(verifyVersion) {
    auto env = info.Env();
    const auto sequence = this->sequence();
    Protocol::RawPacket packet(Method::GET, Property::SYS_VERSION, sequence);
    // Identity decoder: read the raw ACK payload as Packet::System::Version
    // directly below, no need to round-trip through the JS-facing
    // Protocol.System.Version factory for an internal-only check.
    auto identity = Napi::Function::New(
        env, [](const Napi::CallbackInfo &info) -> Napi::Value {
          return info[0];
        });
    auto value = send(sequence, Property::SYS_VERSION, identity, packet);
    if (!value.IsPromise())
      return value; // send() already threw/returned null on failure
    auto self = this;
    auto onFulfilled = Napi::Function::New(
        env, [self](const Napi::CallbackInfo &info) -> Napi::Value {
          auto env = info.Env();
          auto buffer = info[0].As<Napi::ArrayBuffer>();
          if (buffer.ByteLength() < sizeof(Packet::System::Version))
            throw JS::Error(env, "Malformed System::Version response");
          auto version = *reinterpret_cast<const Packet::System::Version *>(
              buffer.Data());
          bool compatible = version.major >= Protocol::Version::Major;
          self->v2_capable = compatible;
          auto result = Napi::Object::New(env);
          result.Set("major", Napi::Number::New(env, version.major));
          result.Set("minor", Napi::Number::New(env, version.minor));
          result.Set("patch", Napi::Number::New(env, version.patch));
          result.Set("compatible", Napi::Boolean::New(env, compatible));
          return result;
        });
    auto promise = value.As<Napi::Promise>();
    return promise.Get("then").As<Napi::Function>().Call(promise,
                                                          {onFulfilled});
  }

  // v2.2.0: onPush(factory, callback | null) — subscribe to the MCU's
  // unsolicited SYN pushes for factory's property (e.g.
  // Protocol.Command.TrajectoryFrame -> SYN CMD_TRAJECTORY). Each push's
  // payload is decoded with `factory` and passed to `callback` on the JS
  // thread. One callback per property (a later call replaces it); null or
  // undefined unsubscribes. LOG stays native (logged by the rx thread).
  FN(onPush) {
    auto env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction())
      JS_THROW(TypeError, "Device::onPush expects (factory, callback | null)",
               env.Undefined());
    const auto factory = info[0].As<Napi::Function>();
    Property property;
    try {
      property = getProperty(factory);
    }
    JS_EXCEPT(env.Undefined())
    if (property == Property::LOG)
      JS_THROW(TypeError, "LOG pushes are handled natively",
               env.Undefined());
    const auto key = static_cast<uint8_t>(property);
    if (info.Length() < 2 || info[1].IsNull() || info[1].IsUndefined()) {
      push_->handlers.erase(key);
      return env.Undefined();
    }
    if (!info[1].IsFunction())
      JS_THROW(TypeError, "Device::onPush callback must be a function or null",
               env.Undefined());
    auto &handler = push_->handlers[key];
    handler.decode = Napi::Persistent(factory);
    handler.callback = Napi::Persistent(info[1].As<Napi::Function>());
    return env.Undefined();
  }

  FN(release) {
    destroy();
    return env.Undefined();
  }
};


// =====================================================================
// Native mirror POSITION SINK: the controller's `pos_in` port. Accepts FINAL
// volts off a port link's
// delivery thread and performs, natively, exactly what the JS
// StreamHandle.update path did: the stream-update GATE (1 ms min interval +
// dedupe on the input volts), volt→DAC conversion (the @lib/controller-codec
// `channels()` math, ported verbatim), and the CMD_STREAM UPDATE
// fire-and-forget write through the shared SerialWriteSeam. Each ACCEPTED
// write also records the PREDICTED volts (the same DAC round-trip
// `predictVolts` applies) into a fixed-size history ring — the native
// mirror-history for natively-driven inputs, with `mirrorAt`-parity
// interpolation (historyAt) + latest/range queries for JS consumers
// (homography feeder, volt telemetry).
//
// Stream lifecycle stays JS: the session/controller-node CREATEs the MCU
// stream (ACK-backed) and TERMINATEs it on close/unbind — this sink only
// fires UPDATEs, so the quiesce order holds identically. A closed
// seam (device destroyed / disconnected) turns writes into counted no-ops.
// =====================================================================

namespace MirrorSinkMath {
// @lib/controller-codec ports — keep byte-for-byte with the JS reference
// (JS `|0` truncates toward zero; inputs are clamped non-negative first).
inline uint16_t volt2dac(double volt) {
  double d = 65535.0 * volt / 200.0;
  if (d < 0)
    d = 0;
  if (d > 65535)
    d = 65535;
  return static_cast<uint16_t>(d);
}
inline double dac2volt(double dac) { return 200.0 * dac / 65535.0; }
inline void chPair(double volt, double bias, double dv, uint16_t out[2]) {
  double v = volt / 2.0;
  if (v < -dv)
    v = -dv;
  if (v > dv)
    v = dv;
  out[0] = volt2dac(bias + v);
  out[1] = volt2dac(bias - v);
}
// channels(pos, bias, dv) — NOTE the JS passes dv/2 into each pair.
inline void channels(double x, double y, double bias, double dv,
                     uint16_t out[4]) {
  chPair(x, bias, dv / 2.0, out);
  chPair(y, bias, dv / 2.0, out + 2);
}
} // namespace MirrorSinkMath

static int64_t sinkSteadyNs() {
  using namespace std::chrono;
  return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch())
      .count();
}

// AIMD governor knobs. All NAPI-settable via
// MirrorSink.setGovernor; `enabled: false` pins the fixed-gate behavior
// exactly.
struct GovernorParams {
  bool enabled = true;
  double ceilingHz = 1000; // = the fixed 1 ms gate; session sets the
                           // prediction_rate_hz REQUESTED rate here
  double floorHz = 60;
  double stepHz = 25;       // additive climb per evaluation
  int64_t evalMs = 100;     // control-loop cadence (orders slower than emit)
  uint32_t outqLow = 256;   // bytes — climb only while under this
  uint32_t outqHigh = 1024; // bytes — backoff above this
  double rttInflation = 2.0; // p95 gate vs the connect-time baseline
  int64_t fairnessMs = 5;    // defer UPDATEs behind a pending request this old
  int64_t maxDeferMs = 100;  // deferral cap (a timed-out request can't starve)
};

struct MirrorSink : Shared<MirrorSink> {
  static constexpr int64_t kMinIntervalNs = 1'000'000; // 1 ms (JS gate parity)
  static constexpr size_t kHistoryCapacity = 4096;     // ≈4 s at the 1 kHz cap

  SerialWriteSeam::Ptr seam;
  uint8_t streamId = 0;
  double bias = 90.0, dv = 170.0;
  std::string nodeId;
  PortPipe::InPort::Ptr port; // pos_in (created lazily by the NAPI accessor)

  // Counters (plain atomics — probed out-of-loop, never gate the write path).
  std::atomic<uint64_t> received{0}; // items off the link
  std::atomic<uint64_t> written{0};  // UPDATEs actually written
  std::atomic<uint64_t> deduped{0};  // gate: same pose
  std::atomic<uint64_t> throttled{0}; // gate: min-interval / governor rate
  std::atomic<uint64_t> errors{0};   // seam closed / write failure
  std::atomic<uint64_t> deferred{0}; // fairness reserve deferrals
  std::atomic<uint64_t> backoffs{0}; // governor multiplicative decreases

  // ---- AIMD governor (lives HERE, in the emission gate) ---------------------
  // `effRateHz_` starts AT the ceiling (optimistic start): a clean link is
  // byte-identical to the fixed-gate behavior from the first tick; the additive
  // climb engages only after a backoff. Guarded by `mtx` (evaluated lazily on
  // the write path at `evalMs` cadence — a lock-free-ish emission: one branch +
  // rare O(window) percentile copy every ~100 ms).
  GovernorParams gov;             // mtx
  double effRateHz_ = 1000;       // mtx
  int govState_ = -1;             // -1 off, 0 steady, 1 seeking, 2 backoff (mtx)
  int64_t lastEvalNs_ = 0;        // mtx
  uint64_t lastSoftFail_ = 0;     // mtx — delta detection per evaluation

  void setGovernor(const GovernorParams &p) {
    std::scoped_lock lk(mtx);
    gov = p;
    if (effRateHz_ > gov.ceilingHz)
      effRateHz_ = gov.ceilingHz; // a lowered ceiling clamps immediately
    if (effRateHz_ < gov.floorHz)
      effRateHz_ = gov.floorHz;
    publishGovernor();
  }

  /** Mirror the governor view into the seam atomics (Device.stats → the
   *  profiler "Serial pressure" block — every new stat here surfaces). */
  void publishGovernor() { // mtx held
    if (!gov.enabled) {
      govState_ = -1;
      seam->govState.store(-1, std::memory_order_release);
      seam->govEffectiveRateHz.store(0, std::memory_order_release);
      seam->govCeilingHz.store(gov.ceilingHz, std::memory_order_release);
      return;
    }
    seam->govState.store(govState_ < 0 ? 0 : govState_,
                         std::memory_order_release);
    seam->govEffectiveRateHz.store(effRateHz_, std::memory_order_release);
    seam->govCeilingHz.store(gov.ceilingHz, std::memory_order_release);
  }

  /** One AIMD evaluation (mtx held; `evalMs` cadence). Backoff signals:
   *  a txSoftFail delta, outq above HIGH, or p95 RTT beyond the inflation
   *  gate vs the connect-time baseline → halve (floor-clamped). Otherwise
   *  climb by stepHz toward the ceiling while outq stays under LOW. */
  void evalGovernor(int64_t now) {
    if (!gov.enabled)
      return;
    if (lastEvalNs_ != 0 && now - lastEvalNs_ < gov.evalMs * 1'000'000)
      return;
    lastEvalNs_ = now;
    const uint64_t sf = seam->txSoftFail.load(std::memory_order_relaxed);
    const uint64_t sfDelta = sf - lastSoftFail_;
    lastSoftFail_ = sf;
    const int outq = seam->readOutq();
    const auto rtt = seam->rttStats();
    const bool rttBad = rtt.baselineP50 > 0 && rtt.count >= 4 &&
                        rtt.p95 > gov.rttInflation * rtt.baselineP50;
    const bool pressure = sfDelta > 0 ||
                          outq > static_cast<int>(gov.outqHigh) || rttBad;
    if (pressure) {
      effRateHz_ = std::max(gov.floorHz, effRateHz_ / 2);
      govState_ = 2; // backoff
      backoffs.fetch_add(1, std::memory_order_relaxed);
    } else if (effRateHz_ < gov.ceilingHz &&
               outq < static_cast<int>(gov.outqLow) && !rttBad) {
      effRateHz_ = std::min(gov.ceilingHz, effRateHz_ + gov.stepHz);
      govState_ = effRateHz_ >= gov.ceilingHz ? 0 : 1; // steady : seeking
    } else {
      govState_ = effRateHz_ >= gov.ceilingHz ? 0 : govState_ == 2 ? 1 : 0;
    }
    publishGovernor();
  }

  // One history sample: predicted volts (DAC round-trip) at a steady-ns stamp.
  struct Sample {
    int64_t tNs = 0;
    double lx = 0, ly = 0, rx = 0, ry = 0;
  };

  // Gate + history state (one mutex — the write path is ≤1 kHz).
  std::mutex mtx;
  bool hasLast = false;
  double lastLx = 0, lastLy = 0, lastRx = 0, lastRy = 0; // input volts (dedupe)
  int64_t lastSentNs = 0;
  std::vector<Sample> ring{kHistoryCapacity};
  size_t head = 0, count = 0;

  // The pos_in sink body — runs on the port link's delivery thread.
  void push(const VoltPair::Ptr &v) {
    if (!v)
      return;
    received.fetch_add(1, std::memory_order_relaxed);
    const int64_t now = sinkSteadyNs();
    // FAIRNESS RESERVE (Part 2): while a two-phase request has been pending
    // longer than fairnessMs, UPDATEs are DEFERRED (coalesced, never queued —
    // the next tick carries a fresher pose anyway) so requests never sit
    // behind a stream burst. maxDeferMs caps the deferral so a timed-out /
    // lost request can't starve the stream.
    {
      const int64_t oldest =
          seam->oldestPendingNs.load(std::memory_order_acquire);
      const int64_t newest =
          seam->newestPendingNs.load(std::memory_order_acquire);
      if (oldest > 0) {
        std::scoped_lock lk(mtx);
        if (gov.enabled) {
          const int64_t lo = gov.fairnessMs * 1'000'000;
          const int64_t hi = gov.maxDeferMs * 1'000'000;
          const int64_t ageOld = now - oldest;
          const int64_t ageNew = now - newest;
          // Defer if EITHER tracked pending sits in the window — a zombie
          // outside it must not mask a fresh request inside it (see the seam
          // comment; realistic pending depth is <=2, both ends suffice).
          if ((ageOld >= lo && ageOld <= hi) || (ageNew >= lo && ageNew <= hi)) {
            deferred.fetch_add(1, std::memory_order_relaxed);
            return;
          }
        }
      }
    }
    uint16_t chL[4], chR[4];
    {
      std::scoped_lock lk(mtx);
      evalGovernor(now); // lazy AIMD evaluation at the stats cadence
      if (hasLast && v->lx == lastLx && v->ly == lastLy && v->rx == lastRx &&
          v->ry == lastRy) {
        deduped.fetch_add(1, std::memory_order_relaxed);
        return;
      }
      // Effective emission interval: the 1 ms floor, opened up to the
      // governor's discovered rate (governor off = exactly the fixed gate).
      const int64_t minIntervalNs =
          gov.enabled
              ? std::max(kMinIntervalNs,
                         static_cast<int64_t>(1e9 / std::max(1.0, effRateHz_)))
              : kMinIntervalNs;
      if (hasLast && now - lastSentNs < minIntervalNs) {
        throttled.fetch_add(1, std::memory_order_relaxed);
        return;
      }
      lastLx = v->lx;
      lastLy = v->ly;
      lastRx = v->rx;
      lastRy = v->ry;
      lastSentNs = now;
      hasLast = true;
    }
    MirrorSinkMath::channels(v->lx, v->ly, bias, dv, chL);
    MirrorSinkMath::channels(v->rx, v->ry, bias, dv, chR);
    // The serial write happens OUTSIDE the gate mutex (only the seam mutex
    // serializes the fd) — a slow write never blocks a probe.
    if (!seam->writeMirrorUpdate(streamId, chL, chR)) {
      errors.fetch_add(1, std::memory_order_relaxed);
      return;
    }
    written.fetch_add(1, std::memory_order_relaxed);
    // Record the PREDICTED volts (DAC round-trip — predictVolts parity).
    Sample smp;
    smp.tNs = now;
    smp.lx = MirrorSinkMath::dac2volt(static_cast<double>(chL[0]) - chL[1]);
    smp.ly = MirrorSinkMath::dac2volt(static_cast<double>(chL[2]) - chL[3]);
    smp.rx = MirrorSinkMath::dac2volt(static_cast<double>(chR[0]) - chR[1]);
    smp.ry = MirrorSinkMath::dac2volt(static_cast<double>(chR[2]) - chR[3]);
    std::scoped_lock lk(mtx);
    ring[head] = smp;
    head = (head + 1) % kHistoryCapacity;
    if (count < kHistoryCapacity)
      count++;
  }

  // i = 0 oldest … count-1 newest (call with mtx held).
  const Sample &at(size_t i) const {
    const size_t start = (head + kHistoryCapacity - count) % kHistoryCapacity;
    return ring[(start + i) % kHistoryCapacity];
  }

  // mirrorAt parity (app/orchestrator/mirror-history.ts): lerp between the
  // bracketing samples; clamped (interpolated=false) outside the span; no
  // sample → found=false.
  struct At {
    bool found = false;
    bool interpolated = false;
    int64_t ageNs = 0;
    double lx = 0, ly = 0, rx = 0, ry = 0;
  };
  At historyAt(int64_t tNs) {
    std::scoped_lock lk(mtx);
    At out;
    if (count == 0)
      return out;
    const Sample &oldest = at(0);
    const Sample &newest = at(count - 1);
    auto fill = [&](const Sample &s, int64_t age, bool interp) {
      out.found = true;
      out.interpolated = interp;
      out.ageNs = age;
      out.lx = s.lx;
      out.ly = s.ly;
      out.rx = s.rx;
      out.ry = s.ry;
    };
    if (tNs <= oldest.tNs)
      return fill(oldest, oldest.tNs - tNs, tNs == oldest.tNs), out;
    if (tNs >= newest.tNs)
      return fill(newest, tNs - newest.tNs, tNs == newest.tNs), out;
    // Binary search for the first sample with t > tNs.
    size_t lo = 0, hi = count - 1;
    while (lo < hi) {
      const size_t mid = (lo + hi) >> 1;
      if (at(mid).tNs <= tNs)
        lo = mid + 1;
      else
        hi = mid;
    }
    const Sample &after = at(lo);
    const Sample &before = at(lo - 1);
    const double span = static_cast<double>(after.tNs - before.tNs);
    const double t = span == 0 ? 0 : static_cast<double>(tNs - before.tNs) / span;
    Sample lerped;
    lerped.lx = before.lx + (after.lx - before.lx) * t;
    lerped.ly = before.ly + (after.ly - before.ly) * t;
    lerped.rx = before.rx + (after.rx - before.rx) * t;
    lerped.ry = before.ry + (after.ry - before.ry) * t;
    const int64_t ageBefore = tNs - before.tNs;
    const int64_t ageAfter = after.tNs - tNs;
    fill(lerped, ageBefore < ageAfter ? ageBefore : ageAfter, true);
    return out;
  }

  bool historyLatest(Sample &out) {
    std::scoped_lock lk(mtx);
    if (count == 0)
      return false;
    out = at(count - 1);
    return true;
  }

  std::vector<Sample> historyQuery(int64_t fromNs, int64_t toNs) {
    std::scoped_lock lk(mtx);
    std::vector<Sample> out;
    for (size_t i = 0; i < count; i++) {
      const Sample &smp = at(i);
      if (smp.tNs >= fromNs && smp.tNs <= toNs)
        out.push_back(smp);
    }
    return out;
  }
};

static Napi::Object sampleToJs(Napi::Env env, const MirrorSink::Sample &s) {
  auto o = Napi::Object::New(env);
  o.Set("tNs", Napi::BigInt::New(env, s.tNs));
  auto l = Napi::Object::New(env);
  l.Set("x", Napi::Number::New(env, s.lx));
  l.Set("y", Napi::Number::New(env, s.ly));
  auto r = Napi::Object::New(env);
  r.Set("x", Napi::Number::New(env, s.rx));
  r.Set("y", Napi::Number::New(env, s.ry));
  o.Set("left", l);
  o.Set("right", r);
  return o;
}

class MirrorSinkObject : public CoreObject<MirrorSinkObject, MirrorSink::Ptr> {
public:
  static inline const std::string name = "MirrorSink";
  static std::string describe(const MirrorSinkObject *) { return "MirrorSink"; }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(MirrorSinkObject, env),
            INSTANCE_METHOD(MirrorSinkObject, probe),
            INSTANCE_METHOD(MirrorSinkObject, setGovernor),
            INSTANCE_METHOD(MirrorSinkObject, historyLatest),
            INSTANCE_METHOD(MirrorSinkObject, historyAt),
            INSTANCE_METHOD(MirrorSinkObject, historyQuery),
            Napi::InstanceWrap<MirrorSinkObject>::template InstanceAccessor<
                &MirrorSinkObject::get_pos_in>("pos_in", napi_enumerable),
        });
  }

  CORE_OBJECT_DECL(MirrorSinkObject)

  MirrorSinkObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  static void destruct(MirrorSinkObject *self) {
    // Retire the seam's governor mirror — the profiler must not show a stale
    // effective rate after the sink is gone.
    try {
      const auto &c = self->core();
      c->seam->govState.store(-1, std::memory_order_release);
      c->seam->govEffectiveRateHz.store(0, std::memory_order_release);
    } catch (...) {
    }
  }

  FN(probe) {
    auto env = info.Env();
    try {
      const auto &c = core();
      auto o = Napi::Object::New(env);
      o.Set("received", Napi::Number::New(env, double(c->received.load())));
      o.Set("written", Napi::Number::New(env, double(c->written.load())));
      o.Set("deduped", Napi::Number::New(env, double(c->deduped.load())));
      o.Set("throttled", Napi::Number::New(env, double(c->throttled.load())));
      o.Set("errors", Napi::Number::New(env, double(c->errors.load())));
      o.Set("deferred", Napi::Number::New(env, double(c->deferred.load())));
      o.Set("backoffs", Napi::Number::New(env, double(c->backoffs.load())));
      o.Set("open", Napi::Boolean::New(
                        env, c->seam->open.load(std::memory_order_acquire)));
      // Governor view (serial-rate-governor.md Part 2/3).
      {
        std::scoped_lock lk(c->mtx);
        o.Set("effectiveRateHz",
              Napi::Number::New(env, c->gov.enabled ? c->effRateHz_ : 0));
        o.Set("ceilingHz", Napi::Number::New(env, c->gov.ceilingHz));
        const int gs = c->gov.enabled ? (c->govState_ < 0 ? 0 : c->govState_)
                                      : -1;
        o.Set("governorState",
              Napi::String::New(env, gs == 0   ? "steady"
                                     : gs == 1 ? "seeking"
                                     : gs == 2 ? "backoff"
                                               : "off"));
      }
      // ACK-RTT view (Part 4 — the session's serial-latency estimate reads
      // p50 here at its stats throttle).
      const auto rtt = c->seam->rttStats();
      o.Set("ackRttP50", Napi::Number::New(env, rtt.p50));
      o.Set("ackRttP95", Napi::Number::New(env, rtt.p95));
      o.Set("ackRttCount",
            Napi::Number::New(env, static_cast<double>(rtt.count)));
      return o;
    }
    JS_EXCEPT(env.Undefined())
  }

  // setGovernor(partial GovernorParams) — live retune; named invalid_arguments
  // (the stereo-params precedent). `enabled: false` pins the fixed-gate
  // behavior byte-for-byte.
  FN(setGovernor) {
    auto env = info.Env();
    try {
      JS_ASSERT(info[0].IsObject(), TypeError,
                "setGovernor: params object required", env.Undefined());
      auto o = info[0].As<Napi::Object>();
      GovernorParams p;
      {
        std::scoped_lock lk(core()->mtx);
        p = core()->gov; // partial update over the current params
      }
      auto num = [&](const char *k, double &dst, double lo, double hi) {
        if (!o.Has(k) || o.Get(k).IsUndefined())
          return;
        const double v = o.Get(k).As<Napi::Number>().DoubleValue();
        if (!std::isfinite(v) || v < lo || v > hi)
          throw std::invalid_argument(
              std::string("setGovernor: `") + k + "` out of range");
        dst = v;
      };
      if (o.Has("enabled") && !o.Get("enabled").IsUndefined())
        p.enabled = o.Get("enabled").ToBoolean().Value();
      num("ceilingHz", p.ceilingHz, 1, 100000);
      num("floorHz", p.floorHz, 1, 100000);
      num("stepHz", p.stepHz, 1, 10000);
      double tmp;
      tmp = static_cast<double>(p.evalMs);
      num("evalMs", tmp, 1, 60000);
      p.evalMs = static_cast<int64_t>(tmp);
      tmp = static_cast<double>(p.outqLow);
      num("outqLow", tmp, 0, 1e9);
      p.outqLow = static_cast<uint32_t>(tmp);
      tmp = static_cast<double>(p.outqHigh);
      num("outqHigh", tmp, 0, 1e9);
      p.outqHigh = static_cast<uint32_t>(tmp);
      num("rttInflation", p.rttInflation, 1, 1000);
      tmp = static_cast<double>(p.fairnessMs);
      num("fairnessMs", tmp, 0, 10000);
      p.fairnessMs = static_cast<int64_t>(tmp);
      tmp = static_cast<double>(p.maxDeferMs);
      num("maxDeferMs", tmp, 1, 60000);
      p.maxDeferMs = static_cast<int64_t>(tmp);
      if (p.floorHz > p.ceilingHz)
        throw std::invalid_argument(
            "setGovernor: `floorHz` must be <= `ceilingHz`");
      if (p.outqLow > p.outqHigh)
        throw std::invalid_argument(
            "setGovernor: `outqLow` must be <= `outqHigh`");
      if (p.fairnessMs > p.maxDeferMs)
        throw std::invalid_argument(
            "setGovernor: `fairnessMs` must be <= `maxDeferMs`");
      core()->setGovernor(p);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(historyLatest) {
    auto env = info.Env();
    try {
      MirrorSink::Sample s;
      if (!core()->historyLatest(s))
        return env.Null();
      return sampleToJs(env, s);
    }
    JS_EXCEPT(env.Undefined())
  }

  // historyAt(tNs: bigint) → { left, right, ageNs, interpolated } | null —
  // the JS mirrorAt shape, so the homography feeder's seam is a passthrough.
  FN(historyAt) {
    auto env = info.Env();
    try {
      const int64_t t = convert<int64_t>(info[0]);
      const auto at = core()->historyAt(t);
      if (!at.found)
        return env.Null();
      auto o = Napi::Object::New(env);
      auto l = Napi::Object::New(env);
      l.Set("x", Napi::Number::New(env, at.lx));
      l.Set("y", Napi::Number::New(env, at.ly));
      auto r = Napi::Object::New(env);
      r.Set("x", Napi::Number::New(env, at.rx));
      r.Set("y", Napi::Number::New(env, at.ry));
      o.Set("left", l);
      o.Set("right", r);
      o.Set("ageNs", Napi::BigInt::New(env, at.ageNs));
      o.Set("interpolated", Napi::Boolean::New(env, at.interpolated));
      return o;
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(historyQuery) {
    auto env = info.Env();
    try {
      const int64_t from = convert<int64_t>(info[0]);
      const int64_t to = convert<int64_t>(info[1]);
      const auto rows = core()->historyQuery(from, to);
      auto arr = Napi::Array::New(env, rows.size());
      for (size_t i = 0; i < rows.size(); i++)
        arr.Set(static_cast<uint32_t>(i), sampleToJs(env, rows[i]));
      return arr;
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(pos_in) {
    auto env = info.Env();
    try {
      auto c = core();
      if (posIn_.IsEmpty()) {
        if (!c->port) {
          auto sink = c; // the port sink pins the MirrorSink
          c->port = PortPipe::makeInPort<VoltPair::Ptr>(
              c->nodeId, "pos", "volts",
              [sink](const VoltPair::Ptr &v) { sink->push(v); });
        }
        auto js = PortPipe::createInPortJs(env, c->port);
        posIn_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return posIn_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

private:
  Napi::ObjectReference posIn_;
};

CORE_OBJECT(MirrorSinkObject)

// createMirrorSink(device, { streamId, bias, dv, nodeId }) — attach a native
// pos_in sink to a live Device's write seam. The MCU stream (streamId) must
// already exist (JS createStream, ACK-backed) and is TERMINATED by JS on
// close — this sink only fires UPDATEs (quiesce ownership stays JS).
static FN(createMirrorSink) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsObject(), TypeError,
              "createMirrorSink: device required", env.Undefined());
    auto *dev = Napi::ObjectWrap<DeviceObject>::Unwrap(info[0].As<Napi::Object>());
    JS_ASSERT(dev != nullptr, TypeError,
              "createMirrorSink: first argument must be a Device",
              env.Undefined());
    JS_ASSERT(info[1].IsObject(), TypeError,
              "createMirrorSink: options object required", env.Undefined());
    auto o = info[1].As<Napi::Object>();
    auto sink = MirrorSink::create();
    sink->seam = dev->writeSeam();
    const double sid = o.Get("streamId").ToNumber().DoubleValue();
    if (!(sid >= 0 && sid < 256) || sid != std::floor(sid))
      throw std::invalid_argument(
          "createMirrorSink: `streamId` must be an integer 0..255");
    sink->streamId = static_cast<uint8_t>(sid);
    if (o.Has("bias") && o.Get("bias").IsNumber())
      sink->bias = o.Get("bias").As<Napi::Number>().DoubleValue();
    if (o.Has("dv") && o.Get("dv").IsNumber())
      sink->dv = o.Get("dv").As<Napi::Number>().DoubleValue();
    sink->nodeId = o.Has("nodeId") && o.Get("nodeId").IsString()
                       ? o.Get("nodeId").As<Napi::String>().Utf8Value()
                       : "controller";
    sink->setGovernor(GovernorParams{}); // publish the baked defaults' mirror
    return MirrorSinkObject::Create(env, sink);
  }
  JS_EXCEPT(env.Undefined())
}

// Test-only (__serialTestPty): openpty() → { fd: master, path: slave }. The
// Device opens the slave by path (SerialOpen's normal tty setup works on a
// pty); the test reads the master fd from JS (`fs.readSync(fd, ...)`) to
// assert the exact frames a native sink wrote. Hardware-free UPDATE-write coverage.
static FN(__serialTestPty) {
  auto env = info.Env();
  try {
    int master = -1, slave = -1;
    char path[128] = {0};
    JS_ASSERT(openpty(&master, &slave, path, nullptr, nullptr) == 0, Error,
              "openpty failed: " + std::string(std::strerror(errno)),
              env.Undefined());
    ::close(slave); // the Device re-opens the slave by path
    // NON-BLOCKING master: tests poll it with fs.readSync — a BLOCKING read
    // on an empty pty would freeze the whole JS thread (hit by test 46's
    // drain timer; test 45 only ever read after writes, so it never blocked).
    ::fcntl(master, F_SETFL, ::fcntl(master, F_GETFL) | O_NONBLOCK);
    auto o = Napi::Object::New(env);
    o.Set("fd", Napi::Number::New(env, master));
    o.Set("path", Napi::String::New(env, path));
    return o;
  }
  JS_EXCEPT(env.Undefined())
}

void exportControllerModule(Napi::Env env, Napi::Object &exports) {
  bufferAccessor.get(env) = Napi::Persistent(Napi::Symbol::New(env, "Buffer"));
  propNameAccessor.get(env) =
      Napi::Persistent(Napi::Symbol::New(env, "PropertyName"));
  exports.Set("Device", DeviceObject::Init(env));
  auto Protocol = Napi::Object::New(env);
  Protocol.Set("Log", factory<Property::LOG, StringPacket>(env, "Log"));
  Protocol.Set("System", System::Init(env));
  Protocol.Set("Config", Config::Init(env));
  Protocol.Set("Command", Command::Init(env));
  Protocol.Freeze();
  exports.Set("Protocol", Protocol);
  // Native mirror position sink (native-compose-controller.md).
  MirrorSinkObject::Export(env, exports);
  exports.Set("createMirrorSink",
              Napi::Function::New<createMirrorSink>(env, "createMirrorSink"));
  // Test-only (core/test/45): a raw pty pair — Device opens the slave path,
  // the test reads the master fd via fs.readSync (openpty precedent).
  exports.Set("__serialTestPty",
              Napi::Function::New<__serialTestPty>(env, "__serialTestPty"));
}
