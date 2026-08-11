// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// fovea-fw-sim: a host binary running the REAL firmware translation units — firmware/src/{Protocol,
// Streams,Capture,Global,MEMS}.cpp — behind the thin HAL shim (hal.cpp /
// shim/*.h). Owns a pty pair (prints `pty <slave-path>` on stdout; core's
// Device opens the slave), and its main loop mirrors Firmware.cpp's exactly:
// time.update → Streams::tick → Capture::tick → Protocol::tick → drain COBS
// rx → handle(). The dispatch switch below is a verbatim copy of
// Firmware.cpp's handle() (the one piece the sim replaces, per the proposal).
//
// Control channel (stdin, line-oriented; every accepted line is ACKed with
// `ok <line>` on stdout so a driver can sequence against it):
//   strobe <L|R> <rise_us> <fall_us> [jitter_us]   arm auto strobe injection:
//       on each RISE of that camera's trigger pin (the pin the firmware
//       drives), its strobe pin (the pin the firmware reads) rises at
//       +rise_us and falls at +fall_us (±jitter, deterministic PRNG)
//   strobe <L|R> off                               disarm (timeout tests)
//   polarity <L|R> <high|low>                      injection polarity; `low`
//       models the real opto output (idles at the pull-up, exposure pulls it
//       LOW). Sticky across re-arming. Default `high`.
//   read <L|R>                                     emit `level <L|R> <level>`
//       — that camera's strobe pin as the firmware would read it right now
//   quit                                           exit 0
//
// Options: --loop-us <n> throttles the service loop (default 50; 0 = free
// run) to emulate device-side saturation.
//
// stdout control plane: `pty <path>`, `pin <num> <level>` (enable + trigger
// pins), `dac cs=<-.L.R.LR> <hex word>` (MEMS-SPI capture), `pwm ...` (LPF),
// `strobe <L|R> <level>` (injected edges), `level <L|R> <level>` (probe
// reply), `ok/err <line>`, `reboot`.

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <fcntl.h>
#include <random>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

#if defined(__APPLE__)
#include <util.h> // openpty (same guard as core/src/Controller.cpp)
#else
#include <pty.h>
#endif
#include <termios.h>

#include <Arduino.h>
#include <SPI.h>

#include <Protocol/Packet.h>
#include <Protocol/Protocol.h>

#include "Board.h"
#include "Capture.h"
#include "Global.h"
#include "Streams.h"

#include "sim.h"

// ============================================================================
// Strobe-edge injection (scriptable per-camera rise/fall schedules relative
// to the trigger write)
// ============================================================================

