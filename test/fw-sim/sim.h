// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Internal seam between the HAL shim (hal.cpp — Arduino/SPI surface) and the
// sim pump (main.cpp — pty owner, control channel, strobe scheduler).

#pragma once

#include <cstddef>
#include <cstdint>

namespace Sim {

// The pty MASTER fd (O_NONBLOCK), wired by main() before setup(). The shim
// Serial reads/writes it.
extern int serialFd;

// Host-side 64-bit steady-clock microseconds since process start (never
// wraps in practice; the 32-bit Arduino micros() truncates this).
uint64_t nowUs();

// Control-plane line to stdout (printf-style), '\n'-terminated + flushed —
// the driving test consumes these (pty path, dac words, pin edges, acks).
void emit(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

// --- hal → main hooks (defined in main.cpp) ---------------------------------
// A recorded OUTPUT pin write that CHANGED the pin level — main emits the
// `pin` line and schedules strobe edges off camera-trigger rises.
void onPinWrite(unsigned pin, uint8_t level);
// One decoded MEMS bus frame (a 3-byte DAC word, hal.cpp bus decoder);
// `csMask` bit0 = left bus (Board::dac[0]), bit1 = right; 3 = the same word
// went out on both buses in the same lockstep frame.
void onDacWord(uint8_t csMask, const uint8_t *bytes, size_t len);

// --- main → hal (defined in hal.cpp) ----------------------------------------
// Strobe-edge injection: set an INPUT pin's level (no ISR side effects)...
void setInputPin(unsigned pin, uint8_t level);
uint8_t pinLevel(unsigned pin);
// ...then fire the attachInterrupt() handler registered on that pin (no-op if
// none). Takes the noInterrupts() recursive mutex — firmware critical
// sections exclude injected edges exactly like cli/sei on the MCU.
void fireIsr(unsigned pin);

} // namespace Sim
