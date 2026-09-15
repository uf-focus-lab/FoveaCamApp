// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Session-owned ORBIT brick seam: the native circular-scan generator
// (`Aravis.createOrbitStream`) on its own 1 kHz thread, whose `volt_out` pipes
// straight into the controller's native `pos_in`. Seam-injected (never imports
// core at runtime) so a session unit-tests without the native addon.
// spec: docs/spec/core-streams.md#orbit-stream

import type { MirrorVolts, OutPort } from "core/types";
import type { ProbeSnapshot } from "core/Pipe";
import type { Pos } from "@lib/controller-codec";

/** The linearization of the angle→volt chain around the scan center: the
 *  commanded pose is `center + J · offset`. `jL`/`jR` are row-major 2×2
 *  volts-per-radian `[dVx/dox, dVx/doy, dVy/dox, dVy/doy]` — the session owns
 *  the calibration, the brick only ever applies this affine map. */
export interface OrbitPose {
  centerL: Pos;
  centerR: Pos;
  jL: number[];
  jR: number[];
}

/** Ring radius (radians in the wide angular frame), revolutions per second,
 *  and whether the scan is running. */
export interface OrbitParams {
  ampRad: number;
  hz: number;
  enabled: boolean;
}

export interface OrbitHandle {
  /** Push the center + Jacobian (steer, verge, shift, baseline, servo step).
   *  The first pose lands on the center directly; later ones are slewed. */
  setPose(pose: OrbitPose): void;
  /** Push the orbit parameters (scan start/stop, live amplitude/frequency). */
  setOrbit(params: OrbitParams): void;
  /** The brick's thread meter (inputs pose/orbit, output volt). */
  probe(): ProbeSnapshot;
  /** Typed final-volts OUT port — pipe it into the controller's `pos_in`. */
  readonly volt_out: OutPort<MirrorVolts>;
  /** Stop the paced thread and eject the subscribers. Idempotent. */
  release(): void;
}

export interface OrbitSeam {
  /** `name` is the graph node id AND the brick's meter name. */
  create(name: string): OrbitHandle;
}
