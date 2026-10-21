// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// fovea-fw-sim SELF-CHECK: drives the firmware simulator over its pty using
// the SHARED wire stack (lib/Protocol + lib/COBS) directly — no core addon —
// so the sim's firmware behavior is verifiable standalone (`cd test && make
// build && ./build/fw-sim-check`). Covers the behaviors below at the wire
// level; core/test/47-firmware-sim.ts drives the same behaviors through
// core's Device.
//
//   1. v2.1.0 GET version handshake.
//   2. Bias staged while disabled; Enable ACK; enable ORDER (DAC init words
//      + bias on both buses, FCLK, then MEMS_EN); Bias REJ while enabled.
//   3. CMD_STREAM CREATE ACK + its 8 lockstep position frames (per mirror
//      3x WRITE_IREG + APPLY_IREG); seq=0 UPDATE silence (no response
//      bytes); UPDATE unknown id REJ.
//   4. CMD_FRAME two-phase: ACK{queue_position} -> injected strobes -> FIN
//      {frame_id, t_trigger < t_exposure, positions == live target}.
//   5. Strobe-timeout REJ (strobes disarmed).
//   6. settle_time: SWITCH-frame trigger deferred >= settle (MCU clock);
//      same-stream frame undeferred; settle 0 switch undeferred.
//   7. Enable(false) teardown wire ORDER: pending-frame REJ before the
//      enable ACK; power-down ORDER (MEMS_EN low, bias, FCLK off).
//   C1-C4 (v2.2.0, between 6 and 7): CMD_SCHEDULE keyframe applied at its
//      MCU time; INTERPOLATE ramp writes intermediate DAC values (and a
//      mid-ramp frame reports them); stale/UPDATE-clears semantics;
//      CMD_TRAJECTORY upload/commit/start -> periodic DAC playback + marker
//      SYN pushes with sane timestamps; STOP holds position, DAC returns to
//      the streams.
//   D. Pipelining (workstream D, runs between 6 and 7): N requests in
//      flight answered in seq order at ~one round trip; seq=0 UPDATEs
//      interleaved silently (latest wins); requests behind a pending
//      two-phase FRAME are not gated by its FIN.
//   8. Center camera (V0.1 board): cameras = C|L|R drives all three Line2
//      triggers and FINs; the default mask (0) is still L|R (C untouched) and
//      FINs right after a C|L|R frame; an out-of-range mask REJs.
//   9. Strobe polarity contract: lines idle at the released level (HIGH, the
//      pull-up, for the default active-LOW Board::STROBE_ACTIVE_LEVEL); an
//      inverted (active-HIGH, LineInverter-shaped) injected waveform times
//      out against it with the "stuck at active level" hint; back to the
//      open-drain active-LOW shape, it FINs again.
//  10. quit -> exit 0.

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <signal.h> // ::kill — leaks in via sys/wait.h on glibc, NOT on macOS
#include <stdexcept>
#include <string>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <vector>

#if defined(__APPLE__)
#include <mach-o/dyld.h> // _NSGetExecutablePath (sim binary lives beside us)
#endif

#include <COBS/RX.h>
#include <COBS/TX.h>
#include <Protocol/Packet.h>
#include <Protocol/Protocol.h>
#include <Protocol/Version.h>

using Clock = std::chrono::steady_clock;

