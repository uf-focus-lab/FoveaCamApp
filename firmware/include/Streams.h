// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>

#include <Protocol/Packet.h>

// Named, continuously-updatable mirror-position targets (Protocol v2
// CMD_STREAM — named `Streams` here, plural, to avoid colliding with the
// Packet::Command::MirrorStream wire-packet type). Latest-target-wins: a stream
// holds one current L+R target, updated by (usually fire-and-forget) UPDATE
// requests. The MEMS DAC always tracks whichever stream is currently
// `active()` — switched by the frame engine (Capture.h) when a CMD_FRAME
// request on a different stream starts.
namespace Streams {

using Packet::Command::MirrorPosition;

constexpr uint8_t CAPACITY = 64;
constexpr uint8_t INVALID_ID = 0xFF;

// True if `id` was CREATEd and not yet TERMINATEd.
bool exists(uint8_t id);
// True if a frame request is queued or in-flight on this stream (blocks
// TERMINATE; used by Capture to REJect duplicate-stream frame requests).
bool hasPendingFrame(uint8_t id);
void setPendingFrame(uint8_t id, bool pending);

bool create(uint8_t id, const MirrorPosition &left, const MirrorPosition &right);
bool update(uint8_t id, const MirrorPosition &left, const MirrorPosition &right);
// Fails (returns false) if the stream has a pending frame request.
bool terminate(uint8_t id);

// Switches the physically-applied ("active") stream. Fails if `id` doesn't
// exist. Forces a DAC write on the next tick() even if the target is
// unchanged, so the new stream's position is committed before a trigger.
bool activate(uint8_t id);
uint8_t active();

// Snapshot of the active stream's current (possibly mid-update) target;
// INVALID_ID leaves both positions zeroed. Used to latch mirror positions
// into the FrameResult at strobe rise.
void snapshot(MirrorPosition &left, MirrorPosition &right);

// Marks the active stream dirty so tick() re-commits its (possibly unchanged)
// target to the DAC on the next loop. Used after a MEMS re-init (SYS_RESET
// MEMS recovery) so the mirror reloads the live targets. No-op when no stream is active. While a trajectory owns (or
// holds) the DAC, re-commits the driven position instead.
void touch();
// A MEMS re-init parked the DAC at V_BIAS: forget the last-written record
// (claim() seeds V_BIAS until the next write). Call BEFORE touch().
void noteReinit();

// Call every loop() tick: writes the active stream's target to the MEMS DAC,
// skipping the SPI write when the target hasn't changed since the last tick.
void tick();

// Terminates every stream unconditionally (e.g. on System::Enable(false)).
// Also empties every schedule and returns DAC ownership to the streams.
void clear();

// ---- v2.2.0 CMD_SCHEDULE: timestamped keyframes ----------------------------
// spec: docs/spec/serial-protocol.md#schedule
//
// Each stream owns a time-ordered keyframe ring (SCHEDULE_DEPTH deep). tick()
// pops every keyframe whose t_apply <= now into the stream's target (latest
// wins) and, while the head keyframe carries Schedule::INTERPOLATE, writes the
// linear interpolation between the previous keyframe (the "anchor") and the
// head into the target each tick. update() (CMD_STREAM UPDATE) and
// terminate() clear the stream's ring.

using Packet::Command::Timestamp;

constexpr uint8_t SCHEDULE_DEPTH = 32;

enum class ScheduleResult : uint8_t {
  OK,
  UNKNOWN_STREAM,
  FULL,  // ring holds SCHEDULE_DEPTH pending keyframes (counted as dropped)
  STALE, // t_apply older than the last applied keyframe (dropped + counted)
};

ScheduleResult schedule(uint8_t id, Timestamp t_apply, uint8_t flags,
                        const MirrorPosition &left,
                        const MirrorPosition &right);

// Cumulative dropped-keyframe counters (since boot). tick() also reports
// growth in a WARN log, rate-limited to one line per DROP_LOG_PERIOD_US.
uint32_t droppedStale();
uint32_t droppedFull();

// ---- v2.2.0 DAC ownership (CMD_TRAJECTORY) ---------------------------------
// spec: docs/spec/serial-protocol.md#trajectory
//
// STREAMS:    normal — tick() commits the active stream's target.
// TRAJECTORY: the trajectory engine drives the DAC via drive(); tick() and
//             schedules leave it alone (CMD_STREAM UPDATE / CMD_SCHEDULE are
//             REJected by the handlers).
// HOLD:       after a trajectory STOP — the mirror holds the last driven
//             position until a fresh stream write (UPDATE, CREATE taking the
//             DAC, an applied keyframe, activate()) reclaims it.
// snapshot() reports the driven position whenever the owner is not STREAMS,
// so Capture's exposure latches see what the DAC actually holds.
enum class Owner : uint8_t { STREAMS, TRAJECTORY, HOLD };

Owner owner();
// Trajectory takes the DAC (pending stream writes are discarded; the next
// drive() always writes — and nothing else does: a pending touch() is dropped,
// and one landing after claim() is left for that first drive() instead of
// being re-committed by tick(), so the previous run's position is never
// re-driven before phase 0). The drive position starts as the DAC's last
// written value, so a release() before the first drive() holds where the
// mirror actually is.
void claim();
// Writes `left`/`right` to the DAC if they changed (or a touch() is pending).
// No-op unless owner() == TRAJECTORY.
void drive(const MirrorPosition &left, const MirrorPosition &right);
// Trajectory STOP: TRAJECTORY -> HOLD (no-op otherwise).
void release();
// Command::Actuate wrote the DAC directly (never while a trajectory runs):
// records it as the DAC's last written value and, under HOLD, makes it the
// hold position (a MEMS recovery's touch() and snapshot() then use it instead
// of snapping back to the trajectory's last position).
void noteActuate(const MirrorPosition &left, const MirrorPosition &right);

} // namespace Streams
