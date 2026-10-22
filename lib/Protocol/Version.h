// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>

namespace Protocol {

namespace Version {

// Wire-compatibility changelog (semver on the serial protocol):
// v1.0.0: Protocol v2 — FIN completion method, seq==0 fire-and-forget,
// CMD_STREAM/CMD_FRAME, uint64 timestamps. CMD_ACTUATE/CMD_TRIGGER timing is
// two-phase ACK/FIN.
// v1.1.0: SYS_TIMESTAMP clock-calibration property (GET = parse-time µs stamp,
// SET = counter reset). Backward-compatible addition.
// v2.0.0: CMD_FRAME payload gains a trailing `settle_time` (µs) — a trigger
// HOLD applied only on a stream SWITCH (see Packet.h Frame + Capture.cpp
// startNext). BREAKING: the fixed-size CMD_FRAME payload length changed and
// FixedSizePacket::inflate is exact-size, so firmware/core/host must ship as a
// matched set; settle_time == 0 reproduces the prior behavior on the wire.
// v2.1.0: SYS_RESET gains a `MEMS` type (2) — a targeted DAC recovery that
// re-inits the AD5664R DACs in place (incl. RESET) without a reboot or a
// Board::enable rail cycle, then re-commits the active stream's targets
// (firmware Protocol.cpp HANDLE_SET(System::Reset)). Backward-compatible: the
// wire layout is unchanged, and older firmware REJects the unknown reset type.
// v2.2.0: two new properties, both in the MCU Global::time µs domain.
// CMD_SCHEDULE (0x0D) appends timestamped keyframes (optionally linearly
// interpolated) to an existing stream's time-ordered ring; CMD_STREAM UPDATE
// still means "now, latest wins" and clears that ring. CMD_TRAJECTORY (0x0E)
// uploads a periodic trajectory table with trigger markers (BEGIN/DATA/MARK/
// COMMIT/START/STOP/DELETE) that the MCU plays back on its own, pushing one
// SYN CMD_TRAJECTORY TrajectoryFrame per marker capture. Backward-compatible
// additions: no existing layout changed; older firmware REJects the unknown
// properties ("Unknown packet type"). Hosts gate both on >= 2.2.0.
constexpr uint8_t Major = 2;
constexpr uint8_t Minor = 2;
constexpr uint8_t Patch = 0;

} // namespace Version

} // namespace Protocol
