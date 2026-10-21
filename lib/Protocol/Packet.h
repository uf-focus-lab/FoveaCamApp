// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstddef> // offsetof (wire-layout static_asserts below)

#include "Protocol.h"

namespace Packet {

inline Protocol::RawPacket
reject(const std::string &reason,
       Protocol::Property p = Protocol::Property::NONE, uint16_t seq = 0) {
  Protocol::RawPacket packet(Protocol::REJ, p, seq);
  packet.setData(reason.c_str(), reason.size());
  return packet;
}

namespace Log {

typedef Protocol::StringPacket<Protocol::Property::LOG> Log;

inline Protocol::RawPacket create(std::string message) {
  auto packet = Log::Prototype::Create::SYN(0);
  Log::Prototype::deflate(message, packet);
  return packet;
}

} // namespace Log

namespace System {

typedef Protocol::StringPacket<Protocol::Property::SYS_INFO> Info;

FIXED_SIZE_PACKET(Version, SYS_VERSION) {
  uint8_t major;
  uint8_t minor;
  uint8_t patch;
};

FIXED_SIZE_PACKET(Reset, SYS_RESET) {
  // SOFT/HARD reboot the MCU (single-phase ACK, then reset). MEMS is a targeted
  // DAC recovery: re-init the AD5664R DACs in place without rebooting or
  // dropping the session (see firmware Protocol.cpp HANDLE_SET(System::Reset)).
  // Wire layout is unchanged (one uint8_t); an unknown type on older firmware
  // is REJected.
  typedef enum Type : uint8_t { SOFT = 0, HARD = 1, MEMS = 2 } Type;
  Type type;
};

FIXED_SIZE_PACKET(Enable, SYS_ENABLE) { uint8_t enable; };

// Clock-calibration surface. GET replies the MCU's wraparound-corrected uint64
// microsecond clock (Global::time), stamped AT PACKET PARSE/HANDLE TIME — not
// at reply serialization — so a host
// calibration ping's jitter stays at the serial-latency floor. SET resets the
// counter to the payload value (normally 0) and echoes the fresh clock back.
// Single-phase (ACK/REJ, no FIN). Same clock domain and units as
// Command::Timestamp (FrameResult t_trigger/t_exposure).
FIXED_SIZE_PACKET(Timestamp, SYS_TIMESTAMP) { uint64_t microseconds; };

static_assert(sizeof(Timestamp) == 8, "Timestamp payload is uint64 µs");

} // namespace System

namespace Config {

FIXED_SIZE_PACKET(Log, CFG_LOG) {
  typedef enum Level : uint8_t {
    OFF = 0,
    ERR = 1,
    WARN = 2,
    INFO = 3,
    VERB = 4,
  } Level;
  Level level;
};

FIXED_SIZE_PACKET(LPF, CFG_LPF) {
  // Low Pass Filter cutoff frequency in Hz
  uint16_t frequency;
};

FIXED_SIZE_PACKET(Bias, CFG_BIAS) {
  // Bias voltage in 16-bit unsigned integer
  uint16_t voltage;
};

} // namespace Config

namespace Command {

PACKED(MirrorPosition) { uint16_t ch[4]; };

typedef uint32_t Microseconds;
// Wide MCU-clock timestamp (µs); wraps only at the firmware's uint64 counter
// limit, keeping wrap handling entirely firmware-side (see Global::time).
typedef uint64_t Timestamp;

FIXED_SIZE_PACKET(Actuate, CMD_ACTUATE) {
  MirrorPosition left;
  MirrorPosition right;
  union {
    Microseconds settle_time;   // Time to wait after mirror movement
    Microseconds complete_time; // Timestamp when action is complete
  };
};

FIXED_SIZE_PACKET(Trigger, CMD_TRIGGER) {
  union {
    Microseconds duration;  // Duration to trigger
    Microseconds timestamp; // Timestamp when trigger starts
  };
};

static_assert(sizeof(Trigger) == sizeof(Microseconds));

// Bitmask for Frame::cameras. Bit i = firmware Board::camera[i]. All three
// cameras are triggerable on the V0.1 controller board (Line2 trigger, Line3
// strobe cabled on each); a mask of 0 means the default CAM_L | CAM_R, so C
// is captured only when asked for. Bits outside C|L|R are REJected.
typedef enum CameraMask : uint8_t {
  CAM_NONE = 0,
  CAM_C = 1,
  CAM_L = 2,
  CAM_R = 4,
} CameraMask;

// SET request: create/update/terminate a named, continuously-updatable
// mirror-position target. Single-phase (ACK/REJ only, no FIN). UPDATE is
// normally sent with seq == 0 (fire-and-forget, ~1kHz). Named `MirrorStream`
// rather than `Stream` to avoid colliding with Arduino's own `Stream` class
// (firmware/src/*.cpp transitively include <Arduino.h>).
FIXED_SIZE_PACKET(MirrorStream, CMD_STREAM) {
  typedef enum Op : uint8_t { CREATE = 0, UPDATE = 1, TERMINATE = 2 } Op;
  Op op;
  uint8_t id;                   // stream id, host-chosen (0..N-1)
  MirrorPosition left;          // target; ignored by TERMINATE
  MirrorPosition right;
};

// GET request: triggered-capture. Two-phase — ACK (queue position, this
// revision's FrameAccepted payload) then FIN (FrameResult) or REJ at either
// phase (duplicate stream, unknown/out-of-range stream, queue full, strobe
// timeout).
FIXED_SIZE_PACKET(Frame, CMD_FRAME) {
  uint8_t stream;        // stream the mirrors follow during this exposure
  uint8_t cameras;        // CameraMask bitmask; default CAM_L | CAM_R
  Microseconds pulse;    // trigger pulse width
  // Trigger SETTLE HOLD (µs). Applied ONLY when this request SWITCHES the
  // active stream (the mirror is commanded to a new location): the firmware
  // moves the mirror, waits settle_time, THEN asserts the trigger. Independent
  // of `pulse` — it is NOT subtracted from the exposure window. 0 = no hold.
  // The 2-point mirror averaging + strobe machinery runs afterward.
  Microseconds settle_time;
};

// Compile-time lock on the CMD_FRAME request layout (mirrors the
// FrameAccepted/FrameResult asserts below): stream(1)+cameras(1)+pulse(4)+
// settle_time(4). Enforced on BOTH host and MCU (shared header) so a field
// reorder or a lost `__packed__` can never silently desync the request.
static_assert(sizeof(Frame) == 10,
              "Frame request = stream(1)+cameras(1)+pulse(4)+settle_time(4)");

// ACK payload for Frame: position in the per-stream FIFO queue (0 = next).
PACKED(FrameAccepted) { uint8_t queue_position; };

// FIN payload for Frame. Timestamps are latched at their physical edges;
// left/right are the mirror position AVERAGED over the exposure (see below).
PACKED(FrameResult) {
  uint8_t stream;
  // Firmware-monotonic capture counter (1-based; 0 = none). Stable frame
  // identity: flows FIN -> host -> recorder per-frame metadata -> UI, bound to
  // the camera frame via the t_exposure/timestamp pairing. Distinct from the
  // uint16 protocol `seq` (which is per-request and wraps at 65536).
  uint32_t frame_id;
  Timestamp t_trigger;  // MCU us: trigger rise
  Timestamp t_exposure; // MCU us: strobe rise = line asserted (exposure start)
  // Exposure-AVERAGED mirror position: per-channel round-half-up mean of the
  // DAC target latched at strobe rise (exposure start) and at strobe fall
  // (exposure finish).
  MirrorPosition left;
  MirrorPosition right;
};

// Compile-time locks on the CMD_FRAME two-phase wire layout, enforced on BOTH
// host and MCU since they share this header — so a field
// reorder, a lost `__packed__`, or padding creep can never silently desync the
// FIN payload. Runtime counterpart: core/test/10-frame-result.ts.
static_assert(sizeof(FrameAccepted) == 1, "Frame ACK payload is one byte");
static_assert(sizeof(FrameResult) == 37,
              "FIN payload = stream(1)+frame_id(4)+t_trigger(8)+t_exposure(8)"
              "+left(8)+right(8)");
static_assert(offsetof(FrameResult, stream) == 0);
static_assert(offsetof(FrameResult, frame_id) == 1); // right after stream
static_assert(offsetof(FrameResult, t_trigger) == 5);
static_assert(offsetof(FrameResult, t_exposure) == 13);
static_assert(offsetof(FrameResult, left) == 21);
static_assert(offsetof(FrameResult, right) == 29);

} // namespace Command

} // namespace Packet