#define CHECK(COND, MSG)                                                       \
  do {                                                                         \
    if (!(COND))                                                               \
      throw std::runtime_error(std::string("CHECK failed: ") + MSG + " (" +    \
                               #COND + ")");                                   \
  } while (0)

// --- Sim child process --------------------------------------------------------

struct Sim {
  pid_t pid = -1;
  int in = -1;   // sim stdin (control channel)
  int out = -1;  // sim stdout (control plane)
  std::string buf;
  std::vector<std::string> lines;

  void pump(int timeoutMs = 0) {
    pollfd p{out, POLLIN, 0};
    while (true) {
      const int r = ::poll(&p, 1, timeoutMs);
      if (r <= 0)
        return;
      char chunk[1024];
      const ssize_t n = ::read(out, chunk, sizeof(chunk));
      if (n <= 0)
        return;
      buf.append(chunk, size_t(n));
      size_t nl;
      while ((nl = buf.find('\n')) != std::string::npos) {
        lines.push_back(buf.substr(0, nl));
        buf.erase(0, nl + 1);
      }
      timeoutMs = 0; // drain whatever is immediately available, then return
    }
  }

  std::string waitLine(const std::string &prefix, int timeoutMs = 5000,
                       size_t from = 0) {
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    size_t scanned = from;
    while (true) {
      for (; scanned < lines.size(); scanned++)
        if (lines[scanned].rfind(prefix, 0) == 0)
          return lines[scanned];
      if (Clock::now() >= deadline)
        throw std::runtime_error("timed out waiting for sim line: " + prefix);
      pump(20);
    }
  }

  // Index of the first line at/after `from` that equals `line` exactly (after
  // pumping until it appears or the timeout passes).
  size_t indexOf(const std::string &line, size_t from = 0,
                 int timeoutMs = 5000) {
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    size_t scanned = from;
    while (true) {
      for (; scanned < lines.size(); scanned++)
        if (lines[scanned] == line)
          return scanned;
      if (Clock::now() >= deadline)
        throw std::runtime_error("timed out waiting for sim line: " + line);
      pump(20);
    }
  }

  void ctl(const std::string &cmd) {
    const size_t from = lines.size();
    const std::string msg = cmd + "\n";
    CHECK(::write(in, msg.data(), msg.size()) == ssize_t(msg.size()),
          "control write");
    waitLine("ok " + cmd, 5000, from);
  }
};

static std::string selfDir() {
  char path[4096] = {0};
#if defined(__APPLE__)
  uint32_t size = sizeof(path);
  if (_NSGetExecutablePath(path, &size) != 0)
    throw std::runtime_error("_NSGetExecutablePath failed");
#else
  const ssize_t n = ::readlink("/proc/self/exe", path, sizeof(path) - 1);
  if (n <= 0)
    throw std::runtime_error("readlink /proc/self/exe failed");
  path[n] = 0;
#endif
  std::string s(path);
  const auto slash = s.rfind('/');
  return slash == std::string::npos ? "." : s.substr(0, slash);
}

static Sim spawnSim() {
  const std::string bin = selfDir() + "/fovea-fw-sim";
  int inPipe[2], outPipe[2];
  CHECK(::pipe(inPipe) == 0 && ::pipe(outPipe) == 0, "pipe");
  const pid_t pid = ::fork();
  CHECK(pid >= 0, "fork");
  if (pid == 0) {
    ::dup2(inPipe[0], STDIN_FILENO);
    ::dup2(outPipe[1], STDOUT_FILENO);
    ::close(inPipe[0]);
    ::close(inPipe[1]);
    ::close(outPipe[0]);
    ::close(outPipe[1]);
    const char *argv[] = {bin.c_str(), "--loop-us", "50", nullptr};
    ::execv(bin.c_str(), const_cast<char *const *>(argv));
    std::perror("execv fovea-fw-sim");
    ::_exit(127);
  }
  ::close(inPipe[0]);
  ::close(outPipe[1]);
  Sim sim;
  sim.pid = pid;
  sim.in = inPipe[1];
  sim.out = outPipe[0];
  return sim;
}

// --- Wire client (shared lib/Protocol + lib/COBS) ------------------------------

struct Wire {
  int fd = -1;
  COBS::TX tx;
  COBS::RX rx;
  uint16_t seq = 0;
  // Drained while waiting: high-rate DAC playback (v2.2.0 stages) can fill
  // the sim's stdout pipe faster than a test step reads it, and a sim blocked
  // on stdout stops answering on the pty.
  Sim *sim = nullptr;

  uint16_t next() { return ++seq == 0 ? ++seq : seq; }

  void send(Protocol::RawPacket &&packet) {
    CHECK(tx.encode(packet.finalize()), "COBS encode");
    size_t off = 0;
    while (off < tx.size()) {
      const ssize_t n = ::write(fd, tx.data() + off, tx.size() - off);
      if (n > 0) {
        off += size_t(n);
        continue;
      }
      if (n < 0 && (errno == EAGAIN || errno == EINTR)) {
        pollfd p{fd, POLLOUT, 0};
        ::poll(&p, 1, 100);
        continue;
      }
      throw std::runtime_error("pty write failed");
    }
  }

  /** Next COBS frame off the pty (SYN LOG pushes are skipped unless
   *  `keepSyn`); throws on timeout. */
  Protocol::RawPacket recv(int timeoutMs = 5000, bool keepSyn = false) {
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    while (true) {
      uint8_t byte;
      const ssize_t n = ::read(fd, &byte, 1);
      if (n == 1) {
        if (!rx.recv(byte))
          continue;
        Protocol::RawPacket packet(rx.get());
        const auto header = packet.validate();
        CHECK(header != Protocol::INVALID, "checksum-valid packet");
        if (!keepSyn && Protocol::method(header) == Protocol::Method::SYN)
          continue; // LOG push — not a response
        return packet;
      }
      if (Clock::now() >= deadline)
        throw std::runtime_error("timed out waiting for a response packet");
      if (sim)
        sim->pump(0);
      pollfd p{fd, POLLIN, 0};
      ::poll(&p, 1, sim ? 2 : 20);
    }
  }

  /** True iff NO frame arrives within `windowMs` (seq=0 silence probe). */
  bool silent(int windowMs) {
    try {
      recv(windowMs, true);
      return false;
    } catch (const std::runtime_error &) {
      return true;
    }
  }
};

template <typename T>
static T payloadAs(const Protocol::RawPacket &packet) {
  CHECK(packet.dataSize() == sizeof(T), "payload size");
  T out;
  std::memcpy(&out, packet.data(), sizeof(T));
  return out;
}

static std::string payloadStr(const Protocol::RawPacket &packet) {
  return {reinterpret_cast<const char *>(packet.data()), packet.dataSize()};
}

static void expectHeader(const Protocol::RawPacket &packet,
                         Protocol::Method method, Protocol::Property property,
                         uint16_t seq, const char *what) {
  const auto header = packet.validate();
  CHECK(Protocol::method(header) == method, what);
  CHECK(Protocol::property(header) == property, what);
  CHECK(packet.header().sequence == seq, what);
}

// Round-trip helpers -------------------------------------------------------------

using namespace Packet;
namespace Cmd = Packet::Command;

static Protocol::RawPacket setPacket(Protocol::Property p, uint16_t seq,
                                     const void *payload, size_t len) {
  Protocol::RawPacket packet(Protocol::Method::SET, p, seq);
  if (payload)
    packet.setData(payload, len);
  return packet;
}

static uint64_t mcuNow(Wire &wire) {
  const uint16_t s = wire.next();
  wire.send({Protocol::Method::GET, Protocol::Property::SYS_TIMESTAMP, s});
  const auto ack = wire.recv();
  expectHeader(ack, Protocol::Method::ACK, Protocol::Property::SYS_TIMESTAMP, s,
               "timestamp ACK");
  return payloadAs<System::Timestamp>(ack).microseconds;
}

struct FrameOutcome {
  bool accepted = false;
  Cmd::FrameAccepted ack{};
  bool finished = false; // FIN (else REJ)
  Cmd::FrameResult fin{};
  std::string rejReason;
};

static FrameOutcome runFrame(Wire &wire, uint8_t stream, uint32_t pulse,
                             uint32_t settle, int timeoutMs = 5000,
                             uint8_t cameras = Cmd::CAM_L | Cmd::CAM_R) {
  Cmd::Frame req{};
  req.stream = stream;
  req.cameras = cameras;
  req.pulse = pulse;
  req.settle_time = settle;
  const uint16_t s = wire.next();
  Protocol::RawPacket packet(Protocol::Method::GET, Protocol::Property::CMD_FRAME, s);
  packet.setData(&req, sizeof(req));
  wire.send(std::move(packet));

  FrameOutcome out;
  auto first = wire.recv(timeoutMs);
  auto header = first.validate();
  CHECK(first.header().sequence == s, "frame response sequence");
  if (Protocol::method(header) == Protocol::Method::REJ) {
    out.rejReason = payloadStr(first);
    return out;
  }
  expectHeader(first, Protocol::Method::ACK, Protocol::Property::CMD_FRAME, s,
               "frame ACK");
  out.accepted = true;
  out.ack = payloadAs<Cmd::FrameAccepted>(first);

  auto second = wire.recv(timeoutMs);
  header = second.validate();
  CHECK(second.header().sequence == s, "frame completion sequence");
  if (Protocol::method(header) == Protocol::Method::REJ) {
    out.rejReason = payloadStr(second);
    return out;
  }
  expectHeader(second, Protocol::Method::FIN, Protocol::Property::CMD_FRAME, s,
               "frame FIN");
  out.finished = true;
  out.fin = payloadAs<Cmd::FrameResult>(second);
  return out;
}

static void expectAck(Wire &wire, Protocol::Property p, uint16_t seq,
                      const char *what) {
  const auto packet = wire.recv();
  expectHeader(packet, Protocol::Method::ACK, p, seq, what);
}

static std::string expectRej(Wire &wire, Protocol::Property p, uint16_t seq,
                             const char *what) {
  const auto packet = wire.recv();
  expectHeader(packet, Protocol::Method::REJ, p, seq, what);
  return payloadStr(packet);
}

static Cmd::MirrorPosition pos(uint16_t a, uint16_t b, uint16_t c, uint16_t d) {
  Cmd::MirrorPosition m;
  m.ch[0] = a;
  m.ch[1] = b;
  m.ch[2] = c;
  m.ch[3] = d;
  return m;
}

static void streamOp(Wire &wire, Cmd::MirrorStream::Op op, uint8_t id,
                     const Cmd::MirrorPosition &l, const Cmd::MirrorPosition &r,
                     uint16_t seq) {
  Cmd::MirrorStream cmd{};
  cmd.op = op;
  cmd.id = id;
  cmd.left = l;
  cmd.right = r;
  wire.send(setPacket(Protocol::Property::CMD_STREAM, seq, &cmd, sizeof(cmd)));
}

// ============================================================================
// v2.2.0 helpers (CMD_SCHEDULE / CMD_TRAJECTORY stages C1-C4)
// ============================================================================

// One captured MEMS DAC word (`dac cs=<L|R|LR> <hex>`), DECODED so assertions
// key on (mirror, value) rather than the command bits — the DAC frame set is
// free to change (e.g. WRITE_IREG x3 + APPLY_IREG per device).
struct DacWord {
  bool left = false, right = false;
  uint8_t cmd = 0, addr = 0;
  uint16_t value = 0;
};

static bool parseDac(const std::string &line, DacWord &w) {
  char cs[8] = {0};
  unsigned b0, b1, b2;
  if (std::sscanf(line.c_str(), "dac cs=%7s %2x%2x%2x", cs, &b0, &b1, &b2) !=
      4)
    return false;
  w.left = std::strchr(cs, 'L') != nullptr;
  w.right = std::strchr(cs, 'R') != nullptr;
  w.cmd = uint8_t((b0 >> 3) & 7);
  w.addr = uint8_t(b0 & 7);
  w.value = uint16_t((b1 << 8) | b2);
  return true;
}

// AD5664R commands that carry a channel value (write input reg n, write n +
// update all, write n + update n) to a single channel (A..D).
static bool carriesValue(const DacWord &w) {
  return (w.cmd == 0 || w.cmd == 2 || w.cmd == 3) && w.addr <= 3;
}

// Channel values written to mirror `side` ('L'/'R') in sim lines [from, to).
static std::vector<uint16_t> dacValues(const Sim &sim, char side, size_t from,
                                       size_t to = SIZE_MAX) {
  std::vector<uint16_t> out;
  to = std::min(to, sim.lines.size());
  for (size_t i = from; i < to; i++) {
    DacWord w;
    if (!parseDac(sim.lines[i], w) || !carriesValue(w))
      continue;
    if ((side == 'L' && w.left) || (side == 'R' && w.right))
      out.push_back(w.value);
  }
  return out;
}

static bool hasValue(const std::vector<uint16_t> &v, uint16_t x) {
  return std::find(v.begin(), v.end(), x) != v.end();
}

// Values of `v` inside [lo, hi] (a channel's private value band).
static std::vector<uint16_t> inBand(const std::vector<uint16_t> &v,
                                    uint16_t lo, uint16_t hi) {
  std::vector<uint16_t> out;
  for (auto x : v)
    if (x >= lo && x <= hi)
      out.push_back(x);
  return out;
}

// Drain every control-plane line the sim has emitted so far. The sim's loop
// runs tick() (DAC words -> stdout) BEFORE handle() (responses -> pty), so
// once a response has arrived, a drain sees every DAC word emitted up to the
// MCU instant that request was handled.
static void drain(Sim &sim) { sim.pump(5); }

static void sleepMs(int ms) { ::poll(nullptr, 0, ms); }

// Next SYN CMD_TRAJECTORY push (LOG pushes skipped); throws on timeout.
static Cmd::TrajectoryFrame recvTrajectoryFrame(Wire &wire, int timeoutMs) {
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
  while (true) {
    const int left =
        int(std::chrono::duration_cast<std::chrono::milliseconds>(
                deadline - Clock::now())
                .count());
    if (left <= 0)
      throw std::runtime_error("timed out waiting for a TrajectoryFrame push");
    auto packet = wire.recv(left, true);
    const auto header = packet.validate();
    if (Protocol::method(header) == Protocol::Method::SYN &&
        Protocol::property(header) == Protocol::Property::CMD_TRAJECTORY)
      return payloadAs<Cmd::TrajectoryFrame>(packet);
    CHECK(Protocol::method(header) == Protocol::Method::SYN &&
              Protocol::property(header) == Protocol::Property::LOG,
          "only LOG / trajectory pushes arrive unsolicited");
  }
}

static void sendSchedule(Wire &wire, uint16_t seq, uint8_t stream,
                         uint64_t tApply, uint8_t flags,
                         const Cmd::MirrorPosition &l,
                         const Cmd::MirrorPosition &r) {
  Cmd::Schedule k{};
  k.stream = stream;
  k.flags = flags;
  k.t_apply = tApply;
  k.left = l;
  k.right = r;
  wire.send(setPacket(Protocol::Property::CMD_SCHEDULE, seq, &k, sizeof(k)));
}

// Sends one CMD_TRAJECTORY op (fixed header + optional trailing samples) and
// returns its response (ACK or REJ).
static Protocol::RawPacket trajectoryOp(Wire &wire, const void *header,
                                        size_t headerLen,
                                        const void *tail = nullptr,
                                        size_t tailLen = 0) {
  std::vector<uint8_t> body(headerLen + tailLen);
  std::memcpy(body.data(), header, headerLen);
  if (tailLen)
    std::memcpy(body.data() + headerLen, tail, tailLen);
  const uint16_t s = wire.next();
  wire.send(setPacket(Protocol::Property::CMD_TRAJECTORY, s, body.data(),
                      body.size()));
  auto resp = wire.recv();
  CHECK(resp.header().sequence == s, "trajectory response sequence");
  CHECK(Protocol::property(resp.validate()) ==
            Protocol::Property::CMD_TRAJECTORY,
        "trajectory response property");
  return resp;
}

static void expectOk(const Protocol::RawPacket &resp, const char *what) {
  if (Protocol::method(resp.validate()) != Protocol::Method::ACK)
    throw std::runtime_error(std::string("CHECK failed: ") + what +
                             " (got REJ: " + payloadStr(resp) + ")");
}

static std::string expectRejected(const Protocol::RawPacket &resp,
                                  const char *what) {
  CHECK(Protocol::method(resp.validate()) == Protocol::Method::REJ, what);
  return payloadStr(resp);
}

static Cmd::TrajectoryRef trajectoryRef(Cmd::Trajectory::Op op, uint8_t id) {
  Cmd::TrajectoryRef r{};
  r.op = op;
  r.id = id;
  return r;
}

int main() {
  Sim sim = spawnSim();
  int rc = 1;
  try {
    const std::string ptyLine = sim.waitLine("pty ");
    const std::string ptyPath = ptyLine.substr(4);
    std::printf("fw-sim-check: sim at %s\n", ptyPath.c_str());

    Wire wire;
    wire.sim = &sim;
    wire.fd = ::open(ptyPath.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
    CHECK(wire.fd >= 0, "open pty slave");
    termios tty{};
    CHECK(::tcgetattr(wire.fd, &tty) == 0, "tcgetattr");
    ::cfmakeraw(&tty);
    CHECK(::tcsetattr(wire.fd, TCSANOW, &tty) == 0, "tcsetattr raw");

    // 1 — version handshake
    {
      const uint16_t s = wire.next();
      wire.send({Protocol::Method::GET, Protocol::Property::SYS_VERSION, s});
      const auto ack = wire.recv();
      expectHeader(ack, Protocol::Method::ACK, Protocol::Property::SYS_VERSION,
                   s, "version ACK");
      const auto v = payloadAs<System::Version>(ack);
      CHECK(v.major == Protocol::Version::Major &&
                v.minor == Protocol::Version::Minor &&
                v.patch == Protocol::Version::Patch,
            "firmware reports the shared Protocol::Version (2.1.0)");
      std::printf("fw-sim-check: 1 version %u.%u.%u OK\n", v.major, v.minor,
                  v.patch);
    }

    // 2 — bias staging, enable, bias REJ while enabled
    {
      Config::Bias bias{};
      bias.voltage = 30000;
      uint16_t s = wire.next();
      wire.send(setPacket(Protocol::Property::CFG_BIAS, s, &bias, sizeof(bias)));
      expectAck(wire, Protocol::Property::CFG_BIAS, s, "bias ACK (disabled)");

      System::Enable en{};
      en.enable = 1;
      const size_t mark = sim.lines.size();
      s = wire.next();
      wire.send(setPacket(Protocol::Property::SYS_ENABLE, s, &en, sizeof(en)));
      expectAck(wire, Protocol::Property::SYS_ENABLE, s, "enable ACK");
      // The recorded MEMS word train (same word on both buses = cs=LR), in
      // order, ending in the staged bias broadcast...
      size_t at = mark;
      for (const char *word :
           {"280001", "380001", "20000F", "300000", "1F7530"})
        at = sim.indexOf(std::string("dac cs=LR ") + word, at) + 1;
      const size_t biasAt = at - 1;
      // ...then FCLK running, and only THEN the driver enable rail (guide p27).
      const size_t fclkAt = sim.indexOf("pwm pin=10 duty=128", mark);
      const size_t railAt = sim.indexOf("pin 6 1", mark);
      CHECK(biasAt < fclkAt && fclkAt < railAt,
            "enable order: DAC init + bias, FCLK, then MEMS_EN");

      bias.voltage = 5;
      s = wire.next();
      wire.send(setPacket(Protocol::Property::CFG_BIAS, s, &bias, sizeof(bias)));
      const auto reason =
          expectRej(wire, Protocol::Property::CFG_BIAS, s, "bias REJ enabled");
      CHECK(reason.find("enabled") != std::string::npos, "bias REJ reason");
      std::printf("fw-sim-check: 2 enable sequence + bias REJ OK\n");
    }

    // 3 — stream table: CREATE, seq=0 UPDATE silence, unknown-id REJ
    {
      const size_t createMark = sim.lines.size();
      uint16_t s = wire.next();
      streamOp(wire, Cmd::MirrorStream::CREATE, 1, pos(1000, 2000, 3000, 4000),
               pos(4000, 3000, 2000, 1000), s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "stream CREATE ACK");
      // A fresh stream takes the DAC: per mirror 3x WRITE_IREG (A, B, D) +
      // APPLY_IREG on C (write + update all), both buses in lockstep — each
      // frame's left word then its right word. ch[2] -> D, ch[3] -> C.
      {
        size_t at = sim.indexOf("dac cs=L 0003E8", createMark); // A 1000
        for (const char *line :
             {"dac cs=R 000FA0",  // A 4000
              "dac cs=L 0107D0",  // B 2000
              "dac cs=R 010BB8",  // B 3000
              "dac cs=L 030BB8",  // D 3000
              "dac cs=R 0307D0",  // D 2000
              "dac cs=L 120FA0",  // C 4000 + update all
              "dac cs=R 1203E8"}) { // C 1000 + update all
          const size_t next = sim.indexOf(line, at);
          CHECK(next == at + 1,
                std::string("position frames back to back: ") + line);
          at = next;
        }
      }

      // seq=0 fire-and-forget UPDATE: applies (DAC word) with ZERO response.
      const size_t mark = sim.lines.size();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
               pos(12000, 22000, 32000, 42000), pos(42000, 32000, 22000, 12000),
               0);
      CHECK(wire.silent(150), "seq=0 UPDATE stays silent");
      sim.waitLine("dac cs=L 002EE0", 5000, mark); // ...but moved the mirror

      s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 7, pos(0, 0, 0, 0),
               pos(0, 0, 0, 0), s);
      const auto reason = expectRej(wire, Protocol::Property::CMD_STREAM, s,
                                    "unknown stream REJ");
      CHECK(reason.find("Unknown stream") != std::string::npos,
            "unknown stream REJ reason");
      std::printf("fw-sim-check: 3 stream table OK\n");
    }

    // 4 — CMD_FRAME two-phase with injected strobes
    {
      sim.ctl("strobe L 500 2500");
      sim.ctl("strobe R 700 2500");
      const auto frame = runFrame(wire, 1, 2000, 0);
      CHECK(frame.accepted && frame.finished, "frame completes");
      CHECK(frame.ack.queue_position == 0, "queue position 0");
      CHECK(frame.fin.frame_id >= 1, "frame_id assigned");
      CHECK(frame.fin.t_exposure > frame.fin.t_trigger, "exposure after trigger");
      CHECK(frame.fin.t_exposure - frame.fin.t_trigger < 50'000,
            "strobe rise within 50 ms of the trigger edge");
      // No UPDATE mid-exposure: rise/fall latches == the live target.
      CHECK(frame.fin.left.ch[0] == 12000 && frame.fin.left.ch[3] == 42000,
            "FIN left = stream target");
      CHECK(frame.fin.right.ch[0] == 42000 && frame.fin.right.ch[3] == 12000,
            "FIN right = stream target");
      std::printf("fw-sim-check: 4 two-phase FIN (frame_id=%u) OK\n",
                  frame.fin.frame_id);
    }

    // 5 — strobe-timeout REJ
    {
      sim.ctl("strobe L off");
      sim.ctl("strobe R off");
      const auto dead = runFrame(wire, 1, 2000, 0);
      CHECK(dead.accepted && !dead.finished, "timeout frame ACKed then REJed");
      CHECK(dead.rejReason.find("Strobe timeout") != std::string::npos,
            "strobe-timeout reason");
      std::printf("fw-sim-check: 5 strobe-timeout REJ OK\n");
    }

    // 6 — settle_time deferral (v2.0.0): switch deferred, same-stream not,
    //     settle 0 parity
    {
      uint16_t s = wire.next();
      streamOp(wire, Cmd::MirrorStream::CREATE, 2, pos(100, 200, 300, 400),
               pos(400, 300, 200, 100), s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "stream 2 CREATE");
      sim.ctl("strobe L 500 2500");
      sim.ctl("strobe R 700 2500");

      constexpr uint64_t SETTLE = 150'000;
      const uint64_t t0 = mcuNow(wire);
      const auto sw = runFrame(wire, 2, 2000, SETTLE); // stream 1 -> 2: SWITCH
      CHECK(sw.finished, "switch frame completes");
      CHECK(sw.fin.t_trigger - t0 >= SETTLE, "switch trigger deferred >= settle");
      CHECK(sw.fin.t_exposure - sw.fin.t_trigger < 50'000,
            "exposure runs off the REAL (deferred) trigger edge");

      const uint64_t t1 = mcuNow(wire);
      const auto same = runFrame(wire, 2, 2000, SETTLE); // same stream: no hold
      CHECK(same.finished, "same-stream frame completes");
      CHECK(same.fin.t_trigger - t1 < 100'000, "same-stream frame undeferred");

      const uint64_t t2 = mcuNow(wire);
      const auto zero = runFrame(wire, 1, 2000, 0); // switch back, settle 0
      CHECK(zero.finished, "settle-0 frame completes");
      CHECK(zero.fin.t_trigger - t2 < 100'000, "settle 0 fires immediately");
      std::printf("fw-sim-check: 6 settle_time (deferred %llu us) OK\n",
                  static_cast<unsigned long long>(sw.fin.t_trigger - t0));
    }

    // ===================================================================
    // v2.2.0 stages C1-C4 — CMD_SCHEDULE + CMD_TRAJECTORY (workstream C).
    // State on entry: enabled; stream 1 active with target
    //   L = (12000, 22000, 32000, 42000), R = (42000, 32000, 22000, 12000);
    //   strobes armed (L 500/2500, R 700/2500).
    // DAC assertions decode words to (mirror, value) and give each probed
    // channel a private value band, so they hold whatever DAC frame set the
    // MEMS driver uses.
    // ==========================================================================
    const auto R0 = pos(42000, 32000, 22000, 12000);

    // C1 — CMD_SCHEDULE: a keyframe applies AT its MCU time, not on arrival
    {
      constexpr uint64_t LEAD = 300'000;
      const size_t mark = sim.lines.size();
      const uint64_t tApply = mcuNow(wire) + LEAD;
      const uint16_t s = wire.next();
      sendSchedule(wire, s, 1, tApply, Cmd::Schedule::NONE,
                   pos(15151, 22000, 32000, 42000), R0);
      const auto ack = wire.recv();
      expectHeader(ack, Protocol::Method::ACK, Protocol::Property::CMD_SCHEDULE,
                   s, "schedule ACK");
      const auto echo = payloadAs<Cmd::Schedule>(ack);
      CHECK(echo.stream == 1 && echo.t_apply == tApply &&
                echo.left.ch[0] == 15151,
            "schedule ACK echoes the keyframe");

      // Before t_apply a frame still reports the OLD target (MCU clock).
      const auto before = runFrame(wire, 1, 2000, 0);
      CHECK(before.finished, "pre-apply frame completes");
      CHECK(before.fin.t_exposure < tApply, "pre-apply frame exposed early");
      CHECK(before.fin.left.ch[0] == 12000, "pre-apply frame: old target");

      // Poll the MCU clock: the keyframe's DAC word is absent at every
      // reading well before t_apply and present at the first one well after.
      // Absence is the SOUND direction: a word emitted before reading t is
      // already in the stdout pipe when t's ACK arrives, so `lastAbsent`
      // bounds the apply instant from below (presence only bounds it by the
      // drain time, hence the 20 ms margins).
      int64_t lastAbsent = 0;
      while (true) {
        const uint64_t t = mcuNow(wire);
        drain(sim);
        const bool present = hasValue(dacValues(sim, 'L', mark), 15151);
        if (!present)
          lastAbsent = int64_t(t) - int64_t(tApply);
        if (t + 20'000 < tApply)
          CHECK(!present, "keyframe not applied early (MCU clock)");
        if (t > tApply + 20'000) {
          CHECK(present, "keyframe applied by t_apply + 20 ms (MCU clock)");
          break;
        }
        sleepMs(2);
      }
      const auto after = runFrame(wire, 1, 2000, 0);
      CHECK(after.finished && after.fin.t_trigger >= tApply &&
                after.fin.left.ch[0] == 15151,
            "post-apply frame reports the keyframe target");
      std::printf("fw-sim-check: C1 schedule keyframe applied at MCU t_apply "
                  "(still absent at t_apply %+lld us) OK\n",
                  static_cast<long long>(lastAbsent));
    }

    // C2 — INTERPOLATE ramp: intermediate DAC words, an MCU-time-consistent
    //      mid-ramp frame; seq=0 silence; stale REJ; UPDATE clears schedule
    {
      // L ch0 ramps inside its private band [2000, 9000]; the rest holds.
      const size_t mark = sim.lines.size();
      const uint64_t t0 = mcuNow(wire);
      const uint64_t tA = t0 + 50'000, tB = t0 + 250'000;
      sendSchedule(wire, 0, 1, tA, Cmd::Schedule::NONE,
                   pos(2000, 22000, 32000, 42000), R0);
      sendSchedule(wire, 0, 1, tB, Cmd::Schedule::INTERPOLATE,
                   pos(9000, 22000, 32000, 42000), R0);
      CHECK(wire.silent(30), "seq=0 keyframes stay silent");

      while (mcuNow(wire) < tA + 100'000)
        sleepMs(2);
      const auto mid = runFrame(wire, 1, 2000, 0);
      CHECK(mid.finished, "mid-ramp frame completes");
      // Exposure average ~ the ramp at trigger + 1500 us (injected strobe
      // rise +500, fall +2500).
      const double frac =
          double(int64_t(mid.fin.t_trigger + 1500) - int64_t(tA)) /
          double(tB - tA);
      const double expected = 2000.0 + 7000.0 * frac;
      const uint16_t got = mid.fin.left.ch[0];
      CHECK(got > 2000 && got < 9000, "mid-ramp frame between keyframes");
      CHECK(std::abs(double(got) - expected) < 350.0,
            "mid-ramp frame matches the MCU-time lerp");
      CHECK(mid.fin.left.ch[1] == 22000 && mid.fin.right.ch[0] == 42000,
            "non-ramping channels hold");

      while (mcuNow(wire) < tB + 20'000)
        sleepMs(5);
      drain(sim);
      const auto band = inBand(dacValues(sim, 'L', mark), 2000, 9000);
      // The ramp starts on the tick K_A applies (the segment toward K_B is
      // already interpolating then), so its first word sits just above 2000.
      CHECK(!band.empty() && band.front() >= 2000 && band.front() < 2050 &&
                band.back() == 9000,
            "ramp runs from K_A to exactly K_B");
      std::vector<uint16_t> inter;
      for (auto v : band)
        if (v > 2000 && v < 9000 && !hasValue(inter, v))
          inter.push_back(v);
      CHECK(inter.size() >= 20, "ramp writes intermediate DAC values");
      CHECK(std::is_sorted(band.begin(), band.end()), "ramp is monotonic");

      // Stale: older than the last APPLIED keyframe (tB) -> dropped + REJ.
      uint16_t s = wire.next();
      sendSchedule(wire, s, 1, tA, Cmd::Schedule::NONE,
                   pos(4444, 22000, 32000, 42000), R0);
      CHECK(expectRej(wire, Protocol::Property::CMD_SCHEDULE, s, "stale REJ")
                    .find("older") != std::string::npos,
            "stale keyframe reason");
      s = wire.next();
      sendSchedule(wire, s, 9, tB, Cmd::Schedule::NONE, R0, R0);
      CHECK(expectRej(wire, Protocol::Property::CMD_SCHEDULE, s,
                      "unknown stream REJ")
                    .find("Unknown stream") != std::string::npos,
            "unknown stream reason");

      // UPDATE ("now, latest wins") clears the pending schedule.
      const size_t mark2 = sim.lines.size();
      const uint64_t t1 = mcuNow(wire);
      s = wire.next();
      sendSchedule(wire, s, 1, t1 + 80'000, Cmd::Schedule::NONE,
                   pos(7777, 22000, 32000, 42000), R0);
      expectAck(wire, Protocol::Property::CMD_SCHEDULE, s, "pending keyframe");
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
               pos(3333, 22000, 32000, 42000), R0, 0);
      while (mcuNow(wire) < t1 + 120'000)
        sleepMs(5);
      drain(sim);
      const auto v = dacValues(sim, 'L', mark2);
      CHECK(hasValue(v, 3333) && !hasValue(v, 7777),
            "UPDATE cleared the pending keyframe");
      std::printf("fw-sim-check: C2 interpolation (%zu intermediate words, "
                  "mid-frame %u vs %.0f) + stale/UPDATE semantics OK\n",
                  inter.size(), unsigned(got), expected);
    }

    // C3 — CMD_TRAJECTORY: chunked upload, COMMIT validation, START -> DAC
    //      playback + one marker SYN push per cycle, ENDED push
    constexpr uint8_t TID = 0;
    constexpr uint32_t PERIOD = 20'000;
    constexpr uint32_t MARK_AT = 10'000;
    {
      // 25 samples (DATA chunks 12 + 12 + 1), 800 us apart. L ch0 ramps
      // through its private band [1000, 3400]; every other channel holds.
      constexpr uint16_t N = 25;
      CHECK(Cmd::Trajectory::CHUNK_SAMPLES == 12, "DATA chunk size");
      std::vector<Cmd::TrajectorySample> samples(N);
      for (uint16_t i = 0; i < N; i++) {
        samples[i].t_offset = i * 800u;
        samples[i].left = pos(uint16_t(1000 + 100 * i), 5000, 6000, 7000);
        samples[i].right = pos(8000, 9000, 10000, 11000);
      }
      Cmd::TrajectoryBegin b{};
      b.op = Cmd::Trajectory::BEGIN;
      b.id = 9;
      b.sample_count = N;
      b.period = PERIOD;
      CHECK(expectRejected(trajectoryOp(wire, &b, sizeof(b)), "BEGIN id 9")
                    .find("out of range") != std::string::npos,
            "table id limit reason");
      b.id = TID;
      b.sample_count = 5000;
      CHECK(expectRejected(trajectoryOp(wire, &b, sizeof(b)), "BEGIN 5000")
                    .find("4096") != std::string::npos,
            "sample budget reason");
      b.sample_count = N;
      expectOk(trajectoryOp(wire, &b, sizeof(b)), "BEGIN");

      auto chunk = [&](uint16_t first, uint8_t n) {
        Cmd::TrajectoryData d{};
        d.op = Cmd::Trajectory::DATA;
        d.id = TID;
        d.first_index = first;
        d.count = n;
        return trajectoryOp(wire, &d, sizeof(d), &samples[first],
                            n * sizeof(Cmd::TrajectorySample));
      };
      expectOk(chunk(0, 12), "DATA 0..11 (full chunk)");
      expectOk(chunk(12, 12), "DATA 12..23");
      expectRejected(chunk(20, 12), "DATA past the end");
      const auto commit = trajectoryRef(Cmd::Trajectory::COMMIT, TID);
      CHECK(expectRejected(trajectoryOp(wire, &commit, sizeof(commit)),
                           "COMMIT incomplete")
                    .find("incomplete") != std::string::npos,
            "COMMIT validates every sample is present");
      Cmd::TrajectoryStart st{};
      st.op = Cmd::Trajectory::START;
      st.id = TID;
      expectRejected(trajectoryOp(wire, &st, sizeof(st)), "START uncommitted");
      expectOk(chunk(24, 1), "DATA 24");

      Cmd::TrajectoryMark m{};
      m.op = Cmd::Trajectory::MARK;
      m.id = TID;
      m.marker = 0;
      m.t_offset = PERIOD;
      m.cameras = Cmd::CAM_L | Cmd::CAM_R;
      m.pulse = 2000;
      expectRejected(trajectoryOp(wire, &m, sizeof(m)), "MARK offset >= period");
      m.t_offset = MARK_AT;
      expectOk(trajectoryOp(wire, &m, sizeof(m)), "MARK");
      expectOk(trajectoryOp(wire, &commit, sizeof(commit)), "COMMIT");
      expectRejected(trajectoryOp(wire, &commit, sizeof(commit)),
                     "double COMMIT");

      constexpr uint32_t CYCLES = 10;
      const size_t mark = sim.lines.size();
      const uint64_t tStart = mcuNow(wire) + 100'000;
      st.t_start = tStart;
      st.cycles = CYCLES;
      expectOk(trajectoryOp(wire, &st, sizeof(st)), "START");
      // Armed (pre-positioned, before t_start): the trajectory owns the DAC.
      uint16_t s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1, R0, R0, s);
      CHECK(expectRej(wire, Protocol::Property::CMD_STREAM, s, "UPDATE REJ")
                    .find("trajectory owns") != std::string::npos,
            "stream UPDATE refused while a trajectory runs");
      s = wire.next();
      sendSchedule(wire, s, 1, tStart, Cmd::Schedule::NONE, R0, R0);
      CHECK(expectRej(wire, Protocol::Property::CMD_SCHEDULE, s, "SCHEDULE REJ")
                    .find("trajectory owns") != std::string::npos,
            "keyframe refused while a trajectory runs");
      expectRejected(trajectoryOp(wire, &st, sizeof(st)), "double START");

      uint32_t lastFrameId = 0;
      uint64_t worstLate = 0;
      for (uint32_t k = 0; k < CYCLES; k++) {
        const auto f = recvTrajectoryFrame(wire, 2000);
        CHECK(f.status == Cmd::TrajectoryFrame::OK, "marker capture OK");
        CHECK(f.id == TID && f.marker == 0 && f.cycle == k,
              "marker push identity (id, marker, cycle)");
        CHECK(f.result.stream == TID, "FrameResult.stream = trajectory id");
        CHECK(f.result.frame_id > lastFrameId, "frame_id monotonic");
        lastFrameId = f.result.frame_id;
        const uint64_t due = tStart + uint64_t(k) * PERIOD + MARK_AT;
        CHECK(f.result.t_trigger >= due, "marker never fires early");
        CHECK(f.result.t_trigger - due < 5'000, "marker fires at its phase");
        worstLate = std::max<uint64_t>(worstLate, f.result.t_trigger - due);
        CHECK(f.result.t_exposure > f.result.t_trigger &&
                  f.result.t_exposure - f.result.t_trigger < 50'000,
              "exposure follows the marker trigger");
        // Exposure-averaged position: the mean of the DAC at strobe rise and
        // fall. The marker fires right after the tick that drove the table
        // at the trigger phase, and the ramp only climbs from there until
        // the band top (the wrap is ~9 ms later), so the average is
        // bracketed by the table at t_trigger and the band top. (Sim loop
        // stalls delay strobe edges, so t_exposure is not a tight bound.)
        auto table = [&](uint64_t t) {
          return 1000.0 + 100.0 * double((t - tStart) % PERIOD) / 800.0;
        };
        const double lo = table(f.result.t_trigger) - 10.0;
        const double hi = 3400.0;
        const double got = f.result.left.ch[0];
        if (!(got >= lo && got <= hi))
          std::fprintf(stderr, "marker %u: ch0 %.0f outside [%.0f, %.0f]\n", k,
                       got, lo, hi);
        CHECK(got >= lo && got <= hi,
              "marker frame position = table over the exposure window");
        CHECK(f.result.left.ch[1] == 5000 && f.result.right.ch[0] == 8000,
              "marker frame: constant channels exact");
      }
      const auto end = recvTrajectoryFrame(wire, 2000);
      CHECK(end.status == Cmd::TrajectoryFrame::ENDED &&
                end.marker == Cmd::TrajectoryFrame::NO_MARKER &&
                end.cycle == CYCLES,
            "ENDED push after the last cycle");
      CHECK(end.result.t_trigger == tStart + uint64_t(CYCLES) * PERIOD,
            "ENDED carries the run's end time");

      drain(sim);
      const auto band = inBand(dacValues(sim, 'L', mark), 1000, 3400);
      std::vector<uint16_t> distinct;
      for (auto v : band)
        if (!hasValue(distinct, v))
          distinct.push_back(v);
      unsigned wraps = 0;
      bool high = false;
      for (auto v : band) {
        if (v > 3000)
          high = true;
        else if (v < 1500 && high) {
          wraps++;
          high = false;
        }
      }
      CHECK(distinct.size() >= 50, "interpolated playback writes many values");
      CHECK(wraps >= CYCLES - 1, "playback is periodic (one wrap per cycle)");
      CHECK(!band.empty() && band.back() == 1000,
            "finite run ends holding phase 0");
      std::printf("fw-sim-check: C3 trajectory %u cycles, %zu distinct DAC "
                  "values, %u wraps, %u marker pushes (worst +%llu us) OK\n",
                  CYCLES, distinct.size(), wraps, CYCLES,
                  static_cast<unsigned long long>(worstLate));
    }

    // C4 — HOLD after the run (survives the 1 Hz refresh), STOP mid-run holds
    //      the last position, control returns to the streams, DELETE
    {
      // After ENDED the mirror holds phase 0 across a MEMS refresh: stream 1's
      // target (L ch1 = 22000) is NOT re-committed.
      size_t mark = sim.lines.size();
      sleepMs(1200);
      drain(sim);
      auto v = dacValues(sim, 'L', mark);
      for (auto x : inBand(v, 1000, 3400))
        CHECK(x == 1000, "HOLD keeps the final trajectory position");
      CHECK(!hasValue(v, 22000), "HOLD: the stream target is not re-committed");

      // Endless run from now, then STOP mid-run.
      Cmd::TrajectoryStart st{};
      st.op = Cmd::Trajectory::START;
      st.id = TID;
      st.t_start = 0;
      st.cycles = 0;
      const size_t runMark = sim.lines.size();
      expectOk(trajectoryOp(wire, &st, sizeof(st)), "START (now, forever)");
      sleepMs(70);
      const auto stop = trajectoryRef(Cmd::Trajectory::STOP, TID);
      expectOk(trajectoryOp(wire, &stop, sizeof(stop)), "STOP");
      drain(sim);
      const auto ran = inBand(dacValues(sim, 'L', runMark), 1000, 3400);
      CHECK(ran.size() > 10, "endless run drove the DAC");
      const uint16_t held = ran.back();
      mark = sim.lines.size();
      sleepMs(100);
      drain(sim);
      v = dacValues(sim, 'L', mark);
      for (auto x : inBand(v, 1000, 3400))
        CHECK(x == held, "STOP holds the last position");
      CHECK(!hasValue(v, 22000), "STOP does not snap back to the stream");

      // Control returns to the streams on the next stream write.
      mark = sim.lines.size();
      uint16_t s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
               pos(4321, 22000, 32000, 42000), R0, s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "UPDATE after STOP");
      bool back = false;
      for (int i = 0; i < 100 && !back; i++) {
        drain(sim);
        back = hasValue(dacValues(sim, 'L', mark), 4321);
      }
      CHECK(back, "stream UPDATE drives the DAC again after STOP");

      const auto del = trajectoryRef(Cmd::Trajectory::DELETE, TID);
      expectOk(trajectoryOp(wire, &del, sizeof(del)), "DELETE");
      CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                           "START deleted")
                    .find("Unknown trajectory") != std::string::npos,
            "deleted table is gone");
      std::printf("fw-sim-check: C4 HOLD/STOP (held %u) + DAC hand-back + "
                  "DELETE OK\n",
                  unsigned(held));
    }
    // ==== STAGE D — serial pipelining (workstream D) ==========================
    // The firmware side of "no ACK serialisation": loop() drains every
    // available byte per iteration and every handler answers synchronously, so
    // requests need no one-in-flight discipline on the host. Self-contained
    // (helpers are local lambdas) so the other workstreams' stages merge
    // around it. Spec: docs/spec/serial-protocol.md#pipelining.
    //   D1 — N GETs written back-to-back WITHOUT reading: all N ACK, in send
    //        (seq) order, and the batch costs far less than N awaited round
    //        trips.
    //   D2 — seq=0 UPDATEs interleaved between awaited GETs in one burst:
    //        only the GETs answer (in order) and the LAST update wins.
    //   D3 — GETs issued while a two-phase CMD_FRAME is pending (FIN ~60 ms
    //        away) ACK BEFORE that FIN — a pending request never gates
    //        unrelated ones.
    {
      auto frameBytes = [&](Protocol::RawPacket &&packet,
                            std::vector<uint8_t> &out) {
        CHECK(wire.tx.encode(packet.finalize()), "COBS encode (burst)");
        out.insert(out.end(), wire.tx.data(), wire.tx.data() + wire.tx.size());
      };
      auto writeAll = [&](const std::vector<uint8_t> &bytes) {
        size_t off = 0;
        while (off < bytes.size()) {
          const ssize_t n =
              ::write(wire.fd, bytes.data() + off, bytes.size() - off);
          if (n > 0) {
            off += size_t(n);
            continue;
          }
          CHECK(n < 0 && (errno == EAGAIN || errno == EINTR), "burst write");
          pollfd p{wire.fd, POLLOUT, 0};
          ::poll(&p, 1, 100);
        }
      };
      auto getTs = [&](uint16_t s, std::vector<uint8_t> &out) {
        frameBytes({Protocol::Method::GET, Protocol::Property::SYS_TIMESTAMP, s},
                   out);
      };
      auto msSince = [](Clock::time_point t0) {
        return std::chrono::duration<double, std::milli>(Clock::now() - t0)
            .count();
      };

      // D1 — sequential baseline vs one pipelined burst.
      constexpr int N = 128;
      auto t0 = Clock::now();
      for (int i = 0; i < N; i++)
        (void)mcuNow(wire);
      const double seqMs = msSince(t0);

      std::vector<uint16_t> seqs;
      std::vector<uint8_t> burst;
      for (int i = 0; i < N; i++) {
        seqs.push_back(wire.next());
        getTs(seqs.back(), burst);
      }
      t0 = Clock::now();
      writeAll(burst);
      uint64_t prevUs = 0, firstUs = 0;
      for (int i = 0; i < N; i++) {
        const auto ack = wire.recv();
        expectHeader(ack, Protocol::Method::ACK,
                     Protocol::Property::SYS_TIMESTAMP, seqs[size_t(i)],
                     "pipelined ACK in seq order");
        const uint64_t us = payloadAs<System::Timestamp>(ack).microseconds;
        CHECK(us >= prevUs, "pipelined requests handled in send order");
        if (i == 0)
          firstUs = us;
        prevUs = us;
      }
      const double pipeMs = msSince(t0);
      CHECK(pipeMs * 2 < seqMs,
            "pipelined batch costs well under N sequential round trips");
      std::printf("fw-sim-check: D1 %d GETs pipelined %.2f ms vs sequential "
                  "%.2f ms (%.1fx; MCU handled all within %llu us) OK\n",
                  N, pipeMs, seqMs, seqMs / pipeMs,
                  static_cast<unsigned long long>(prevUs - firstUs));

      // D2 — fire-and-forget UPDATEs interleaved with awaited GETs. Stream 1
      // is the ACTIVE stream after stage 6 (its settle-0 frame re-activated it).
      const size_t dacMark = sim.lines.size();
      constexpr int U = 16;
      seqs.clear();
      burst.clear();
      for (int k = 0; k < U; k++) {
        Cmd::MirrorStream cmd{};
        cmd.op = Cmd::MirrorStream::UPDATE;
        cmd.id = 1;
        cmd.left = pos(uint16_t(0x5A00 + k), 0x1111, 0x2222, 0x3333);
        cmd.right = pos(0x4444, 0x5555, 0x6666, 0x7777);
        frameBytes(setPacket(Protocol::Property::CMD_STREAM, 0, &cmd,
                             sizeof(cmd)),
                   burst);
        if (k % 4 == 3) {
          seqs.push_back(wire.next());
          getTs(seqs.back(), burst);
        }
      }
      writeAll(burst);
      for (const auto s : seqs) {
        const auto ack = wire.recv();
        expectHeader(ack, Protocol::Method::ACK,
                     Protocol::Property::SYS_TIMESTAMP, s,
                     "interleaved GET ACK (updates stay silent)");
      }
      CHECK(wire.silent(100), "no response to any seq=0 UPDATE in the burst");
      char last[8];
      std::snprintf(last, sizeof(last), "%04X", 0x5A00 + U - 1);
      // Format-agnostic DAC match (the dual-bus shim may change the word's
      // command nibble / cs split): a left-mirror word ending in the value.
      auto leftWordEndsWith = [](const std::string &l, const char *hex,
                                 size_t n) {
        return l.rfind("dac cs=L", 0) == 0 && l.size() >= 4 &&
               l.compare(l.size() - 4, n, hex, n) == 0;
      };
      const bool lastLanded = [&] {
        const auto deadline = Clock::now() + std::chrono::milliseconds(2000);
        while (Clock::now() < deadline) {
          for (size_t i = dacMark; i < sim.lines.size(); i++)
            if (leftWordEndsWith(sim.lines[i], last, 4))
              return true;
          sim.pump(20);
        }
        return false;
      }();
      CHECK(lastLanded, "last UPDATE of the burst reached the left DAC");
      size_t landed = 0;
      for (size_t i = dacMark; i < sim.lines.size(); i++)
        if (leftWordEndsWith(sim.lines[i], "5A", 2))
          landed++;
      std::printf("fw-sim-check: D2 %d seq=0 UPDATEs + %zu GETs in one burst: "
                  "GET ACKs in order, updates silent, latest wins (%zu/%d "
                  "targets reached the DAC — Streams::tick coalesces) OK\n",
                  U, seqs.size(), landed, U);

      // D3 — unrelated requests are not gated by a pending two-phase FRAME.
      sim.ctl("strobe L 500 60000");
      sim.ctl("strobe R 700 60000");
      Cmd::Frame req{};
      req.stream = 1;
      req.cameras = Cmd::CAM_L | Cmd::CAM_R;
      req.pulse = 58'000; // strobe falls (60 ms) inside pulse + REJ margin
      req.settle_time = 0;
      const uint16_t frameSeq = wire.next();
      burst.clear();
      {
        Protocol::RawPacket packet(Protocol::Method::GET,
                                   Protocol::Property::CMD_FRAME, frameSeq);
        packet.setData(&req, sizeof(req));
        frameBytes(std::move(packet), burst);
      }
      seqs.clear();
      for (int i = 0; i < 8; i++) {
        seqs.push_back(wire.next());
        getTs(seqs.back(), burst);
      }
      t0 = Clock::now();
      writeAll(burst);
      expectAck(wire, Protocol::Property::CMD_FRAME, frameSeq, "D3 frame ACK");
      for (const auto s : seqs) {
        const auto ack = wire.recv();
        expectHeader(ack, Protocol::Method::ACK,
                     Protocol::Property::SYS_TIMESTAMP, s,
                     "GET behind a pending FRAME ACKs before its FIN");
      }
      const double getsMs = msSince(t0);
      const auto fin = wire.recv();
      expectHeader(fin, Protocol::Method::FIN, Protocol::Property::CMD_FRAME,
                   frameSeq, "pending FRAME FINs after the GETs");
      const double finMs = msSince(t0);
      sim.ctl("strobe L 500 2500");
      sim.ctl("strobe R 700 2500");
      std::printf("fw-sim-check: D3 8 GETs ACKed %.2f ms after a FRAME whose "
                  "FIN took %.2f ms — no head-of-line blocking OK\n",
                  getsMs, finMs);
    }
    // ==== end STAGE D =========================================================

    // 7 — Enable(false) teardown wire order: pending-frame REJ, THEN the ACK
    {
      sim.ctl("strobe L off");
      sim.ctl("strobe R off");
      // Park a frame (long pulse, no strobes) so disable has one to cancel.
      Cmd::Frame req{};
      req.stream = 1;
      req.cameras = Cmd::CAM_L | Cmd::CAM_R;
      req.pulse = 2'000'000;
      req.settle_time = 0;
      const uint16_t frameSeq = wire.next();
      Protocol::RawPacket packet(Protocol::Method::GET,
                                 Protocol::Property::CMD_FRAME, frameSeq);
      packet.setData(&req, sizeof(req));
      wire.send(std::move(packet));
      expectAck(wire, Protocol::Property::CMD_FRAME, frameSeq, "parked frame ACK");

      System::Enable off{};
      const size_t disableMark = sim.lines.size();
      const uint16_t disableSeq = wire.next();
      wire.send(setPacket(Protocol::Property::SYS_ENABLE, disableSeq, &off,
                          sizeof(off)));
      // Wire order proof: the canceled frame's REJ precedes the enable ACK.
      const auto rej = wire.recv();
      expectHeader(rej, Protocol::Method::REJ, Protocol::Property::CMD_FRAME,
                   frameSeq, "canceled frame REJs FIRST");
      CHECK(payloadStr(rej).find("System disabled") != std::string::npos,
            "cancel reason");
      expectAck(wire, Protocol::Property::SYS_ENABLE, disableSeq,
                "enable ACK arrives AFTER the cancels");
      // Power-down in reverse (guide p31): MEMS_EN LOW, bias, FCLK off.
      const size_t railAt = sim.indexOf("pin 6 0", disableMark);
      const size_t biasAt = sim.indexOf("dac cs=LR 1F7530", disableMark);
      const size_t fclkAt = sim.indexOf("pwm pin=10 duty=0", disableMark);
      CHECK(railAt < biasAt && biasAt < fclkAt,
            "disable order: MEMS_EN low, bias to neutral, then FCLK off");

      // Stream table cleared: re-enable, then stream 1 must be unknown.
      System::Enable on{};
      on.enable = 1;
      uint16_t s = wire.next();
      wire.send(setPacket(Protocol::Property::SYS_ENABLE, s, &on, sizeof(on)));
      expectAck(wire, Protocol::Property::SYS_ENABLE, s, "re-enable");
      s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1, pos(0, 0, 0, 0),
               pos(0, 0, 0, 0), s);
      CHECK(expectRej(wire, Protocol::Property::CMD_STREAM, s,
                      "stream 1 gone after disable")
                    .find("Unknown stream") != std::string::npos,
            "disable cleared the stream table");
      std::printf("fw-sim-check: 7 teardown order + stream clear OK\n");
    }

    // Board::camera trigger (Line3) pins, as the sim's `pin` lines report them
    // (firmware/include/Board.h: C = 16, L = 20, R = 5).
    const std::string TRIG_C = "pin 16 ", TRIG_L = "pin 20 ", TRIG_R = "pin 5 ";
    const auto seen = [&](const std::string &prefix, size_t from) {
      for (size_t i = from; i < sim.lines.size(); i++)
        if (sim.lines[i].rfind(prefix, 0) == 0)
          return true;
      return false;
    };

    // 8 — center camera: C|L|R FIN, default mask stays L|R, bad mask REJ
    {
      uint16_t s = wire.next();
      streamOp(wire, Cmd::MirrorStream::CREATE, 3, pos(5000, 6000, 7000, 8000),
               pos(8000, 7000, 6000, 5000), s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "stream 3 CREATE");
      sim.ctl("strobe C 300 2000");
      sim.ctl("strobe L 500 2500");
      sim.ctl("strobe R 700 2500");

      size_t mark = sim.lines.size();
      const auto all = runFrame(wire, 3, 2000, 0, 5000,
                                Cmd::CAM_C | Cmd::CAM_L | Cmd::CAM_R);
      CHECK(all.accepted, "C|L|R frame ACKed (no center-camera REJ)");
      CHECK(all.finished, "C|L|R frame FINs");
      CHECK(all.fin.t_exposure > all.fin.t_trigger, "C|L|R exposure after trigger");
      sim.waitLine(TRIG_C + "1", 1000, mark);
      sim.waitLine(TRIG_L + "1", 1000, mark);
      sim.waitLine(TRIG_R + "1", 1000, mark);
      sim.waitLine("strobe C 1", 1000, mark); // C's injected exposure
      sim.waitLine(TRIG_C + "0", 1000, mark); // ...and its trigger released
      CHECK(all.fin.left.ch[0] == 5000 && all.fin.right.ch[0] == 8000,
            "C|L|R FIN positions = stream 3 target");

      // cameras = 0 -> firmware default L|R. Also proves a camera outside the
      // request (C's edges from the frame above) cannot block completion.
      mark = sim.lines.size();
      const auto dflt = runFrame(wire, 3, 2000, 0, 5000, 0);
      CHECK(dflt.finished, "default-mask frame FINs right after a C|L|R frame");
      sim.waitLine(TRIG_L + "1", 1000, mark);
      sim.waitLine(TRIG_R + "1", 1000, mark);
      CHECK(!seen(TRIG_C, mark), "default mask leaves the C trigger untouched");

      const auto bad = runFrame(wire, 3, 2000, 0, 5000, 0x08);
      CHECK(!bad.accepted && bad.rejReason.find("Invalid camera mask") !=
                                 std::string::npos,
            "mask outside C|L|R REJs synchronously");
      std::printf("fw-sim-check: 8 center camera C|L|R + default L|R OK\n");
    }

    // 9 — strobe polarity contract (Board::STROBE_ACTIVE_LEVEL = LOW: the
    //     camera's open-drain Line2 pulls the pulled-up line LOW while exposing)
    {
      const auto level = [&](const std::string &cam) {
        const size_t from = sim.lines.size();
        sim.ctl("read " + cam);
        const auto line = sim.waitLine("level " + cam + " ", 1000, from);
        return line.substr(line.rfind(' ') + 1);
      };
      for (const char *cam : {"C", "L", "R"})
        CHECK(level(cam) == "1",
              std::string("strobe ") + cam +
                  " idles at the released level (HIGH = pull-up, active-LOW line)");

      // Inverted waveform (LineInverter=true): idles LOW, exposure drives
      // HIGH. Against the active-LOW firmware the idle reads as "asserted", so
      // the request can never see a release after its rise and must time out —
      // the contract that polarity is a board constant, not something the
      // line can flip.
      sim.ctl("polarity L high");
      sim.ctl("polarity R high");
      CHECK(level("L") == "0" && level("R") == "0",
            "inverted (active-HIGH) line idles LOW");
      sim.ctl("strobe L 500 2500");
      sim.ctl("strobe R 700 2500");
      const auto inverted = runFrame(wire, 3, 2000, 0);
      CHECK(inverted.accepted && !inverted.finished,
            "active-HIGH strobe vs active-LOW firmware: ACK then REJ");
      CHECK(inverted.rejReason.rfind("Strobe timeout", 0) == 0,
            "inverted-polarity REJ is a strobe timeout");
      CHECK(inverted.rejReason.find("stuck at active level") != std::string::npos,
            "timeout names the line stuck at the active level");

      // Honest V0.1 open-drain waveform again -> FIN.
      sim.ctl("polarity L low");
      sim.ctl("polarity R low");
      CHECK(level("L") == "1" && level("R") == "1",
            "back to active-LOW: lines idle at the pull-up again");
      const auto honest = runFrame(wire, 3, 2000, 0);
      CHECK(honest.finished, "active-LOW (open-drain) strobe FINs");
      std::printf("fw-sim-check: 9 strobe polarity contract (\"%s\") OK\n",
                  inverted.rejReason.c_str());
    }

    // 10 — clean shutdown
    sim.ctl("quit");
    int status = 0;
    CHECK(::waitpid(sim.pid, &status, 0) == sim.pid, "waitpid");
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0, "sim exits 0");
    std::printf("fw-sim-check: ALL OK\n");
    rc = 0;
    ::close(wire.fd);
  } catch (const std::exception &e) {
    std::fprintf(stderr, "fw-sim-check FAILED: %s\n", e.what());
    if (sim.pid > 0)
      ::kill(sim.pid, SIGKILL);
    ::waitpid(sim.pid, nullptr, 0);
  }
  return rc;
}
