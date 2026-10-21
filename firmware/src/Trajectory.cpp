// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <cstring>

#include <Protocol/Packet.h>
#include <Protocol/Protocol.h>

#include "Capture.h"
#include "Global.h"
#include "Streams.h"
#include "Trajectory.h"

// See Streams.cpp: RAM2 on Teensy 4, plain storage on the host sim. Not
// zero-initialized on the MCU — sample validity is the `present` bitmap.
#ifndef DMAMEM
#define DMAMEM
#endif

namespace Trajectory {

namespace {

using Packet::Command::MirrorPosition;
using Packet::Command::TrajectoryFrame;
using Flag = Packet::Command::Trajectory::Flag;

// REJ texts below name these limits — keep them in sync.
static_assert(MAX_TABLES == 4 && MAX_SAMPLES == 4096 && MAX_MARKERS == 8,
              "update the REJ reason texts in Trajectory.cpp");

enum class State : uint8_t { FREE, LOADING, SEALED };

struct Marker {
  bool valid = false;
  Microseconds offset = 0;
  uint8_t cameras = 0;
  Microseconds pulse = 0;
};

struct Table {
  State state = State::FREE;
  uint16_t base = 0;  // first pool index
  uint16_t count = 0; // samples
  Microseconds period = 0;
  uint8_t flags = 0;
  Marker markers[MAX_MARKERS];
};

DMAMEM TrajectorySample pool[MAX_SAMPLES];
uint32_t present[MAX_SAMPLES / 32]; // bit per pool index: DATA received
Table tables[MAX_TABLES];

struct Playback {
  bool active = false;
  uint8_t id = 0;
  Timestamp tStart = 0;
  uint32_t cycles = 0; // 0 = forever
  // Marker crossing window: markers fire for absolute phase times m with
  // prev < m <= elapsed (first: 0 <= m <= elapsed).
  bool first = true;
  uint64_t prev = 0;
};

Playback play;

inline bool isPresent(uint16_t i) { return present[i >> 5] & (1u << (i & 31)); }
inline void setPresent(uint16_t i) { present[i >> 5] |= 1u << (i & 31); }
inline void clearPresent(uint16_t i) { present[i >> 5] &= ~(1u << (i & 31)); }

bool isRunning(uint8_t id) { return play.active && play.id == id; }

// First-fit allocation of `count` contiguous pool slots, skipping `except`
// (the table being re-BEGUN). Returns false when no gap is large enough.
bool allocate(uint16_t count, uint8_t except, uint16_t &base) {
  uint16_t candidate = 0;
  for (;;) {
    if (uint32_t(candidate) + count > MAX_SAMPLES)
      return false;
    bool overlap = false;
    for (uint8_t i = 0; i < MAX_TABLES; i++) {
      const Table &t = tables[i];
      if (i == except || t.state == State::FREE)
        continue;
      if (candidate < t.base + t.count && t.base < candidate + count) {
        candidate = t.base + t.count; // jump past the blocker, retry
        overlap = true;
        break;
      }
    }
    if (!overlap) {
      base = candidate;
      return true;
    }
  }
}

// Sample i of a table, copied out of the packed pool.
inline TrajectorySample sample(const Table &t, uint16_t i) {
  TrajectorySample s;
  std::memcpy(&s, &pool[t.base + i], sizeof(s));
  return s;
}

uint16_t lerp(uint16_t a, uint16_t b, int64_t elapsed, int64_t span) {
  const int64_t num = (int64_t(b) - int64_t(a)) * elapsed;
  const int64_t step = (num >= 0 ? num + span / 2 : num - span / 2) / span;
  return static_cast<uint16_t>(int64_t(a) + step);
}

// The table's mirror target at phase `phase` (0 <= phase < period).
void positionAt(const Table &t, uint32_t phase, MirrorPosition &left,
                MirrorPosition &right) {
  // i = last sample with t_offset <= phase; none -> wrap to the last sample
  // of the previous cycle.
  uint16_t lo = 0, hi = t.count; // search [lo, hi)
  while (lo < hi) {
    const uint16_t mid = lo + (hi - lo) / 2;
    if (sample(t, mid).t_offset <= phase)
      lo = mid + 1;
    else
      hi = mid;
  }
  const bool wrapped = lo == 0;
  const uint16_t i = wrapped ? t.count - 1 : lo - 1;
  const TrajectorySample a = sample(t, i);
  if (t.flags & Flag::STEP) {
    left = a.left;
    right = a.right;
    return;
  }
  const uint16_t j = (i + 1) % t.count;
  const TrajectorySample b = sample(t, j);
  // Segment [ta, tb) in the same phase frame as `phase`.
  const int64_t ta = int64_t(a.t_offset) - (wrapped ? int64_t(t.period) : 0);
  const int64_t tb =
      int64_t(b.t_offset) + (!wrapped && j <= i ? int64_t(t.period) : 0);
  const int64_t span = tb - ta;
  const int64_t elapsed = int64_t(phase) - ta;
  if (span <= 0) { // single-sample table: constant
    left = a.left;
    right = a.right;
    return;
  }
  for (uint8_t c = 0; c < 4; c++) {
    left.ch[c] = lerp(a.left.ch[c], b.left.ch[c], elapsed, span);
    right.ch[c] = lerp(a.right.ch[c], b.right.ch[c], elapsed, span);
  }
}

void halt() {
  play.active = false;
  Streams::release(); // TRAJECTORY -> HOLD: the mirror stays put
}

FrameResult emptyResult(uint8_t id, Timestamp t) {
  FrameResult r{};
  r.stream = id;
  r.t_trigger = t;
  return r;
}

struct Crossing {
  uint8_t marker;
  uint32_t cycle;
  uint64_t at; // elapsed µs since t_start
};

// Fires every marker whose phase time lies in the crossing window ending at
// `elapsed`, in time order. Only the latest crossing of each marker counts
// (a stalled loop never bursts a backlog of triggers).
void fireMarkers(const Table &t, uint64_t elapsed) {
  Crossing due[MAX_MARKERS];
  uint8_t n = 0;
  for (uint8_t m = 0; m < MAX_MARKERS; m++) {
    const Marker &mk = t.markers[m];
    if (!mk.valid || elapsed < mk.offset)
      continue;
    uint64_t k = (elapsed - mk.offset) / t.period;
    if (play.cycles && k >= play.cycles)
      k = play.cycles - 1;
    const uint64_t at = k * t.period + mk.offset;
    if (at > elapsed || (!play.first && at <= play.prev))
      continue;
    // Insertion sort by time (n <= MAX_MARKERS).
    uint8_t pos = n++;
    while (pos > 0 && due[pos - 1].at > at) {
      due[pos] = due[pos - 1];
      pos--;
    }
    due[pos] = Crossing{m, static_cast<uint32_t>(k), at};
  }
  for (uint8_t i = 0; i < n; i++) {
    const Marker &mk = t.markers[due[i].marker];
    const Capture::MarkerOrigin origin{play.id, due[i].marker, due[i].cycle};
    if (!Capture::enqueueMarker(origin, mk.cameras, mk.pulse))
      push(play.id, due[i].marker, due[i].cycle, TrajectoryFrame::BUSY,
           emptyResult(play.id, play.tStart + due[i].at));
  }
}

} // namespace

// ---- SET ops ------------------------------------------------------------------

const char *begin(uint8_t id, uint16_t sampleCount, Microseconds period,
                  uint8_t flags) {
  if (id >= MAX_TABLES)
    return "Trajectory id out of range (max 4 tables)";
  if (isRunning(id))
    return "Trajectory is running (STOP it first)";
  if (sampleCount == 0)
    return "Trajectory needs at least one sample";
  if (sampleCount > MAX_SAMPLES)
    return "Trajectory too long (max 4096 samples total)";
  if (period == 0)
    return "Trajectory period must be > 0";
  if (flags & ~Flag::STEP)
    return "Unknown trajectory flags";
  uint16_t base;
  if (!allocate(sampleCount, id, base))
    return "Trajectory pool full (max 4096 samples total; DELETE a table)";
  Table &t = tables[id];
  t = Table{};
  t.state = State::LOADING;
  t.base = base;
  t.count = sampleCount;
  t.period = period;
  t.flags = flags;
  for (uint16_t i = 0; i < sampleCount; i++)
    clearPresent(base + i);
  return nullptr;
}

const char *data(uint8_t id, uint16_t firstIndex, uint8_t count,
                 const uint8_t *samples) {
  if (id >= MAX_TABLES || tables[id].state == State::FREE)
    return "Unknown trajectory id (BEGIN first)";
  Table &t = tables[id];
  if (t.state != State::LOADING)
    return "Trajectory already committed (BEGIN again to reload)";
  if (count == 0 || count > CHUNK_SAMPLES)
    return "DATA chunk must carry 1..12 samples";
  if (uint32_t(firstIndex) + count > t.count)
    return "DATA chunk past the end of the table";
  std::memcpy(&pool[t.base + firstIndex], samples,
              size_t(count) * sizeof(TrajectorySample));
  for (uint16_t i = 0; i < count; i++)
    setPresent(t.base + firstIndex + i);
  return nullptr;
}

const char *mark(uint8_t id, uint8_t marker, Microseconds offset,
                 uint8_t cameras, Microseconds pulse) {
  if (id >= MAX_TABLES || tables[id].state == State::FREE)
    return "Unknown trajectory id (BEGIN first)";
  if (isRunning(id))
    return "Trajectory is running (STOP it first)";
  if (marker >= MAX_MARKERS)
    return "Marker index out of range (max 8 markers per table)";
  Table &t = tables[id];
  if (cameras == 0) { // clear
    t.markers[marker] = Marker{};
    return nullptr;
  }
  if (offset >= t.period)
    return "Marker offset must be < period";
  if (pulse == 0)
    return "Marker pulse must be > 0";
  if (!Capture::camerasSupported(cameras))
    return "Unsupported camera mask for a marker";
  t.markers[marker] = Marker{true, offset, cameras, pulse};
  return nullptr;
}

const char *commit(uint8_t id) {
  if (id >= MAX_TABLES || tables[id].state == State::FREE)
    return "Unknown trajectory id (BEGIN first)";
  Table &t = tables[id];
  if (t.state == State::SEALED)
    return "Trajectory already committed";
  for (uint16_t i = 0; i < t.count; i++)
    if (!isPresent(t.base + i))
      return "Trajectory incomplete: every sample index must be uploaded";
  for (uint16_t i = 0; i < t.count; i++) {
    const Microseconds off = sample(t, i).t_offset;
    if (off >= t.period)
      return "Sample offset must be < period";
    if (i > 0 && off <= sample(t, i - 1).t_offset)
      return "Sample offsets must be strictly increasing";
  }
  t.state = State::SEALED;
  return nullptr;
}

const char *start(uint8_t id, Timestamp tStart, uint32_t cycles) {
  if (id >= MAX_TABLES || tables[id].state == State::FREE)
    return "Unknown trajectory id (BEGIN first)";
  if (tables[id].state != State::SEALED)
    return "Trajectory not committed (COMMIT first)";
  if (play.active)
    return "A trajectory is already running (STOP it first)";
  const Timestamp now = Global::time.now();
  play = Playback{};
  play.active = true;
  play.id = id;
  play.cycles = cycles;
  play.tStart = tStart == 0 ? now : tStart;
  if (play.tStart < now) {
    // Joining a run already in progress: only FUTURE marker phases fire.
    play.first = false;
    play.prev = now - play.tStart;
  }
  Streams::claim();
  return nullptr;
}

const char *stop(uint8_t id) {
  if (id >= MAX_TABLES || tables[id].state == State::FREE)
    return "Unknown trajectory id";
  if (isRunning(id))
    halt();
  return nullptr; // not running: idempotent
}

const char *remove(uint8_t id) {
  if (id >= MAX_TABLES)
    return "Trajectory id out of range (max 4 tables)";
  if (isRunning(id))
    halt();
  tables[id] = Table{};
  return nullptr;
}

bool running() { return play.active; }

void tick() {
  if (!play.active)
    return;
  if (!Global::system_enabled ||
      Streams::owner() != Streams::Owner::TRAJECTORY) {
    // Disabled (Streams::clear reclaimed the DAC) — the run is over.
    play.active = false;
    push(play.id, TrajectoryFrame::NO_MARKER, 0, TrajectoryFrame::CANCELLED,
         emptyResult(play.id, Global::time.now()));
    return;
  }
  const Table &t = tables[play.id];
  MirrorPosition left, right;
  const Timestamp now = Global::time.now();
  if (now < play.tStart) {
    // Armed: pre-position at phase 0 so the mirror has settled by t_start.
    positionAt(t, 0, left, right);
    Streams::drive(left, right);
    return;
  }
  uint64_t elapsed = now - play.tStart;
  const uint64_t total = uint64_t(play.cycles) * t.period;
  const bool ended = play.cycles != 0 && elapsed >= total;
  if (ended)
    elapsed = total;
  // Move first, then trigger: the marker's exposure starts on the position
  // this tick commits.
  positionAt(t, static_cast<uint32_t>(elapsed % t.period), left, right);
  Streams::drive(left, right);
  fireMarkers(t, elapsed);
  play.first = false;
  play.prev = elapsed;
  if (ended) {
    const uint8_t id = play.id;
    const uint32_t cycles = play.cycles;
    halt();
    push(id, TrajectoryFrame::NO_MARKER, cycles, TrajectoryFrame::ENDED,
         emptyResult(id, play.tStart + total));
  }
}

void push(uint8_t id, uint8_t marker, uint32_t cycle, uint8_t status,
          const FrameResult &result) {
  TrajectoryFrame frame{};
  frame.id = id;
  frame.marker = marker;
  frame.cycle = cycle;
  frame.status = status;
  frame.result = result;
  auto packet = Packet::Command::Trajectory::Create::SYN(0);
  packet.setData(&frame, sizeof(frame));
  // SYN pushes always go out (Protocol::send would swallow seq 0) — same
  // direct write as the LOG macro.
  if (COBS::tx.encode(packet.finalize()))
    Serial.write(COBS::tx.data(), COBS::tx.size());
}

} // namespace Trajectory
