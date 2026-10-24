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
//   4b. Trigger released at exposure end when the strobe falls before the
//      pulse ends (Timed fallback), so the next capture still rises.
//   5. Strobe-timeout REJ (strobes disarmed).
//   6. settle_time: SWITCH-frame trigger deferred >= settle (MCU clock);
//      same-stream frame undeferred; settle 0 switch undeferred.
//   7. Enable(false) teardown wire ORDER: pending-frame REJ before the
//      enable ACK; power-down ORDER (MEMS_EN low, bias, FCLK off).
//   C1-C4 (v2.2.0, between 6 and 7): CMD_SCHEDULE keyframe applied at its
//      MCU time; INTERPOLATE ramp writes intermediate DAC values (and a
//      mid-ramp frame reports them); stale/UPDATE-clears semantics;
//      CMD_TRAJECTORY upload/commit/start -> periodic DAC playback + marker
//      SYN pushes with sane timestamps; Actuate / legacy Trigger REJ while
//      a run plays, START REJ while a legacy Trigger is pending; an Actuate
//      in HOLD moves the hold position (past the 1 Hz refresh); STOP holds
//      position; a START + MEMS reset burst still starts at phase 0; START +
//      STOP in one loop iteration holds the DAC's actual position, and right
//      after a MEMS reset holds V_BIAS; DAC returns to the streams.
//   C5 (v2.2.1): CMD_TRAJECTORY atomic swap — START b at a's t_start while a
//      runs (same period) switches tables in place: mismatched period /
//      t_start / a itself REJ with a still running; a's in-flight capture
//      pushes (a's id) after the swap ACK; marker cycles stay contiguous on
//      the original clock; the DAC ramp keeps advancing (no HOLD, no phase
//      jump) and b's table plays afterwards.
//   C6 (v2.2.1): two more swap shapes with the same continuity checks — b's
//      marker earlier than the phase at the swap first fires NEXT cycle (not
//      late in the swap cycle); b with more markers than a fires its extra
//      marker in the swap cycle, once, on the original clock. C6c: a swap
//      while ARMED keeps pre-positioning at b's phase 0; a swap whose
//      `cycles` is already spent ends on the next tick (phase-0 hold, ENDED).
//   D. Pipelining (runs between 6 and 7): N requests in
//      flight answered in seq order at ~one round trip; seq=0 UPDATEs
//      interleaved silently (latest wins); requests behind a pending
//      two-phase FRAME are not gated by its FIN.
//   8. Center camera (V0.1 board): cameras = C|L|R drives all three Line3
//      triggers and FINs; the default mask (0) is still L|R (C untouched) and
//      FINs right after a C|L|R frame; an out-of-range mask REJs.
//   9. Strobe polarity contract: lines idle at the released level (HIGH, the
//      pull-up, for the default active-LOW Board::STROBE_ACTIVE_LEVEL); an
//      inverted (active-HIGH, LineInverter=false) injected waveform times
//      out against it with the "stuck at active level" hint; back to the
//      open-drain active-LOW shape, it FINs again.
//  10. quit -> exit 0.
//
// Host load. The timing stages (C2-C6) need the sim to get a FAIR CORE
// SHARE: its loop must keep real time to within a few ms. Starved for tens
// of ms, the firmware answers exactly as it should — a late marker, missed
// crossings merged into one BUSY push, an ENDED overtaking the last capture's
// OK push — and those answers are told from faults only by the sim's own
// `stall <gap_us> <mcu_us>` lines: a timing failure is a fixture miss
// (re-run) only when a recorded stall at least as long as the margin the
// check gives overlaps its window, else a firmware fault. A push that is not
// the one expected is classified by KIND (checkPush): a skipped crossing
// needs a stall of ~a period, a BUSY or an ENDED ahead of an OK push the
// idle gap before it in stalls, a STROBE_TIMEOUT the timeout's slack; a
// repeated or backward (cycle, marker) or a wrong table id is a firmware
// fault whatever the sim did. Host-side stalls (this process descheduled)
// are handled by measuring the instants that matter on the MCU clock instead
// (the swap instant, the strobe rises).
// A sim starved for longer than the re-arm budget absorbs fails the run as a
// fixture failure ("host missed the window"), not as a firmware fault.

#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <functional>
#include <initializer_list>
#include <optional>
#include <poll.h>
#include <signal.h> // ::kill — leaks in via sys/wait.h on glibc, NOT on macOS
#include <stdexcept>
#include <string>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <utility>
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

// One sim service-loop stall (`stall <gap_us> <mcu_us>`), MCU clock.
struct Stall {
  uint64_t from, to; // [mcu_us - gap_us, mcu_us]
};

struct Sim {
  pid_t pid = -1;
  int in = -1;   // sim stdin (control channel)
  int out = -1;  // sim stdout (control plane)
  std::string buf;
  std::vector<std::string> lines;
  std::vector<Stall> stalls; // every `stall` line seen so far

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
        unsigned long long gap, at;
        if (std::sscanf(lines.back().c_str(), "stall %llu %llu", &gap, &at) ==
            2)
          stalls.push_back({at > gap ? at - gap : 0, at});
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

  // A request round trip on the pty (set by main: a GET SYS_TIMESTAMP that
  // skips any other response). A stall line is emitted at the START of the
  // loop iteration after the gap — so a preemption INSIDE one iteration (say
  // between the strobe pump and Capture::tick) is reported only after the
  // pushes that iteration sent. The iteration that answers a request sent
  // after a push has arrived is a later one, and it prints its stall line
  // before the answer goes out; callers sync before reading `stalls`.
  std::function<void()> sync;

  // The longest recorded loop stall of at least `margin` us overlapping the
  // MCU interval [lo, hi], or 0. Pumps first (call sync() before: see above).
  uint64_t stalledFor(uint64_t lo, uint64_t hi, uint64_t margin) {
    pump(5);
    uint64_t worst = 0;
    for (const Stall &st : stalls)
      if (st.to - st.from >= margin && st.from <= hi && st.to >= lo)
        worst = std::max(worst, st.to - st.from);
    return worst;
  }

  // The recorded stall time inside [lo, hi], summed over every stall. Pumps
  // first, as stalledFor.
  uint64_t stalledTotal(uint64_t lo, uint64_t hi) {
    pump(5);
    uint64_t sum = 0;
    for (const Stall &st : stalls)
      if (st.from < hi && st.to > lo)
        sum += std::min(st.to, hi) - std::max(st.from, lo);
    return sum;
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
#ifdef F_SETPIPE_SZ
  // Trajectory playback writes a DAC line every few loop ticks; a 64 KB pipe
  // fills quickly whenever this process is descheduled (a loaded host), and
  // the sim then BLOCKS in its write — a loop stall the timing assertions
  // would blame on the firmware. Best effort (Linux; capped by
  // pipe-max-size).
  ::fcntl(outPipe[0], F_SETPIPE_SZ, 1 << 20);
#endif
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
  // SYN CMD_TRAJECTORY pushes recv() met while waiting for a response, in
  // arrival order; recvTrajectoryFrame() pops them first. Never dropped: a
  // push read by a round-trip helper (mcuNow, expectAck, trajectoryOp, ...)
  // is still the one a stage expects next, and a doubled marker or a
  // spurious BUSY cannot hide behind a helper.
  std::deque<Packet::Command::TrajectoryFrame> pushes;

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

  /** Next response off the pty; throws on timeout. Unsolicited SYNs are not
   *  responses: LOG pushes are skipped and CMD_TRAJECTORY pushes queued on
   *  `pushes` — unless `keepSyn`, which returns every frame raw. */
  Protocol::RawPacket recv(int timeoutMs = 5000, bool keepSyn = false) {
    auto packet = tryRecv(timeoutMs, keepSyn);
    if (!packet)
      throw std::runtime_error("timed out waiting for a response packet");
    return std::move(*packet);
  }

  /** recv(), but nullopt on timeout. */
  std::optional<Protocol::RawPacket> tryRecv(int timeoutMs, bool keepSyn) {
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
        if (!keepSyn && Protocol::method(header) == Protocol::Method::SYN) {
          if (Protocol::property(header) ==
              Protocol::Property::CMD_TRAJECTORY) {
            Packet::Command::TrajectoryFrame f;
            CHECK(packet.dataSize() == sizeof(f), "trajectory push size");
            std::memcpy(&f, packet.data(), sizeof(f));
            pushes.push_back(f);
          }
          continue; // a push — not a response
        }
        return packet;
      }
      if (Clock::now() >= deadline)
        return std::nullopt;
      if (sim)
        sim->pump(0);
      pollfd p{fd, POLLIN, 0};
      ::poll(&p, 1, sim ? 2 : 20);
    }
  }

  /** True iff NO frame arrives within `windowMs` (seq=0 silence probe). */
  bool silent(int windowMs) { return !tryRecv(windowMs, true); }
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

// Next SYN CMD_TRAJECTORY push — the oldest queued one (Wire::pushes), else
// off the wire (LOG pushes skipped). False on timeout.
static bool nextPush(Wire &wire, int timeoutMs, Cmd::TrajectoryFrame &out) {
  if (!wire.pushes.empty()) {
    out = wire.pushes.front();
    wire.pushes.pop_front();
    return true;
  }
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
  while (true) {
    const int left =
        int(std::chrono::duration_cast<std::chrono::milliseconds>(
                deadline - Clock::now())
                .count());
    if (left <= 0)
      return false;
    auto got = wire.tryRecv(left, true);
    if (!got)
      return false;
    const Protocol::RawPacket &packet = *got;
    const auto header = packet.validate();
    if (Protocol::method(header) == Protocol::Method::SYN &&
        Protocol::property(header) == Protocol::Property::CMD_TRAJECTORY) {
      out = payloadAs<Cmd::TrajectoryFrame>(packet);
      return true;
    }
    CHECK(Protocol::method(header) == Protocol::Method::SYN &&
              Protocol::property(header) == Protocol::Property::LOG,
          "only LOG / trajectory pushes arrive unsolicited");
  }
}

// Next SYN CMD_TRAJECTORY push (queued first); throws on timeout.
static Cmd::TrajectoryFrame recvTrajectoryFrame(Wire &wire, int timeoutMs) {
  Cmd::TrajectoryFrame f;
  if (!nextPush(wire, timeoutMs, f))
    throw std::runtime_error("timed out waiting for a TrajectoryFrame push");
  return f;
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

// One COBS frame appended to a burst; sendBurst() writes the whole burst at
// once, so the sim's loop reads it in one Serial.available() batch and handles
// every packet in it within ONE loop iteration (no tick() in between).
static void appendFrame(Wire &wire, Protocol::RawPacket &&packet,
                        std::vector<uint8_t> &out) {
  CHECK(wire.tx.encode(packet.finalize()), "COBS encode (burst)");
  out.insert(out.end(), wire.tx.data(), wire.tx.data() + wire.tx.size());
}

static void sendBurst(Wire &wire, const std::vector<uint8_t> &bytes) {
  size_t off = 0;
  while (off < bytes.size()) {
    const ssize_t n = ::write(wire.fd, bytes.data() + off, bytes.size() - off);
    if (n > 0) {
      off += size_t(n);
      continue;
    }
    CHECK(n < 0 && (errno == EAGAIN || errno == EINTR), "burst write");
    pollfd p{wire.fd, POLLOUT, 0};
    ::poll(&p, 1, 100);
  }
}

// The next response, which must answer `seq` with an ACK on `p`.
static void expectAckOf(Wire &wire, Protocol::Property p, uint16_t seq,
                        const char *what) {
  const auto resp = wire.recv();
  CHECK(resp.header().sequence == seq && Protocol::property(resp.validate()) == p,
        what);
  if (Protocol::method(resp.validate()) != Protocol::Method::ACK)
    throw std::runtime_error(std::string("CHECK failed: ") + what +
                             " (got: " + payloadStr(resp) + ")");
}

// Host-load tolerance for the stages whose assertions ride on the sim's loop
// keeping real time (marker phases, strobe edges, DAC words per tick). Under a
// loaded host (a parallel type-check) the sim process can be descheduled for
// tens of ms, which the firmware answers exactly as it should — a marker
// crossing coalesced into the latest one, a strobe timeout, a coarse DAC
// step — but which a timing assertion cannot tell from a fault. Such a stage
// runs ONCE more after `recover` restores its entry state. The first failure
// is logged ("retrying once"), so a load flake stays visible; a deterministic
// firmware fault fails both attempts.
//
// A FIXTURE miss is different: the HOST was too slow to act inside a timing
// window the scenario needs (send a swap between two marker phases, sample
// before t_start), so the scenario never ran as designed and nothing about
// the firmware was observed. A miss found before acting re-syncs in place to
// the next cycle's window (fixtureWindow); one found only afterwards throws
// FixtureMiss and the stage re-runs. Either way at most FIXTURE_REARMS times
// per window/stage, each logged ("re-arming") and counted; firmware-fault
// checks stay strict and keep the single retry. Running out of re-arms is a
// fixture failure of its own (FixtureExhausted): the run fails, but with no
// stage retry on top — a retry would only re-arm FIXTURE_REARMS times more.
struct FixtureMiss : std::runtime_error {
  using std::runtime_error::runtime_error;
};
struct FixtureExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};
constexpr unsigned FIXTURE_REARMS = 5;
static unsigned stageRetries = 0, fixtureRearms = 0; // reported at the end

