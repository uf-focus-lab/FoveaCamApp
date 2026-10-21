// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>

#include <Protocol/Packet.h>

// Uploaded periodic trajectories with trigger markers (Protocol v2.2.0
// CMD_TRAJECTORY — the MirrorLink use case). The host uploads a table once
// (BEGIN / DATA chunks / MARK / COMMIT); START plays it back entirely on the
// MCU: the DAC follows the table at phase φ = (now - t_start) mod period
// (linear interpolation between samples, or step/hold), and each marker fires
// a camera trigger through the Capture engine when φ crosses its offset, once
// per cycle. Every marker capture pushes one `SYN CMD_TRAJECTORY`
// TrajectoryFrame. While a trajectory runs it owns the DAC (Streams::Owner);
// STOP holds the last position and hands control back to the streams.
// spec: docs/spec/serial-protocol.md#trajectory
namespace Trajectory {

using Packet::Command::FrameResult;
using Packet::Command::Microseconds;
using Packet::Command::Timestamp;
using Packet::Command::TrajectorySample;

// ---- Sizing (the ONE place; REJ reasons name the limit) --------------------
// Teensy 4.0: the sample pool lives in DMAMEM (RAM2, 512 KB): 4096 x 20 B =
// 80 KB.
constexpr uint8_t MAX_TABLES = 4;       // table ids 0..MAX_TABLES-1
constexpr uint16_t MAX_SAMPLES = 4096;  // total across all tables
constexpr uint8_t MAX_MARKERS = 8;      // per table (marker 0..MAX_MARKERS-1)
constexpr uint8_t CHUNK_SAMPLES = Packet::Command::Trajectory::CHUNK_SAMPLES;

// ---- SET ops (firmware/src/Protocol.cpp dispatches here) -------------------
// Each returns nullptr on success, or a REJ reason (static storage).
const char *begin(uint8_t id, uint16_t sampleCount, Microseconds period,
                  uint8_t flags);
// `samples` points at `count` packed TrajectorySamples (may be unaligned).
const char *data(uint8_t id, uint16_t firstIndex, uint8_t count,
                 const uint8_t *samples);
const char *mark(uint8_t id, uint8_t marker, Microseconds offset,
                 uint8_t cameras, Microseconds pulse);
const char *commit(uint8_t id);
// tStart == 0 -> now. cycles == 0 -> forever. Requires the system enabled
// (checked by the caller, like every CMD_* handler).
const char *start(uint8_t id, Timestamp tStart, uint32_t cycles);
const char *stop(uint8_t id);
// Stops the table first if it is the running one. Deleting a free id is a
// no-op success.
const char *remove(uint8_t id);

// True while a trajectory is armed or playing (it owns the DAC).
bool running();

// Call every loop() tick, after Streams::tick() and before Capture::tick():
// drives the DAC along the table and fires markers. Halts (STOP semantics) if
// the system was disabled or the streams reclaimed the DAC (Streams::clear).
void tick();

// Completion sink: sends one `SYN CMD_TRAJECTORY` TrajectoryFrame push.
// Used by Capture.cpp for marker-originated captures and by tick() for BUSY /
// ENDED. `status` is a Packet::Command::TrajectoryFrame::Status.
void push(uint8_t id, uint8_t marker, uint32_t cycle, uint8_t status,
          const FrameResult &result);

} // namespace Trajectory
