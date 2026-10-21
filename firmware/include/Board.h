// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// FoveaCam Duo Driver board V0.1 (pcb/ submodule, uf-focus-lab/DuoController
// master, tag v0.1.2). Pin numbers are Teensy 4.0 digital pins and come from
// the GENERATED map pcb/board/pins.h — when the board changes, regenerate that
// file and update the constants here; nothing else in the firmware may hold a
// pin number. Board-level notes: pcb/board/specs.md §3 (pin map, SPI buses,
// freeze analysis) and §6 (firmware notes).
//
// Differences from the V0.0 hand-drawn board this firmware used to run on:
//   * one independent SPI bus per MEMS driver (FlexIO1 / FlexIO2 pins), CS as
//     plain GPIO — no shared, branched bus;
//   * MEMS_EN moved to pin 6 (held LOW by the RT1062 through reset);
//   * all four camera GPIO lines are cabled on all three cameras, the center
//     camera included — triggering now uses the NON-isolated lines;
//   * pin 13 (LED) is the CAM2 trigger output: there is no free LED.

#include "Global.h"
#include "core_pins.h"
#include <pins_arduino.h>

namespace Board {

template <unsigned Mode = INPUT_DISABLE, unsigned InitVal = LOW> class Pin {
public:
  const unsigned number;
  inline constexpr Pin(unsigned num) : number(num) {};
  inline void init() const {
    switch (Mode) {
    case INPUT:
    case INPUT_PULLUP:
    case INPUT_PULLDOWN:
      pinMode(number, Mode);
      break;
    case OUTPUT:
    case OUTPUT_OPENDRAIN:
      pinMode(number, Mode);
      digitalWrite(number, InitVal);
      break;
    default:
      pinMode(number, INPUT_DISABLE);
    }
  }
  inline uint8_t read() const { return digitalRead(number); }
  inline void write(uint8_t val) const {
    static_assert(Mode == OUTPUT || Mode == OUTPUT_OPENDRAIN,
                  "Pin::write: Pin not configured as output");
    VERB("digitalWrite(%u, %u)", number, val);
    digitalWrite(number, val);
  }
  inline void freq(float freq) const {
    static_assert(Mode == OUTPUT || Mode == OUTPUT_OPENDRAIN,
                  "Pin::freq: Pin not configured as output");
    VERB("analogWriteFrequency(%u, %f)", number, freq * 60.0f);
    analogWriteFrequency(number, freq * 60.0f); // Teensy uses 60x frequency
  }
  inline void tone(uint8_t duty_cycle = 128) const {
    static_assert(Mode == OUTPUT || Mode == OUTPUT_OPENDRAIN,
                  "Pin::tone: Pin not configured as output");
    VERB("analogWrite(%u, %u)", number, duty_cycle);
    analogWrite(number, duty_cycle);
  }
  inline void noTone() const {
    static_assert(Mode == OUTPUT || Mode == OUTPUT_OPENDRAIN,
                  "Pin::noTone: Pin not configured as output");
    VERB("analogWrite(%u, %u)", number, 0);
    analogWrite(number, 0);
  }
};

// ---------------------------------------------------------------------------
// MEMS drivers (Mirrorcle digital-input driver, AD5664R DAC, J_SPI1 / J_SPI2)
// ---------------------------------------------------------------------------

// One point-to-point SPI bus per driver. SCLK/MOSI sit on FlexIO-capable pins
// (DRV1 = FlexIO1 D05/D06, DRV2 = FlexIO2 D01/D02) so either a FlexIO SPI
// peripheral or GPIO bit-banging can drive them; CS (the AD5664R SYNC) is a
// plain GPIO, LOW = selected, and must be LOW for the whole 24-bit frame and
// HIGH between frames. No MISO: the driver has no data output.
// Pads: reduced drive strength + slow slew on every bus pin (specs.md §6).
struct DacBus {
  const Pin<OUTPUT, HIGH> cs; // SYNC, active LOW
  const Pin<OUTPUT, LOW> sclk;
  const Pin<OUTPUT, LOW> mosi;
  inline void init() const {
    cs.init();
    sclk.init();
    mosi.init();
  }
};

constexpr unsigned SELECT = LOW;
constexpr unsigned UNSELECT = HIGH;

constexpr DacBus dac[] = {
    {{2}, {3}, {4}},   // DRV1 — Left Fovea Mirror  (J_SPI1): CS1, SCLK1, MOSI1
    {{9}, {12}, {11}}, // DRV2 — Right Fovea Mirror (J_SPI2): CS2, SCLK2, MOSI2
};
constexpr unsigned DAC_COUNT = sizeof(dac) / sizeof(dac[0]);

// Shared driver enable (J_SPI1.5 + J_SPI2.5). GPIO_B0_10 has a 100k pull-down
// through reset and a keeper afterwards, so the drivers stay off until
// firmware drives it. Sequence (Mirrorcle guide p27/p31): LOW first thing in
// setup(); raise only after DAC init, Vbias on all channels and FCLK running;
// drop before stopping FCLK or the SPI.
constexpr unsigned ENABLE = HIGH;
constexpr unsigned DISABLE = LOW;
constexpr Pin<OUTPUT, DISABLE> enable{6};

// Shared filter clock for both drivers and both axes (J_SPI1.9/.10,
// J_SPI2.9/.10): 50 % square wave at 60x the low-pass cut-off, 3 kHz..3 MHz.
// `freq()` applies the 60x; `tone()`/`noTone()` start/stop it.
constexpr Pin<OUTPUT> fclk{10};

// ---------------------------------------------------------------------------
// Cameras (FLIR Blackfly S GPIO, J_CAM0..2, all four lines cabled 1:1)
// ---------------------------------------------------------------------------

// Camera-side line map (FLIR BFS): Line0 = opto-isolated input, Line1 =
// opto-isolated output (open collector, pulls LOW only), Line2 = non-isolated
// bidirectional 3.3 V, Line3 = non-isolated bidirectional 3.3 V that doubles
// as the camera's 8-24 V VAUX power input.
//
// This board uses the NON-isolated lines for triggering (no opto edge lag,
// a real logic level in both directions):
//   trigger: Teensy OUTPUT -> camera Line2 (host sets TriggerSource=Line2)
//   strobe:  Teensy INPUT  <- camera Line3 (host sets Line3 = ExposureActive)
// Line3 is the strobe (an input on our side) on purpose: the Teensy pin must
// never drive Line3 — a pin is 3.6 V abs. max and that net is the camera's
// VAUX input — so it is INPUT from boot and stays so (pcb/board/pins.h).
// The opto pair stays cabled; `opto_trigger`/`opto_strobe` keep the old pins
// reachable for a bench fallback but Capture does not use them.
//
// STROBE_ACTIVE_LEVEL: the level read on `strobe` while the camera exposes.
// Non-isolated ExposureActive asserts HIGH (host leaves LineInverter off);
// the opto output, if ever used instead, asserts LOW against the pull-up.
// Verify on the bench with a scope before the first synced capture.
constexpr uint8_t STROBE_ACTIVE_LEVEL = HIGH;
constexpr uint8_t OPTO_STROBE_ACTIVE_LEVEL = LOW;

struct CameraPinout {
  const Pin<OUTPUT> trigger;             // -> camera Line2 (CAMn_L2)
  const Pin<INPUT_PULLUP> strobe;        // <- camera Line3 (CAMn_L3)
  const Pin<INPUT_DISABLE> opto_trigger; // -> camera Line0 (CAMn_IN), unused
  const Pin<INPUT_PULLUP> opto_strobe;   // <- camera Line1 (CAMn_OUT), unused
  inline void init() const {
    trigger.init();
    strobe.init();
    opto_trigger.init();
    opto_strobe.init();
  }
};

// Index == Packet::Command camera bit order: 0 = C, 1 = L, 2 = R.
//                 L2    L3    L0    L1
constexpr CameraPinout camera[] = {
    {{18}, {16}, {17}, {19}}, // CAM0 - Center      (J_CAM0)
    {{22}, {20}, {21}, {23}}, // CAM1 - Left Fovea  (J_CAM1)
    {{14}, {5}, {13}, {15}},  // CAM2 - Right Fovea (J_CAM2)
};
constexpr unsigned CAMERA_COUNT = sizeof(camera) / sizeof(camera[0]);

// No status LED: pin 13 (LED_BUILTIN) is CAM2's opto trigger line on this
// board, so nothing may blink it.

// ---------------------------------------------------------------------------
// Pad control (IOMUXC SW_PAD_CTL_PAD_*, specs.md §6, Mirrorcle guide p10)
// ---------------------------------------------------------------------------
// pinMode(OUTPUT) leaves a pad at DSE 7 (the strongest drive, R0/7 ~ 21 ohm)
// with the default slew. Into a 152 mm ribbon cable that rings and couples
// (SCK sits between SYN and FCLK_X in the IDC cable), so the DAC buses get a
// series-terminating drive strength and slow slew, and FCLK the weakest
// drive. DSE 1/2/3 = R0/1..3 ~ 150/75/50 ohm; SRE 0 = slow slew; SPEED 0 = 50 MHz
// (plenty for SCLK <= 25 MHz). No keeper/pull (PKE 0): these are push-pull
// outputs. Tune BUS_PAD_DSE on the bench against a scope.
constexpr uint32_t BUS_PAD_DSE = 2;  // SCLKn / MOSIn / CSn, 1..3
constexpr uint32_t FCLK_PAD_DSE = 1; // FCLK

// Must run AFTER every pinMode() on these pins — pinMode rewrites the pad
// register (analogWrite()/analogWriteFrequency() only touch the mux, so FCLK
// keeps its pad through tone()/noTone()). init() calls it last.
inline void padSetup() {
#ifndef FOVEA_HOST_SIM
  const uint32_t bus = IOMUXC_PAD_DSE(BUS_PAD_DSE) | IOMUXC_PAD_SPEED(0);
  for (const auto &b : dac) {
    *portControlRegister(b.cs.number) = bus;
    *portControlRegister(b.sclk.number) = bus;
    *portControlRegister(b.mosi.number) = bus;
  }
  *portControlRegister(fclk.number) =
      IOMUXC_PAD_DSE(FCLK_PAD_DSE) | IOMUXC_PAD_SPEED(0);
#endif
}

inline void init() {
  enable.init();
  enable.write(DISABLE); // first thing: drivers stay off until MEMS::enable()
  for (const auto &bus : dac)
    bus.init();
  fclk.init();
  for (const auto &cam : camera)
    cam.init();
  padSetup(); // last: pinMode() above reset these pads to DSE 7
}

} // namespace Board
