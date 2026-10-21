// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Host HAL implementation: the Arduino/GPIO surface the real firmware TUs run
// against. Everything is
// recorded rather than actuated — pin writes go to a level table (+ the
// main.cpp hook for trigger/enable observability), fast-GPIO register writes
// (the MEMS bus bit-bang) go through a Teensy 4.0 port model whose bus
// decoder commits DAC words to the control plane, micros() runs off the
// steady clock, and noInterrupts()/interrupts() is a recursive-mutex pair
// shared with the injected strobe "ISRs".

#include <cerrno>
#include <chrono>
#include <cstdarg>
#include <mutex>
#include <poll.h>
#include <thread>
#include <unistd.h>

#include <Arduino.h>
#include <core_pins.h>

#include "sim.h"

#include "Board.h" // Board::dac lane pins (MEMS bus decoder)

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
  // Board::fclk.tone()/noTone() land here — surface the duty so
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

// --- Fast-GPIO port model + MEMS bus decoder --------------------------------------

namespace {

// Teensy 4.0 pin -> fast-GPIO port/bit (teensy4/core_pins.h CORE_PINn_BIT,
// GPIO6/7/9 after the startup GPR26..29 remap). Pins past 23 are unmapped
// (mask 0): register writes never reach them.
struct PortBit {
  uint8_t port;
  uint8_t bit;
};
constexpr PortBit PORT_MAP[] = {
    {6, 3},  {6, 2},  {9, 4},  {9, 5},  {9, 6},  {9, 8},  {7, 10}, {7, 17},
    {7, 16}, {7, 11}, {7, 0},  {7, 2},  {7, 1},  {7, 3},  {6, 18}, {6, 19},
    {6, 23}, {6, 22}, {6, 17}, {6, 16}, {6, 26}, {6, 27}, {6, 24}, {6, 25},
};
constexpr unsigned MAPPED_PINS = sizeof(PORT_MAP) / sizeof(PORT_MAP[0]);
constexpr unsigned PORTS = 10;

HostGpioReg *gpioReg(unsigned pin, HostGpioReg::Op op) {
  static HostGpioReg regs[PORTS][3];
  static const bool ready = [] {
    for (unsigned p = 0; p < PORTS; p++)
      for (unsigned o = 0; o < 3; o++)
        regs[p][o] = {static_cast<uint8_t>(p), static_cast<HostGpioReg::Op>(o)};
    return true;
  }();
  (void)ready;
  // Unmapped pins land on port 0, which no mapped pin uses: a write is a no-op.
  const uint8_t port = pin < MAPPED_PINS ? PORT_MAP[pin].port : 0;
  return &regs[port][op];
}

// One decoded AD5664R bus (Board::dac[lane]): SYNC low opens a frame, every
// SCLK FALLING edge shifts MOSI in (the DAC's sampling edge), SYNC high
// closes it. A frame that is not exactly 24 bits, or MOSI changing ON a
// falling edge (a setup/hold violation), is reported as a `dac-error` line
// and never becomes a DAC word.
struct DacLane {
  bool selected = false;
  bool pending = false; // a closed 24-bit frame waiting for the pair flush
  bool setupViolation = false;
  unsigned bits = 0;
  uint32_t shift = 0;
  uint32_t word = 0;
};
DacLane dacLanes[2];

struct LaneLevels {
  uint8_t cs, sclk, mosi;
};

LaneLevels laneLevels(unsigned lane) {
  const auto &bus = Board::dac[lane];
  return {pins[bus.cs.number].level, pins[bus.sclk.number].level,
          pins[bus.mosi.number].level};
}

void emitDacWord(uint8_t csMask, uint32_t word) {
  const uint8_t bytes[3] = {static_cast<uint8_t>(word >> 16),
                            static_cast<uint8_t>(word >> 8),
                            static_cast<uint8_t>(word)};
  Sim::onDacWord(csMask, bytes, sizeof(bytes));
}

// One register store's effect on both lanes. Within a store the order is:
// SYNC fall, SCLK fall (samples the PRE-store MOSI), SYNC rise.
void decodeDacStore(const LaneLevels (&before)[2]) {
  static const char LANE[] = {'L', 'R'};
  for (unsigned i = 0; i < 2; i++) {
    const LaneLevels now = laneLevels(i);
    DacLane &d = dacLanes[i];
    if (before[i].cs == HIGH && now.cs == LOW) {
      d.selected = true;
      d.setupViolation = false;
      d.bits = 0;
      d.shift = 0;
    }
    if (d.selected && before[i].sclk == HIGH && now.sclk == LOW) {
      if (before[i].mosi != now.mosi)
        d.setupViolation = true;
      d.shift = (d.shift << 1) | (before[i].mosi ? 1u : 0u);
      d.bits++;
    }
    if (d.selected && before[i].cs == LOW && now.cs == HIGH) {
      d.selected = false;
      if (d.bits == 24 && !d.setupViolation) {
        d.pending = true;
        d.word = d.shift & 0xFFFFFFu;
      } else {
        Sim::emit("dac-error cs=%c bits=%u setup=%s", LANE[i], d.bits,
                  d.setupViolation ? "violated" : "ok");
      }
    }
  }
  // Pair flush once both lanes are idle: the bit-bang closes both frames on
  // the same lockstep edge (left store, then right store), so a frame that
  // went out on both buses is emitted once — `cs=LR` when the words match,
  // `cs=L` then `cs=R` when they differ; a single-lane frame as itself.
  DacLane &l = dacLanes[0], &r = dacLanes[1];
  if (l.selected || r.selected || !(l.pending || r.pending))
    return;
  if (l.pending && r.pending && l.word == r.word) {
    emitDacWord(3, l.word);
  } else {
    if (l.pending)
      emitDacWord(1, l.word);
    if (r.pending)
      emitDacWord(2, r.word);
  }
  l.pending = r.pending = false;
}

bool isDacPin(unsigned pin) {
  for (const auto &bus : Board::dac)
    if (pin == bus.cs.number || pin == bus.sclk.number ||
        pin == bus.mosi.number)
      return true;
  return false;
}

uint32_t cycleCounter = 0;

} // namespace