static void noteRearm(const std::string &what, unsigned miss) {
  if (miss >= FIXTURE_REARMS)
    throw FixtureExhausted("re-arms exhausted: " + what + " (host missed "
                           "the window " + std::to_string(miss + 1) +
                           " times)");
  fixtureRearms++;
  std::printf("fw-sim-check: fixture miss %u/%u (%s); re-arming\n", miss + 1,
              FIXTURE_REARMS, what.c_str());
  std::fflush(stdout);
}

template <typename Body, typename Recover>
static void retryOnce(const char *stage, Body body, Recover recover) {
  bool retried = false;
  for (unsigned misses = 0;; recover()) {
    try {
      body();
      return;
    } catch (const FixtureMiss &e) {
      noteRearm(std::string(stage) + ": " + e.what(), misses++);
    } catch (const FixtureExhausted &) {
      throw;
    } catch (const std::runtime_error &e) {
      if (retried)
        throw;
      retried = true;
      stageRetries++;
      std::printf("fw-sim-check: %s attempt failed (%s); retrying once\n",
                  stage, e.what());
      std::fflush(stdout);
    }
  }
}

// The sim's `stall` report threshold (STALL_REPORT_US in fw-sim/main.cpp): a
// loop gap shorter than this leaves no line.
constexpr uint64_t STALL_REPORT_US = 2'000;

// Whether the sim's recorded loop stalls explain a failure over the MCU
// window [lo, hi]: the longest stall of at least `margin` us overlapping it
// or, `summed`, the stall time inside it when that adds up to `margin` (a
// BUSY or an ENDED overtaking an OK push takes a late fire AND a late
// completion: two stalls). 0 = no. margin = UINT64_MAX: never. Two request
// round trips first (Sim::sync) — the first can still be read by the loop
// iteration that sent the push being checked, when the sim is preempted
// between the two — so a stall inside that iteration is on record.
static uint64_t stallExplains(Sim &sim, uint64_t lo, uint64_t hi,
                              uint64_t margin, bool summed = false) {
  if (margin == UINT64_MAX)
    return 0;
  if (sim.sync) {
    try {
      sim.sync();
      sim.sync();
    } catch (const std::runtime_error &) {
      // classify on what is on record
    }
  }
  if (!summed)
    return sim.stalledFor(lo, hi, margin);
  const uint64_t sum = sim.stalledTotal(lo, hi);
  return sum >= margin ? sum : 0;
}

