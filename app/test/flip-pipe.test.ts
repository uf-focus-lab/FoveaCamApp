// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `flip-pipe`: the session-owned FLIP node helper, unit-tested over an
// injected fake seam (never loads native core / the pipe session). It
// advertises the flip pipe with the SOURCE pipe's spec (only the id changes)
// BEFORE attaching the brick chained on the source pipe id, un-advertises
// again when the attach throws (never an advertised pipe with no producer),
// and retires as detach + un-advertise.

import { describe, expect, it, vi } from "vitest";
import {
  createFlipPipe,
  type FlipPipeOptions,
  type FlipPipeSeam,
} from "@orchestrator/flip-pipe";
import type { PipeSpec } from "@lib/orchestrator/pipe-contract";

const SOURCE: PipeSpec = {
  id: "camera/SN42/convert",
  pixelFormat: "Mono8",
  dtype: "U8",
  width: 4,
  height: 3,
  channels: 1,
  stride: 4,
  bytesPerFrame: 12,
} as PipeSpec;

const OPTS: FlipPipeOptions = { toleranceNs: 1_000_000n, anchorFrom: "traj" };

function fakeSeam() {
  const calls: string[] = [];
  const seam: FlipPipeSeam = {
    advertise: vi.fn(
      (spec: PipeSpec) => (calls.push(`advertise:${spec.id}`), 1),
    ),
    unadvertise: vi.fn((id: string) => void calls.push(`unadvertise:${id}`)),
    attach: vi.fn(
      (src: string, id: string) => void calls.push(`attach:${src}->${id}`),
    ),
    pushAnchor: vi.fn(),
    probe: vi.fn(() => null),
    detach: vi.fn((id: string) => void calls.push(`detach:${id}`)),
  };
  return { seam, calls };
}

describe("createFlipPipe", () => {
  it("advertises the source spec under the flip id, then attaches chained on the source", () => {
    const { seam, calls } = fakeSeam();
    const h = createFlipPipe(seam, SOURCE.id, SOURCE, "camera/SN42/flip", OPTS);
    expect(calls).toEqual([
      "advertise:camera/SN42/flip",
      "attach:camera/SN42/convert->camera/SN42/flip",
    ]);
    expect(seam.advertise).toHaveBeenCalledWith({
      ...SOURCE,
      id: "camera/SN42/flip",
    });
    expect(seam.attach).toHaveBeenCalledWith(
      SOURCE.id,
      "camera/SN42/flip",
      OPTS,
    );
    const anchor = { tStart: 1n, tEnd: 2n, flip: true };
    h.pushAnchor(anchor);
    expect(seam.pushAnchor).toHaveBeenCalledWith("camera/SN42/flip", anchor);
    h.retire();
    expect(calls.slice(-2)).toEqual([
      "detach:camera/SN42/flip",
      "unadvertise:camera/SN42/flip",
    ]);
  });

  it("un-advertises and rethrows when the attach fails", () => {
    const { seam, calls } = fakeSeam();
    vi.mocked(seam.attach).mockImplementation(() => {
      calls.push("attach");
      throw new Error("no such source pipe");
    });
    expect(() =>
      createFlipPipe(seam, SOURCE.id, SOURCE, "camera/SN42/flip", OPTS),
    ).toThrow("no such source pipe");
    expect(calls).toEqual([
      "advertise:camera/SN42/flip",
      "attach",
      "unadvertise:camera/SN42/flip",
    ]);
    expect(seam.detach).not.toHaveBeenCalled();
  });
});
