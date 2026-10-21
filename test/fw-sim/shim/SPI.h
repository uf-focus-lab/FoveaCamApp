// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Host <SPI.h> shim — INERT. The firmware no longer uses the Arduino SPI
// library: the V0.1 board's two MEMS DAC buses are bit-banged in lockstep
// (firmware/src/MEMS.cpp) and the sim decodes their waveform from the GPIO
// register model (shim core_pins.h + hal.cpp). Only `SPI.begin()` survives,
// for the sim's setup() mirror in test/fw-sim/main.cpp; drop this header once
// that mirror no longer calls it.

#pragma once

class SPIClass {
public:
  void begin() {}
};

extern SPIClass SPI;
