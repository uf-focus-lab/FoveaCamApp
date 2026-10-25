// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>
#include <core_pins.h>
#include <cstdint>
#include <type_traits>

#include "Board.h"
#include "Global.h"
#include "MEMS-SPI.h"
#include "MEMS.h"

namespace MEMS {

// =============================================================================
// Bus — lockstep bit-bang of the two AD5664R buses (see MEMS-SPI.h for why)
// =============================================================================
//
// Waveform per frame (SPI mode 1, every edge one SCLK half period apart):
//
//   SYNC  ‾‾\________________________ ... _________/‾‾‾
//   SCLK  __/‾‾\__/‾‾\__/‾‾\__/‾‾\___ ... __/‾‾\___ ___
//   MOSI  __X b23 X b22 X b21 X b20 X ... X b0  X___ ___
//           ^ SYNC falls with the first rising edge (t4 = one half period)
//                                             SYNC rises one half period
//                                             after the 24th falling edge
//                                             (t7), MOSI parks low with it.
//
// 24 rising + 24 falling + 1 SYNC-rise = 49 edges per frame; a frame takes
// 48 half periods (= 24 SCLK periods, 2.4 us at 10 MHz), plus one half period
// of SYNC high before the next frame's SYNC falls (t8/t9).
//
// Each edge is ONE store per lane to that lane's DR_TOGGLE register (a lane's
// three pins share a fast-GPIO port, verified in setup()); the toggle masks of
// a whole burst are precomputed, so the timed loop is load + store + poll.
//
// Interrupts: only the last few cycles before an edge's slot and the edge's
// two stores run with interrupts masked — ~20 CPU cycles worst case, so the
// strobe ISRs in Capture.cpp (which latch micros()) see at most ~35 ns of
// added latency at 600 MHz. An ISR that fires BETWEEN edges just stretches
// that SCLK phase on both lanes equally; the AD5664R has no minimum SCLK
// rate, so a stretched phase is harmless, and the schedule re-anchors so the
// following phase is shortened by at most a quarter period (and never below
// the AD5664R minimum).
namespace Bus {

namespace {

static_assert(Board::DAC_COUNT == LANES, "one bus lane per Board::dac entry");

// The register type behind portToggleRegister(): `volatile uint32_t` on the
// Teensy, the sim's recording proxy (test/fw-sim/shim/core_pins.h) on the
// host — one driver body for both.
using GpioReg = std::remove_pointer_t<decltype(portToggleRegister(0u))>;

struct Lane {
  GpioReg *set, *clear, *toggle;
  uint32_t cs, sclk, mosi; // bit masks within the lane's port
};

Lane lane[LANES];
bool ready = false;

constexpr size_t EDGES_PER_FRAME = 49;
constexpr size_t MAX_EDGES = MAX_FRAMES * EDGES_PER_FRAME;

// How long before an edge's slot interrupts get masked (CPU cycles). The
// masked window per edge is this + one coarse-poll iteration + two stores,
// ~20 cycles (~33 ns at 600 MHz) worst case. Interrupts are re-enabled for
// the rest of every half period, so a pending ISR is always taken between
// edges — never deferred to the end of a frame.
constexpr uint32_t IRQ_WINDOW_CYCLES = 8;

// Precomputed toggle masks for one burst. Static (not stack): the driver is
// only ever called from loop() context and is not reentrant.
uint32_t edges[LANES][MAX_EDGES];

#ifdef FOVEA_HOST_SIM
// Host: the shim's recursive-mutex pair (excludes injected strobe "ISRs").
inline uint32_t irqSave() {
  noInterrupts();
  return 0;
}
inline void irqRestore(uint32_t) { interrupts(); }
#else
// Save/restore PRIMASK rather than __disable_irq()/__enable_irq(), so a caller
// that already runs with interrupts masked stays masked.
inline uint32_t irqSave() {
  uint32_t primask;
  asm volatile("mrs %0, primask\n\tcpsid i" : "=r"(primask)::"memory");
  return primask;
}
inline void irqRestore(uint32_t primask) {
  asm volatile("msr primask, %0" ::"r"(primask) : "memory");
}
#endif

void setup() {
  for (unsigned i = 0; i < LANES; i++) {
    const auto &bus = Board::dac[i];
    Lane &l = lane[i];
    l.set = portSetRegister(bus.cs.number);
    l.clear = portClearRegister(bus.cs.number);
    l.toggle = portToggleRegister(bus.cs.number);
    // One store per lane per edge only works if CS, SCLK and MOSI sit on the
    // same GPIO port (true for the V0.1 map: GPIO9 / GPIO7). A board change
    // that splits a lane must change this driver, not silently mis-clock.
    if (portToggleRegister(bus.sclk.number) != l.toggle ||
        portToggleRegister(bus.mosi.number) != l.toggle)
      crash("MEMS bus: a lane's CS/SCLK/MOSI must share one GPIO port");
    l.cs = digitalPinToBitMask(bus.cs.number);
    l.sclk = digitalPinToBitMask(bus.sclk.number);
    l.mosi = digitalPinToBitMask(bus.mosi.number);
  }
  ready = true;
}

// Fill `e` with the 49 toggle masks per frame of `words` on lane `l`.
uint32_t *encode(uint32_t *e, const Lane &l, const uint32_t *words, size_t n) {
  for (size_t f = 0; f < n; f++) {
    const uint32_t w = words[f] & 0xFFFFFFu;
    // Bit j of x = b_j XOR b_(j+1), with b_24 = 0 (MOSI is parked low between
    // frames): whether MOSI must flip on the rising edge that presents b_j.
    const uint32_t x = w ^ (w >> 1);
    for (int j = 23; j >= 0; j--) {
      // Rising edge: present b_j (the first one of the frame also drops SYNC).
      *e++ = l.sclk | ((0u - ((x >> j) & 1u)) & l.mosi) | (j == 23 ? l.cs : 0);
      // Falling edge: the AD5664R samples b_j.
      *e++ = l.sclk;
    }
    // SYNC high; park MOSI low (flip iff b_0 was 1).
    *e++ = l.cs | ((0u - (w & 1u)) & l.mosi);
  }
  return e;
}

void burst(const uint32_t *left, const uint32_t *right, size_t n) {
  const uint32_t *src[LANES] = {left, right};
  const size_t count = n * EDGES_PER_FRAME;
  for (unsigned i = 0; i < LANES; i++) {
    if (src[i])
      encode(edges[i], lane[i], src[i], n);
    else
      for (size_t k = 0; k < count; k++)
        edges[i][k] = 0; // idle lane: toggling nothing is a no-op store
  }

  // Edge spacing from the LIVE CPU clock (F_CPU_ACTUAL follows
  // set_arm_clock()): ceil, so the clock is never faster than SCLK_HZ, and
  // never a phase shorter than the AD5664R minimum.
  const uint32_t cpu = F_CPU_ACTUAL;
  const uint32_t minPhase =
      (SPI::T_MIN_PHASE_NS * (cpu / 1000u) + 999'999u) / 1'000'000u;
  uint32_t half = (cpu + 2 * SPI::SCLK_HZ - 1) / (2 * SPI::SCLK_HZ);
  if (half < minPhase)
    half = minPhase;
  // Late-edge tolerance. An edge that lands up to `slack` cycles after its
  // slot (poll granularity) keeps the absolute schedule, so the on-wire clock
  // averages exactly SCLK_HZ. A later edge (an ISR between edges, or a loop
  // slower than the clock) re-anchors the schedule at `now - slack`: the next
  // phase is then >= half - slack — at most a quarter period short, and never
  // below T_MIN_PHASE_NS.
  uint32_t slack = half / 4;
  if (half - slack < minPhase)
    slack = half - minPhase;

  // Re-assert the idle levels so the toggles start from a known state (a
  // no-op on the wire when the bus is already idle).
  for (const Lane &l : lane) {
    *l.set = l.cs;
    *l.clear = l.sclk | l.mosi;
  }

  GpioReg *const tl = lane[0].toggle;
  GpioReg *const tr = lane[1].toggle;
  const uint32_t *el = edges[0];
  const uint32_t *er = edges[1];
  // The idle re-assertion counts as "the previous edge": the first SYNC fall
  // comes one half period later (>= t8 SYNC-high after any earlier frame).
  uint32_t t = ARM_DWT_CYCCNT;
  for (size_t k = 0; k < count; k++) {
    t += half;
    // Coarse wait with interrupts ENABLED, until IRQ_WINDOW_CYCLES before the
    // slot (an ISR here only delays the edge).
    while (static_cast<int32_t>(ARM_DWT_CYCCNT - t) <
           -static_cast<int32_t>(IRQ_WINDOW_CYCLES)) {
    }
    // Fine wait + the two stores in ONE masked window: the sampled `now` is
    // the edge time up to a fixed pipeline offset (no ISR can slip in
    // between), and both lanes' edges land within a few cycles of each other
    // — which is what makes the final APPLY_IREG edge shared.
    const uint32_t irq = irqSave();
    uint32_t now;
    while (static_cast<int32_t>((now = ARM_DWT_CYCCNT) - t) < 0) {
    }
    *tl = el[k];
    *tr = er[k];
    irqRestore(irq);
    if (now - t > slack)
      t = now - slack; // late: re-anchor, never compress past the slack
  }
}

} // namespace

void transmit(const uint32_t *left, const uint32_t *right, size_t n) {
  if (!ready)
    setup();
  while (n > 0) {
    const size_t chunk = n < MAX_FRAMES ? n : MAX_FRAMES;
    burst(left, right, chunk);
    if (left)
      left += chunk;
    if (right)
      right += chunk;
    n -= chunk;
  }
}

} // namespace Bus

// =============================================================================
// AD5664R command layer
// =============================================================================

namespace {

using namespace SPI;

constexpr uint32_t frame(CMD::CMD cmd, CH::CH ch, uint16_t value = 0) {
  return Word(cmd, ch, value).frame();
}

// "Broadcast": the same frames on both buses, in lockstep.
inline void broadcast(const uint32_t *words, size_t n) {
  Bus::transmit(words, words, n);
}

MirrorPosition staged[Bus::LANES];
uint8_t stagedMask = Device::NONE;

} // namespace

void enable() {
  INFO("MEMS Enable");
  // 0x280001 FULL RESET, on its own. The AD5664R data sheet gives no
  // post-reset settling for the serial interface; the V0.0 driver always had
  // several us between frames, so keep a few us here (enable is rare).
  const uint32_t reset = frame(CMD::RESET, CH::NONE, 1);
  broadcast(&reset, 1);
  delayMicroseconds(5);
  const uint32_t init[] = {
      // 0x380001 ENABLE INTERNAL REFERENCE
      frame(CMD::INT_REF_SETUP, CH::NONE, 1),
      // 0x20000F ENABLE ALL DAC Channels
      frame(CMD::DAC_POWER, CH::NONE, 0b1111),
      // 0x300000 ENABLE SOFTWARE LDAC
      frame(CMD::LDAC_SETUP, CH::NONE, 0),
      // Set V_BIAS to Neutral (all channels, write + update)
      frame(CMD::WRITE_UPDATE_DAC, CH::ALL, Global::bias_voltage),
  };
  broadcast(init, sizeof(init) / sizeof(init[0]));
  // Any staged-but-unapplied target predates the RESET; drop it.
  stagedMask = Device::NONE;
};

void disable() {
  INFO("MEMS Disable");
  // Set V_BIAS to Neutral (all channels, write + update)
  const uint32_t bias =
      frame(CMD::WRITE_UPDATE_DAC, CH::ALL, Global::bias_voltage);
  broadcast(&bias, 1);
  stagedMask = Device::NONE;
}

void set(Device device, const MirrorPosition &pos) {
  for (unsigned i = 0; i < Bus::LANES; i++)
    if (device & (1u << i))
      staged[i] = pos;
  stagedMask |= device;
}

void apply() {
  if (stagedMask == Device::NONE)
    return;
  // Per mirror: channels A, B, D into the input registers, then channel C with
  // APPLY_IREG (write input register n + update ALL DAC registers) — the four
  // outputs change together on that frame's 24th falling edge, and with both
  // buses in lockstep both mirrors change within a few CPU cycles of each
  // other. 4 frames ≈ 9.7 us at 10 MHz for both mirrors.
  uint32_t words[Bus::LANES][4];
  for (unsigned i = 0; i < Bus::LANES; i++) {
    if (!(stagedMask & (1u << i)))
      continue;
    for (unsigned c = 0; c < 4; c++)
      words[i][c] = frame(c < 3 ? CMD::WRITE_IREG : CMD::APPLY_IREG, CH::ch[c],
                          staged[i].ch[c]);
  }
  Bus::transmit((stagedMask & Device::LEFT) ? words[0] : nullptr,
                (stagedMask & Device::RIGHT) ? words[1] : nullptr, 4);
  stagedMask = Device::NONE;
}

} // namespace MEMS
