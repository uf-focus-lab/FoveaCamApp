// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "Global.h"
#include "core_pins.h"
#include <pins_arduino.h>

namespace Board {

namespace SPI {
constexpr unsigned MOSI = 11;
constexpr unsigned MISO = 12; // Not connected
constexpr unsigned SCLK = 13;
} // namespace SPI

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

constexpr unsigned LED_ON = HIGH;
constexpr unsigned LED_OFF = LOW;
constexpr Pin<OUTPUT, LED_OFF> led{LED_BUILTIN};

constexpr unsigned ENABLE = HIGH;
constexpr unsigned DISABLE = LOW;
constexpr Pin<OUTPUT, DISABLE> enable{15};

// Controller side of each camera's opto GPIO pair: `trigger` drives the
// camera's trigger INPUT pin, `strobe` reads the camera's strobe OUTPUT pin.
// The camera's opto output is an open-collector sink referenced to opto GND —
// it only pulls low, so the strobe pin must supply its own pull-up (3.3V
// internal; the pin is not 5V tolerant) or it floats. Line idles HIGH.
typedef struct CameraPinout {
  const Pin<OUTPUT> trigger;
  const Pin<INPUT_PULLUP> strobe;
  inline void init() const {
    trigger.init();
    strobe.init();
  }
} CameraPinout;

constexpr CameraPinout camera[] = {
    {{20}, {21}}, // CAM0 - Center
    {{22}, {23}}, // CAM1 - Left Fovea
    {{18}, {19}}, // CAM2 - Right Fovea
};

constexpr unsigned SELECT = LOW;
constexpr unsigned UNSELECT = HIGH;
constexpr Pin<OUTPUT, UNSELECT> mems_cs[] = {
    {9},  // CS1 - Left Fovea Mirror
    {10}, // CS2 - Right Fovea Mirror
};

constexpr Pin<OUTPUT> low_pass_filter{14};

inline void init() {
  enable.init();
  enable.write(DISABLE);
  for (const auto &pin : camera)
    pin.init();
  for (const auto &pin : mems_cs)
    pin.init();
  low_pass_filter.init();
}

} // namespace Board
