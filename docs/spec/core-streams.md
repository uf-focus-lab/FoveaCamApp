# core Stream / Subscriber lifetime

Behavior spec for `core/lib/Stream/Stream.h` (`Stream<T>` publisher +
`Subscriber<T>`). These are the teardown-safety rules that prevent a family of
reintroduction bugs — the code carries `// spec:` pointers back to the anchors
below. Nothing here is aspirational; every rule prevents a specific crash/hang.

`Stream<T>` runs one producer thread that fans a payload out to N subscribers
under `mutex`. `Shared<Stream>` is intentionally unsupported (add it in a derived
class if ever needed). A subscriber can be ejected from BOTH ends: the stream
pops all subscribers on crash/terminate; a subscriber pops only itself when
destructed from the subscribing end.

## lost-wakeup {#lost-wakeup}

`shutdown()` sets `flag_terminate` UNDER `mutex`, then `notify_all`.
`wait_activate()` evaluates its predicate (which reads `flag_terminate`) while
holding `mutex` and then atomically unlocks+sleeps in `unfreeze.wait()`. If the
flag were flipped + notified WITHOUT the mutex, the notify
could land in the gap after the parking thread read the flag as false but before
it blocked — a lost wakeup: the producer sleeps forever and the `thread.join()`
hangs, the orchestrator never exits, and hardware stays armed. A hung teardown
violates the quiescence invariant as badly as an aborted one. Flipping the flag
under `mutex` serializes against the predicate check, so the `notify_all` is
never lost.

## eject-and-drain {#eject-and-drain}

The destroyed-mutex race. After `shutdown()` joins
the producer thread, THIS stream's own thread can never touch `mutex` /
`subscribers` again. What remains is a cross-thread `Subscriber::close()` racing
our destruction: on a CLEAN shutdown (unlike `crash()`), without ejection the base
would leave every subscriber's back-pointer intact — so a subscriber destroyed AFTER us
would `close() -> unsubscribe()` and lock a freed `mutex`. `eject_all_and_drain()`
closes this in two moves, both BEFORE `~Stream` frees `mutex`:

1. **eject** — null every still-attached subscriber's back-pointer (via
   `detach()`, under the stream `mutex` and each subscriber's state guard) so any
   LATER `close()` sees a dead stream and skips `unsubscribe()`.
2. **drain** — spin-wait (`yield`) until `closes_in_flight_` reaches 0, i.e. any
   `close()` already past its null-check and in flight toward `unsubscribe()` has
   finished touching `mutex`.