namespace {

struct StrobeConfig {
  bool armed = false;
  uint32_t riseUs = 500;
  uint32_t fallUs = 2500;
  uint32_t jitterUs = 0;
  // false: exposure asserts the pin HIGH. true: the pin idles at its pull-up
  // and exposure pulls it LOW — a real opto-isolated (open-collector) output.
  bool activeLow = false;
};

struct Edge {
  uint64_t dueUs; // Sim::nowUs() domain
  unsigned pin;
  uint8_t level;
};

// Index 0 = L (Board::camera[1]), 1 = R (Board::camera[2]) — the two
// hardware-triggerable cameras.
StrobeConfig strobes[2];
std::vector<Edge> edges;
std::mt19937 rng(42); // deterministic across runs

bool running = true;
uint64_t loopUs = 50;

int64_t jitter(uint32_t magnitude) {
  if (magnitude == 0)
    return 0;
  std::uniform_int_distribution<int64_t> d(-int64_t(magnitude),
                                           int64_t(magnitude));
  return d(rng);
}

void scheduleStrobes(int cam) {
  const auto &cfg = strobes[cam];
  if (!cfg.armed)
    return;
  const unsigned strobePin = Board::camera[cam + 1].strobe.number;
  const uint64_t now = Sim::nowUs();
  int64_t rise = int64_t(cfg.riseUs) + jitter(cfg.jitterUs);
  int64_t fall = int64_t(cfg.fallUs) + jitter(cfg.jitterUs);
  if (rise < 0)
    rise = 0;
  if (fall <= rise)
    fall = rise + 1;
  const uint8_t asserted = cfg.activeLow ? LOW : HIGH;
  const uint8_t released = cfg.activeLow ? HIGH : LOW;
  edges.push_back({now + uint64_t(rise), strobePin, asserted});
  edges.push_back({now + uint64_t(fall), strobePin, released});
}

// Fire every due edge in due-order: set the strobe pin level, then invoke the
// attached ISR — the sim's stand-in for the MCU's pin-change interrupt.
void pumpStrobes() {
  if (edges.empty())
    return;
  const uint64_t now = Sim::nowUs();
  std::sort(edges.begin(), edges.end(),
            [](const Edge &a, const Edge &b) { return a.dueUs < b.dueUs; });
  size_t fired = 0;
  for (const auto &e : edges) {
    if (e.dueUs > now)
      break;
    Sim::setInputPin(e.pin, e.level);
    Sim::fireIsr(e.pin);
    Sim::emit("strobe %s %u", e.pin == Board::camera[1].strobe.number ? "L" : "R",
              unsigned(e.level));
    fired++;
  }
  edges.erase(edges.begin(), edges.begin() + fired);
}

// ============================================================================
// Control channel (stdin)
// ============================================================================

std::string controlBuf;

void handleControlLine(const std::string &line) {
  if (line.empty())
    return;
  if (line == "quit") {
    running = false;
    Sim::emit("ok %s", line.c_str());
    return;
  }
  unsigned rise = 0, fall = 0, jit = 0;
  char cam = 0;
  char off[8] = {0};
  if (std::sscanf(line.c_str(), "strobe %c %u %u %u", &cam, &rise, &fall,
                  &jit) >= 3 &&
      (cam == 'L' || cam == 'R')) {
    auto &cfg = strobes[cam == 'L' ? 0 : 1];
    // Field-wise, not aggregate: polarity is sticky across re-arming, so
    // `polarity` and `strobe` can be issued in either order.
    cfg.armed = true;
    cfg.riseUs = rise;
    cfg.fallUs = fall;
    cfg.jitterUs = jit;
    Sim::emit("ok %s", line.c_str());
    return;
  }
  if (std::sscanf(line.c_str(), "strobe %c %7s", &cam, off) == 2 &&
      (cam == 'L' || cam == 'R') && std::strcmp(off, "off") == 0) {
    strobes[cam == 'L' ? 0 : 1].armed = false;
    Sim::emit("ok %s", line.c_str());
    return;
  }
  char pol[8] = {0};
  if (std::sscanf(line.c_str(), "polarity %c %7s", &cam, pol) == 2 &&
      (cam == 'L' || cam == 'R') &&
      (std::strcmp(pol, "low") == 0 || std::strcmp(pol, "high") == 0)) {
    strobes[cam == 'L' ? 0 : 1].activeLow = std::strcmp(pol, "low") == 0;
    Sim::emit("ok %s", line.c_str());
    return;
  }
  if (std::sscanf(line.c_str(), "read %c", &cam) == 1 &&
      (cam == 'L' || cam == 'R')) {
    const unsigned pin = Board::camera[(cam == 'L' ? 0 : 1) + 1].strobe.number;
    Sim::emit("level %c %u", cam, unsigned(Sim::pinLevel(pin)));
    Sim::emit("ok %s", line.c_str());
    return;
  }
  Sim::emit("err %s", line.c_str());
}

void pumpControl() {
  char buf[512];
  for (;;) {
    const ssize_t n = ::read(STDIN_FILENO, buf, sizeof(buf));
    if (n > 0) {
      controlBuf.append(buf, size_t(n));
      continue;
    }
    if (n == 0) {
      running = false; // driver went away — never orphan the sim
      return;
    }
    break; // EAGAIN — no pending input
  }
  size_t nl;
  while ((nl = controlBuf.find('\n')) != std::string::npos) {
    std::string line = controlBuf.substr(0, nl);
    controlBuf.erase(0, nl + 1);
    if (!line.empty() && line.back() == '\r')
      line.pop_back();
    handleControlLine(line);
  }
}

} // namespace

// ============================================================================
// hal → main hooks
// ============================================================================

void Sim::onPinWrite(unsigned pin, uint8_t level) {
  // Observability: the system-enable rail + the three camera trigger outputs.
  if (pin == Board::enable.number || pin == Board::camera[0].trigger.number ||
      pin == Board::camera[1].trigger.number ||
      pin == Board::camera[2].trigger.number)
    Sim::emit("pin %u %u", pin, unsigned(level));
  // Trigger RISE starts that camera's scripted strobe schedule ("relative to
  // the trigger write").
  if (level == HIGH) {
    if (pin == Board::camera[1].trigger.number)
      scheduleStrobes(0); // L
    else if (pin == Board::camera[2].trigger.number)
      scheduleStrobes(1); // R
  }
}

void Sim::onDacWord(uint8_t csMask, const uint8_t *bytes, size_t len) {
  static const char *CS[] = {"-", "L", "R", "LR"};
  char hex[2 * 8 + 1] = {0};
  for (size_t i = 0; i < len && i < 8; i++)
    std::snprintf(hex + 2 * i, 3, "%02X", bytes[i]);
  Sim::emit("dac cs=%s %s", CS[csMask & 3], hex);
}

// ============================================================================
// Firmware pump — setup() + loop() + handle(), mirroring Firmware.cpp
// ============================================================================

void handle(const Protocol::RawPacket &&packet);
namespace Protocol {
void tick(); // Non-blocking Actuate/Trigger completion (Protocol.cpp)
}

// Verbatim from firmware/src/Firmware.cpp (the sim replaces only the pump
// around it — keep the dispatch table an exact mirror).

