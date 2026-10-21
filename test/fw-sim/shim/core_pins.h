// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Host stand-in for Teensy's <core_pins.h> (firmware-sim-harness): the pin
// API + constants live in the shim <Arduino.h>; this header adds the
// fast-GPIO register surface the MEMS bus bit-bang (firmware/src/MEMS.cpp)
// drives, plus the DWT cycle counter and CPU clock it schedules edges with.
//
// GPIO registers are modelled per Teensy 4.0 port: portSet/Clear/Toggle
// Register(pin) return a proxy whose `*reg = mask` applies the SET/CLEAR/
// TOGGLE to every pin of that port in the mask (test/fw-sim/hal.cpp, same
// pin -> port/bit map as the real core), updates the shared pin-level table,
// and feeds the MEMS bus decoder that turns the SYNC/SCLK/MOSI waveform back
// into `dac cs=<L|R|LR> <hex24>` control-plane lines. The firmware driver is
// therefore exercised bit for bit on the host.

#pragma once

#include <Arduino.h>

// One fast-GPIO write register (DR_SET / DR_CLEAR / DR_TOGGLE) of one port.
struct HostGpioReg {
  enum Op : uint8_t { SET, CLEAR, TOGGLE };
  uint8_t port;
  Op op;
  void operator=(uint32_t mask); // hal.cpp
};

HostGpioReg *portSetRegister(unsigned pin);
HostGpioReg *portClearRegister(unsigned pin);
HostGpioReg *portToggleRegister(unsigned pin);
uint32_t digitalPinToBitMask(unsigned pin);

// ARM DWT cycle counter: advances a fixed step per read on the host, so the
// driver's busy-wait edge schedule terminates without burning wall time.
uint32_t hostCycleCount();
#define ARM_DWT_CYCCNT (hostCycleCount())

#ifndef F_CPU
#define F_CPU 600000000
#endif
#define F_CPU_ACTUAL (static_cast<uint32_t>(F_CPU))