// A timing check whose failure a starved SIM can produce with the firmware
// right (a marker fired late, a coarse DAC step — see the header). It fails
// as a fixture miss only when the sim's recorded stalls explain it
// (stallExplains: one stall at least `margin` us long overlapping the MCU
// window [lo, hi] the check is about, or `summed` stall time inside it);
// otherwise it is a firmware fault, as strict as CHECK. margin = UINT64_MAX:
// always strict.
static void checkTimed(Sim &sim, bool ok, const std::string &what,
                       uint64_t lo, uint64_t hi, uint64_t margin,
                       bool summed = false) {
  if (ok)
    return;
  if (const uint64_t gap = stallExplains(sim, lo, hi, margin, summed))
    throw FixtureMiss(what + " — the sim loop stalled " +
                      (summed ? "a total of " : "") + std::to_string(gap) +
                      " us inside the window (margin " +
                      std::to_string(margin) + " us)");
  throw std::runtime_error("CHECK failed: " + what);
}
#define CHECK_TIMED(SIM, COND, MSG, LO, HI, MARGIN)                            \
  checkTimed(SIM, bool(COND), std::string(MSG) + " (" #COND ")", LO, HI, MARGIN)

// A stage's marker schedule, for classifying a push that is not the one the
// stage expects next by what a starved sim CAN do with the firmware right
// (checkPush, discardPushes). Each gap is the shortest stretch of its kind in
// the stage's schedule, us; UINT64_MAX (the default) keeps that kind strict.
struct PushGaps {
  uint64_t period = UINT64_MAX;  // the table period
  uint64_t marker = UINT64_MAX;  // a capture's end -> the next marker phase
  uint64_t end = UINT64_MAX;     // the last capture's end -> the run's end
  uint64_t timeout = UINT64_MAX; // the strobe timeout's slack past the fall
};

// A crossing is skipped only when no loop iteration ran for a whole period;
// 1/8 of it is slack for the pass bodies around a gap measured start to start.
static uint64_t skipMargin(const PushGaps &g) {
  return g.period == UINT64_MAX ? UINT64_MAX : g.period - g.period / 8;
}

// The stall time an idle gap takes summed over two stalls: the gap, less the
// two unreported (< STALL_REPORT_US) loop gaps it may also span.
static uint64_t summedMargin(uint64_t gap) {
  if (gap == UINT64_MAX)
    return gap;
  return std::max<uint64_t>(gap - std::min(gap, 2 * STALL_REPORT_US), 1);
}

static std::string describePush(const Cmd::TrajectoryFrame &f) {
  return "status " + std::to_string(f.status) + " id " + std::to_string(f.id) +
         " marker " + std::to_string(f.marker) + " cycle " +
         std::to_string(f.cycle);
}

// `f` must be the marker push a stage expects next: OK, table `id`, (cycle,
// marker), that crossing due at MCU time `due`. A starved sim (firmware
// right) answers that crossing with only:
//   - a STROBE_TIMEOUT of it: one stall of the timeout's slack over
//     [due - P, due + P] (between the edge pump and Capture::tick);
//   - a BUSY of it or of a crossing up to one cycle on, ahead of its push
//     (that crossing met this capture still busy; Trajectory::tick runs
//     before Capture::tick): the stalls over [due, the BUSY's phase] add up
//     to the inter-marker idle gap;
//   - ENDED ahead of the run's last capture push: the stalls over [due, the
//     run's end] add up to the end gap;
//   - any later crossing (this one skipped): no loop iteration for ~a period,
//     one stall of skipMargin over [due, due + P].
// A repeated or backward (cycle, marker), a wrong table id, a CANCELLED push
// or a malformed ENDED is a firmware fault whatever the sim did.
static void checkPush(Sim &sim, const Cmd::TrajectoryFrame &f, uint8_t id,
                      uint8_t marker, uint32_t cycle, uint64_t due,
                      const PushGaps &g, const std::string &what) {
  using TF = Cmd::TrajectoryFrame;
  const int64_t want = (int64_t(cycle) << 8) | marker;
  const int64_t got = (int64_t(f.cycle) << 8) | f.marker;
  if (f.status == TF::OK && f.id == id && got == want)
    return;
  const std::string desc = what + ": push identity/status (got " +
                           describePush(f) + ", want status 0 id " +
                           std::to_string(id) + " marker " +
                           std::to_string(marker) + " cycle " +
                           std::to_string(cycle) + ")";
  std::fprintf(stderr, "%s\n", desc.c_str());
  auto fault = [&](const char *kind) {
    throw std::runtime_error("CHECK failed: " + desc + " — " + kind);
  };
  const uint64_t P = g.period == UINT64_MAX ? 0 : g.period;
  if (f.id != id)
    fault("wrong table id");
  if (f.status == TF::ENDED) {
    if (f.marker != TF::NO_MARKER)
      fault("an ENDED push with a marker");
    if (f.cycle == uint64_t(cycle) + 1)
      checkTimed(sim, false, desc + " — ENDED overtook the last capture's push",
                 due, f.result.t_trigger, summedMargin(g.end), true);
    if (f.cycle > uint64_t(cycle) + 1)
      checkTimed(sim, false, desc + " — ENDED past a skipped crossing", due,
                 due + P, skipMargin(g));
    fault("ENDED before the expected crossing's cycle");
  }
  if (f.marker == TF::NO_MARKER || f.status == TF::CANCELLED)
    fault("not a marker capture or BUSY push");
  if (got < want)
    fault("a repeated or backward (cycle, marker)");
  if (f.status == TF::BUSY && f.cycle <= uint64_t(cycle) + 1)
    checkTimed(sim, false, desc + " — a BUSY ahead of this crossing's push",
               due, f.result.t_trigger, summedMargin(g.marker), true);
  if (got > want)
    checkTimed(sim, false, desc + " — a skipped crossing", due, due + P,
               skipMargin(g));
  if (f.status == TF::STROBE_TIMEOUT)
    checkTimed(sim, false, desc + " — a strobe timeout", due - std::min(due, P),
               due + P, g.timeout);
  fault("unknown status");
}

// Drops the trajectory pushes of cycles no stage inspects — C4's endless run,
// the cycles a fixture re-arm skips — so none stands in for a push a stage
// expects later (Wire::recv queues them). Queued pushes first, then off the
// wire: up to and including the push of cycle `last` when `untilLast` (a
// table with ONE marker) and then, after a request round trip, every queued
// push of a cycle <= `last` (a starved sim pushes BUSY(c) before OK(c - 1):
// Trajectory::tick runs before Capture::tick), else whatever arrives within
// `waitMs`. Each must be a marker push (any status) of table `id` for a cycle
// in [first, last], every (cycle, marker) once, the capture pushes in order
// and the BUSY pushes in order. A capture's push behind a later crossing's
// BUSY needs the stalls of the idle gap (`g.marker`, summed over the period
// before that BUSY), a cycle past `last` (`last` skipped) a stall of ~a
// period over the MCU window [lo, hi] (checkTimed); anything else is a
// firmware fault. Returns the count.
static unsigned discardPushes(Wire &wire, uint8_t id, uint32_t first,
                              uint32_t last, bool untilLast, int waitMs,
                              const std::string &what, uint64_t lo = 0,
                              uint64_t hi = UINT64_MAX,
                              const PushGaps &g = PushGaps{}) {
  using TF = Cmd::TrajectoryFrame;
  const auto deadline = Clock::now() + std::chrono::milliseconds(waitMs);
  unsigned n = 0;
  // (cycle, marker) of every push dropped, the last capture push and the
  // last BUSY (and that BUSY's crossing time).
  std::vector<int64_t> keys;
  int64_t prevCapture = -1, prevBusy = -1;
  uint64_t busyAt = 0;
  bool reached = false; // untilLast: the push of cycle `last` was dropped
  while (true) {
    Cmd::TrajectoryFrame f;
    if (reached) {
      if (wire.pushes.empty() || wire.pushes.front().cycle > last)
        return n;
      f = wire.pushes.front();
      wire.pushes.pop_front();
    } else {
      const int left =
          int(std::chrono::duration_cast<std::chrono::milliseconds>(
                  deadline - Clock::now())
                  .count());
      if (!nextPush(wire, std::max(left, 0), f)) {
        CHECK(!untilLast, what + ": the push of cycle " +
                              std::to_string(last) + " arrives");
        return n;
      }
    }
    const int64_t key = (int64_t(f.cycle) << 8) | f.marker;
    const std::string desc = what + ": dropped push (got " + describePush(f) +
                             ", want id " + std::to_string(id) + " cycles " +
                             std::to_string(first) + ".." +
                             std::to_string(last) + ")";
    CHECK(f.id == id && f.marker != TF::NO_MARKER && f.cycle >= first,
          desc + " — a wrong table id, a non-marker push or a cycle before "
                 "the range");
    CHECK(std::find(keys.begin(), keys.end(), key) == keys.end(),
          desc + " — a repeated (cycle, marker)");
    if (f.cycle > last)
      checkTimed(*wire.sim, false, desc + " — cycle " + std::to_string(last) +
                                       " skipped",
                 lo, hi, skipMargin(g));
    CHECK(key > prevCapture, desc + " — behind a later capture's push");
    if (f.status == TF::BUSY) {
      CHECK(key > prevBusy, desc + " — behind a later crossing's BUSY");
      prevBusy = key;
      busyAt = f.result.t_trigger;
    } else {
      if (key < prevBusy &&
          !stallExplains(*wire.sim,
                         busyAt - std::min(busyAt, g.period), busyAt,
                         summedMargin(g.marker), true))
        throw std::runtime_error("CHECK failed: " + desc +
                                 " — a capture push behind a later "
                                 "crossing's BUSY with no sim stall to "
                                 "explain it");
      prevCapture = key;
    }
    keys.push_back(key);
    n++;
    if (untilLast && !reached && f.cycle == last) {
      reached = true;
      (void)mcuNow(wire); // what the sim pushed before the answer is queued
    }
  }
}

// Swallows every frame until the wire has been quiet for `quietMs` (queued
// pushes included).
static void flushWire(Wire &wire, int quietMs = 150) {
  while (!wire.silent(quietMs)) {
  }
  wire.pushes.clear();
}

// Retry recovery for the trajectory stages: DELETE `ids` (halts the running
// one; a free id is a no-op) and swallow everything still in flight — stale
// responses of the failed attempt, its pushes, a deleted table's last
// capture push — so the retry starts on a quiet wire.
static void recoverTrajectories(Wire &wire, std::initializer_list<uint8_t> ids) {
  std::vector<uint16_t> pending;
  for (uint8_t id : ids) {
    const auto del = trajectoryRef(Cmd::Trajectory::DELETE, id);
    const uint16_t s = wire.next();
    wire.send(setPacket(Protocol::Property::CMD_TRAJECTORY, s, &del,
                        sizeof(del)));
    pending.push_back(s);
  }
  while (!pending.empty()) {
    auto pkt = wire.recv(2000, true);
    const auto h = pkt.validate();
    if (Protocol::method(h) == Protocol::Method::SYN)
      continue;
    const auto it = std::find(pending.begin(), pending.end(),
                              pkt.header().sequence);
    if (it == pending.end())
      continue; // a stale response of the failed attempt
    expectOk(pkt, "retry recovery DELETE");
    pending.erase(it);
  }
  flushWire(wire);
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
    // Sim::sync: one GET SYS_TIMESTAMP round trip; a stale response of the
    // failing step ahead of its answer is skipped (pushes are queued).
    sim.sync = [&wire] {
      const uint16_t s = wire.next();
      wire.send({Protocol::Method::GET, Protocol::Property::SYS_TIMESTAMP, s});
      while (wire.recv(2000).header().sequence != s) {
      }
    };
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
            "firmware reports the shared Protocol::Version");
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

    // 4b — the trigger line is RELEASED when the exposure ends before the
    //      pulse does (Timed fallback: a camera exposure shorter than the
    //      pulse), so the next capture still gets a rising edge. Without the
    //      release the second frame here times out (the line never fell).
    {
      // Strobes still armed at 500/2500 us from stage 4; pulse 10 ms.
      const auto first = runFrame(wire, 1, 10'000, 0);
      CHECK(first.finished, "short-exposure frame FINs (strobe fell mid-pulse)");
      const auto second = runFrame(wire, 1, 10'000, 0);
      CHECK(second.finished,
            "next frame FINs: the trigger was released at exposure end");
      std::printf("fw-sim-check: 4b trigger released at exposure end OK\n");
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
    // v2.2.0 stages C1-C4 — CMD_SCHEDULE + CMD_TRAJECTORY.
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

      // Poll the MCU clock, draining after each reading t. Absence is
      // checked against t: a word emitted before t is already in the stdout
      // pipe when t's ACK arrives, so `lastAbsent` bounds the apply instant
      // from below. Presence is checked against the NEXT reading t': that
      // drain ran before the GET for t' was sent, so a word it saw was
      // emitted before t' — present with t' < t_apply is an early apply
      // whatever the host's latency (no margin: a correct apply has
      // t' > t_apply).
      int64_t lastAbsent = 0;
      bool sawPresent = false; // the previous reading's drain had the word
      while (true) {
        const uint64_t t = mcuNow(wire);
        CHECK(!(sawPresent && t < tApply),
              "keyframe not applied early (MCU clock)");
        drain(sim);
        const bool present = hasValue(dacValues(sim, 'L', mark), 15151);
        if (!present)
          lastAbsent = int64_t(t) - int64_t(tApply);
        if (t > tApply + 20'000) {
          CHECK(present, "keyframe applied by t_apply + 20 ms (MCU clock)");
          break;
        }
        sawPresent = present;
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
    retryOnce("C2", [&] {
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
      // Its exposure (trigger + 500..2500 us) must lie on the ramp; a host
      // descheduled past t_B sent it too late to probe the ramp at all.
      if (mid.fin.t_trigger + 2500 >= tB)
        throw FixtureMiss("mid-ramp frame triggered past t_B (host stall)");
      // Exposure average ~ the ramp at trigger + 1500 us (injected strobe
      // rise +500, fall +2500).
      const double frac =
          double(int64_t(mid.fin.t_trigger + 1500) - int64_t(tA)) /
          double(tB - tA);
      const double expected = 2000.0 + 7000.0 * frac;
      const uint16_t got = mid.fin.left.ch[0];
      CHECK(got > 2000 && got < 9000, "mid-ramp frame between keyframes");
      // 350 counts = 10 ms of ramp: a sim stall that long between the
      // trigger and the injected edges moves the exposure on the ramp.
      CHECK_TIMED(sim, std::abs(double(got) - expected) < 350.0,
                  "mid-ramp frame matches the MCU-time lerp",
                  mid.fin.t_trigger, mid.fin.t_trigger + 2500, 10'000);
      CHECK(mid.fin.left.ch[1] == 22000 && mid.fin.right.ch[0] == 42000,
            "non-ramping channels hold");

      while (mcuNow(wire) < tB + 20'000)
        sleepMs(5);
      drain(sim);
      const auto band = inBand(dacValues(sim, 'L', mark), 2000, 9000);
      // The ramp starts on the tick K_A applies (the segment toward K_B is
      // already interpolating then), so its first word sits just above 2000:
      // within the ramp slope (7000 counts / 200 ms = 35 per ms) times a
      // 10 ms host-load stall of the sim loop past t_A (idle: ~1 tick). A
      // ramp that began more than 10 ms late, or ahead of K_A's value, lands
      // outside that window (5 % of the ramp).
      constexpr double RAMP_SLOPE = 7000.0 / 200'000.0; // counts per us
      constexpr uint64_t STALL_US = 10'000;
      const double firstMax = 2000.0 + RAMP_SLOPE * double(STALL_US);
      CHECK(!band.empty() && band.front() >= 2000 && band.back() == 9000,
            "ramp runs from K_A to exactly K_B");
      CHECK_TIMED(sim, double(band.front()) <= firstMax,
                  "the ramp starts on the tick K_A applies", tA,
                  tA + uint64_t((band.front() - 2000.0) / RAMP_SLOPE),
                  STALL_US);
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
    }, [&] {
      // Entry state: stream 1 at C1's target (L ch0 15151, outside the ramp
      // band); the UPDATE also clears any keyframe still pending.
      flushWire(wire);
      const uint16_t s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
               pos(15151, 22000, 32000, 42000), R0, s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "C2 retry UPDATE");
      sleepMs(20);
      drain(sim);
    });

    // C3 — CMD_TRAJECTORY: chunked upload, COMMIT validation, START -> DAC
    //      playback + one marker SYN push per cycle, ENDED push
    // A 120 ms period with the marker a third in: under sustained host load
    // the sim's loop is starved for 15-40 ms at a time, and the schedule
    // leaves every capture (2.5 ms) more idle time than that before the next
    // marker (117.5 ms) and the run's end (77.5 ms), and room for a fire up
    // to P/2 = 60 ms late.
    constexpr uint8_t TID = 0;
    constexpr uint32_t PERIOD = 120'000;
    constexpr uint32_t MARK_AT = 40'000;
    constexpr uint32_t SPACING = 4'800; // sample spacing; the ramp: 115.2 ms
    retryOnce("C3", [&] {
      // 25 samples (DATA chunks 12 + 12 + 1), SPACING apart. L ch0 ramps
      // through its private band [1000, 3400]; every other channel holds.
      constexpr uint16_t N = 25;
      CHECK(Cmd::Trajectory::CHUNK_SAMPLES == 12, "DATA chunk size");
      std::vector<Cmd::TrajectorySample> samples(N);
      for (uint16_t i = 0; i < N; i++) {
        samples[i].t_offset = i * SPACING;
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
      // The injected strobes fall 2.5 ms after the trigger (Timed shape: the
      // trigger is released then); the timeout (pulse + 5 ms) sits 22.5 ms
      // past it, so a sim stall between the edge pump and Capture::tick
      // shorter than that cannot turn the capture into a STROBE_TIMEOUT.
      m.pulse = 20'000;
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
      // The push schedule (checkPush): a capture ends 2.5 ms after its
      // trigger, the next marker is 117.5 ms later and the run's end 77.5 ms
      // later; the strobe timeout sits 22.5 ms past the fall.
      PushGaps gaps;
      gaps.period = PERIOD;
      gaps.marker = 117'500;
      gaps.end = 77'500;
      gaps.timeout = 22'500;
      for (uint32_t k = 0; k < CYCLES; k++) {
        const auto f = recvTrajectoryFrame(wire, 2000);
        const uint64_t due = tStart + uint64_t(k) * PERIOD + MARK_AT;
        checkPush(sim, f, TID, 0, k, due, gaps, "C3 marker");
        CHECK(f.result.stream == TID, "FrameResult.stream = trajectory id");
        CHECK(f.result.frame_id > lastFrameId, "frame_id monotonic");
        lastFrameId = f.result.frame_id;
        CHECK(f.result.t_trigger >= due, "marker never fires early");
        // Half a period: under host load a sim loop stall delays the fire
        // (idle ~2.5 ms worst), but any lateness below P/2 still pins the
        // trigger to THIS cycle's phase (a cycle slip or a phase error of
        // the order of the period fails) — unless the sim recorded a stall
        // that long over [due, t_trigger].
        CHECK_TIMED(sim, f.result.t_trigger - due < PERIOD / 2,
                    "marker fires at its phase", due, f.result.t_trigger,
                    PERIOD / 2);
        worstLate = std::max<uint64_t>(worstLate, f.result.t_trigger - due);
        CHECK(f.result.t_exposure > f.result.t_trigger,
              "exposure follows the marker trigger");
        // The rise is injected 0.5 ms after the trigger: 50 ms later takes a
        // sim stall of ~49.5 ms in between.
        CHECK_TIMED(sim, f.result.t_exposure - f.result.t_trigger < 50'000,
                    "exposure starts right after the marker trigger",
                    f.result.t_trigger, f.result.t_exposure, 49'000);
        // Exposure-averaged position: the mean of the DAC at strobe rise and
        // fall. The marker fires right after the tick that drove the table
        // at that tick's `now` >= due, and the ramp only climbs from there
        // until the band top (the wrap is ~75 ms later), so the average is
        // bracketed by the table at the DUE phase and the band top. Not the
        // table at t_trigger: Capture reads it AFTER that tick's drive, under
        // a live clock, so a host preemption between the two reads puts it
        // above the driven value. (Sim loop stalls delay strobe edges, so
        // t_exposure is not a tight bound.) A marker a host stall fired late
        // can expose into the wrap segment (phase 115.2 ms on, down to phase
        // 0): the fall (2 ms after the rise at t_exposure, + 1 ms of pump
        // slack) then latches the post-wrap ramp, and only the band bounds
        // the average.
        auto table = [&](uint64_t t) {
          return 1000.0 +
                 100.0 * double((t - tStart) % PERIOD) / double(SPACING);
        };
        const bool onRamp = MARK_AT + (f.result.t_exposure - due) + 3'000 <
                            (N - 1) * SPACING;
        const double lo = onRamp ? table(due) - 10.0 : 1000.0;
        const double hi = 3400.0;
        const double got = f.result.left.ch[0];
        if (!(got >= lo && got <= hi))
          std::fprintf(stderr,
                       "marker %u: ch0 %.0f outside [%.0f, %.0f] (trigger "
                       "due+%llu us, exposure trigger+%llu us)\n",
                       k, got, lo, hi,
                       static_cast<unsigned long long>(f.result.t_trigger -
                                                       due),
                       static_cast<unsigned long long>(f.result.t_exposure -
                                                       f.result.t_trigger));
        CHECK(got >= lo && got <= hi,
              "marker frame position = table over the exposure window");
        CHECK(f.result.left.ch[1] == 5000 && f.result.right.ch[0] == 8000,
              "marker frame: constant channels exact");
      }
      // Every marker push is in: nothing a starved sim does puts anything
      // but ENDED next (an ENDED overtaking the last OK failed above).
      const auto end = recvTrajectoryFrame(wire, 2000);
      CHECK(end.status == Cmd::TrajectoryFrame::ENDED && end.id == TID &&
                end.marker == Cmd::TrajectoryFrame::NO_MARKER &&
                end.cycle == CYCLES,
            "ENDED push after the last cycle (got " + describePush(end) + ")");
      CHECK(end.result.t_trigger == tStart + uint64_t(CYCLES) * PERIOD,
            "ENDED carries the run's end time");
      (void)mcuNow(wire); // anything pushed after ENDED is queued by now
      CHECK(wire.pushes.empty(), "no push after ENDED");

      drain(sim);
      const auto band = inBand(dacValues(sim, 'L', mark), 1000, 3400);
      std::vector<uint16_t> distinct;
      for (auto v : band)
        if (!hasValue(distinct, v))
          distinct.push_back(v);
      // A wrap is a maximal DECREASING run of words (the ramp only climbs
      // elsewhere; the wrap segment 115.2 -> 120 ms descends over several
      // ticks), the final drop to the phase-0 hold included. Not "above
      // 3000, then below 1500": a loaded host's sparse ticks can leave a
      // cycle with no word in its top 3 ms. Repeats (the 1 Hz refresh
      // re-commits an unchanged word) are dropped first.
      std::vector<uint16_t> steps = band;
      steps.erase(std::unique(steps.begin(), steps.end()), steps.end());
      unsigned wraps = 0;
      for (size_t i = 1; i < steps.size(); i++)
        if (steps[i] < steps[i - 1] && (i == 1 || steps[i - 1] > steps[i - 2]))
          wraps++;
      CHECK(distinct.size() >= 50, "interpolated playback writes many values");
      CHECK(wraps >= CYCLES - 1, "playback is periodic (one wrap per cycle)");
      CHECK(!band.empty() && band.back() == 1000,
            "finite run ends holding phase 0");
      std::printf("fw-sim-check: C3 trajectory %u cycles, %zu distinct DAC "
                  "values, %u wraps, %u marker pushes (worst +%llu us) OK\n",
                  CYCLES, distinct.size(), wraps, CYCLES,
                  static_cast<unsigned long long>(worstLate));
    }, [&] { recoverTrajectories(wire, {TID}); });

    // C4 — HOLD after the run (survives the 1 Hz refresh), START refused
    //      while a legacy Trigger is pending, STOP mid-run holds the last
    //      position, START + MEMS reset burst starts at phase 0, an Actuate
    //      moves the hold, START + STOP burst holds the DAC's position,
    //      control returns to the streams, DELETE
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

      // A pending legacy Trigger holds every Line3 HIGH until its FIN: a
      // START meanwhile is refused (a marker's pulse would be cut by that
      // FIN), and works once the FIN is out.
      uint16_t s = 0;
      Cmd::TrajectoryStart st{};
      st.op = Cmd::Trajectory::START;
      st.id = TID;
      st.t_start = 0;
      st.cycles = 0;
      Cmd::Trigger trig{};
      trig.duration = 150'000;
      s = wire.next();
      wire.send(setPacket(Protocol::Property::CMD_TRIGGER, s, &trig,
                          sizeof(trig)));
      expectAck(wire, Protocol::Property::CMD_TRIGGER, s, "legacy Trigger");
      CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                           "START while a Trigger is pending") ==
                "A trigger is pending (legacy Trigger) — wait for its FIN",
            "START refused while a legacy Trigger is pending");
      expectHeader(wire.recv(), Protocol::Method::FIN,
                   Protocol::Property::CMD_TRIGGER, s, "legacy Trigger FIN");

      // Endless run from now, then STOP mid-run.
      const uint64_t runFrom = mcuNow(wire); // <= the run's t_start ("now")
      const size_t runMark = sim.lines.size();
      expectOk(trajectoryOp(wire, &st, sizeof(st)), "START (now, forever)");
      // The running trajectory owns the DAC and the trigger lines: a direct
      // Actuate and the legacy all-camera Trigger are refused.
      Cmd::Actuate act{};
      act.left = pos(30000, 31000, 32000, 33000);
      act.right = R0;
      act.settle_time = 1000;
      s = wire.next();
      wire.send(setPacket(Protocol::Property::CMD_ACTUATE, s, &act,
                          sizeof(act)));
      CHECK(expectRej(wire, Protocol::Property::CMD_ACTUATE, s, "Actuate REJ")
                    .find("trajectory owns the DAC") != std::string::npos,
            "Actuate refused while a trajectory runs");
      trig.duration = 1000;
      s = wire.next();
      wire.send(setPacket(Protocol::Property::CMD_TRIGGER, s, &trig,
                          sizeof(trig)));
      CHECK(expectRej(wire, Protocol::Property::CMD_TRIGGER, s, "Trigger REJ")
                    .find("trajectory owns the trigger lines") !=
                std::string::npos,
            "legacy Trigger refused while a trajectory runs");
      // STOP mid-run once the run has driven more than 10 ramp words, or
      // after 1 s of MCU time: a starved sim's loop runs less often, not on
      // a different clock, so a sim that writes fewer than 10 words in a
      // second of playback is a fault, however loaded the host.
      sleepMs(70);
      auto ranWords = [&] {
        drain(sim);
        return inBand(dacValues(sim, 'L', runMark), 1000, 3400).size();
      };
      while (ranWords() <= 10 && mcuNow(wire) < runFrom + 1'000'000)
        sleepMs(5);
      const auto stop = trajectoryRef(Cmd::Trajectory::STOP, TID);
      expectOk(trajectoryOp(wire, &stop, sizeof(stop)), "STOP");
      // Its marker pushes are not inspected here: drop them, each a marker
      // push of TID for a cycle the run reached by the STOP. A capture STOP
      // left in flight completes by pulse + strobe margin (25 ms) on the MCU
      // clock: once a GET answers past that, its push is queued.
      const uint64_t stoppedBy = mcuNow(wire);
      while (mcuNow(wire) < stoppedBy + 30'000)
        sleepMs(1);
      {
        PushGaps endless;
        endless.period = PERIOD;
        endless.marker = 117'500;
        discardPushes(wire, TID, 0, uint32_t((stoppedBy - runFrom) / PERIOD),
                      false, 0, "C4 endless run", runFrom, stoppedBy, endless);
      }
      drain(sim);
      const auto ran = inBand(dacValues(sim, 'L', runMark), 1000, 3400);
      CHECK(ran.size() > 10, "endless run drove the DAC within 1 s of MCU "
                             "time");
      const uint16_t held = ran.back();
      mark = sim.lines.size();
      sleepMs(100);
      drain(sim);
      v = dacValues(sim, 'L', mark);
      for (auto x : inBand(v, 1000, 3400))
        CHECK(x == held, "STOP holds the last position");
      CHECK(!hasValue(v, 22000), "STOP does not snap back to the stream");

      // A fresh START after the mid-run STOP: the FIRST DAC word of the new
      // run is its phase 0 (1000), never the held position. A MEMS recovery
      // (SYS_RESET MEMS -> Streams::touch) in the SAME loop iteration as the
      // START leaves a refresh pending when the next Streams::tick runs —
      // before Trajectory::tick's first drive — so this exercises the
      // `firstDrive` guard: without it that tick re-commits the held position.
      // The next tick pre-positions at phase 0 only while it is still ahead
      // of t_start: a generous lead, and a GET in the burst measures when the
      // START was handled (a stall of the sim's loop from there past t_start
      // makes the first word a later phase — the firmware joining its own
      // run in progress, as it should).
      Cmd::TrajectoryStart re = st;
      re.t_start = mcuNow(wire) + 200'000;
      re.cycles = 1;
      uint64_t tHandled = 0;
      mark = sim.lines.size();
      {
        std::vector<uint8_t> burst;
        const uint16_t sStart = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::CMD_TRAJECTORY, sStart, &re,
                              sizeof(re)),
                    burst);
        System::Reset rst{};
        rst.type = System::Reset::MEMS;
        const uint16_t sReset = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::SYS_RESET, sReset, &rst,
                              sizeof(rst)),
                    burst);
        const uint16_t sNow = wire.next();
        appendFrame(wire,
                    {Protocol::Method::GET, Protocol::Property::SYS_TIMESTAMP,
                     sNow},
                    burst);
        sendBurst(wire, burst);
        expectAckOf(wire, Protocol::Property::CMD_TRAJECTORY, sStart,
                    "START after STOP (burst with a MEMS reset)");
        expectAckOf(wire, Protocol::Property::SYS_RESET, sReset,
                    "MEMS reset in the START burst");
        const auto ack = wire.recv();
        expectHeader(ack, Protocol::Method::ACK,
                     Protocol::Property::SYS_TIMESTAMP, sNow,
                     "START burst timestamp");
        tHandled = payloadAs<System::Timestamp>(ack).microseconds;
      }
      // From the reset's DAC init words on: the burst's START was handled
      // right before them, in the same handle() pass. A word ahead of them
      // is the HOLD's own (a 1 Hz refresh re-committing the held position
      // between `mark` and the burst), not the new run's.
      const size_t burstAt = sim.indexOf("dac cs=LR 280001", mark);
      std::vector<uint16_t> fresh;
      for (int i = 0; i < 200 && fresh.empty(); i++) {
        sleepMs(1);
        drain(sim);
        fresh = inBand(dacValues(sim, 'L', burstAt), 1000, 3400);
      }
      CHECK(!fresh.empty(), "START after STOP drives the DAC");
      if (fresh.front() != 1000)
        std::fprintf(stderr,
                     "C4 fresh START: first word %u (held %u), START handled "
                     "at t_start%+lld us\n",
                     unsigned(fresh.front()), unsigned(held),
                     static_cast<long long>(tHandled) -
                         static_cast<long long>(re.t_start));
      CHECK(held == 1000 || fresh.front() != held,
            "a fresh START's first DAC word is never the held position");
      if (tHandled >= re.t_start) // C4 runs once: this fails the run
        throw FixtureMiss("C4: the fresh START was handled past its t_start "
                          "— host stall");
      CHECK_TIMED(sim, fresh.front() == 1000,
                  "a fresh START's first DAC word is phase 0", tHandled,
                  re.t_start, re.t_start - tHandled);
      // Exactly the one marker's OK push, then ENDED (the endless run's
      // pushes were all dropped above). C3's schedule: the capture ends
      // 2.5 ms after the trigger, 77.5 ms before the run's end.
      {
        PushGaps one;
        one.period = PERIOD;
        one.marker = 117'500;
        one.end = 77'500;
        one.timeout = 22'500;
        checkPush(sim, recvTrajectoryFrame(wire, 2000), TID, 0, 0,
                  re.t_start + MARK_AT, one, "C4 fresh START marker");
        const auto end = recvTrajectoryFrame(wire, 2000);
        CHECK(end.status == Cmd::TrajectoryFrame::ENDED && end.id == TID &&
                  end.marker == Cmd::TrajectoryFrame::NO_MARKER &&
                  end.cycle == 1 &&
                  end.result.t_trigger == re.t_start + PERIOD,
              "C4 fresh START: ENDED after its one cycle (got " +
                  describePush(end) + ")");
      }

      // HOLD is not running: Actuate works again (ACK, then FIN after the
      // settle time) — the host may re-aim after a scan — and becomes the
      // hold position (Streams::noteActuate).
      mark = sim.lines.size();
      s = wire.next();
      wire.send(setPacket(Protocol::Property::CMD_ACTUATE, s, &act,
                          sizeof(act)));
      expectAck(wire, Protocol::Property::CMD_ACTUATE, s, "Actuate in HOLD");
      expectHeader(wire.recv(), Protocol::Method::FIN,
                   Protocol::Property::CMD_ACTUATE, s, "Actuate in HOLD FIN");
      drain(sim);
      CHECK(hasValue(dacValues(sim, 'L', mark), 30000),
            "Actuate in HOLD writes the DAC");
      // ... and moves the hold position: the 1 Hz refresh re-commits it,
      // never the trajectory's phase-0 hold.
      mark = sim.lines.size();
      sleepMs(1200);
      drain(sim);
      v = dacValues(sim, 'L', mark);
      CHECK(hasValue(v, 30000), "the refresh re-commits the Actuate position");
      CHECK(inBand(v, 1000, 3400).empty(),
            "Actuate in HOLD survives the 1 Hz refresh (no snap-back)");

      // Control returns to the streams on the next stream write.
      mark = sim.lines.size();
      s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
               pos(4321, 22000, 32000, 42000), R0, s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "UPDATE after STOP");
      bool back = false;
      for (int i = 0; i < 100 && !back; i++) {
        drain(sim);
        back = hasValue(dacValues(sim, 'L', mark), 4321);
      }
      CHECK(back, "stream UPDATE drives the DAC again after STOP");

      // START (future t_start) and STOP in ONE loop iteration: the run never
      // drives, and the HOLD keeps what the DAC holds — the stream's 4321 —
      // across the 1 Hz refresh, not a stale drive position (the Actuate's
      // 30000, or zeros after boot).
      mark = sim.lines.size();
      {
        Cmd::TrajectoryStart fut = st;
        fut.t_start = mcuNow(wire) + 500'000;
        fut.cycles = 1;
        std::vector<uint8_t> burst;
        const uint16_t sStart = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::CMD_TRAJECTORY, sStart, &fut,
                              sizeof(fut)),
                    burst);
        const uint16_t sStop = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::CMD_TRAJECTORY, sStop, &stop,
                              sizeof(stop)),
                    burst);
        sendBurst(wire, burst);
        expectAckOf(wire, Protocol::Property::CMD_TRAJECTORY, sStart,
                    "START (burst with STOP)");
        expectAckOf(wire, Protocol::Property::CMD_TRAJECTORY, sStop,
                    "STOP in the START burst");
      }
      sleepMs(1200);
      drain(sim);
      v = dacValues(sim, 'L', mark);
      CHECK(hasValue(v, 4321), "the refresh re-commits the held position");
      CHECK(!hasValue(v, 30000) && !hasValue(v, 0) &&
                inBand(v, 1000, 3400).empty(),
            "START+STOP in one iteration holds the DAC's actual position");
      // Hand the DAC back to stream 1 (same target).
      mark = sim.lines.size();
      s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
               pos(4321, 22000, 32000, 42000), R0, s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "UPDATE after HOLD");
      back = false;
      for (int i = 0; i < 100 && !back; i++) {
        drain(sim);
        back = hasValue(dacValues(sim, 'L', mark), 4321);
      }
      CHECK(back, "stream UPDATE drives the DAC again after the HOLD");
      (void)mcuNow(wire); // that write's remaining words: out by this ACK
      drain(sim);

      // A MEMS recovery (SYS_RESET MEMS) re-inits every channel to V_BIAS, so
      // a START (future t_start) + STOP in the SAME loop iteration right
      // after it holds V_BIAS: claim() seeds Global::bias_voltage because
      // Streams::noteReinit() forgot the last write. The 1 Hz refresh then
      // re-commits the bias on all four channels of both mirrors — not the
      // stream's pre-reset position (L ch0 4321, R = R0: the last DAC write)
      // and not zeros. The reset's own bias word is a CH::ALL broadcast,
      // which carriesValue() skips, so every per-channel word in the window
      // is a refresh write.
      constexpr uint16_t BIAS = 30000; // stage 2's staged CFG_BIAS
      mark = sim.lines.size();
      {
        Cmd::TrajectoryStart fut = st;
        fut.t_start = mcuNow(wire) + 500'000;
        fut.cycles = 1;
        std::vector<uint8_t> burst;
        System::Reset rst{};
        rst.type = System::Reset::MEMS;
        const uint16_t sReset = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::SYS_RESET, sReset, &rst,
                              sizeof(rst)),
                    burst);
        const uint16_t sStart = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::CMD_TRAJECTORY, sStart, &fut,
                              sizeof(fut)),
                    burst);
        const uint16_t sStop = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::CMD_TRAJECTORY, sStop, &stop,
                              sizeof(stop)),
                    burst);
        sendBurst(wire, burst);
        expectAckOf(wire, Protocol::Property::SYS_RESET, sReset,
                    "MEMS reset (burst with START + STOP)");
        expectAckOf(wire, Protocol::Property::CMD_TRAJECTORY, sStart,
                    "START after the MEMS reset");
        expectAckOf(wire, Protocol::Property::CMD_TRAJECTORY, sStop,
                    "STOP in the reset burst");
      }
      sleepMs(1200);
      drain(sim);
      {
        // From the reset's init words on (a 1 Hz refresh between `mark` and
        // the burst still re-commits the stream's position).
        bool wrote[2][4] = {}; // [L, R][channel] got a per-channel word
        for (size_t i = sim.indexOf("dac cs=LR 280001", mark);
             i < sim.lines.size(); i++) {
          DacWord w;
          if (!parseDac(sim.lines[i], w) || !carriesValue(w))
            continue;
          if (w.value != BIAS)
            std::fprintf(stderr,
                         "C4 reset hold: %s ch%u written %u, want %u\n",
                         w.left ? "L" : "R", unsigned(w.addr),
                         unsigned(w.value), unsigned(BIAS));
          CHECK(w.value == BIAS,
                "a START+STOP right after a MEMS reset holds V_BIAS (not the "
                "pre-reset position, not zeros)");
          wrote[0][w.addr] |= w.left;
          wrote[1][w.addr] |= w.right;
        }
        for (const auto &side : wrote)
          for (bool ch : side)
            CHECK(ch, "the refresh re-commits V_BIAS on every channel of "
                      "both mirrors");
      }
      // Hand the DAC back to stream 1 (same target) for the later stages.
      s = wire.next();
      streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
               pos(4321, 22000, 32000, 42000), R0, s);
      expectAck(wire, Protocol::Property::CMD_STREAM, s, "UPDATE after HOLD");

      const auto del = trajectoryRef(Cmd::Trajectory::DELETE, TID);
      expectOk(trajectoryOp(wire, &del, sizeof(del)), "DELETE");
      CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                           "START deleted")
                    .find("Unknown trajectory") != std::string::npos,
            "deleted table is gone");
      std::printf("fw-sim-check: C4 HOLD/STOP (held %u) + reset hold at V_BIAS "
                  "+ DAC hand-back + DELETE OK\n",
                  unsigned(held));
    }
    // C5/C6 — v2.2.1 ATOMIC SWAP, shared fixture. Every table has the same
    // 120 ms shape: L ch0 is a pure 0.05 count/us ramp 13000 -> 18950 over
    // [0, 119 ms], wrapping back in the last 1 ms; ch1 tells the tables
    // apart. The long period leaves every capture tens of ms of idle time
    // before the next marker and the run's end, and every swap window
    // 38-84 ms wide: a niced harness next to busy cores, and the sim it
    // spawns, are descheduled for 15-40 ms at a time.
    {
      constexpr uint8_t TA = 1, TB = 2, TC = 3;
      constexpr uint32_t P = 120'000;      // period (us)
      constexpr uint32_t RAMP_END = 119'000; // the ramp's last sample
      constexpr uint32_t US_PER_COUNT = 20;  // ramp slope
      constexpr uint16_t BAND_LO = 13000,
                         BAND_HI = BAND_LO + RAMP_END / US_PER_COUNT;
      constexpr uint16_t CH1_A = 5100, CH1_B = 5200, CH1_C = 5300;
      // Marker lateness bound. A sim loop stall under host load delays a fire
      // (idle: < 1 ms; > 5 ms seen with a parallel type-check). 30 ms is a
      // quarter of the period and below every marker spacing used here, so a
      // marker inside it is still the crossing of THIS cycle's phase; a
      // phase reset or a slipped cycle is caught by the cycle identity and
      // the DAC continuity checks, which do not depend on host timing.
      constexpr uint64_t LATE_MAX = 30'000;
      struct Mark {
        uint32_t at, pulse; // marker phase, trigger pulse (us)
      };
      auto table = [&](uint64_t phase) { // ch0 on the rising part
        return double(BAND_LO) + double(phase % P) / double(US_PER_COUNT);
      };
      auto upload = [&](uint8_t id, uint32_t period, uint16_t ch1,
                        std::initializer_list<Mark> marks) {
        const uint32_t offs[4] = {0, P / 3, 2 * P / 3, RAMP_END};
        std::vector<Cmd::TrajectorySample> smp(4);
        for (int i = 0; i < 4; i++) {
          // C: same shape, scaled (64-bit: offs x period overflows 32)
          smp[i].t_offset = uint32_t(uint64_t(offs[i]) * period / P);
          smp[i].left = pos(uint16_t(BAND_LO + offs[i] / US_PER_COUNT), ch1,
                            6100, 7100);
          smp[i].right = pos(8000, 9000, 10000, 11000);
        }
        Cmd::TrajectoryBegin b{};
        b.op = Cmd::Trajectory::BEGIN;
        b.id = id;
        b.sample_count = 4;
        b.period = period;
        expectOk(trajectoryOp(wire, &b, sizeof(b)), "C5/C6 BEGIN");
        Cmd::TrajectoryData d{};
        d.op = Cmd::Trajectory::DATA;
        d.id = id;
        d.first_index = 0;
        d.count = 4;
        expectOk(trajectoryOp(wire, &d, sizeof(d), smp.data(),
                              4 * sizeof(Cmd::TrajectorySample)),
                 "C5/C6 DATA");
        uint8_t index = 0;
        for (const Mark &mk : marks) {
          Cmd::TrajectoryMark m{};
          m.op = Cmd::Trajectory::MARK;
          m.id = id;
          m.marker = index++;
          m.t_offset = mk.at;
          m.cameras = Cmd::CAM_L | Cmd::CAM_R;
          m.pulse = mk.pulse;
          expectOk(trajectoryOp(wire, &m, sizeof(m)), "C5/C6 MARK");
        }
        const auto c = trajectoryRef(Cmd::Trajectory::COMMIT, id);
        expectOk(trajectoryOp(wire, &c, sizeof(c)), "C5/C6 COMMIT");
      };
      auto startOp = [&](uint8_t id, uint64_t t, uint32_t cycles) {
        Cmd::TrajectoryStart st{};
        st.op = Cmd::Trajectory::START;
        st.id = id;
        st.t_start = t;
        st.cycles = cycles;
        return st;
      };
      // Injected strobes: rise 500/700 us after the trigger, fall `fall` us
      // after it — before the pulse ends (the Timed shape: the capture
      // completes and drops the trigger at the fall); pulse + the 5 ms strobe
      // margin covers it with room for a sim stall (TIMEOUT_SLACK).
      uint32_t strobeFall = 0; // checkMarker: the exposure's length
      auto strobes = [&](uint32_t fall) {
        strobeFall = fall;
        sim.ctl("strobe L 500 " + std::to_string(fall));
        sim.ctl("strobe R 700 " + std::to_string(fall));
      };
      auto waitMcu = [&](uint64_t t) {
        uint64_t now = mcuNow(wire);
        while (now < t) {
          sleepMs(1);
          now = mcuNow(wire);
        }
        return now;
      };
      // Waits for phase `from` of `cycle` of a forever run started at T and
      // returns the MCU time, read inside [from, before) of `cycle` once
      // `ready()` holds (polled after each reading; none = at once). A
      // reading at/after `before` means the host was descheduled past the
      // window before acting (nothing was sent): re-sync to the first later
      // cycle whose window is still ahead (`cycle` is advanced; the run plays
      // on unchanged). `enter(cycle)` runs before each cycle's polling, the
      // first included: it consumes what that cycle is expected to push
      // before the window and drops the skipped cycles' pushes
      // (discardPushes — Wire::recv queues every push the GETs meet).
      auto fixtureWindow = [&](uint64_t T, uint32_t &cycle, uint32_t from,
                               uint32_t before, const std::string &what,
                               const std::function<void(uint32_t)> &enter =
                                   nullptr,
                               const std::function<bool()> &ready = nullptr) {
        for (unsigned miss = 0;; miss++) {
          if (enter)
            enter(cycle);
          const uint64_t base = T + uint64_t(cycle) * P;
          uint64_t now = waitMcu(base + from);
          while (ready && now < base + before && !ready()) {
            sleepMs(1);
            now = mcuNow(wire);
          }
          if (now < base + before)
            return now;
          noteRearm(what + " — read at cycle " + std::to_string((now - T) / P) +
                        " phase " + std::to_string((now - T) % P) +
                        " us (window: cycle " + std::to_string(cycle) + ")",
                    miss);
          cycle = uint32_t((now - T - from) / P) + 1;
        }
      };
      // The running stage's push schedule (checkPush): the shortest idle
      // stretch between a capture's end and the next marker phase, and
      // between the last capture's end and the run's end — set per stage
      // (pushGaps). The strobe timeout's slack past the injected fall is
      // 25 ms in every C5/C6 shape.
      PushGaps gaps;
      gaps.period = P;
      gaps.timeout = 25'000;
      auto pushGaps = [&](uint64_t marker, uint64_t end) {
        gaps.marker = marker;
        gaps.end = end;
      };
      // One marker push on the ORIGINAL phase clock: identity, never early,
      // on phase, and the exposure-averaged position is the ramp over the
      // window with ch1 from the table(s) that drove it.
      uint64_t worstLate = 0;
      auto checkMarker = [&](const Cmd::TrajectoryFrame &f, uint8_t id,
                             uint8_t marker, uint32_t cycle, uint64_t tStart,
                             uint32_t at, const std::string &what,
                             uint16_t ch1Lo, uint16_t ch1Hi) {
        const uint64_t due = tStart + uint64_t(cycle) * P + at;
        checkPush(sim, f, id, marker, cycle, due, gaps,
                  what + " (no missed or doubled cycle)");
        CHECK(f.result.t_trigger >= due, what + ": never fires early");
        if (f.result.t_trigger - due >= LATE_MAX)
          std::fprintf(stderr, "%s: fired +%llu us after its phase\n",
                       what.c_str(),
                       static_cast<unsigned long long>(f.result.t_trigger -
                                                       due));
        CHECK_TIMED(sim, f.result.t_trigger - due < LATE_MAX,
                    what + ": fires at its phase (original clock)", due,
                    f.result.t_trigger, LATE_MAX);
        worstLate = std::max<uint64_t>(worstLate, f.result.t_trigger - due);
        // Lower bound from the DUE phase (as C3): the tick that fired drove
        // the ramp at its own now >= due; t_trigger is read after that drive
        // under a live clock, so it can lie above the driven value. Unless a
        // late fire (host stall) let the exposure reach the wrap segment at
        // RAMP_END (the fall comes strobeFall - 500 us after the L rise at
        // t_exposure, + 1 ms of pump slack): then only the band applies.
        const bool onRamp = at + (f.result.t_exposure - due) +
                                (strobeFall - 500) + 1'000 <
                            RAMP_END;
        const double lo = onRamp ? table(due - tStart) - 10.0 : BAND_LO;
        const double got = f.result.left.ch[0];
        if (!(got >= lo && got <= BAND_HI))
          std::fprintf(stderr, "%s: ch0 %.0f outside [%.0f, %u]\n",
                       what.c_str(), got, lo, unsigned(BAND_HI));
        CHECK(got >= lo && got <= BAND_HI,
              what + ": position = the ramp at the original phase");
        CHECK(f.result.left.ch[1] >= ch1Lo && f.result.left.ch[1] <= ch1Hi,
              what + ": latched the table(s) driving its exposure");
      };
      // The swap START with a GET SYS_TIMESTAMP behind it in ONE burst: the
      // sim's loop handles both in the same iteration, so the GET's answer
      // is the MCU instant the swap was handled (`t`) — measured, not
      // inferred from a reading the host took before a send it may have been
      // descheduled ahead of. Reads raw until both ACKs; trajectory pushes
      // that arrive before the swap's ACK are returned (`early`), later ones
      // queued for recvTrajectoryFrame. Nothing may be queued before: every
      // earlier push was consumed (or dropped as skipped) by the stage.
      struct SwapAck {
        uint64_t t = 0;
        std::vector<Cmd::TrajectoryFrame> early;
      };
      auto swapStart = [&](const Cmd::TrajectoryStart &st,
                           const std::string &stage) {
        CHECK(wire.pushes.empty(),
              stage + ": no unexpected trajectory push before the swap");
        std::vector<uint8_t> burst;
        const uint16_t sSwap = wire.next();
        appendFrame(wire,
                    setPacket(Protocol::Property::CMD_TRAJECTORY, sSwap, &st,
                              sizeof(st)),
                    burst);
        const uint16_t sNow = wire.next();
        appendFrame(wire,
                    {Protocol::Method::GET, Protocol::Property::SYS_TIMESTAMP,
                     sNow},
                    burst);
        sendBurst(wire, burst);
        SwapAck out;
        bool acked = false, timed = false;
        while (!acked || !timed) {
          auto pkt = wire.recv(2000, true);
          const auto h = pkt.validate();
          if (Protocol::method(h) == Protocol::Method::SYN) {
            if (Protocol::property(h) == Protocol::Property::LOG)
              continue;
            CHECK(Protocol::property(h) == Protocol::Property::CMD_TRAJECTORY,
                  stage + ": only LOG / trajectory pushes arrive unsolicited");
            const auto f = payloadAs<Cmd::TrajectoryFrame>(pkt);
            if (acked)
              wire.pushes.push_back(f);
            else
              out.early.push_back(f);
            continue;
          }
          if (!acked) {
            CHECK(pkt.header().sequence == sSwap,
                  stage + ": the swap answers first");
            if (Protocol::method(h) != Protocol::Method::ACK)
              throw std::runtime_error("CHECK failed: " + stage +
                                       " swap START ACKed (got " +
                                       payloadStr(pkt) + ")");
            acked = true;
            continue;
          }
          expectHeader(pkt, Protocol::Method::ACK,
                       Protocol::Property::SYS_TIMESTAMP, sNow,
                       "swap instant ACK");
          out.t = payloadAs<System::Timestamp>(pkt).microseconds;
          timed = true;
        }
        for (const auto &f : out.early)
          std::fprintf(stderr,
                       "%s: push before the swap ACK: id %u marker %u cycle "
                       "%u status %u t_trigger %llu (swap at %llu)\n",
                       stage.c_str(), unsigned(f.id), unsigned(f.marker),
                       unsigned(f.cycle), unsigned(f.status),
                       static_cast<unsigned long long>(f.result.t_trigger),
                       static_cast<unsigned long long>(out.t));
        return out;
      };
      // A swap that lands with no capture in flight (C6). Handled at/after
      // `limit` — the MCU time from which the scenario stops being the one
      // designed (a's next marker may have fired first, b's marker phase
      // passed) — the host stalled between its in-window reading and the
      // send: fixture miss. Before it, no push may precede the ACK.
      auto swapIdle = [&](const Cmd::TrajectoryStart &st,
                          const std::string &stage, uint64_t limit,
                          const char *limitWhat) {
        const auto sw = swapStart(st, stage);
        if (sw.t >= limit)
          throw FixtureMiss(stage + ": the swap was handled " +
                            std::to_string(sw.t - limit) + " us past " +
                            limitWhat + " — host stall");
        CHECK(sw.early.empty(),
              stage + ": no trajectory push before the swap ACK");
        return sw.t;
      };
      auto expectEnded = [&](uint8_t id, uint32_t cycles, uint64_t tStart,
                             const std::string &stage) {
        // Every marker push is in (an ENDED overtaking the last one failed
        // checkMarker): a starved sim puts nothing but ENDED next.
        const auto end = recvTrajectoryFrame(wire, 2000);
        const uint64_t tEnd = tStart + uint64_t(cycles) * P;
        CHECK(end.status == Cmd::TrajectoryFrame::ENDED && end.id == id &&
                  end.marker == Cmd::TrajectoryFrame::NO_MARKER &&
                  end.cycle == cycles,
              stage + ": b's budget (from the original t_start) ends the run "
                      "(got " + describePush(end) + ")");
        CHECK(end.result.t_trigger == tEnd,
              stage + ": ENDED at t_start + cycles x period (original clock)");
      };
      // DAC continuity across a swap (sim lines [runMark, swapMark) were
      // emitted before it, the swap handled at MCU time tSwap, in the same
      // cycle as the drain at swapMark): in band, advancing through the
      // swap, one wrap per cycle, b's table afterwards. Returns the wrap
      // count. The run spans [tStart, tStart + cycles x P] on the MCU clock:
      // the shape checks leave a sim stall of up to RAMP_STALL harmless
      // (below), and a longer one recorded over the run makes their failure
      // a fixture miss; a missing wrap takes a skipped cycle (no loop
      // iteration for ~a period: skipMargin). The advancing check compares
      // b's FIRST word (ch0 precedes ch1 = CH1_B in each write) with a's
      // last before the drain — the words between are a's own — and only a
      // stall of SWAP_TO_WRAP (the latest swap phase used, 89 ms, to the
      // wrap) over [tSwap, tSwap + P] lets that first word be a post-wrap
      // one.
      constexpr uint64_t RAMP_STALL = 48'000, SWAP_TO_WRAP = 30'000;
      auto checkRamp = [&](size_t runMark, size_t swapMark, uint64_t tSwap,
                           unsigned cycles, uint64_t tStart,
                           const std::string &stage) {
        drain(sim);
        const uint64_t tEnd = tStart + uint64_t(cycles) * P;
        const auto before =
            inBand(dacValues(sim, 'L', runMark, swapMark), BAND_LO, BAND_HI);
        CHECK(!before.empty(), stage + ": a drove the DAC before the swap");
        const auto ch1 = dacValues(sim, 'L', swapMark);
        const auto firstB = std::find(ch1.begin(), ch1.end(), CH1_B);
        CHECK(firstB != ch1.end() && firstB != ch1.begin(),
              stage + ": b's table plays after the swap");
        const uint16_t bFirst = *(firstB - 1);
        CHECK(bFirst >= BAND_LO && bFirst <= BAND_HI,
              stage + ": b's first write is on the ramp");
        CHECK_TIMED(sim, bFirst >= before.back(),
                    stage + ": the ramp keeps advancing across the swap (no "
                            "phase reset)",
                    tSwap, tSwap + P, SWAP_TO_WRAP);
        // Every decreasing run is a full wrap (high -> low): it starts at
        // phase >= 70 ms (ch0 >= 16500) and lands at phase <= 50 ms (ch0 <=
        // 15500). A phase reset at a swap before phase 70 ms (every swap here
        // lands by 89 ms) would start a decreasing run below the "high"
        // bound; at any phase it fails the advancing check above and adds a
        // wrap to the count below. One wrap per cycle boundary + the final
        // hold at phase 0 (exempt from the "high" bound: a loop stall right
        // before the end can clamp it early). The bounds leave a sim stall
        // of up to ~50 ms around a wrap harmless. Consecutive identical
        // words are dropped first: the 1 Hz housekeeping refresh re-commits
        // an unchanged value, and a repeat inside the wrap segment would
        // split one wrap into two.
        auto all = inBand(dacValues(sim, 'L', runMark), BAND_LO, BAND_HI);
        all.erase(std::unique(all.begin(), all.end()), all.end());
        std::vector<std::pair<uint16_t, uint16_t>> steps; // (top, bottom)
        for (size_t i = 1; i < all.size(); i++) {
          if (all[i] >= all[i - 1])
            continue;
          const uint16_t top = all[i - 1];
          while (i + 1 < all.size() && all[i + 1] < all[i])
            i++;
          steps.emplace_back(top, all[i]);
        }
        for (size_t i = 0; i < steps.size(); i++) {
          const bool ok = steps[i].second <= 15'500 &&
                          (i + 1 == steps.size() || steps[i].first >= 16'500);
          if (!ok)
            std::fprintf(stderr, "%s backstep %u -> %u (#%zu of %zu)\n",
                         stage.c_str(), unsigned(steps[i].first),
                         unsigned(steps[i].second), i, steps.size());
          CHECK_TIMED(sim, ok,
                      stage + ": the DAC only steps back at a cycle wrap",
                      tStart, tEnd, RAMP_STALL);
        }
        if (steps.size() != cycles) {
          std::fprintf(stderr, "%s: %zu wraps, want %u:", stage.c_str(),
                       steps.size(), cycles);
          for (const auto &st : steps)
            std::fprintf(stderr, " %u->%u", unsigned(st.first),
                         unsigned(st.second));
          std::fprintf(stderr, "\n");
        }
        // An extra wrap is a phase jump whatever the sim did; a missing one
        // takes a skipped cycle.
        CHECK_TIMED(sim, steps.size() == cycles,
                    stage + ": one wrap per cycle (no extra phase jump)",
                    tStart, tEnd,
                    steps.size() < cycles ? skipMargin(gaps) : UINT64_MAX);
        CHECK(std::find(firstB, ch1.end(), CH1_A) == ch1.end(),
              stage + ": a never plays again after b took over");
        return unsigned(steps.size());
      };
      // Tables gone, strobes + stream state as C4 left them. Every push of
      // the run was consumed: one more (after ENDED) would be a doubled one.
      auto cleanup = [&](const std::string &stage) {
        for (uint8_t id : {TA, TB, TC}) { // a free id DELETEs as a no-op
          const auto del = trajectoryRef(Cmd::Trajectory::DELETE, id);
          expectOk(trajectoryOp(wire, &del, sizeof(del)),
                   (stage + " DELETE").c_str());
        }
        CHECK(wire.pushes.empty(), stage + ": no push after the run's ENDED");
        strobes(2500);
        const size_t backMark = sim.lines.size();
        const uint16_t s = wire.next();
        streamOp(wire, Cmd::MirrorStream::UPDATE, 1,
                 pos(4321, 22000, 32000, 42000), R0, s);
        expectAck(wire, Protocol::Property::CMD_STREAM, s,
                  (stage + " stream hand-back").c_str());
        bool back = false;
        for (int i = 0; i < 100 && !back; i++) {
          drain(sim);
          back = hasValue(dacValues(sim, 'L', backMark), 4321);
        }
        CHECK(back, stage + ": the streams drive the DAC again");
      };
      // retryOnce recovery: halt + forget every table, quiet wire, then the
      // scenario's entry state (strobes, streams own the DAC). One unmarked
      // cycle ending at phase 0 (as every normal entry does) so a retry
      // starts from the same mirror position as the first attempt.
      auto recover = [&] {
        recoverTrajectories(wire, {TA, TB, TC});
        upload(TA, P, CH1_A, {});
        auto st = startOp(TA, 0, 1);
        expectOk(trajectoryOp(wire, &st, sizeof(st)), "C5/C6 retry reset run");
        const auto end = recvTrajectoryFrame(wire, 2000);
        CHECK(end.status == Cmd::TrajectoryFrame::ENDED,
              "C5/C6 retry reset run ENDED");
        cleanup("C5/C6 retry");
      };

      // C5 — START {b, t_start = a's, cycles} while table a runs switches
      //      the playing table in place. Proves: a mismatched period /
      //      t_start (and a re-START of a itself) REJs with a still running;
      //      the swap lands while a's marker capture is IN FLIGHT and that
      //      capture's OK push still arrives after the ACK with a's id;
      //      markers keep firing on the ORIGINAL phase clock with no missed
      //      or doubled cycle — b's marker 0 sits LATER in the cycle than
      //      a's, so the swap lands between a's (already fired) and b's
      //      marker-0 phase and only the by-index crossing state keeps it
      //      from firing twice in that cycle; the DAC ramp stays in band and
      //      keeps advancing through the swap (no HOLD, no phase reset), and
      //      b's table is what plays afterwards.
      retryOnce("C5", [&] {
        constexpr uint32_t AT_A = 5'000;   // a's (and c's) marker-0 phase
        constexpr uint32_t AT_B = 45'000;  // b's marker-0 phase (later)
        // The capture spans the swap: trigger at 5 ms, exposure over at
        // 45 ms (Timed shape — the exposure ends before the pulse and the
        // trigger is released then). The strobe timeout (pulse + 5 ms =
        // 65 ms after the trigger) sits 25 ms past the fall, so a loaded
        // host's sim stall between the edge pump and Capture::tick cannot
        // turn the capture into a STROBE_TIMEOUT. The swap window — after
        // the rises, before b's marker phase and a's fall — is ~38 ms wide;
        // b's captures (45 -> 85 ms) end 35 ms before each cycle end.
        constexpr uint32_t PULSE = 60'000; // marker pulse
        constexpr uint32_t FALL = 40'000;  // injected strobe fall
        constexpr uint32_t CYCLES_B = 6;   // b's budget (from t_start)
        uint32_t sc = 1; // the swap cycle (later if the host misses cycle 1)
        auto c5Marker = [&](const Cmd::TrajectoryFrame &f, uint8_t id,
                            uint32_t cycle, uint64_t tStart, const char *what,
                            uint16_t ch1Lo, uint16_t ch1Hi) {
          checkMarker(f, id, 0, cycle, tStart, id == TB ? AT_B : AT_A,
                      std::string("C5 ") + what, ch1Lo, ch1Hi);
        };

        upload(TA, P, CH1_A, {{AT_A, PULSE}});
        upload(TB, P, CH1_B, {{AT_B, PULSE}});
        upload(TC, P / 2, CH1_C, {{AT_A, PULSE}}); // different period
        strobes(FALL);
        // b's last capture ends at phase 85 ms, the run at 120 ms.
        pushGaps(80'000, 35'000); // b's capture end -> its next marker / end

        const size_t runMark = sim.lines.size();
        const uint64_t T = mcuNow(wire) + 50'000;
        auto st = startOp(TA, T, 0); // a: forever
        expectOk(trajectoryOp(wire, &st, sizeof(st)), "C5 START a");
        c5Marker(recvTrajectoryFrame(wire, 2000), TA, 0, T, "a cycle 0", CH1_A,
                 CH1_A);

        // a's cycle-0 capture is done (push in hand); the next trigger is
        // ~80 ms away. Every START below must REJ and leave a running.
        const std::string running = "A trajectory is already running";
        st = startOp(TC, T, CYCLES_B);
        CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                             "C5 START c (period mismatch)")
                      .find(running) == 0,
              "C5 period mismatch keeps the 'already running' REJ");
        st = startOp(TB, T + 1, CYCLES_B);
        CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                             "C5 START b (t_start + 1 us)")
                      .find(running) == 0,
              "C5 t_start mismatch (1 us) REJs");
        st = startOp(TB, 0, CYCLES_B);
        CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                             "C5 START b (t_start 0 = now)")
                      .find(running) == 0,
              "C5 t_start 0 never swaps");
        st = startOp(TA, T, CYCLES_B);
        CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                             "C5 START a (itself)")
                      .find(running) == 0,
              "C5 re-START of the running table REJs");

        // Wait until a's cycle-sc marker has fired and its capture is in
        // flight — both injected strobe rises (the exposure-start latch) seen
        // on the sim's stdout, the fall FALL after the trigger still ahead —
        // then swap, BEFORE b's marker-0 phase of that same cycle. Keyed to
        // the capture's actual rises, not to a's due phase: a sim stall over
        // the marker phase delays the fire and the rises with it, and a swap
        // ahead of the rise would latch b's table at both ends.
        uint32_t seen = 0;     // the last cycle whose a push was consumed
        size_t cycleMark = 0;  // sim lines from here on: this cycle's capture
        auto enter = [&](uint32_t cycle) {
          if (cycle > seen + 1) // re-armed: drop a's pushes for the skipped
            discardPushes(wire, TA, seen + 1, cycle - 1, true, 2000,
                          "C5 re-arm", T + uint64_t(seen) * P,
                          T + uint64_t(cycle) * P, gaps);
          seen = cycle - 1;
          drain(sim); // every edge of cycle - 1's capture (its push is in)
          cycleMark = sim.lines.size();
        };
        // Injected exposure starts: the active level, LOW by default
        // (Board::STROBE_ACTIVE_LEVEL; stage 9 covers the polarity).
        auto risen = [&] {
          drain(sim);
          bool l = false, r = false;
          for (size_t i = cycleMark; i < sim.lines.size(); i++) {
            l = l || sim.lines[i] == "strobe L 0";
            r = r || sim.lines[i] == "strobe R 0";
          }
          return l && r;
        };
        fixtureWindow(T, sc, AT_A + 1'000, AT_B - 1'000,
                      "C5: the swap is sent while a's capture is in flight "
                      "(both strobe rises seen), before b's marker phase",
                      enter, risen);
        // b keeps CYCLES_B - 2 cycles after the swap cycle.
        const uint32_t cyclesB = CYCLES_B + (sc - 1);
        const uint64_t cycleT = T + uint64_t(sc) * P;
        // Drained after the in-window reading: [runMark, swapMark) is every
        // word emitted before the swap up to this cycle's phase `from` (the
        // cycle's wrap included), and nothing after it (checkRamp).
        drain(sim);
        const size_t swapMark = sim.lines.size();

        st = startOp(TB, T, cyclesB);
        const auto sw = swapStart(st, "C5");
        // a's capture can only complete (and push) once its strobe falls,
        // FALL after a trigger at/after its due phase: a push before the ACK
        // of a swap handled earlier is a firmware fault. Handled later, the
        // host stalled past the window (fixture miss).
        if (!sw.early.empty() && sw.t >= cycleT + AT_A + FALL)
          throw FixtureMiss("C5: the swap was handled at swap-cycle phase " +
                            std::to_string(sw.t - cycleT) +
                            " us, after a's capture completed — host stall");
        CHECK(sw.early.empty(),
              "C5 a's in-flight push arrives AFTER the swap ACK");
        // Past b's marker phase the by-index crossing state is not what
        // keeps b's marker 0 from firing in the swap cycle (the crossing
        // window has passed it anyway): the scenario did not run as designed.
        if (sw.t >= cycleT + AT_B)
          throw FixtureMiss("C5: the swap was handled at swap-cycle phase " +
                            std::to_string(sw.t - cycleT) +
                            " us, past b's marker phase — host stall");
        const auto inflight = recvTrajectoryFrame(wire, 2000);
        // Its exposure STRADDLES the swap: the rise latched a's position, the
        // fall b's (same ramp; ch1 averages a's and b's) — unless the sim's
        // loop, starved, pumped both falls (the finish latch: the last fall
        // wins) before the Trajectory::tick that first drove b: then both
        // latches read a. The sim's stdout has the order (the strobe pump,
        // the DAC words and the push come from one thread, in that order),
        // and every line of it is out before the push.
        drain(sim);
        size_t fallL = SIZE_MAX, fallR = SIZE_MAX, firstB = SIZE_MAX;
        for (size_t i = cycleMark; i < sim.lines.size(); i++) {
          const std::string &line = sim.lines[i];
          if (fallL == SIZE_MAX && line == "strobe L 1")
            fallL = i;
          if (fallR == SIZE_MAX && line == "strobe R 1")
            fallR = i;
          DacWord w;
          if (firstB == SIZE_MAX && i >= swapMark && parseDac(line, w) &&
              carriesValue(w) && w.left && w.value == CH1_B)
            firstB = i;
        }
        const bool aOnly = fallL < firstB && fallR < firstB;
        const uint16_t ch1 = aOnly ? CH1_A : (CH1_A + CH1_B) / 2;
        c5Marker(inflight, TA, sc, T, "a's in-flight swap cycle", ch1, ch1);
        // The swap went out only after risen() saw both injected rises, and
        // t_exposure is the rise ISR's micros() sample: the capture's
        // trigger and exposure start precede the measured swap instant on
        // correct firmware, whatever the host or the sim did.
        CHECK(inflight.result.t_trigger < sw.t &&
                  inflight.result.t_exposure < sw.t,
              "C5 a's capture (trigger T" +
                  std::to_string(inflight.result.t_trigger - T) +
                  ", exposure T" +
                  std::to_string(inflight.result.t_exposure - T) +
                  " us) started before the swap (T" +
                  std::to_string(sw.t - T) + " us)");
        if (aOnly)
          throw FixtureMiss("C5: both of a's strobe falls were pumped before "
                            "b first drove the DAC (the swap was handled at "
                            "swap-cycle phase " +
                            std::to_string(sw.t - cycleT) +
                            " us, the next loop pass late) — the exposure "
                            "did not straddle the swap");

        // b's markers continue the SAME cycle count on the same clock; b's
        // marker 0 does NOT fire again in the swap cycle (a's marker 0 had).
        for (uint32_t k = sc + 1; k < cyclesB; k++) {
          c5Marker(recvTrajectoryFrame(wire, 2000), TB, k, T, "b", CH1_B,
                   CH1_B);
          if (k == sc + 1) { // between pushes: a period mismatch still REJs
            st = startOp(TC, T, CYCLES_B);
            CHECK(expectRejected(trajectoryOp(wire, &st, sizeof(st)),
                                 "C5 START c over b")
                          .find(running) == 0,
                  "C5 period mismatch REJs while b runs");
          }
        }
        expectEnded(TB, cyclesB, T, "C5");
        const unsigned wraps =
            checkRamp(runMark, swapMark, sw.t, cyclesB, T, "C5");
        CHECK(!hasValue(dacValues(sim, 'L', runMark), CH1_C),
              "C5 the REJected table c never played");
        cleanup("C5");
        std::printf("fw-sim-check: C5 atomic swap a->b mid-capture (a's "
                    "in-flight push after the ACK), cycles 0-%u contiguous on "
                    "the original clock (worst +%llu us), %u wraps, 5 "
                    "mismatched STARTs REJected OK\n",
                    cyclesB - 1, static_cast<unsigned long long>(worstLate),
                    wraps);
      }, recover);

      // C6 — two more swap shapes, same continuity assertions. Short
      // captures (exposure over 4 ms after the trigger, Timed shape: the
      // trigger is released then; timeout at pulse + 5 ms = 29 ms, 25 ms
      // past the fall) so every swap lands with no capture in flight and no
      // push can race the ACK.
      constexpr uint32_t PULSE6 = 24'000, FALL6 = 4'000;
      constexpr uint32_t CYCLES6 = 5;
      // C6a — b's marker EARLIER than the phase at the swap. a = {m0 @80 ms},
      //       b = {m0 @10 ms}; the swap lands in cycle 1 between ~11 and
      //       79 ms, past b's marker phase and before a's (the swap instant
      //       is measured, so a swap handled at/after a's marker phase — a
      //       host stall between the in-window reading and the send — is a
      //       fixture retry, not a firmware failure). The crossing window
      //       has already passed b's phase, so b's marker 0 must NOT fire
      //       late in cycle 1 at the swap — it first fires in cycle 2, on its
      //       phase; a's marker no longer fires in cycle 1 either (cycle 1
      //       has no marker push: never doubled; a marker moved before the
      //       swap phase first fires next cycle).
      retryOnce("C6a", [&] {
        constexpr uint32_t A_AT = 80'000, B_AT = 10'000;
        upload(TA, P, CH1_A, {{A_AT, PULSE6}});
        upload(TB, P, CH1_B, {{B_AT, PULSE6}});
        strobes(FALL6);
        // a's capture ends at 84 ms, b's next marker is at 130 ms; b's
        // capture ends at 14 ms, the run at 120 ms.
        pushGaps(46'000, 106'000);
        const size_t runMark = sim.lines.size();
        const uint64_t T = mcuNow(wire) + 50'000;
        auto st = startOp(TA, T, 0); // a: forever
        expectOk(trajectoryOp(wire, &st, sizeof(st)), "C6a START a");
        checkMarker(recvTrajectoryFrame(wire, 2000), TA, 0, 0, T, A_AT,
                    "C6a a cycle 0", CH1_A, CH1_A);
        uint32_t sc = 1;   // the swap cycle
        uint32_t seen = 0; // the last cycle whose a push was consumed
        fixtureWindow(T, sc, B_AT + 1'000, A_AT - 1'000,
                      "C6a: the swap is sent after b's marker phase and "
                      "before a's",
                      [&](uint32_t cycle) {
                        if (cycle > seen + 1) // re-armed: a fired meanwhile
                          discardPushes(wire, TA, seen + 1, cycle - 1, true,
                                        2000, "C6a re-arm",
                                        T + uint64_t(seen) * P,
                                        T + uint64_t(cycle) * P, gaps);
                        seen = cycle - 1;
                      });
        const uint32_t cycles = CYCLES6 + (sc - 1); // b's budget
        const uint64_t cycleT = T + uint64_t(sc) * P;
        drain(sim); // swapMark as in C5 (checkRamp's split)
        const size_t swapMark = sim.lines.size();
        // Handled at/after a's swap-cycle marker phase, a's marker may have
        // fired first (its push then precedes the ACK): a host stall.
        const uint64_t tSwap =
            swapIdle(startOp(TB, T, cycles), "C6a", cycleT + A_AT,
                     "a's swap-cycle marker phase");
        const auto first = recvTrajectoryFrame(wire, 2000);
        if (!(first.cycle == sc + 1 && first.result.t_trigger >= cycleT + P))
          std::fprintf(stderr,
                       "C6a first push after the swap: id %u marker %u cycle "
                       "%u status %u t_trigger T%+lld us\n",
                       unsigned(first.id), unsigned(first.marker),
                       unsigned(first.cycle), unsigned(first.status),
                       static_cast<long long>(first.result.t_trigger) -
                           static_cast<long long>(T));
        CHECK(first.result.t_trigger >= cycleT + P,
              "C6a b's earlier marker first fires NEXT cycle (not late in "
              "the swap cycle)");
        checkMarker(first, TB, 0, sc + 1, T, B_AT, "C6a b after the swap",
                    CH1_B, CH1_B);
        for (uint32_t k = sc + 2; k < cycles; k++)
          checkMarker(recvTrajectoryFrame(wire, 2000), TB, 0, k, T, B_AT,
                      "C6a b", CH1_B, CH1_B);
        expectEnded(TB, cycles, T, "C6a");
        checkRamp(runMark, swapMark, tSwap, cycles, T, "C6a");
        cleanup("C6a");
      }, recover);
      // C6b — b with MORE markers than a. a = {m0 @10 ms}, b = {m0 @10 ms,
      //       m1 @60 ms}; the swap lands in cycle 1 between ~16 and 59 ms
      //       (a's m0 fired and finished, its push read). b's m1 never fired (its by-index crossing state
      //       is zero from START) and its phase is still ahead, so it fires
      //       in the swap cycle — once, on the original clock, no backlog of
      //       earlier cycles — m0 is not doubled in cycle 1, and both markers
      //       fire every cycle after.
      retryOnce("C6b", [&] {
        constexpr uint32_t M0 = 10'000, M1 = 60'000;
        upload(TA, P, CH1_A, {{M0, PULSE6}});
        upload(TB, P, CH1_B, {{M0, PULSE6}, {M1, PULSE6}});
        strobes(FALL6);
        // m0's capture ends at 14 ms, m1 is at 60 ms; m1's ends at 64 ms, the
        // run at 120 ms.
        pushGaps(46'000, 56'000);
        const size_t runMark = sim.lines.size();
        const uint64_t T = mcuNow(wire) + 50'000;
        auto st = startOp(TA, T, 0); // a: forever
        expectOk(trajectoryOp(wire, &st, sizeof(st)), "C6b START a");
        checkMarker(recvTrajectoryFrame(wire, 2000), TA, 0, 0, T, M0,
                    "C6b a", CH1_A, CH1_A);
        uint32_t sc = 1;   // the swap cycle
        uint32_t seen = 0; // the last cycle whose a push was consumed
        // Each cycle's own a push is read BEFORE polling its window (a late
        // fire pushes after the window opens; it must never stand in for
        // b's extra marker), the skipped cycles' dropped.
        fixtureWindow(T, sc, M0 + FALL6 + 2'000, M1 - 1'000,
                      "C6b: the swap is sent after a's marker finished and "
                      "before b's extra marker phase",
                      [&](uint32_t cycle) {
                        if (cycle > seen + 1)
                          discardPushes(wire, TA, seen + 1, cycle - 1, true,
                                        2000, "C6b re-arm",
                                        T + uint64_t(seen) * P,
                                        T + uint64_t(cycle) * P, gaps);
                        checkMarker(recvTrajectoryFrame(wire, 2000), TA, 0,
                                    cycle, T, M0, "C6b a", CH1_A, CH1_A);
                        seen = cycle;
                      });
        const uint32_t cycles = CYCLES6 + (sc - 1); // b's budget
        const uint64_t cycleT = T + uint64_t(sc) * P;
        drain(sim); // swapMark as in C5 (checkRamp's split)
        const size_t swapMark = sim.lines.size();
        // Handled at/after b's extra marker phase, its crossing is behind
        // the window and it first fires next cycle: a host stall.
        const uint64_t tSwap = swapIdle(startOp(TB, T, cycles), "C6b",
                                        cycleT + M1, "b's extra marker phase");
        checkMarker(recvTrajectoryFrame(wire, 2000), TB, 1, sc, T, M1,
                    "C6b b's extra marker 1 in the swap cycle", CH1_B, CH1_B);
        for (uint32_t k = sc + 1; k < cycles; k++) {
          checkMarker(recvTrajectoryFrame(wire, 2000), TB, 0, k, T, M0,
                      "C6b b marker 0", CH1_B, CH1_B);
          checkMarker(recvTrajectoryFrame(wire, 2000), TB, 1, k, T, M1,
                      "C6b b marker 1", CH1_B, CH1_B);
        }
        expectEnded(TB, cycles, T, "C6b");
        checkRamp(runMark, swapMark, tSwap, cycles, T, "C6b");
        cleanup("C6b");
      }, recover);
      // C6c — the two remaining documented swap guarantees
      //       (serial-protocol.md §trajectory, atomic swap).
      //   armed: a swap while the run is still ARMED (before t_start) keeps
      //       pre-positioning — now at b's phase 0 — and b then plays from
      //       t_start (its marker fires in cycle 0, b's budget ends it).
      //   spent: a swap whose new `cycles` is already spent (b.cycles = 2,
      //       sent in cycle 2 before phase 89 ms) ends the run on the next
      //       tick:
      //       b never plays past its phase 0 (its marker at 90 ms, still
      //       ahead, never fires), the mirror holds phase 0, and ENDED
      //       carries t_start + 2 x period on the original clock.
      retryOnce("C6c", [&] {
        constexpr uint32_t B_AT = 10'000, LATE_AT = 90'000;
        upload(TA, P, CH1_A, {});
        upload(TB, P, CH1_B, {{B_AT, PULSE6}});
        strobes(FALL6);
        // armed: b's capture ends at 14 ms, the run at 120 ms, its next
        // marker phase at 130 ms (spent: no capture at all).
        pushGaps(116'000, 106'000);
        // L's in-band (ch0) values from b's first write on — ch0 precedes
        // ch1 = CH1_B in each write — after checking a's ch1 never returns.
        auto afterB = [&](size_t from, size_t to, const std::string &what) {
          const auto v = dacValues(sim, 'L', from, to);
          const auto firstB = std::find(v.begin(), v.end(), CH1_B);
          CHECK(firstB != v.end() && firstB != v.begin(),
                what + ": b's phase 0 is driven");
          CHECK(std::find(firstB, v.end(), CH1_A) == v.end(),
                what + ": a never drives again after the swap");
          return inBand(std::vector<uint16_t>(firstB - 1, v.end()), BAND_LO,
                        BAND_HI);
        };

        // armed
        size_t runMark = sim.lines.size();
        uint64_t T = mcuNow(wire) + 80'000;
        auto st = startOp(TA, T, 0); // a: forever
        expectOk(trajectoryOp(wire, &st, sizeof(st)), "C6c armed START a");
        bool armedA = false; // a pre-positioned at its phase 0 first
        for (int i = 0; i < 100 && !armedA; i++) {
          drain(sim);
          armedA = hasValue(dacValues(sim, 'L', runMark), CH1_A);
        }
        CHECK(armedA, "C6c armed: a pre-positions before t_start");
        drain(sim); // swapMark as in C5 (checkRamp's split)
        size_t swapMark = sim.lines.size();
        // a has no marker: no push may precede the ACK. The pre-position
        // check below samples up to T - 30 ms; a swap handled within 15 ms
        // of t_start leaves it nothing to see (host stall).
        const uint64_t tSwap = swapIdle(startOp(TB, T, 1), "C6c armed",
                                        T - 15'000, "t_start - 15 ms");
        // Sampled well before t_start: the drain below also takes the words
        // emitted while it runs.
        const uint64_t armedNow = waitMcu(T - 30'000);
        drain(sim);
        const size_t preMark = sim.lines.size();
        if (armedNow >= T - 15'000)
          throw FixtureMiss("armed window sampled at T" +
                            std::to_string(int64_t(armedNow - T)) +
                            " us — host stall");
        const auto armed = afterB(swapMark, preMark, "C6c armed");
        CHECK(!armed.empty(), "C6c armed: b's phase 0 is driven");
        for (auto x : armed)
          CHECK(x == BAND_LO, "C6c armed: the swap keeps pre-positioning at "
                              "b's phase 0 (no playback before t_start)");
        checkMarker(recvTrajectoryFrame(wire, 2000), TB, 0, 0, T, B_AT,
                    "C6c armed b cycle 0", CH1_B, CH1_B);
        expectEnded(TB, 1, T, "C6c armed");
        checkRamp(runMark, swapMark, tSwap, 1, T, "C6c armed");
        cleanup("C6c armed");

        // spent
        upload(TA, P, CH1_A, {});
        upload(TB, P, CH1_B, {{LATE_AT, PULSE6}});
        runMark = sim.lines.size();
        T = mcuNow(wire) + 50'000;
        st = startOp(TA, T, 0); // a: forever
        expectOk(trajectoryOp(wire, &st, sizeof(st)), "C6c spent START a");
        uint32_t sc = 2; // the swap cycle = b's (spent) budget
        fixtureWindow(T, sc, 5'000, LATE_AT - 1'000,
                      "C6c spent: the swap is sent before b's marker phase");
        drain(sim); // swapMark as in C5 (checkRamp's split)
        swapMark = sim.lines.size();
        // Handled past b's marker phase, "the marker never fires" would hold
        // without the spent-budget end (its crossing is behind the window).
        swapIdle(startOp(TB, T, sc), "C6c spent",
                 T + uint64_t(sc) * P + LATE_AT, "b's marker phase");
        const auto end = recvTrajectoryFrame(wire, 2000);
        if (end.status != Cmd::TrajectoryFrame::ENDED)
          std::fprintf(stderr,
                       "C6c spent: got status %u id %u marker %u cycle %u\n",
                       unsigned(end.status), unsigned(end.id),
                       unsigned(end.marker), unsigned(end.cycle));
        CHECK(end.status == Cmd::TrajectoryFrame::ENDED && end.id == TB &&
                  end.marker == Cmd::TrajectoryFrame::NO_MARKER &&
                  end.cycle == sc,
              "C6c spent: the next push is b's ENDED (no marker fired)");
        CHECK(end.result.t_trigger == T + uint64_t(sc) * P,
              "C6c spent: ENDED at t_start + cycles x period (original "
              "clock)");
        CHECK(hasValue(dacValues(sim, 'L', runMark, swapMark), CH1_A),
              "C6c spent: a played before the swap");
        sleepMs(100); // the hold persists
        drain(sim);
        const auto held = afterB(swapMark, SIZE_MAX, "C6c spent");
        CHECK(!held.empty(), "C6c spent: phase 0 is driven");
        for (auto x : held)
          CHECK(x == BAND_LO, "C6c spent: the run ends holding phase 0 (b "
                              "never plays past it)");
        cleanup("C6c spent");
        std::printf("fw-sim-check: C6c swap while armed pre-positions at b's "
                    "phase 0; swap with a spent budget ends with a phase-0 "
                    "hold + ENDED OK\n");
      }, recover);
      std::printf("fw-sim-check: C6 swap shapes: b's earlier marker first "
                  "fires next cycle, b's extra marker fires in the swap "
                  "cycle, continuity holds (worst +%llu us across C5/C6) "
                  "OK\n",
                  static_cast<unsigned long long>(worstLate));
    }
    // ==== STAGE D — serial pipelining =========================================
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

      // D1 — sequential baseline vs pipelined bursts. Both are host
      // wall-clock times: the pipelined one is the best of BURSTS, so one
      // sim stall inside a batch does not decide the 2x comparison.
      constexpr int N = 128, BURSTS = 3;
      auto t0 = Clock::now();
      for (int i = 0; i < N; i++)
        (void)mcuNow(wire);
      const double seqMs = msSince(t0);

      std::vector<uint16_t> seqs;
      std::vector<uint8_t> burst;
      double pipeMs = 0;
      uint64_t handledUs = 0; // MCU span of the fastest batch
      for (int b = 0; b < BURSTS; b++) {
        seqs.clear();
        burst.clear();
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
        const double ms = msSince(t0);
        if (b == 0 || ms < pipeMs) {
          pipeMs = ms;
          handledUs = prevUs - firstUs;
        }
      }
      CHECK(pipeMs * 2 < seqMs,
            "pipelined batch costs well under N sequential round trips");
      std::printf("fw-sim-check: D1 %d GETs pipelined %.2f ms (best of %d) "
                  "vs sequential %.2f ms (%.1fx; MCU handled all within %llu "
                  "us) OK\n",
                  N, pipeMs, BURSTS, seqMs, seqMs / pipeMs,
                  static_cast<unsigned long long>(handledUs));

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

      // Inverted waveform (LineInverter=false): idles LOW, exposure drives
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
    uint64_t worstStall = 0;
    for (const Stall &st : sim.stalls)
      worstStall = std::max(worstStall, st.to - st.from);
    std::printf("fw-sim-check: %u stage retries, %u fixture re-arms, %zu sim "
                "loop stalls > 2 ms (worst %llu us)\n",
                stageRetries, fixtureRearms, sim.stalls.size(),
                static_cast<unsigned long long>(worstStall));
    std::printf("fw-sim-check: ALL OK\n");
    rc = 0;
    ::close(wire.fd);
  } catch (const std::exception &e) {
    // A fixture failure (the host or the sim starved past every re-arm) is
    // not a firmware verdict; say which one it is.
    const bool fixture = dynamic_cast<const FixtureMiss *>(&e) ||
                         dynamic_cast<const FixtureExhausted *>(&e);
    std::fprintf(stderr, "fw-sim-check FAILED%s: %s\n",
                 fixture ? " (fixture, not a firmware fault)" : "", e.what());
    if (sim.pid > 0)
      ::kill(sim.pid, SIGKILL);
    ::waitpid(sim.pid, nullptr, 0);
  }
  return rc;
}
