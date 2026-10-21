// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <Protocol/Packet.h>
#include <Protocol/Version.h>
#include <core_pins.h>

#include "Board.h"
#include "Capture.h"
#include "Global.h"
#include "MEMS.h"
#include "Streams.h"
#include "convert.h"

void Protocol::send(Protocol::RawPacket &packet) {
  // seq == 0 fire-and-forget: perform the action, stay silent.
  // spec: docs/spec/serial-protocol.md#fire-and-forget
  if (packet.header().sequence == 0)
    return;
  if (COBS::tx.encode(packet.finalize()))
    Serial.write(COBS::tx.data(), COBS::tx.size());
}

// Unqualified `send(packet)` below resolves to Protocol::send via
// argument-dependent lookup (packet's type, Protocol::RawPacket, lives in
// namespace Protocol) — no local wrapper needed.
using Protocol::send;

void Protocol::reject(const Sequence &seq, Property p,
                      const std::string &reason) {
  RawPacket packet{Method::REJ, p, seq};
  packet.setData(reason.data(), reason.size());
  send(packet);
}

#define HANDLE_GET(PACKET)                                                     \
  template <> void Packet::PACKET::Prototype::GET(const Protocol::Sequence &seq)

// Payload-carrying GET (CMD_FRAME is a request with an inflated argument,
// unlike the read-only GETs above).
#define HANDLE_GET_PAYLOAD(PACKET)                                             \
  template <>                                                                 \
  void Packet::PACKET::Prototype::GET(const Protocol::Sequence &seq,          \
                                      Inflated payload)

#define HANDLE_SET(PACKET)                                                     \
  template <>                                                                  \
  void Packet::PACKET::Prototype::SET(const Protocol::Sequence &seq,           \
                                      Inflated payload)

#define HANDLE_ACK(PACKET)                                                     \
  template <>                                                                  \
  void Packet::PACKET::Prototype::ACK(const Protocol::Sequence &seq,           \
                                      Inflated payload)

#define HANDLE_SYN(PACKET)                                                     \
  template <>                                                                  \
  void Packet::PACKET::Prototype::SYN(const Protocol::Sequence &seq,           \
                                      Inflated payload)

// Non-blocking Actuate/Trigger completion: two-phase (ACK now, FIN after a timed
// delay via tick()); one of each in-flight, overlap REJected.
// spec: docs/spec/serial-protocol.md#two-phase
namespace {

template <typename Payload> struct PendingAction {
  bool pending = false;
  Protocol::Sequence seq = 0;
  Payload result{};
  Packet::Command::Timestamp due = 0;

  bool start(Protocol::Sequence nextSeq, const Payload &payload,
             Packet::Command::Timestamp nextDue) {
    if (pending)
      return false;
    seq = nextSeq;
    result = payload;
    due = nextDue;
    pending = true;
    return true;
  }

  bool ready(Packet::Command::Timestamp now) const {
    return pending && now >= due;
  }

  void clear() { pending = false; }
};

PendingAction<Packet::Command::Actuate> actuate;
PendingAction<Packet::Command::Trigger> trigger;

} // namespace

static void cancelPendingActuate(const char *reason) {
  if (!actuate.pending)
    return;
  actuate.clear();
  Packet::Command::Actuate::reject(actuate.seq, reason);
}

static void cancelPendingTrigger(const char *reason) {
  if (!trigger.pending)
    return;
  trigger.clear();
  Packet::Command::Trigger::reject(trigger.seq, reason);
}

namespace Protocol {
// Advances the non-blocking Actuate/Trigger completion timers; defined
// below, forward-declared here (and again, separately, in Firmware.cpp)
// since out-of-line `Protocol::tick()` requires a prior in-namespace
// declaration in *this* translation unit.
void tick();
} // namespace Protocol

HANDLE_GET(System::Info) {
  auto packet = Create::ACK(seq);
  deflate(SYSTEM_INFO, packet);
  send(packet);
}

HANDLE_GET(System::Version) {
  auto packet = Create::ACK(seq);
  deflate({.major = Protocol::Version::Major,
           .minor = Protocol::Version::Minor,
           .patch = Protocol::Version::Patch},
          packet);
  send(packet);
}

