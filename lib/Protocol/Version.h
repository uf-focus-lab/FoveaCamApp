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
// v2.2.1: CMD_TRAJECTORY atomic table swap. START {id = b, t_start, cycles}
// while table a runs is ACCEPTED iff b != a is committed, b.period ==
// a.period and t_start == a's recorded t_start (exact µs; 0 never matches):
// the firmware switches the playing table to b in place — phase clock and
// per-marker-index crossing state carry over, no HOLD, no re-claim (an ARMED
// run keeps pre-positioning at b's phase 0), no push; `cycles` replaces the
// budget; a stays committed (the host DELETEs it) and a capture a's marker
// already started still pushes with a's id. Any other START while running
// still REJs "A trajectory is already running (STOP it first)". Wire layout
// unchanged; a host that sees that REJ (older firmware) falls back to
// STOP(a) + START(b).
constexpr uint8_t Major = 2;
constexpr uint8_t Minor = 2;
constexpr uint8_t Patch = 1;

} // namespace Version

} // namespace Protocol
