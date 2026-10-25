// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <cstring>

#include "Global.h"
#include "MEMS.h"
#include "Streams.h"

// Teensy 4 places DMAMEM arrays in the 512 KB OCRAM (RAM2) instead of the
// tightly-coupled RAM1 that also holds code; the host sim has no such section.
// DMAMEM storage is NOT zero-initialized on the MCU, so only plain data whose
// validity is tracked elsewhere goes there.
#ifndef DMAMEM
#define DMAMEM
#endif

namespace Streams {

namespace {

using Packet::Command::Schedule;

struct Entry {
  bool active = false; // CREATEd, not yet TERMINATEd
  bool pendingFrame = false;
  MirrorPosition left{};
  MirrorPosition right{};
};

Entry table[CAPACITY];
uint8_t activeId = INVALID_ID;
bool dirty = false; // active stream's target not yet written to the DAC
// touch(): re-commit whatever currently drives the DAC on the next tick.
bool refresh = false;

// ---- v2.2.0 schedule state --------------------------------------------------

// POD (DMAMEM-safe): validity is tracked by the per-stream Ring head/count.
struct Keyframe {
  Timestamp t;
  MirrorPosition left;
  MirrorPosition right;
  uint8_t flags;
};

DMAMEM Keyframe keyframes[CAPACITY][SCHEDULE_DEPTH];

struct Ring {
  uint8_t head = 0;
  uint8_t count = 0;
  // Last APPLIED keyframe's t_apply (the stale-drop threshold).
  bool applied = false;
  Timestamp lastApplied = 0;
  // Interpolation anchor: the segment into the head keyframe starts here.
  Timestamp anchorT = 0;
  MirrorPosition anchorLeft{};
  MirrorPosition anchorRight{};
};

Ring rings[CAPACITY];
uint8_t scheduledStreams = 0; // streams with count > 0 (tick() fast path)

uint32_t dropStale = 0, dropFull = 0;
uint32_t reportedDrops = 0;
uint64_t lastDropLogUs = 0;
constexpr uint64_t DROP_LOG_PERIOD_US = 1'000'000;

// ---- v2.2.0 DAC ownership ---------------------------------------------------
Owner dacOwner = Owner::STREAMS;
MirrorPosition driveLeft{}, driveRight{};
// The first drive() after claim() writes unconditionally. A flag of its own,
// NOT `refresh`: Streams::tick() runs before Trajectory::tick() in loop(), and
// a pending touch() under TRAJECTORY ownership re-writes driveLeft/driveRight — until
// the new run's first drive() that is the LAST run's position, a stale value
// that would move the mirror for one tick before phase 0. tick() therefore
// leaves the DAC alone while this is set (drive() honours a pending refresh).
bool firstDrive = false;
// What the DAC was last written with (writeDac, or a direct Actuate via
// noteActuate). claim() seeds driveLeft/driveRight from it, so a HOLD before
// the run's first drive() (START and STOP/DELETE handled in one loop
// iteration) holds the DAC's actual position. Not known after boot or a
// disable (clear()): the enable sequence leaves every channel at V_BIAS.
MirrorPosition dacLeft{}, dacRight{};
bool dacKnown = false;

inline Keyframe &slot(uint8_t id, uint8_t index) {
  return keyframes[id][(rings[id].head + index) % SCHEDULE_DEPTH];
}

void clearSchedule(uint8_t id) {
  if (rings[id].count > 0)
    scheduledStreams--;
  rings[id] = Ring{};
}

bool samePosition(const MirrorPosition &a, const MirrorPosition &b) {
  return std::memcmp(&a, &b, sizeof(MirrorPosition)) == 0;
}

// Round-to-nearest linear interpolation of one channel at elapsed/span.
uint16_t lerp(uint16_t a, uint16_t b, uint64_t elapsed, uint64_t span) {
  const int64_t delta = int64_t(b) - int64_t(a);
  const int64_t num = delta * int64_t(elapsed);
  const int64_t den = int64_t(span);
  const int64_t step = (num >= 0 ? num + den / 2 : num - den / 2) / den;
  return static_cast<uint16_t>(int64_t(a) + step);
}

void lerpPosition(const MirrorPosition &a, const MirrorPosition &b,
                  uint64_t elapsed, uint64_t span, MirrorPosition &out) {
  for (uint8_t i = 0; i < 4; i++)
    out.ch[i] = lerp(a.ch[i], b.ch[i], elapsed, span);
}

void writeDac(const MirrorPosition &left, const MirrorPosition &right) {
  MEMS::set(MEMS::Device::LEFT, left);
  MEMS::set(MEMS::Device::RIGHT, right);
  MEMS::apply();
  dacLeft = left;
  dacRight = right;
  dacKnown = true;
}

// Sets a stream's target (ISR-safe against Capture's snapshot) and marks the
// DAC dirty if it is the active one and actually changed.
void setTarget(uint8_t id, const MirrorPosition &left,
               const MirrorPosition &right) {
  Entry &e = table[id];
  if (samePosition(e.left, left) && samePosition(e.right, right))
    return;
  noInterrupts();
  e.left = left;
  e.right = right;
  interrupts();
  if (id == activeId)
    dirty = true;
}

// Advances one stream's schedule to `now`.
void runSchedule(uint8_t id, Timestamp now) {
  Ring &ring = rings[id];
  bool popped = false;
  Keyframe applied{};
  while (ring.count > 0 && slot(id, 0).t <= now) {
    applied = slot(id, 0);
    ring.head = (ring.head + 1) % SCHEDULE_DEPTH;
    ring.count--;
    popped = true;
  }
  if (popped) {
    ring.applied = true;
    ring.lastApplied = applied.t;
    ring.anchorT = applied.t;
    ring.anchorLeft = applied.left;
    ring.anchorRight = applied.right;
    setTarget(id, applied.left, applied.right);
    if (ring.count == 0)
      scheduledStreams--;
  }
  if (ring.count == 0)
    return;
  const Keyframe &next = slot(id, 0);
  if (!(next.flags & Schedule::INTERPOLATE))
    return;
  // anchorT <= now < next.t here: the anchor is either an applied keyframe
  // (t <= now) or the arrival time of a keyframe into an empty ring.
  const uint64_t span = next.t - ring.anchorT;
  const uint64_t elapsed = now - ring.anchorT;
  MirrorPosition left, right;
  lerpPosition(ring.anchorLeft, next.left, elapsed, span, left);
  lerpPosition(ring.anchorRight, next.right, elapsed, span, right);
  setTarget(id, left, right);
}

void reportDrops(Timestamp now) {
  const uint32_t total = dropStale + dropFull;
  if (total == reportedDrops || now - lastDropLogUs < DROP_LOG_PERIOD_US)
    return;
  lastDropLogUs = now;
  reportedDrops = total;
  WARN("Schedule: dropped %lu stale + %lu overflow keyframes (cumulative)",
       static_cast<unsigned long>(dropStale),
       static_cast<unsigned long>(dropFull));
}

} // namespace

bool exists(uint8_t id) { return id < CAPACITY && table[id].active; }

bool hasPendingFrame(uint8_t id) {
  return exists(id) && table[id].pendingFrame;
}

void setPendingFrame(uint8_t id, bool pending) {
  if (exists(id))
    table[id].pendingFrame = pending;
}

bool create(uint8_t id, const MirrorPosition &left,
            const MirrorPosition &right) {
  if (id >= CAPACITY || table[id].active)
    return false;
  table[id] = Entry{true, false, left, right};
  clearSchedule(id);
  // A stream drives the DAC only while ACTIVE. A freshly CREATEd stream takes
  // the DAC when nothing else holds it; captures still re-activate their own
  // stream per request. Hosts run one exclusive stream, so this never steals
  // from a live one.
  if (activeId == INVALID_ID) {
    activeId = id;
    dirty = true;
  }
  return true;
}

bool update(uint8_t id, const MirrorPosition &left,
            const MirrorPosition &right) {
  if (!exists(id))
    return false;
  // v2.2.0: a plain UPDATE means "now, latest wins" — it supersedes (clears)
  // any pending CMD_SCHEDULE keyframes on this stream.
  clearSchedule(id);
  // Guard against the strobe ISR's Streams::snapshot() (Capture.cpp) reading
  // a torn MirrorPosition mid-write — it runs concurrently with this from
  // interrupt context.
  noInterrupts();
  table[id].left = left;
  table[id].right = right;
  interrupts();
  if (id == activeId)
    dirty = true;
  return true;
}

bool terminate(uint8_t id) {
  if (!exists(id) || table[id].pendingFrame)
    return false;
  table[id] = Entry{};
  clearSchedule(id);
  if (id == activeId)
    activeId = INVALID_ID;
  return true;
}

bool activate(uint8_t id) {
  if (!exists(id))
    return false;
  activeId = id;
  dirty = true;
  return true;
}

uint8_t active() { return activeId; }

void snapshot(MirrorPosition &left, MirrorPosition &right) {
  if (dacOwner != Owner::STREAMS) {
    // v2.2.0: a trajectory drives (or holds) the DAC.
    left = driveLeft;
    right = driveRight;
    return;
  }
  if (activeId == INVALID_ID) {
    left = MirrorPosition{};
    right = MirrorPosition{};
    return;
  }
  left = table[activeId].left;
  right = table[activeId].right;
}

void noteReinit() {
  // MEMS::enable() ran (recovery): every channel is parked at V_BIAS again, so
  // the last-written record no longer describes the DAC. claim() then seeds
  // V_BIAS until the next write.
  dacKnown = false;
}

void touch() {
  // Force the DAC's current owner to be re-committed on the next tick(), even
  // if nothing changed. Used after a MEMS re-init (Protocol.cpp MEMS
  // recovery) so the DAC is re-loaded with live targets.
  if (activeId != INVALID_ID || dacOwner != Owner::STREAMS)
    refresh = true;
}

void tick() {
  if (scheduledStreams > 0 || dropStale + dropFull != reportedDrops) {
    const Timestamp now = Global::time.now();
    // A running trajectory owns the DAC; keyframes are REJected meanwhile, so
    // rings only hold what was queued before START — leave them frozen.
    if (dacOwner != Owner::TRAJECTORY && scheduledStreams > 0)
      for (uint8_t id = 0; id < CAPACITY; id++)
        if (rings[id].count > 0)
          runSchedule(id, now);
    reportDrops(now);
  }
  if (dacOwner == Owner::HOLD && dirty)
    dacOwner = Owner::STREAMS; // a fresh stream write reclaims the DAC
  if (dacOwner != Owner::STREAMS) {
    dirty = false;
    // Before the run's first drive() the driven position is the previous
    // run's: a touch() landing after claim() (a MEMS recovery in the START
    // batch) stays pending for drive() instead.
    if (refresh && !(dacOwner == Owner::TRAJECTORY && firstDrive)) {
      writeDac(driveLeft, driveRight);
      refresh = false;
    }
    return;
  }
  if (activeId == INVALID_ID) {
    refresh = false;
    return;
  }
  if (!dirty && !refresh)
    return;
  writeDac(table[activeId].left, table[activeId].right);
  dirty = false;
  refresh = false;
}

void clear() {
  for (auto &entry : table)
    entry = Entry{};
  for (auto &ring : rings)
    ring = Ring{};
  scheduledStreams = 0;
  activeId = INVALID_ID;
  dirty = false;
  refresh = false;
  dacOwner = Owner::STREAMS;
  dacKnown = false; // parked at V_BIAS; the next enable re-inits it there
}

// ---- v2.2.0 CMD_SCHEDULE ----------------------------------------------------

ScheduleResult schedule(uint8_t id, Timestamp t_apply, uint8_t flags,
                        const MirrorPosition &left,
                        const MirrorPosition &right) {
  if (!exists(id))
    return ScheduleResult::UNKNOWN_STREAM;
  Ring &ring = rings[id];
  if (ring.applied && t_apply < ring.lastApplied) {
    dropStale++;
    return ScheduleResult::STALE;
  }
  if (ring.count >= SCHEDULE_DEPTH) {
    dropFull++;
    return ScheduleResult::FULL;
  }
  if (ring.count == 0) {
    // Arrival into an empty ring: an INTERPOLATE keyframe ramps from where
    // the stream is NOW (its current target), starting now.
    ring.anchorT = Global::time.now();
    ring.anchorLeft = table[id].left;
    ring.anchorRight = table[id].right;
    scheduledStreams++;
  }
  // Time-ordered insert (stable: equal t_apply keeps arrival order). The
  // common case — monotonic t_apply — appends without shifting.
  uint8_t pos = ring.count;
  while (pos > 0 && slot(id, pos - 1).t > t_apply) {
    slot(id, pos) = slot(id, pos - 1);
    pos--;
  }
  slot(id, pos) = Keyframe{t_apply, left, right, flags};
  ring.count++;
  return ScheduleResult::OK;
}

uint32_t droppedStale() { return dropStale; }
uint32_t droppedFull() { return dropFull; }

// ---- v2.2.0 DAC ownership ---------------------------------------------------

Owner owner() { return dacOwner; }

void claim() {
  // Seed first, then flip the owner and the drive position TOGETHER: a strobe
  // edge latching snapshot() between the two must never pair TRAJECTORY
  // ownership with the previous run's drive position.
  MirrorPosition left = dacLeft, right = dacRight;
  if (!dacKnown)
    for (uint8_t i = 0; i < 4; i++)
      left.ch[i] = right.ch[i] = Global::bias_voltage;
  dirty = false;
  refresh = false; // never re-drive the previous run's position
  firstDrive = true;
  noInterrupts();
  dacOwner = Owner::TRAJECTORY;
  driveLeft = left;
  driveRight = right;
  interrupts();
}

void drive(const MirrorPosition &left, const MirrorPosition &right) {
  if (dacOwner != Owner::TRAJECTORY)
    return;
  if (!firstDrive && !refresh && samePosition(left, driveLeft) &&
      samePosition(right, driveRight))
    return;
  noInterrupts();
  driveLeft = left;
  driveRight = right;
  interrupts();
  writeDac(left, right);
  refresh = false;
  firstDrive = false;
}

void release() {
  if (dacOwner != Owner::TRAJECTORY)
    return;
  dacOwner = Owner::HOLD;
  dirty = false;
}

void noteActuate(const MirrorPosition &left, const MirrorPosition &right) {
  dacLeft = left;
  dacRight = right;
  dacKnown = true;
  if (dacOwner != Owner::HOLD)
    return;
  noInterrupts();
  driveLeft = left;
  driveRight = right;
  interrupts();
}

} // namespace Streams