HANDLE_SET(System::Reset) {
  auto packet = Create::ACK(seq);
  if (payload.type == Payload::HARD) {
    VERB("Hard reset requested");
    send(packet);
    delay(100);
    _reboot_Teensyduino_();
    crash("Reboot failed");
  }
  if (payload.type == Payload::SOFT) {
    VERB("Soft reset requested");
    send(packet);
    delay(100);
#ifdef FOVEA_HOST_SIM
    // Host sim: "bkpt" is an ARM32 instruction and cannot assemble on an
    // x86/arm64 host — route through the same reboot shim the HARD path uses.
    // FOVEA_HOST_SIM is never defined by PlatformIO.
    _reboot_Teensyduino_();
#else
    asm volatile("bkpt"); // Breakpoint instruction causes reset
#endif
    crash("Reboot failed");
  }
  if (payload.type == Payload::MEMS) {
    // Targeted DAC recovery: a full MEMS re-init (intentionally INCLUDING the
    // AD5664R RESET) to unwedge a
    // latched-off DAC — WITHOUT cycling the Board::enable rail or clearing the
    // stream table, so the live session survives. Streams::touch() marks the
    // active stream dirty so the next Streams::tick() re-commits current
    // targets. Single-phase ACK (like the reboot branches, but this one returns).
    if (!Global::system_enabled) {
      reject(seq, "Cannot recover MEMS: system is not enabled");
      return;
    }
    VERB("MEMS recovery requested");
    MEMS::enable();
    Streams::touch();
    deflate(payload, packet);
    send(packet);
    return;
  }
  reject(seq, "Unknown reset type");
}

HANDLE_GET(System::Enable) {
  auto packet = Create::ACK(seq);
  deflate({.enable = Global::system_enabled}, packet);
  send(packet);
}

HANDLE_SET(System::Enable) {
  if (payload.enable && !Global::system_enabled) {
    // Enable system. Order per Mirrorcle guide p27 (Board.h, specs.md §6):
    // DAC init + V_BIAS on all channels, FCLK running, THEN the driver
    // enable — the HV stage must never come up on an uninitialised DAC or a
    // stopped filter clock.
    VERB("Enabling system");
    MEMS::enable(); // RESET, INT_REF, DAC_POWER, LDAC, V_BIAS (both mirrors)
    Board::fclk.tone();
    delay(1); // let the filter clock run before the drivers see it
    Board::enable.write(Board::ENABLE);
    Global::system_enabled = true;
    // v1.1: enable does NOT reset Global::time (only System::Timestamp SET does).
    // spec: docs/spec/serial-protocol.md#clock
  } else if (!payload.enable && Global::system_enabled) {
    VERB("Disabling system");
    // Streams do NOT survive disable; cancel everything and power down MEMS.
    // spec: docs/spec/serial-protocol.md#disable
    Capture::cancelAll("System disabled");
    Streams::clear();
    cancelPendingActuate("System disabled");
    cancelPendingTrigger("System disabled");
    // Power down in reverse of enable (guide p31): driver enable LOW first,
    // then park the DAC at V_BIAS, then stop FCLK.
    Board::enable.write(Board::DISABLE);
    delay(1);
    MEMS::disable();
    Board::fclk.noTone();
    Global::system_enabled = false;
  } else {
    VERB("System enable state unchanged");
  }
  GET(seq);
}

HANDLE_GET(System::Timestamp) {
  // Calibration ping: stamp the clock FIRST, at packet parse/handle time (not at
  // reply-serialization), so jitter stays at the serial-latency floor.
  // spec: docs/spec/serial-protocol.md#clock
  const auto now = Global::time.now();
  auto packet = Create::ACK(seq);
  deflate({.microseconds = now}, packet);
  send(packet);
}

HANDLE_SET(System::Timestamp) {
  // The ONLY MCU clock reset (payload normally 0); invalidates host offset cal.
  // spec: docs/spec/serial-protocol.md#clock
  Global::time.reset(payload.microseconds);
  VERB("Clock counter reset");
  GET(seq);
}

HANDLE_GET(Config::Log) {
  auto packet = Create::ACK(seq);
  deflate({.level = Global::log_level}, packet);
  send(packet);
}

HANDLE_SET(Config::Log) {
  Global::log_level = payload.level;
  VERB("Log level set to %u (%s)", Global::log_level,
       convert<std::string>(Global::log_level).c_str());
  GET(seq);
}

HANDLE_GET(Config::LPF) {
  auto packet = Create::ACK(seq);
  deflate({.frequency = Global::lpf_frequency}, packet);
  send(packet);
}

HANDLE_SET(Config::LPF) {
  VERB("Setting LPF frequency to %u Hz", payload.frequency);
  Global::lpf_frequency = payload.frequency;
  Board::fclk.freq(Global::lpf_frequency);
  GET(seq);
}

HANDLE_GET(Config::Bias) {
  auto packet = Create::ACK(seq);
  deflate({.voltage = Global::bias_voltage}, packet);
  send(packet);
}

