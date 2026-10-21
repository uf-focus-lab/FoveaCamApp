// =============================================================================
// Header file for mems operations
// =============================================================================
// License: MIT
// Author: Yuxuan Zhang (zhangyuxuan@ufl.edu)
// =============================================================================void
#ifndef MEMS_DRV_H
#define MEMS_DRV_H

#include <Arduino.h>
#include <cstdint>

#include <Protocol/Packet.h>

namespace MEMS {

typedef enum Device : uint8_t {
  NONE = 0b00,
  LEFT = 0b01,
  RIGHT = 0b10,
  ALL = 0b11,
} Device;

using Packet::Command::MirrorPosition;

// Full AD5664R init on both mirrors: RESET, internal reference on, all DAC
// channels powered, software LDAC, then V_BIAS (Global::bias_voltage) on all
// channels. "Broadcast" = the same word on both buses, in lockstep.
void enable();
// Periodic config re-assertion: re-send the idempotent DAC-power /
// internal-reference / software-LDAC setup
// words to BOTH mirrors. Never RESETs, never writes a value — the mirror does
// not move, so it is safe to call mid-capture.
void refresh();
// Park both mirrors at V_BIAS (all channels). Does NOT touch Board::enable or
// FCLK — the caller sequences those (Protocol.cpp System::Enable).
void disable();
// STAGE a position for one or both mirrors; nothing goes on the wire until
// apply(). Restaging before apply() overwrites (latest wins).
void set(Device device, const MirrorPosition &pos);
// Commit every staged position: per staged mirror 3x WRITE_IREG (channels A,
// B, D) + 1x APPLY_IREG (channel C, write + update all), both buses in
// lockstep, so all channels of both mirrors change on the same final SCLK
// edge. No-op when nothing is staged.
void apply();

} // namespace MEMS

#endif
