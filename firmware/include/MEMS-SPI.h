// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// AD5664R word encoding (MEMS::SPI) and the dual-bus frame driver (MEMS::Bus)
// for the V0.1 board, where each Mirrorcle driver has its own point-to-point
// bus (Board::dac[0] = left, Board::dac[1] = right).
//
// Bus driver choice: a lockstep GPIO bit-bang. Each edge is ONE store to the
// lane's GPIO DR_TOGGLE register (a lane's CS/SCLK/MOSI share a fast-GPIO
// port: left = GPIO9 bits 4/5/6, right = GPIO7 bits 11/1/2 — checked at
// begin()), the left and right stores of an edge are issued back to back, so
// both mirrors' frames go out in the same window and the final (APPLY_IREG)
// falling edge of both buses lands within a few CPU cycles. Why not FlexIO:
// the FlexIO_t4 library is a third-party (KurtE) library, not part of the
// Teensyduino core PlatformIO ships, it has no 24-bit-frame SPI mode, and two
// instances would still need a lockstep start for the shared update instant;
// a bit-bang needs no extra dependency, is fully host-simulated (the sim
// decodes the real pin waveform), and at 10 MHz costs ~10 us of loop time
// per two-mirror update. Pins are FlexIO-capable, so FlexIO stays an option.

#pragma once
#include "Global.h"
#include <cstddef>
#include <cstdint>

namespace MEMS {

namespace SPI {

// ---------------------------------------------------------------------------
// SCLK frequency — the ONE build-time knob for the DAC bus clock.
// ---------------------------------------------------------------------------
// The board recommends 10 MHz until the cable is measured (specs.md §3
// timing table); the AD5664R itself takes 50 MHz. The bit-bang schedules
// every edge off the cycle counter at this rate; above ~20 MHz the edge loop
// itself (~15 cycles per edge at 600 MHz) becomes the limit and the clock
// saturates — slower, never faster (MEMS.cpp). Ceiling enforced below
// (25 MHz): the schedule may shorten a phase by up to a quarter half period
// after a late edge, and that must still be >= T_MIN_PHASE_NS.
constexpr uint32_t SCLK_HZ = 10'000'000;

// AD5664R serial timing used by the driver (ADI AD5624R/AD5644R/AD5664R data
// sheet, VDD 2.7..5.5 V; pcb specs.md §3 lists these as TODO — verify on the
// bench): t1 SCLK cycle >= 20 ns, t2/t3 SCLK high/low >= 9 ns, t4 SYNC-low to
// SCLK-falling setup >= 13 ns, t5/t6 data setup/hold 5/4.5 ns, t7 SCLK-falling
// to SYNC-rising >= 0, t8 SYNC high >= 15 ns, t9 SYNC-rising to next
// SCLK-falling >= 13 ns. Every edge of the schedule is spaced by one SCLK
// half period, so the binding constraint is t8: each phase (including the
// SYNC-high gap between frames) must be >= 15 ns.
constexpr uint32_t T_MIN_PHASE_NS = 15;
static_assert(SCLK_HZ <= 50'000'000, "AD5664R maximum SCLK is 50 MHz");
static_assert(1'000'000'000u / (2 * SCLK_HZ) * 3 / 4 >= T_MIN_PHASE_NS,
              "SCLK_HZ too high for the uniform edge schedule: 3/4 of a half "
              "period must still cover SYNC-high (t8, 15 ns)");

namespace CMD {

typedef enum CMD : uint8_t {
  // Write to Input Register N
  WRITE_IREG = 0b000,
  // Update DAC Register N
  UPDATE_DAC = 0b001,
  // Write to Input Register N, Update All (software LDAC)
  APPLY_IREG = 0b010,
  // Write and Update DAC Register N
  WRITE_UPDATE_DAC = 0b011,
  // DAC Power Control (specified by 0~4 bits in the value field)
  DAC_POWER = 0b100,
  // Reset
  RESET = 0b101,
  // LDAC Register Setup
  LDAC_SETUP = 0b110,
  // Internal Reference Setup (on/off)
  INT_REF_SETUP = 0b111,
} CMD;

}; // namespace CMD

namespace CH {

typedef enum CH : uint8_t {
  NONE = 0b000, // Used when DAC field is ignored
  A = 0b000,
  B = 0b001,
  C = 0b010,
  D = 0b011,
  ALL = 0b111,
} CH;

// MirrorPosition.ch[i] -> DAC channel. The D/C swap is intentional (driver
// board wiring) and must not be "fixed".
static constexpr CH ch[] = {CH::A, CH::B, CH::D, CH::C};

}; // namespace CH

static constexpr uint8_t head(CMD::CMD cmd, CH::CH ch) {
  return (static_cast<uint8_t>(cmd) << 3) | (static_cast<uint8_t>(ch));
}

// One AD5664R input-shift-register frame, 24 bits MSB first:
// 2 don't-care | 3 command | 3 address (channel) | 16 data.
typedef struct Word {
  uint8_t header;
  uint16_t value;
  constexpr Word(uint8_t header, uint16_t value)
      : header(header), value(value) {}
  constexpr Word(CMD::CMD cmd, CH::CH ch, uint16_t value = 0)
      : Word(head(cmd, ch), value) {}
  // The 24-bit frame as shifted out (bit 23 first).
  constexpr uint32_t frame() const {
    return (static_cast<uint32_t>(header) << 16) | value;
  }
} Word;

static_assert(Word(CMD::RESET, CH::NONE, 1).frame() == 0x280001);
static_assert(Word(CMD::WRITE_UPDATE_DAC, CH::ALL, 30000).frame() == 0x1F7530);

} // namespace SPI

// ---------------------------------------------------------------------------
// Bus — the two DAC buses, driven in lockstep.
// ---------------------------------------------------------------------------
namespace Bus {

// Lane index == Board::dac index == MEMS::Device bit (LEFT = bit 0).
constexpr unsigned LANES = 2;
// Longest batch in one call (enable() sends 5 frames); longer batches are
// split, which only inserts an extra SYNC-high gap.
constexpr size_t MAX_FRAMES = 8;

// Shift `n` frames out on both lanes concurrently: frame i goes to the left
// DAC as left[i] and to the right DAC as right[i]. A nullptr lane stays idle
// (its SYNC never falls). Each frame is a full SYNC-low..SYNC-high cycle;
// frames are separated by one half-period SYNC-high gap. Blocking: returns
// when the last SYNC edge is out (~2.4 us per frame at 10 MHz).
//
// Bus idle state between calls: SYNC high, SCLK low, MOSI low (SPI mode 1 —
// data changes on the rising edge, the AD5664R samples on the falling edge),
// which is exactly what Board::DacBus::init() leaves. The first call caches
// the lanes' GPIO registers (Board::init() must have run); every call
// re-asserts the idle levels before its first edge and re-derives the edge
// schedule from the live CPU clock.
void transmit(const uint32_t *left, const uint32_t *right, size_t n);

} // namespace Bus

} // namespace MEMS
