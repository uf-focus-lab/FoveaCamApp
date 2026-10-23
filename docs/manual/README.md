# User Manual

The operator's guide to FoveaCam Duo — what each screen does, how to run the
rig day to day, and what to do when something looks wrong. Chapters narrate the
app as you see it; for the engineering view of the same features, see the
[architecture](../architecture/README.md) overview and the
[behavior specs](../spec/README.md).

Read in this order the first time:

1. **[Getting Started](./getting-started.md)** — launching, the Welcome
   launcher, the chrome every window shares (progress overlay, record/capture
   buttons, crash banner, menus), switching apps, and quitting.
2. **[Manage Cameras](./manage-cameras.md)** — connect the cameras, assign the
   Left / Wide Angle / Right roles, and tune exposure, gain, frame rate, and
   pixel format. Do this before anything else.
3. **[Single Capture](./single-capture.md)** — a bare live view of one camera,
   for checking streams and framing.
4. **[Calibration](./calibration.md)** — the workflow overview: run
   [Intrinsic](./calibrate-intrinsic.md) →
   [Extrinsic](./calibrate-extrinsic.md) → verify with the
   [Distortion check](./calibrate-distortion.md) → keep fresh with
   [Drift](./calibrate-drift.md). The overview chapter has the
   needs/produces/redo-when table.
5. **The working apps** — [Manual Control](./manual-control.md) (open-loop
   steering bench), [Tracking - Multi](./multi-fovea.md) (multiple tracked
   targets), [Disparity Scope](./disparity-scope.md) (closed-loop vergence
   with PID tuning and a match debugger), and [MirrorLink](./mirror-link.md)
   (ellipse / line / triangle fovea scans with triggered exposure windows).
6. **[Recording and Capture](./recording-and-capture.md)** — record any app's
   session to a `.fcap` file or grab full-depth stills, from every app's title
   bar.
7. **[Viewer](./viewer.md)** — play back `.fcap` recordings on a multi-track
   timeline, standalone (no cameras or running rig needed).
8. **[Settings](./settings.md)** — app-wide preferences (save directory,
   TeleCanvas, marker geometry) and the stored-calibration-data manager;
   open with `Cmd/Ctrl-,` from anywhere.

## Quick reference

| I want to… | Go to |
|---|---|
| Set up cameras on a fresh rig | [Manage Cameras](./manage-cameras.md), then [Calibration](./calibration.md) |
| Start-of-session touch-up | [Drift](./calibrate-drift.md) |
| Check whether calibration is still good | [Distortion check](./calibrate-distortion.md) |
| Point the foveas by hand | [Manual Control](./manual-control.md) |
| Track several targets | [Tracking - Multi](./multi-fovea.md) |
| Tune the vergence loop | [Disparity Scope](./disparity-scope.md) |
| Read a blinking light source | [MirrorLink](./mirror-link.md) |
| Record a session / save a still | [Recording and Capture](./recording-and-capture.md) |
| Review a recording | [Viewer](./viewer.md) (`Cmd/Ctrl-O` from anywhere) |
| Change preferences / manage calibration data | [Settings](./settings.md) (`Cmd/Ctrl-,` from anywhere) |
