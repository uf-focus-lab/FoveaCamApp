// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Host HAL implementation: the Arduino/SPI surface the real firmware TUs run
// against. Everything is
// recorded rather than actuated — pin writes go to a level table (+ the
// main.cpp hook for trigger/enable observability), MEMS-SPI transactions
// commit DAC words to the control plane, micros() runs off the steady clock,
// and noInterrupts()/interrupts() is a recursive-mutex pair shared with the
// injected strobe "ISRs".

#include <cerrno>
#include <chrono>
#include <cstdarg>
#include <mutex>
#include <poll.h>
#include <thread>
#include <unistd.h>

#include <Arduino.h>
#include <SPI.h>

#include "sim.h"

// --- Time ----------------------------------------------------------------------

namespace {
const auto processEpoch = std::chrono::steady_clock::now();
}

uint64_t Sim::nowUs() {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now() - processEpoch)
          .count());
}

uint32_t micros() { return static_cast<uint32_t>(Sim::nowUs()); }

void delay(uint32_t ms) {
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}
void delayMicroseconds(uint32_t us) {
  std::this_thread::sleep_for(std::chrono::microseconds(us));
}
void delayNanoseconds(uint32_t ns) {
  // AD5664R CS setup margins are meaningless on host — record nothing, spin
  // nothing (a 20 ns sleep would round up to a scheduler quantum anyway).
  (void)ns;
}

// --- GPIO -----------------------------------------------------------------------

namespace {

constexpr unsigned PIN_COUNT = 64;

struct PinState {
  uint8_t mode = INPUT_DISABLE;
  uint8_t level = LOW;
  void (*isr)() = nullptr;
};

PinState pins[PIN_COUNT];

// The noInterrupts()/interrupts() pair. Recursive: firmware code may nest
// critical sections, and an injected ISR firing from the pump thread while
// that same thread holds the lock must not deadlock (single-threaded today;
// the mutex keeps the seam correct if injection ever moves to a thread).
std::recursive_mutex irqMutex;

} // namespace

void pinMode(unsigned pin, unsigned mode) {
  if (pin >= PIN_COUNT)
    return;
  pins[pin].mode = static_cast<uint8_t>(mode);
  // An input with a pull resistor and nothing driving it sits at the rail the
  // resistor pulls to — the level the firmware reads before any injected edge.
  if (mode == INPUT_PULLUP)
    pins[pin].level = HIGH;
  else if (mode == INPUT_PULLDOWN)
    pins[pin].level = LOW;
}

void digitalWrite(unsigned pin, uint8_t val) {
  if (pin >= PIN_COUNT)
    return;
  val = val ? HIGH : LOW;
  if (pins[pin].level == val)
    return; // record CHANGES only — re-writes are electrically invisible
  pins[pin].level = val;
  Sim::onPinWrite(pin, val);
}

uint8_t digitalRead(unsigned pin) {
  return pin < PIN_COUNT ? pins[pin].level : LOW;
}

void analogWrite(unsigned pin, unsigned duty) {
  // Board::low_pass_filter.tone()/noTone() land here — surface the duty so
  // the test can watch the LPF drive toggle with Enable.
  Sim::emit("pwm pin=%u duty=%u", pin, duty);
}

void analogWriteFrequency(unsigned pin, float freq) {
  Sim::emit("pwm pin=%u freq=%.1f", pin, static_cast<double>(freq));
}

void attachInterrupt(unsigned pin, void (*isr)(), int mode) {
  (void)mode; // firmware only uses CHANGE; the injector fires on every edge
  if (pin < PIN_COUNT)
    pins[pin].isr = isr;
}

void noInterrupts() { irqMutex.lock(); }
void interrupts() { irqMutex.unlock(); }

void Sim::setInputPin(unsigned pin, uint8_t level) {
  if (pin < PIN_COUNT)
    pins[pin].level = level ? HIGH : LOW;
}

uint8_t Sim::pinLevel(unsigned pin) { return digitalRead(pin); }

void Sim::fireIsr(unsigned pin) {
  if (pin >= PIN_COUNT || !pins[pin].isr)
    return;
  std::lock_guard<std::recursive_mutex> hold(irqMutex);
  pins[pin].isr();
}

[[noreturn]] void _reboot_Teensyduino_() {
  Sim::emit("reboot");
  std::exit(0);
}

// --- Serial (pty master) ---------------------------------------------------------

int Sim::serialFd = -1;

HostSerial Serial;

void HostSerial::begin(unsigned long baud) { (void)baud; }

int HostSerial::available() {
  if (rxHead < rxLen)
    return static_cast<int>(rxLen - rxHead);
  rxHead = rxLen = 0;
  const ssize_t n = ::read(Sim::serialFd, rxBuf, sizeof(rxBuf));
  if (n > 0)
    rxLen = static_cast<size_t>(n);
  return static_cast<int>(rxLen);
}

int HostSerial::read() {
  if (rxHead >= rxLen && available() == 0)
    return -1;
  return rxBuf[rxHead++];
}

size_t HostSerial::write(const uint8_t *data, size_t len) {
  size_t off = 0;
  int stalls = 0;
  while (off < len) {
    const ssize_t n = ::write(Sim::serialFd, data + off, len - off);
    if (n > 0) {
      off += static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && errno == EINTR)
      continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      // pty buffer full (peer not draining). Bounded wait, then drop the
      // remainder — the sim must never wedge on an absent host.
      if (++stalls > 20)
        break;
      pollfd p{Sim::serialFd, POLLOUT, 0};
      ::poll(&p, 1, 50);
      continue;
    }
    break; // EIO etc. — peer gone
  }
  return off;
}

size_t HostSerial::println(const char *s) {
  // Only the crash() path prints text — mirror it onto the control plane too,
  // where the driving test can actually see it.
  Sim::emit("serial-println %s", s);
  const size_t n = write(reinterpret_cast<const uint8_t *>(s), strlen(s));
  const uint8_t crlf[2] = {'\r', '\n'};
  return n + write(crlf, 2);
}

// --- SPI (MEMS DAC-word capture) --------------------------------------------------

SPIClass SPI;

void SPIClass::begin() {}

void SPIClass::beginTransaction(const SPISettings &settings) {
  (void)settings;
  inTransaction = true;
  wordLen = 0;
}

uint8_t SPIClass::transfer(uint8_t byte) {
  // Transfers outside a transaction are MEMS.cpp's 8-cycle delay byte — not
  // part of any DAC word.
  if (inTransaction && wordLen < sizeof(word))
    word[wordLen++] = byte;
  return 0; // MISO is not connected on the board (Board::SPI::MISO comment)
}

void SPIClass::endTransaction() {
  if (!inTransaction)
    return;
  inTransaction = false;
  // CS pins are still asserted here: MEMS::send() deselects only after
  // Word::send() returns. Board::mems_cs = {9, 10}, LOW = selected.
  const uint8_t csMask = static_cast<uint8_t>((digitalRead(9) == LOW ? 1 : 0) |
                                              (digitalRead(10) == LOW ? 2 : 0));
  Sim::onDacWord(csMask, word, wordLen);
}

// --- Control-plane emit -------------------------------------------------------------

void Sim::emit(const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  std::vprintf(fmt, args);
  va_end(args);
  std::putchar('\n');
  std::fflush(stdout); // stdout is a pipe (fully buffered) — flush per line
}
