# Manage Cameras

Manage Cameras is the utility where you set up the rig's cameras: see what is connected, assign each camera its role (left fovea, wide-angle center, or right fovea), and tune its exposure, gain, frame rate, and pixel format. Settings you change here are saved per camera and reused by every other app, so this is normally the first place you visit after connecting hardware.

**Prerequisites:** the cameras connected and powered. No calibration or MEMS controller is needed.

## What you see

Open **Manage Cameras** from the Welcome launcher (Utilities) or the **Apps** menu. The window shows one column per connected camera, side by side. Each column has a live preview at the top and, below it, the camera's controls in compact groups: each group is a small uppercase header row with the group's name on the left and its mode dropdown (or selector) on the right, and the group's slider directly below — no boxes around anything.

If a camera is listed but held by another process, the app shows an error — **Camera <serial> is in use by another process.** Make sure no other app or tool is holding that camera, then reopen Manage Cameras to rescan.

Each slider has a live readout on its right, and the slider is disabled (dimmed) whenever the corresponding "auto" mode is on, so you always edit the value that is actually in effect. While you drag, the knob follows your hand; the readout settles on the value the camera actually applied (the camera may clamp or quantize slightly).

**Click-to-type.** On any manual slider, click the readout value itself: it turns into a small input in the same spot. Type an exact number in the readout's units (FPS, ms, or dB) and press **Enter** (or click away) to apply; **Esc** cancels.

