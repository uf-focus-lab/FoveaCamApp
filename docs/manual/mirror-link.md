# MirrorLink

MirrorLink points both fovea mirrors at one spot and then spins them in a small
circle around it, fast, while each fovea camera takes exactly one frame per
revolution. A light source that blinks on and off at its own rate therefore
paints a **dashed ring** in every fovea frame: the gaps in the ring are the
source's off-periods, so the ring itself is the decoded signal. Use it to read a
free-running optical transmitter, or simply to see a blink pattern you cannot
resolve frame by frame.

**Prerequisites:** a full calibration present (see [Calibration](./calibration.md))
and all three cameras connected (see [Manage Cameras](./manage-cameras.md)). On
an uncalibrated rig the views still show live frames, but steering does nothing
and the center view falls back to the raw, distorted image.

## The layout

Three live columns sit across the top:

- **Left Fovea** (cyan) — the left fovea view with a voltage bar beneath it. The
  view is the raw camera image, deliberately *not* straightened: a frame that
  integrates a whole revolution has no single mirror position to straighten it
  against, and the un-straightened ring is what you are here to read. The
  voltage bar traces the circle live while the scan runs.
- **Center Wide** (orange) — the wide view you steer on. It carries a crosshair
  at the scan center with its angle in degrees, the scan ring, and a small cyan
  and greenyellow circle showing where each fovea is currently aimed. Below it
  sit the **Start Scan** button and the scan status readout.
- **Right Fovea** (greenyellow) — the mirror image of the left column.

A pull-up **drawer** along the bottom holds the alignment sliders on the left and
the scan sliders (plus a **Status** row repeating the scan readout) on the right.
Click the tab at the bottom edge to open it — `Ctrl-\`` toggles it from the
keyboard — then drag the grip to resize it.

### To aim

Press and drag anywhere on the **Center Wide** view. Both foveas follow the
cursor; a crosshair with a degree readout marks the scan center and the dashed
ring previews the path the mirrors will trace. Release to leave the mirrors
parked there. The depth the two eyes converge on comes from the **Verge
Distance** slider, not from the drag.

On an uncalibrated rig the crosshair still follows your drag, but the mirrors do
not move and the aim markers stay hidden — there is no calibration to turn a
pixel into a mirror angle.

Aiming works the same whether or not the scan is running: the ring simply moves
to the new center.

### To fine-align each fovea

The drag is coarse — it puts the ring roughly where you want it, but each mirror
has its own small pointing offset. Use the four trim sliders in the left half of
the drawer:

1. Watch one fovea view and find your source in it.
2. Nudge **Left Trim H** / **Left Trim V** (or the **Right** pair) until the
   source sits at the center of that fovea's frame.
3. Repeat for the other eye.

Each trim moves only its own eye, up to ±0.5°, and moves the ring's center
without changing its size or shape — so you can trim while the scan runs. The
two small circles on the Center Wide view show where each fovea is aimed and
separate as the trims diverge.

### To scan

1. Set **Scan Frequency** (1–100 Hz) and **Scan Amplitude** (0–2°, the ring's
   radius) in the right half of the drawer.
2. Press **Start Scan** (it stays disabled until the three cameras are leased —
   hover the row to see what it is waiting for). The ring goes solid and the
   status line next to the button — repeated in the drawer's **Status** row —
   shows the applied timing, for example
   `20.0 Hz · 50.0 ms · L 49.9 ms · R 49.9 ms`: the frequency, one revolution,
   and each fovea's exposure.
3. Adjust the frequency or amplitude while it runs; both take effect live
   (changing the frequency re-applies the exposure override).
4. Press **Stop Scan** to end it. The mirrors glide back to the aiming center.

The commanded circle is exact, but the mirrors themselves roll off at high
frequency, so the ring you actually see shrinks as you raise the frequency. That
is physical, not a bug — pick the highest frequency where the ring is still
usable.

### What the exposure override does

While the scan runs MirrorLink takes over both fovea cameras' **exposure** and
**frame rate** so one frame covers exactly one revolution. It does not change
anything saved in [Manage Cameras](./manage-cameras.md): the pre-scan exposure,
frame rate, frame-rate-enable, and auto-exposure values are remembered when the
scan starts and written back when it stops, when you leave the app, or whenever
the frequency is re-applied.

A camera that cannot reach the requested frequency keeps its own maximum rate
and still exposes for one revolution (with a gap between frames). If an exposure
ends up more than 2 % off the revolution time, the status line turns amber and a
warning appears in the title-bar tray — the ring in that eye covers only part of
the circle. Hover the status line for the detail; hover it while idle to see what
the current settings would apply.

If **Start Scan** is refused (no cameras leased, or a camera rejected the
exposure write) the status line reads *idle — refused* and its hover carries the
reason.

## Recording

The title-bar record button (or `Cmd/Ctrl-R`) writes the raw left, center, and
right streams to a `.fcap` file, exactly as in the other apps — see
[Recording and Capture](./recording-and-capture.md). Still capture is not offered
here: a scanned frame has no single mirror position to attach to a still. You
cannot switch away from MirrorLink while a recording is running; stop it first.

## Related

- [Manual Control](./manual-control.md) — the same steering bench without the
  scan, plus set-points and still capture.
- [Manage Cameras](./manage-cameras.md) — the exposure and frame-rate settings
  the scan temporarily overrides.
