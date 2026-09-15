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

- **Left Fovea** (cyan) — the left fovea view, a one-line ring readout, and a
  voltage bar. The view is the raw camera image, deliberately *not* straightened:
  a frame that integrates a whole revolution has no single mirror position to
  straighten it against, and the un-straightened ring is what you are here to
  read. The readout row appears only with **Ring Reader** on (see *Reading the
  emitter*). The voltage bar draws the scan path the mirror is commanded to
  follow, with the crosshair on the ring's center.
- **Center Wide** (orange) — the wide view you steer on. It carries a crosshair
  at the scan center with its angle in degrees, the scan ring, and a small cyan
  and greenyellow circle showing where each fovea is currently aimed. Below it
  sit the **Start Scan** button and the scan status readout.
- **Right Fovea** (greenyellow) — the mirror image of the left column.

A pull-up **drawer** along the bottom holds three columns: the mirror controls
(**Verge Distance**, **Vertical Shift**) on the left; the **Auto Align** servo
with its PID sliders and the **Ring View** strips in the middle; and the
**Gain** slider, the scan sliders, the **Ring Reader** switch and a **Status**
row repeating the scan readout on the right.
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

### To fine-align the foveas

The drag is coarse. Two controls in the drawer's left column finish the job — the
same pair Manual Control uses, but stepped finer here: the emitter has to land in the
middle of a fovea frame, not just somewhere in it.

- **Verge Distance** — the depth the two eyes converge on. Too near or too far
  and the source sits off-center in opposite directions in the two fovea views.
- **Vertical Shift** — the vertical toe between the eyes (±0.5°): it raises the
  left fovea and lowers the right by the same amount, for when the source sits
  high in one view and low in the other.

Both move the ring's center without changing its size or shape, so you can use
them while the scan runs. The two small circles on the Center Wide view show
where each fovea is aimed.

### To align automatically

**Auto Align** (the drawer's middle column) is a *servo*, not a one-shot: switch it on and
the mirrors keep hunting the emitter for as long as it is on.

1. Press **Auto Align**. It turns green and the line beside it starts reporting the
   residual error for each eye, in degrees.
2. Watch those numbers fall. When they settle near zero the emitter is centered in both
   fovea views, and **Verge Distance** / **Vertical Shift** have been rewritten to match.
3. Press **Stop Align** to hand control back; the mirrors stay where the servo left them.

It works while the scan is running too — a ring's bright pixels average to its center — so
you can leave it on and watch the ring stay put as the rig drifts.

If the readout says *no emitter in either fovea* the source is out of view or too dim:
steer closer and raise **Gain**. If only one eye sees it, that eye keeps servoing and the
other holds.

**The PID sliders** above the button tune the loop (↺ in the heading puts them back):
**Kp** how hard it corrects, **Ki** how it removes the last bit of standing error,
**Kd** damping if it overshoots, and **Max Step** the largest angle it may move per
measurement. The defaults are a slow, safe loop; raise Kp
first if it crawls.

One caveat while the rig is new: if the error numbers GROW instead of shrinking, the
pixel-to-angle sign is inverted for this mounting. Stop the servo, say so — it is a
one-line change — and use the sliders meanwhile.

### To scan

1. Set **Scan Frequency** (1–100 Hz) and **Scan Amplitude** (0–2°, the ring's
   radius) in the drawer's right column.
2. Press **Start Scan** (it stays disabled until the three cameras are leased —
   hover the row to see what it is waiting for). The ring goes solid and the
   status line next to the button — repeated in the drawer's **Status** row —
   shows the applied timing, for example
   `10.0 Hz · 100.0 ms · L 99.9 ms · R 99.9 ms`: the frequency, one revolution,
   and each fovea's exposure.
3. Adjust the frequency or amplitude while it runs; both take effect live
   (changing the frequency re-applies the exposure override).
4. Press **Stop Scan** to end it. The mirrors glide back to the aiming center.

The commanded circle is exact, but the mirrors themselves roll off at high
frequency, so the ring you actually see shrinks as you raise the frequency. That
is physical, not a bug — pick the highest frequency where the ring is still
usable.

The **voltage bars** under the fovea views draw that commanded circle in volt
space — faint before you start, solid while it runs — with the crosshair parked
on the ring's center. They show the shape the mirror is asked to trace, not a
moving dot: at 10 revolutions per second a marker would only flicker.

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

### Reading the emitter

The **Ring Reader** switch in the drawer's right column (under the scan sliders, above
**Status**) turns the decoder on. It is **off by default** — it reads every fovea frame on
its own worker thread, so it is only worth paying for when you are actually reading an
emitter. It becomes available once the cameras are leased.