#define HEADER(M, P)                                                           \
  (Protocol::header(Protocol::Method::M, Protocol::Property::P))

#define CASE_GET(P)                                                            \
  case Protocol::header(Protocol::Method::GET, Packet::P::PROPERTY):           \
    Packet::P::GET(seq);                                                       \
    break;

// Payload-carrying GET (CMD_FRAME) — validate + inflate like CASE_SET, but
// dispatch to the two-argument Prototype::GET overload.
#define CASE_GET_PAYLOAD(P)                                                    \
  case Protocol::header(Protocol::Method::GET, Packet::P::PROPERTY): {         \
    if (Packet::P::validate(packet))                                          \
      Packet::P::GET(seq, Packet::P::inflate(packet));                        \
    else                                                                      \
      Packet::P::reject(seq, "Invalid packet");                               \
    break;                                                                    \
  }

#define CASE_SET(P)                                                            \
  case Protocol::header(Protocol::Method::SET, Packet::P::PROPERTY): {         \
    if (Packet::P::validate(packet))                                           \
      Packet::P::SET(seq, Packet::P::inflate(packet));                         \
    else                                                                       \
      Packet::P::reject(seq, "Invalid packet");                                \
    break;                                                                     \
  }

void handle(const Protocol::RawPacket &&packet) {
  const auto header = packet.validate();
  const auto &seq = packet.header().sequence;
  switch (header) {
    CASE_GET(System::Info);
    CASE_GET(System::Version);
    CASE_SET(System::Reset);
    CASE_GET(System::Enable);
    CASE_SET(System::Enable);
    CASE_GET(System::Timestamp);
    CASE_SET(System::Timestamp);
    CASE_GET(Config::Log);
    CASE_SET(Config::Log);
    CASE_GET(Config::LPF);
    CASE_SET(Config::LPF);
    CASE_GET(Config::Bias);
    CASE_SET(Config::Bias);
    CASE_SET(Command::MirrorStream);
    CASE_GET_PAYLOAD(Command::Frame);
    CASE_SET(Command::Actuate);
    CASE_SET(Command::Trigger);
  case Protocol::INVALID: {
    auto packet = Packet::reject("Bad packet");
    if (COBS::tx.encode(packet))
      Serial.write(COBS::tx.data(), COBS::tx.size());
    break;
  }
  default: {
    auto packet = Packet::reject("Unknown packet type");
    if (COBS::tx.encode(packet))
      Serial.write(COBS::tx.data(), COBS::tx.size());
    break;
  }
  }
};

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--loop-us") == 0 && i + 1 < argc) {
      loopUs = std::strtoull(argv[++i], nullptr, 10);
    } else {
      std::fprintf(stderr, "usage: %s [--loop-us <n>]\n", argv[0]);
      return 2;
    }
  }

  ::signal(SIGPIPE, SIG_IGN); // stdout/pty peer may vanish — never die on write

  // The pty pair. Raw from birth (termios echo/ONLCR would corrupt COBS
  // bytes written before the Device applies its own raw settings — see
  // core/src/Serial.cpp). The sim keeps BOTH fds open for its lifetime, so
  // the pty survives Device open/close cycles on the slave path.
  int master = -1, slave = -1;
  char path[128] = {0};
  termios raw{};
  cfmakeraw(&raw);
  if (openpty(&master, &slave, path, &raw, nullptr) != 0) {
    std::fprintf(stderr, "openpty failed: %s\n", std::strerror(errno));
    return 1;
  }
  ::fcntl(master, F_SETFL, O_NONBLOCK);
  ::fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
  Sim::serialFd = master;

  Sim::emit("pty %s", path);

  // --- setup(): mirrors Firmware.cpp::setup() --------------------------------
  Serial.begin(115200);
  SPI.begin();
  Board::init();
  Board::low_pass_filter.freq(Global::lpf_frequency);
  Capture::init();

  // --- loop(): the 5-step core mirrors Firmware.cpp::loop() verbatim; the
  // control/strobe pumps in front are the sim's stand-in for the MCU's
  // asynchronous surfaces (host serial ISR = stdin, pin-change ISR = injected
  // edges). `--loop-us` throttles the whole service loop (device-saturation
  // emulation, the serial-rate governor's future sparring partner).
  while (running) {
    pumpControl();
    pumpStrobes();

    Global::time.update();
    Streams::housekeeping(); // M1 periodic MEMS config re-assertion (~1 Hz)
    Streams::tick();
    Capture::tick();
    Protocol::tick();
    for (int available = Serial.available(); available > 0; available--) {
      auto byte = Serial.read();
      if (byte >= 0 && COBS::rx.recv(byte))
        handle(COBS::rx.get());
    }

    if (loopUs > 0)
      std::this_thread::sleep_for(std::chrono::microseconds(loopUs));
  }

  Sim::emit("bye");
  ::close(master);
  ::close(slave);
  return 0;
}
