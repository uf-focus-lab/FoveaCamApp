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
//   8. quit -> exit 0.

#include <cassert>
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
      pollfd p{fd, POLLIN, 0};
      ::poll(&p, 1, 20);
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
                             uint32_t settle, int timeoutMs = 5000) {
  Cmd::Frame req{};
  req.stream = stream;
  req.cameras = Cmd::CAM_L | Cmd::CAM_R;
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

int main() {
  Sim sim = spawnSim();
  int rc = 1;
  try {
    const std::string ptyLine = sim.waitLine("pty ");
    const std::string ptyPath = ptyLine.substr(4);
    std::printf("fw-sim-check: sim at %s\n", ptyPath.c_str());

    Wire wire;
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

    // 8 — clean shutdown
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