With it on, and while the scan runs, MirrorLink decodes the ring in every fovea frame —
separately for each eye — and annotates the view:

- The **circle** it found, in that eye's color. Solid means the frame decoded; dim and
  dashed means it found a ring but could not read it.
- A short amber **arc** marking the *leader*, the start-of-message burst — where the
  message begins. (For which way it runs, hover the readout.)
- **Ticks** crossing the ring at the message's internal boundaries — long ticks between
  fields (gap, leader, length, data, checksum), short ticks between data bytes.

Under each view a one-line readout shows the decoded text and the measured width of one
emitter slot (`px/chip`). Hover it for the full text, the raw hex and the reading
direction. When a frame
fails, the line shows why and keeps the last message that did decode, so a good read stays
on screen:

| Reason | What to do |
|---|---|
| `no ring` | No circular track was found — the emitter is out of frame, too dim (raise **Gain**), or the scan is not running. |
| `no leader` | A ring, but no start marker: usually too dim or the emitter is not sending this format. |
| `below resolution` | The message is too long for the ring you are drawing. Raise **Scan Amplitude**, or shorten the emitter's message. |
| `low contrast @ bit N` | The chips have blurred together at that point in the message — the dot is too big for the chip arc. Raise **Scan Amplitude**, shorten the message, or improve focus. The hover shows the measured contrast. |
| `chip period inconsistent with LEN` | What was read as a message does not fill the ring the way its length field says — usually a mis-locked start marker on a noisy frame. |
| `no terminating gap`, `truncated` | The ring was garbled — check focus, exposure (the **Status** line must not be amber) and that the emitter's cycle matches the scan frequency. |
| `crc mismatch` | The message arrived damaged. Single frames fail all the time; a *persistent* failure means the emitter's rate and the scan frequency disagree. |

Nothing is corrected: a bad frame is dropped and the next revolution is a fresh read. That
is why the readout can flicker between a decode and a reason while the last good value
stays visible. Turning the switch off removes the annotations and the readout rows
entirely, and stops the decoding work.

### Looking inside the decoder

**Ring View** (top of the drawer's middle column) draws what the decoder actually sees,
one strip per eye. It needs **Ring Reader** on, and it only draws while the scan runs.

- **Polar** — the ring unrolled: angle left-to-right, radius top-to-bottom. A healthy ring
  is a bright horizontal band with dark gaps; a band that wanders up and down means the
  path is an ellipse (normal), one that leaves the strip means the fit is off.
- **Binary** — the brightness around the ring after normalization, with the on/off decision
  drawn over it. Chips that merge into a smear here are why a decode fails.
- **Segments** — the same trace with the decoded structure marked: the start burst shaded,
  field boundaries as full-height lines, byte boundaries as short ticks, and a blue line
  where the message's data begins.

Turning it **Off** stops the work entirely.

### To brighten a dim source

The **Gain** slider at the top of the drawer's right column raises both foveas'
sensor gain together, in decibels. Unlike the exposure override it applies for as
long as MirrorLink is open — scanning or not — so you can use it to find a faint
source before you start. Its range is whatever both cameras can honor, and it
starts at the **left** fovea's current gain. It stays disabled, reading `—`,
until the cameras are leased, or if the two cameras share no common gain range.

Gain is the same kind of temporary override as the exposure: the pre-session
gain and auto-gain of both foveas are remembered and written back when you leave
the app, so [Manage Cameras](./manage-cameras.md) keeps whatever you configured
there. More gain also means more noise — raise the exposure (a lower scan
frequency) first when you can.

Note that the slider has no right-click reset: that would slam a live camera to
its minimum gain mid-alignment.

## Capturing a ring frame

The title-bar camera button (or `Cmd/Ctrl-S`) grabs ONE full-depth shot — the left and
right fovea frames and the wide view — and opens the capture preview window, where
**Save** writes them to your save directory. Each image lands as `<name>.png` or
`<name>.tiff` (16-bit for the foveae) beside a `<name>.json` of its metadata.

The fovea images are saved exactly as the camera saw them: **not** straightened against a
mirror position, because a frame that integrated a whole revolution has no single one. That
raw ring is what an offline decoder needs.

The JSON carries the app's state at that moment under `mirror_link`: the scan timing (or
null if you were not scanning), what the **Ring Reader** last made of each eye — the circle
it fitted, the chip width, the failure reason — the vertical shift, the verge distance,
the baseline, and where you were aiming. So a frame that failed to decode on the rig can
be re-analyzed later with everything the reader saw attached to it.

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