**Snap points.** Some sliders show small tick marks at their edges. While dragging with the mouse, the knob snaps exactly onto a tick when you get close (within about 0.5% of the slider's width); keyboard arrows are never snapped, so you can still fine-step past a tick.

## Controls

Every camera column offers the following, from top to bottom. Sliders that a given camera does not support are simply hidden.

### Role

The **Role** dropdown (in the group's header row) tells the rest of the app what this camera is:

- **[ NONE ]** — unassigned.
- **Fovea Left** — the left fovea camera.
- **Wide Angle** — the center, wide-angle camera.
- **Fovea Right** — the right fovea camera.

Roles are how the stereo and tracking apps know which camera is which, so assign them before using those apps.

### Fovea Pair

The moment one camera holds **Fovea Left** and another holds **Fovea Right**, the two are **linked** and a shared **Fovea Pair** panel appears as the first column. The left and right fovea cameras are hardware-triggered together — one trigger pulse exposes both — so their imaging settings must match; the pair panel makes that structural instead of something you maintain by hand:

- **One set of controls for both cameras.** Exposure, Gain, Black Level (with their auto modes), and Pixel Format move to the pair panel; every edit there is applied to **both** cameras together and saved into **both** cameras' configurations (there is no separate "pair" config — each camera's saved config stays complete on its own, so calibration and the other apps read exactly what they always did).
- **The L/R columns collapse.** While linked, each fovea camera's own column shows its live preview, its **Role** dropdown, and read-only value rows. **Changing either camera's Role is how you unlink** — set it to [ NONE ] (or another role) and the full per-camera controls come back.
- **Frame Rate is not part of the pair panel.** A per-camera frame-rate setting is meaningless for a hardware-triggered camera — the trigger decides when frames happen. The linked columns still show the current readout.
- **One camera per role.** If two cameras claim the same fovea role, the link cannot form — a warning above the columns says which role is duplicated; fix the Roles and the pair panel appears.

**If the two configs differ when the link forms**, the pair panel does not guess: it lists what differs and asks — **Use Left's** or **Use Right's**. Nothing is overwritten until you choose; picking a side copies that camera's exposure/gain/black-level/pixel-format settings onto the other, after which the shared controls appear.

**Trigger Budget.** At the bottom of the pair panel, a readout row shows what the current exposure settings imply for the trigger: **"Max trigger rate ≈ N Hz (exposure X ms + margins)"** — or "readout floor X ms" when the camera's readout, not the exposure, is what binds the rate. The trigger pulse must cover the slower eye's exposure, and the interval between triggers adds the camera-reported readout floor plus a small fixed overhead margin (hover the row for the exact terms). The tracking apps derive their trigger pulse and pacing from these same settings — exposure is authoritative; lengthen the pair's exposure and the achievable trigger rate drops accordingly. The per-triple settle hold ([Settings](./settings.md#per-triple-settings)) adds on top when a tracking app drives the trigger.

**Trigger.** A **test** button and a verdict readout. Pressing **test** fires two real triggers on **both** fovea cameras and checks a frame actually arrives from each: first a **software** trigger (which exercises the camera → frame path with no wiring involved), then — if a controller is connected — one **hardware** pulse through the trigger cabling (the controller drives each camera's trigger input, camera **Line3**, through its GPIO cable). If one camera holds the **Wide Angle** role, the test checks the center camera the same way: the controller board cables its trigger too. It briefly pauses the previews and restores free-run afterwards. Read the verdict:

- **untested** — the test has not run this session.
- **OK · sw+hw trigger** — every tested camera produced a frame from both a software and a hardware trigger; the trigger **input** chain is healthy (MCU → trigger line → exposure → frame). The readout ends in **· L R C** when the center camera was tested too. The strobe-return line (camera **Line2** back to the controller) is only proven by a live trigger-sync engage.
- **OK · sw trigger** — software passed on every tested camera, but no controller was connected so the hardware leg was skipped.
- **L: camera** / **R: camera** / **C: camera** — that camera produced no frame even from a software trigger: the fault is the camera or its stream path, not the wiring.
- **L: wiring** / **R: wiring** / **C: wiring** — software passed but the hardware pulse produced no frame: the MCU pulse is not reaching that camera. Check that camera's GPIO cable and its `J_CAM` socket on the controller board (see [The rig](../hardware/rig.md#cameras)).
- **L: no probe** / **R: no probe** / **C: no probe** — the test could not observe that camera's frames (its pipe is parked); not a failure — re-run with the preview open.

This is the same fault the tracking apps trip automatically at engage (see [Disparity Scope](./disparity-scope.md)); run it here first when a synced-capture session refuses to engage.

### Pixel Format

When a camera exposes format options, the **Pixel Format** dropdown lets you choose its sensor readout format. Changing format briefly pauses the preview to reconfigure the camera, and 12-bit packed formats (for example `BayerRG12p`) read full sensor depth to cut debayer quantization noise (hover the dropdown for these terms). The dropdown is momentarily disabled while the switch is applied.

### Frame Rate

The **Frame Rate** group has a mode dropdown — **Manual** or **Auto** — and a slider. In **Manual** mode the slider sets the frame rate (with the live value shown beside it); in **Auto** the camera free-runs and the slider is disabled.

The slider carries snap ticks at **50, 60, 100, and 120 FPS** (those within the camera's range), so the common video and anti-flicker rates land exactly.

### Exposure

The **Exposure** group has a mode dropdown — **Manual**, **Auto (once)**, or **Auto (cont.)** — and a logarithmic slider (readout in ms). The slider is active only in **Manual**; the two auto modes let the camera set exposure itself (once, or continuously).

Snap ticks sit at the anti-flicker exposures — **1/50 s (20 ms), 1/60 s (≈16.67 ms), 1/100 s (10 ms), 1/120 s (≈8.33 ms)** — and at each round decade (0.1 ms, 1 ms, 10 ms, …) inside the camera's range. Exposing for exactly one mains half-period is what kills the rolling brightness bands under 50/60 Hz artificial light, and the ticks make those values land precisely. Click-to-type takes the value in **milliseconds**.

### Gain

The **Gain** group works the same way: **Manual** / **Auto (once)** / **Auto (cont.)** and a slider (in dB), active only in **Manual**.

### Black Level

Where supported, the **Black Level** group offers the same **Manual** / **Auto (once)** / **Auto (cont.)** modes and a slider.

### Reset Config

The red-outlined **Reset Config** button at the bottom of the column returns the camera to automatic defaults — frame rate back to auto, each auto control set to run once, the role cleared — and erases that camera's saved configuration. It lives only on the full per-camera panel, so to reset a linked fovea camera, unlink first (change its Role), reset, then re-assign the role.

## Typical tasks

### To identify which physical camera is which

1. Open **Manage Cameras**.
2. Watch the previews and, if needed, wave your hand or point at each camera in turn to see which column updates.
3. Note the serial and description shown on each preview.

### To assign camera roles

1. In each camera's column, open the **Role** dropdown.
2. Choose **Fovea Left**, **Wide Angle**, or **Fovea Right** to match the physical camera.
3. Give the remaining cameras their roles. The choice is saved immediately and reused by the other apps.

Assigning both fovea roles links the two cameras into the [Fovea Pair](#fovea-pair) — if their settings differ at that moment, the pair panel asks which camera's settings to keep before anything is shared.

### To tune the fovea pair

1. Assign **Fovea Left** and **Fovea Right** so the **Fovea Pair** panel appears.
2. If prompted that the configs differ, pick **Use Left's** or **Use Right's**.
3. Edit **Exposure**, **Gain**, **Black Level**, or **Pixel Format** in the pair panel — both cameras follow together, and both linked columns' readouts confirm it.
4. Check the **Trigger Budget** row: it shows the maximum trigger rate the chosen exposure allows.

### To tune exposure, gain, or frame rate

1. Set the group's mode dropdown to **Manual**.
2. Drag the slider until the preview and readout look right, or click the readout and type an exact value.
3. Repeat for other controls. Values are saved as you change them.

### To eliminate light flicker

1. Set **Exposure** to **Manual**.
2. Drag the slider onto the tick matching your mains frequency: **20 ms (1/50 s)** or **16.67 ms (1/60 s)** for full rejection, **10 ms (1/100 s)** or **8.33 ms (1/120 s)** if you need a shorter exposure. The knob snaps onto the tick exactly.
3. If the frame rate also beats against the lighting, set **Frame Rate** to **Manual** and snap it to 50/60/100/120 FPS.

### To read full sensor bit depth

1. Open the **Pixel Format** dropdown.
2. Choose a 12-bit packed format (for example `BayerRG12p`).
3. Wait for the preview to resume after the brief reconfigure pause.

### To start a camera over

Click **Reset Config** in that camera's column to clear its role and return every control to auto defaults.

## Notes

- Changes here persist and are shared across all apps — you do not need to re-tune a camera each time you switch apps.
- There is no Record or Capture in this utility; the title-bar Record and Capture buttons stay disabled.

> **Data management (`manage-data`).** A `manage-data` module exists in the codebase but is an empty stub — it is not in the app launcher, the **Apps** menu, or any menu, and has no working screens. There is currently no in-app data-management view; recordings are opened through **File ▸ Open Recording…** (see [Getting Started](./getting-started.md#opening-a-recording) and [Viewer](./viewer.md)).
