// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Protocol/Packet.h>

#include "Board.h"
#include "Global.h"

namespace COBS {

RX rx;
TX tx;

} // namespace COBS

namespace Global {

// Wide (uint64) counter, narrow (uint32, matching micros()'s own return type)
// anchor: update()'s elapsed-since-anchor subtraction stays a uint32
// wraparound-correct delta;
// only the accumulating counter is widened, so wrap handling stays entirely
// here (never leaks into Protocol::Timestamp math on the host or firmware
// side).
Time<micros, uint64_t> time;

bool system_enabled = false;

using Packet::Config::Log;
Log::Level log_level = Log::INFO;

uint16_t lpf_frequency = 0;

uint16_t bias_voltage = 0;

} // namespace Global

char log_buffer[COBS::MaxPacketSize];

void crash(std::string err) {
  // Unrecoverable: park the drivers (enable LOW) and repeat the message. No
  // LED blink — pin 13 is a camera line on the V0.1 board (Board.h).
  Board::enable.write(Board::DISABLE);
  while (true) {
    Serial.println(err.c_str());
    delay(1000);
  }
}