HostGpioReg *portSetRegister(unsigned pin) {
  return gpioReg(pin, HostGpioReg::SET);
}
HostGpioReg *portClearRegister(unsigned pin) {
  return gpioReg(pin, HostGpioReg::CLEAR);
}
HostGpioReg *portToggleRegister(unsigned pin) {
  return gpioReg(pin, HostGpioReg::TOGGLE);
}
uint32_t digitalPinToBitMask(unsigned pin) {
  return pin < MAPPED_PINS ? (1u << PORT_MAP[pin].bit) : 0u;
}

void HostGpioReg::operator=(uint32_t mask) {
  const LaneLevels before[2] = {laneLevels(0), laneLevels(1)};
  bool touchedDac = false;
  for (unsigned pin = 0; pin < MAPPED_PINS; pin++) {
    if (PORT_MAP[pin].port != port || !(mask & (1u << PORT_MAP[pin].bit)))
      continue;
    const uint8_t old = pins[pin].level;
    const uint8_t val =
        op == SET ? HIGH : op == CLEAR ? LOW : (old == HIGH ? LOW : HIGH);
    if (val == old)
      continue;
    pins[pin].level = val;
    touchedDac |= isDacPin(pin);
    Sim::onPinWrite(pin, val); // same observability as digitalWrite()
  }
  if (touchedDac)
    decodeDacStore(before);
}

// Each read advances a few "cycles", so the driver's busy-waits end after a
// couple of polls. Host timing is meaningless here; only edge ORDER matters.
uint32_t hostCycleCount() { return cycleCounter += 4; }

// --- Control-plane emit -------------------------------------------------------------

void Sim::emit(const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  std::vprintf(fmt, args);
  va_end(args);
  std::putchar('\n');
  std::fflush(stdout); // stdout is a pipe (fully buffered) — flush per line
}