HANDLE_SET(Config::Bias) {
  if (Global::system_enabled) {
    reject(seq, "Cannot set bias while system is enabled");
    return;
  }
  VERB("Setting bias voltage to %u (%.2f volts)", payload.voltage,
       (200.0f * payload.voltage) / 65535.0f);
  Global::bias_voltage = payload.voltage;
  GET(seq);
}

HANDLE_SET(Command::Actuate) {
  if (!Global::system_enabled) {
    reject(seq, "Cannot perform action: system is not enabled");
    return;
  }
  if (actuate.pending) {
    reject(seq, "An actuate request is already pending");
    return;
  }
  MEMS::set(MEMS::Device::LEFT, payload.left);
  MEMS::set(MEMS::Device::RIGHT, payload.right);
  MEMS::apply();
  actuate.start(seq, payload, Global::time.now() + payload.settle_time);
  auto packet = Create::ACK(seq);
  deflate(payload, packet);
  send(packet);
}

HANDLE_SET(Command::Trigger) {
  if (trigger.pending) {
    reject(seq, "A trigger request is already pending");
    return;
  }
  // Legacy all-camera pulse: asserts every camera's `trigger` (Line2 on the
  // V0.1 board — C, L and R are all cabled). Never touches `strobe` (Line3 =
  // VAUX) or the opto pair; those Pins are inputs and cannot be written.
  for (auto &cam : Board::camera)
    cam.trigger.write(HIGH);
  trigger.start(seq, payload, Global::time.now() + payload.duration);
  auto packet = Create::ACK(seq);
  deflate(payload, packet);
  send(packet);
}

HANDLE_SET(Command::MirrorStream) {
  if (!Global::system_enabled) {
    reject(seq, "Cannot perform action: system is not enabled");
    return;
  }
  bool ok;
  const char *reason;
  switch (payload.op) {
  case Payload::CREATE:
    ok = Streams::create(payload.id, payload.left, payload.right);
    reason = "Stream id out of range, or already exists";
    break;
  case Payload::UPDATE:
    ok = Streams::update(payload.id, payload.left, payload.right);
    reason = "Unknown stream id";
    break;
  case Payload::TERMINATE:
    ok = Streams::terminate(payload.id);
    reason = "Unknown stream id, or a frame request is pending on it";
    break;
  default:
    ok = false;
    reason = "Unknown stream operation";
    break;
  }
  if (!ok) {
    reject(seq, reason);
    return;
  }
  auto packet = Create::ACK(seq);
  deflate(payload, packet);
  send(packet);
}

HANDLE_GET_PAYLOAD(Command::Frame) {
  if (!Global::system_enabled) {
    reject(seq, "Cannot perform action: system is not enabled");
    return;
  }
  // `::` forced: this specialization's "home" is Protocol::FixedSizePacket
  // (Prototype's actual type), so unqualified `Packet` would otherwise
  // resolve to the nested Protocol::Packet<Property> template — see the
  // Protocol::tick() comment above for the general issue.
  ::Packet::Command::FrameAccepted accepted;
  const char *reason = nullptr;
  if (!Capture::enqueue(seq, payload.stream, payload.cameras, payload.pulse,
                       payload.settle_time, accepted, reason)) {
    reject(seq, reason);
    return;
  }
  auto packet = Create::ACK(seq);
  packet.setData(&accepted, sizeof(accepted));
  send(packet);
}

// Advances the non-blocking Actuate/Trigger completion timers; called from
// loop() alongside Streams::tick() and Capture::tick(). Defined with the
// `Protocol::` qualifier, so this function is itself a member of namespace
// Protocol — unqualified `Packet` inside its body would therefore resolve to
// the nested `Protocol::Packet<Property>` template, not the top-level
// `::Packet` namespace from Packet.h. Force the intended one with `::`.
void Protocol::tick() {
  auto now = Global::time.now();
  if (actuate.ready(now)) {
    actuate.clear();
    actuate.result.complete_time = now;
    auto packet = ::Packet::Command::Actuate::Create::FIN(actuate.seq);
    ::Packet::Command::Actuate::deflate(actuate.result, packet);
    send(packet);
  }
  now = Global::time.now();
  if (trigger.ready(now)) {
    trigger.clear();
    for (auto &cam : Board::camera) // release every Line2 trigger (C, L, R)
      cam.trigger.write(LOW);
    trigger.result.timestamp = now;
    auto packet = ::Packet::Command::Trigger::Create::FIN(trigger.seq);
    ::Packet::Command::Trigger::deflate(trigger.result, packet);
    send(packet);
  }
}