Idempotent (a re-entry finds an empty set and a zero counter); teardown path
only, never hot. Lock order matches the publisher fan-out (stream `mutex` FIRST,
then each subscriber's state guard via `detach()`) — never the reverse — so it
cannot deadlock against `Subscriber::close`, which takes ONLY the state guard,
then an atomic, then releases before reaching for `mutex`.

`closes_in_flight_` counts `Subscriber::close(unsubscribe=true)` calls that have
captured a LIVE pointer to this stream (under the subscriber's state guard) and
are in flight toward `unsubscribe()`. The increment lands while the pointer is
provably live (see [lifetime-order](#lifetime-order)); the decrement follows
`unsubscribe()`. It is never contended on the hot path.

## lock-order {#lock-order}

`Subscriber::close()` must NOT hold the state guard across the call into
`Stream::unsubscribe` (which takes the stream `mutex`). The publisher fan-out in
`Stream::loop()` holds the stream `mutex` first, then takes each subscriber's
state guard — so holding the state guard while reaching for the stream mutex is
the opposite order and deadlocks. Therefore: freeze the state under the guard
(capture + null the stream pointer, set the error), RELEASE the guard, and only then
`unsubscribe`. This reorder is safe:

1. `push()` is still never called on a closed subscriber: the fan-out checks
   `ref->isActive()` under the state guard, and once the stream is nulled (under
   that same guard) a concurrent fan-out skips this sub.
2. No use-after-free: `unsubscribe()` blocks on the stream mutex, which the
   fan-out holds for its entire iteration; so this subscriber cannot be erased
   (and `~Subscriber` cannot complete) while the loop might still dereference it.
3. Double-close stays idempotent: a second call sees `stream == nullptr` and
   returns early.
4. Derived overrides (`Sub::Queue` / `Sub::Latest` / `TapPublisher` /
   `RecordSink`) call this base FIRST, then drain on a *different* guard — they
   only rely on the state being frozen (stream nulled + error set) before return.

Calls originating from Stream itself pass `unsubscribe = false` (they already
hold the stream mutex / are erasing us directly), so they never reach the
unsubscribe path regardless.

## lifetime-order {#lifetime-order}

The destroyed-mutex race, subscriber side. The
[lock-order](#lock-order) reorder releases the state guard before locking
`stream->mutex`, so nothing intrinsically keeps `stream` ALIVE across the
`unsubscribe()` call — a concurrent `~Stream` (owning brick teardown) could free
`stream->mutex` in that gap, and `unsubscribe()` would then lock a destroyed
mutex (macOS libc++ `std::mutex` reports EINVAL → `std::system_error` thrown from
a `noexcept ~Subscriber` → `std::terminate`). Closed by pairing with
[eject-and-drain](#eject-and-drain):

- Before `~Stream` frees `mutex`, `shutdown()` nulls EVERY subscriber's
  back-pointer under that subscriber's OWN state guard. So the only way to
  observe `ref->stream != nullptr` while holding the state guard is that the
  eject has NOT yet processed us — which (because it needs this same guard) means
  it is blocked behind us and cannot have advanced to free the stream. Therefore
  `stream` is provably ALIVE at the `closes_in_flight_` increment.
- We bump `closes_in_flight_` WHILE STILL HOLDING the state guard (a plain
  atomic — no lock, so the lock order is untouched). The
  [eject-and-drain](#eject-and-drain) drain refuses to return (and thus `~Stream`
  refuses to free `mutex`) until this count is 0, i.e. until our `unsubscribe()`
  and its matching decrement have completed. A `close()` that arrives AFTER the
  eject sees `stream == nullptr` at the guard and never increments.

## assert-shutdown {#assert-shutdown}

`~Stream` aborts if the producer thread is still joinable: the thread may call
into derived-class virtuals, so derived destructors MUST call `shutdown()` before
their own members are destroyed. Checked at the base to avoid hard-to-debug UAF.

## OrbitStream {#orbit-stream}

Source: `core/src/OrbitStream.cpp`, exported as `Aravis.createOrbitStream(name)`. The
mirror-link circular scan as a native brick: a `Stream<VoltPair::Ptr>` producer on its own
PACED thread, so no stall on the orchestrator's JS event loop (a synchronous camera write,
an allocation) can hold the mirrors mid-revolution.

Per eye, per tick:

```
v = slew(center) + J · amp · (cos φ, sin φ)
φ += 2π · hz · dt
```

- **Pacing.** 1 kHz, `condition_variable::wait_until` on the steady clock (never a busy
  spin; `close()` wakes it, so teardown never waits out a period). `dt` is MEASURED, so a
  late tick lands at the correct phase rather than accumulating drift — the JS pacer's
  wall-clock rule, natively. The 1 kHz is NOMINAL: wake latency puts the realized rate
  around 900 Hz, which is deliberately left alone — the phase accumulates with the measured
  `dt`, so the GEOMETRY does not depend on the rate, and the wire's own stream-update gate
  is 1 ms anyway. `setOrbit`'s `paceHz` (default 1000, clamped 200–1000) retunes the tick
  rate live for a link that cannot carry 1 kHz.
- **Guarded state.** The NAPI thread writes the pose (`setPose`: per-eye center volts +
  `jL`/`jR`, row-major 2×2 volts-per-radian) and the orbit params (`setOrbit`: `ampRad`,
  `hz`, `enabled`) under a `Threading::Guard`; the brick thread advances the slewed center
  and the phase under the same guard.
- **Phase.** Accumulates with the measured `dt` and is continuous across live `hz`/`amp`
  changes; it restarts at 0 only on a disabled→enabled transition.
- **Center slew.** First-order toward the latest pushed center, τ = 8 ms with a 5 mV
  epsilon snap — the `@lib/slew` constants, ported so idle behavior is unchanged. The orbit
  OFFSET is never slewed: a smoothed offset would lag the phase and shrink the ring. The
  FIRST pose after `setPose` lands on the center directly (no swoop from the origin).
- **Going quiet.** While enabled the brick emits every tick. While disabled it emits only
  while the slew still moves the pose — the epsilon snap makes a settled center
  bit-identical tick over tick — then `iterate()` returns `nullptr` and the brick is
  silent. It has already slept out the tick by then, so the base loop's `yield()` path is
  not a spin.
- **Thread QoS.** `start()` requests `QOS_CLASS_USER_INTERACTIVE` on macOS: this thread is
  the mirrors' clock, and a nap-eligible child process otherwise lets the OS coalesce
  timers, stretching a 1 ms wait toward ~16 ms — the pose rate collapses and the ring
  degenerates into a polygon.
- **Ports.** `volt_out` (tag `"volts"`, payload `VoltPair::Ptr`) pipes into the
  controller's native `pos_in`; `[Symbol.asyncIterator]` is the JS fallback consumer.
  `probe()` returns the thread meter (inputs `pose`/`orbit`, output `volt`).
- **Teardown.** `release()` → `close()`: idempotent, wakes the pacer and JOINS the thread
  BEFORE the stream ejects its subscribers ([eject-and-drain](#eject-and-drain)), which
  also runs from the CoreObject `destruct` hook so a live port link pinning the brick
  cannot leave the thread running. Guarded by `core/test/53-orbit-stream.ts`.

## FlipStream {#flip-stream}

Source: `core/lib/Aravis/FlipStream.{h,cpp}`, exported as `Aravis.attachFlipPipe` /
`pushFlipAnchor` / `flipProbe` / `flipProbeAll` / `detachFlipPipe`; the app drives it
through `app/orchestrator/flip-pipe.ts` (`FlipPipeSeam`, injected into the mirror-link
session). The MirrorLink triangle scan exposes one frame on the rising sweep and one on
the falling sweep; the falling-sweep frame reaches every consumer (views, ring reader)
VERTICALLY flipped. The brick is a pass-through copy of a source pipe (a fovea `convert`
pipe in production; any convert / undistort / fovea / scale pipe resolves) that flips the
frames matched to an anchor marked `flip`.

- **Chained brick.** A `ChainedStream` modelled on `ScaleStream`: Leaky/latest-wins
  `OwnedFrame` tap, demand propagation (it runs iff its pipe has consumers; while running
  it keeps the upstream chain awake), a max-bound gated `PipeOfferSubscriber`, the reused
  output buffer released on park. Advertise the flip pipe with the SOURCE pipe's own spec
  (same format, dims, footprint) BEFORE attaching — an unknown pipe throws. Re-attaching a
  live id replaces the brick: the old gated subscriber is reset (off the ring) before the
  new gate is registered, so two producers never write one sink; the old brick is joined
  after that, outside the registry lock.
- **Options.** `attachFlipPipe(sourcePipeId, pipeId, { toleranceNs, anchorCap?,
  anchorFrom? })`: `toleranceNs` MUST be a bigint ≥ 0 (a Number throws — the generic
  int64 conversion would truncate it to int32); `anchorCap` an integer (default 16,
  clamped to [1, 1024]; a non-integer throws); `anchorFrom` the graph node id the anchors
  come from (the controller's trajectory node).
- **Product.** Matched-`flip` frame: `cv::flip(src, dst, 0)` (rows reversed) into the
  reused buffer. Any other frame: passed through by header — the output `cv::Mat` shares
  the input's reference-counted buffer (a deep copy made for this brick's tap alone,
  never written again), so the pixels live as long as any holder keeps the header and no
  second copy is made. Pixel format, dims and stride are the source's;
  `deviceTimestamp`/`systemTimestamp`, the crop origin and the upstream `convertMs` are
  forwarded unchanged — the trusted-time invariant, and the v4 slot header reads as the
  source pipe's would.
- **Anchors.** `pushFlipAnchor(pipeId, { tStart, tEnd, flip })` at FIN rate, one per OK
  marker push: `tStart` = the push's `tExposure` (the strobe-rise latch), `tEnd` =
  `tStart` + the marker's pulse, `flip: marker === 1`. Both are bigints (a Number throws)
  in the owner-applied trusted host-ns domain, the same domain as a frame's
  `deviceTimestamp`; `tEnd < tStart` throws. They go into a mutex-guarded bounded pool
  (`anchorCap`, drop-oldest; evictions counted as `anchorDrops`).
- **Matching rule (two edges).** Which instant the camera stamps a frame with — exposure
  start or end — is not documented for the Blackfly S here, so the brick does not assume
  it. PairStream's root rule (`matchesFrame`, no side delta) runs over BOTH edges of every
  pooled anchor, narrowed to the nearest: an edge is a candidate iff
  `|int64(frame.deviceTimestamp) − edge| <= toleranceNs` (two-sided, inclusive; the
  difference is computed in unsigned arithmetic, so no input can overflow it); the
  smallest difference wins, ties going to the older anchor (and, within one anchor, to
  `tStart`). The frame flips iff a winner exists and its anchor is marked `flip`; with no
  candidate it passes through unflipped and counts `unmatched`. Frames arrive in
  timestamp order, so after each frame the pool sheds every anchor whose BOTH edges are
  older than the winner's matched edge (no later frame can be nearer to them than to that
  edge) or, with no winner, every anchor with `tEnd < ts − toleranceNs`.
- **Late anchors.** Matching happens once, when the brick processes the frame. A frame
  processed before its anchor was pushed (the FIN push lost the race with the frame)
  passes through UNFLIPPED and counts `unmatched`; the anchor arriving afterwards is
  pruned by a later frame. The session pushes the anchor synchronously on the FIN, which
  precedes the frame's arrival in practice; a rising `unmatched` share is the symptom
  when it does not.
- **Tolerance (as the session computes it).** `toleranceNs = 0.4 · min(T, closest marker
  spacing)`, where `T` is the sweep time (half the triangle's 2T period) and the marker
  spacing is taken circularly over the period (`session.ts` `flipTolerance`), floored at
  1 ms for clock alignment (`docs/spec/mirror-link-scan-patterns.md`, review round 1);
  when that floor exceeds 0.45 × the closest marker spacing the windows are too close to
  flip reliably at that frequency and the scan reports `mismatch`. Bounding by the
  marker spacing keeps a frame whose own anchor is late from matching the neighbouring
  marker.
- **Counters.** `flipProbe(pipeId)` returns the thread meter (input `frame`, output
  `flip`) plus `frames`, `flipped`, `unmatched`, `anchorPoolSize`, `anchorDrops`,
  `toleranceNs` and `matchedSkewNs`, or `null` for an unknown pipe; `flipProbeAll()`
  returns the same rows keyed by pipe id for the perf/workload fold. EVERY field is a
  plain Number (`toleranceNs` included — it is far below 2^53): the `flipProbeAll` rows
  land in the perf snapshot's workloads, which the orchestrator client JSON-stringifies,
  and a BigInt would throw there. `matchedSkewNs` is the mean signed (frame stamp −
  matched edge) over the frames matched since the last `flipProbe` — `flipProbe` resets
  the window, `flipProbeAll` only peeks, so the 1 Hz perf fold never steals the session's
  window; 0 when nothing matched. It tells the bench which edge the camera stamps
  (≈ 0 against `tStart` or `tEnd`, the other edge one pulse away) and feeds
  `perf.trajectory.skew_us`. `anchorDrops` climbs harmlessly while the brick is parked
  (no consumer → no frames → nothing prunes) or while frames never match (e.g. the
  owner's clock is not yet calibrated): the pool simply keeps the newest `anchorCap`.
- **Topology.** `Topology.report()` shows a kind `"flip"` row with a `frame` input edge
  from the source pipe and, when `anchorFrom` was given, an `anchor` input edge from that
  node (type `{ kind: "analysis", schema: "trajectory" }`). The native row replaces a
  session-registered row of the same id (`graph-topology.ts` `mergeReportLayers`), so the
  session need not register its own node row for the flip pipes.
- **Teardown.** `detachFlipPipe` unregisters the consumer gate FIRST, then drops the
  binding outside the registry lock (unsubscribe, then the brick's `closeChain()` +
  `shutdown()` join), idempotent (`false` when unknown). JS retires a flip node detach
  then unadvertise (`FlipHandle.retire`). Guarded by `core/test/54-flip-stream.ts`.
- **Build.** `core/CMakeLists.txt` collects sources with `file(GLOB …)`, so an EXISTING
  CMake build directory does not see `FlipStream.cpp` until it is reconfigured (re-run
  `cmake` on it, or delete the cache); without that the addon fails to link or load
  with the flip exports unresolved.
