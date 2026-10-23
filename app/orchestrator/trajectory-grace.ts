// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The retired-table GRACE rule for uploaded trajectories, shared by the
// controller (`controller.ts`, which keeps a retired id routed and
// unallocatable for that long) and the controller node (`controller-node.ts`,
// which scores the retired table's straggler pushes against its own spec).
// Pure and dependency-free so the node never loads the serial device module.
// spec: docs/spec/controller.md#trajectory-ownership

/** The firmware's strobe-timeout margin over a marker's pulse
 *  (firmware/src/Capture.cpp `STROBE_MARGIN_US`): a marker capture finishes —
 *  and pushes — at the latest `pulse + margin` after its trigger edge. */
export const TRAJECTORY_STROBE_MARGIN_US = 5_000;
/** Host-side slack on top of that (serial + event-loop latency of the push). */
export const TRAJECTORY_GRACE_SLACK_US = 50_000;

/** How long a retired table id stays routed (and unallocatable) after a swap
 *  or dispose: a marker capture already in flight when the table stopped
 *  playing still finishes and pushes with the OLD id, at the latest
 *  `max(marker pulse) + STROBE_MARGIN_US` after its trigger, plus slack.
 *  0 for a spec without markers (nothing can be in flight). */
export function trajectoryGraceUs(spec: {
  markers?: ReadonlyArray<{ pulseUs: number }>;
}): number {
  const markers = spec.markers ?? [];
  if (markers.length === 0) return 0;
  const maxPulse = Math.max(...markers.map((m) => m.pulseUs));
  return maxPulse + TRAJECTORY_STROBE_MARGIN_US + TRAJECTORY_GRACE_SLACK_US;
}
