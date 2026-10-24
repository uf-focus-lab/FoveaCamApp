# MirrorLink

MirrorLink points both fovea mirrors at one spot and then sweeps them fast along
a small path around it while the controller triggers the fovea cameras at exact
points on that path. By default the path is a circle and each camera takes
exactly one frame per revolution, so a light source that blinks on and off at its
own rate paints a **dashed ring** in every fovea frame: the gaps in the ring are
the source's off-periods, so the ring itself is the decoded signal. Use it to
read a free-running optical transmitter, or simply to see a blink pattern you
cannot resolve frame by frame. The **Scan Pattern** pane also offers an ellipse,
a straight line, and a triangle sweep that runs out and back along a line, which
takes two frames per cycle, one each way (see *To scan*).

**Prerequisites:** a full calibration present (see [Calibration](./calibration.md))
and all three cameras connected (see [Manage Cameras](./manage-cameras.md)). On
an uncalibrated rig the views still show live frames, but steering does nothing
and the center view falls back to the raw, distorted image.

## The layout

Three live columns sit across the top:

- **Left Fovea** (cyan) — the left fovea view, a one-line ring readout, and a
  voltage bar. The view is the raw camera image, deliberately *not* straightened:
  a frame that integrates a stretch of the scan has no single mirror position to
  straighten it against, and the un-straightened path is what you are here to
  read. (In triangle mode every second frame arrives flipped upright — see
  *To scan*.) The readout row appears only with **Ring Reader** on (see
  *Reading the emitter*). The voltage bar draws the scan path the mirror is
  commanded to follow, with the crosshair on the path's center.
- **Center Wide** (orange) — the wide view you steer on. It carries a crosshair
  where you aimed (the scan center, unless **Auto Vergence** holds a pan) with
  its angle in degrees, the scan path with its exposed
  stretches drawn thicker, the **axis handle** (a spoke from the scan center
  ending in a dot), and a small cyan and greenyellow circle showing where each
  fovea is currently aimed. Below it sit the **Start Scan** button and the scan
  status readout, then the **Ring View** selector and its two decoder strips
  (see *Looking inside the decoder*).
- **Right Fovea** (greenyellow) — the mirror image of the left column.

A pull-up **drawer** along the bottom holds four columns, left to right: the
mirror controls (**Verge Distance**, **Vertical Shift**); the **Auto Vergence**
loop with its PID sliders; the **Scan Pattern** pane (the shape of the scan and
where along it the cameras expose); and the **Gain** slider, **Scan Frequency**,
the **Ring Reader** switch and a **Status** row repeating the scan readout.
Click the tab at the bottom edge to open it — `` Ctrl-` `` toggles it from the
keyboard — then drag the grips between the columns to resize them.

### To aim

Press and drag anywhere on the **Center Wide** view — anywhere except the axis
handle's dot, which turns the scan instead (see *To scan*). The dot always sits
a little way out from the scan center, so a press there always aims (with
**Auto Vergence** holding a pan, the crosshair sits off that center — press
beside the dot, not on it). Both foveas follow
the cursor; a crosshair with a degree readout marks where you aimed and the
dashed path previews what the mirrors will trace. Release to leave the mirrors
parked there. The depth the two eyes converge on comes from the **Verge
Distance** slider, not from the drag.

On an uncalibrated rig the crosshair still follows your drag, but the mirrors do
not move and the aim markers stay hidden — there is no calibration to turn a
pixel into a mirror angle.

Aiming works the same whether or not the scan is running: the path simply moves
to the new center.

### To converge the foveas by hand

The drag is coarse. Two controls in the drawer's left column finish the job — the
same pair Manual Control uses, but stepped finer here: the emitter has to land in the
middle of a fovea frame, not just somewhere in it.

- **Verge Distance** — the depth the two eyes converge on. Too near or too far
  and the source sits off-center in opposite directions in the two fovea views.
- **Vertical Shift** — the vertical toe between the eyes (±2°): it raises the
  left fovea and lowers the right by the same amount, for when the source sits
  high in one view and low in the other.

Both move the scan path's center without changing its size or shape, so you can use
them while the scan runs. The two small circles on the Center Wide view show
where each fovea is aimed.

### To converge automatically

**Auto Vergence** (the drawer's middle column) is the same loop Disparity Scope uses:
it finds each fovea's view inside the wide view and drives the mirrors until the two
agree on whatever you steered at. It is a *loop*, not a one-shot — leave it on and it
keeps up as the rig drifts.

1. Steer the wide view at what you want both foveas on.
2. Press **Auto Vergence**. The line beside it reads `tracking` and **Verge Distance** /
   **Vertical Shift** start moving on their own — those two sliders *are* what the loop
   drives.
3. Press **Stop Vergence** to hand control back; the mirrors hold exactly where the loop
   left them, and the sliders hold the values it reached.

While the **scan** is running the loop pauses (the status reads `paused: scanning`): a
scanned fovea frame is a smear along the scan path, not the patch the match needs. It picks up again the moment
you stop the scan, from the values it had. So the usual order is converge first, then scan.

Other things the status line can say: `hold: match low score` — neither view is confident
enough to steer on; `hold: match stale` — one fovea's frames stopped arriving.

Moving **Verge Distance** or **Vertical Shift** yourself while the loop runs is allowed:
the loop takes your value as its new starting point and carries on from there. Steering
somewhere new re-aims it at the new spot.

**The PID sliders** above the button are the same three groups Disparity Scope has —
**Pan** (how the pair is centred on the target), **Depth** (the convergence distance) and
**Vertical** (the toe between the eyes) — each with **Kp** how hard it corrects, **Ki** how
it removes the last bit of standing error and **Kd** damping if it overshoots. **Min Match
Score** is the confidence below which the loop refuses to steer. The reset button in each
heading puts that group back. The defaults are a slow, safe loop; raise Kp first if it
crawls.

While the loop runs, a small dashed circle in each fovea's colour marks where that fovea
was found in the wide view. If the status sits at `hold: match low score`, look at those
two marks: on the right thing, the scene is simply low-contrast — lower **Min Match
Score** or raise **Gain**; somewhere else entirely, a fovea has locked onto a repeating
pattern, so steer at something more distinctive. `no calibration` means the wide camera has
no undistort calibration and the loop has no map to steer with — calibrate it first. A
refused engage leaves the status at `off — refused` with the reason in its hover.

### To scan

The scan's shape lives in the drawer's **Scan Pattern** pane; its speed is
**Scan Frequency** in the column to its right. The path on the **Center Wide**
view always previews what the current settings will trace — dashed before you
start, solid while it runs — and the stretches drawn thicker are the parts the
cameras actually expose.

1. Pick a **Mode**: **Ellipse** (a closed loop — the circle, an ellipse or a
   straight line) or **Triangle** (a straight sweep out and back).
2. Point the scan's main axis. Either drag the **Axis** slider (degrees, `0` is
   the wide view's horizontal), or press on the **axis handle** — the dot at the
   end of the spoke from the scan center — and drag it around on the
   **Center Wide** view: the axis follows the pointer for as long as you hold
   the button, and the drag does *not* move the scan center. The handle only
   sets the direction: at a small amplitude its dot is drawn further out than
   the end of the path, so it never sits on the scan center. Press anywhere else
   on the view — the scan center included — and you steer as usual. Over the dot
   the pointer turns into a hand and the handle brightens; while you drag it
   the dot grows. While **Auto Vergence** holds a pan the scan center sits a
   little off the crosshair, and the spoke starts from the scan center, where
   the path really is. A handle pushed off the edge of the frame cannot be
   grabbed; use the **Axis** slider then.
3. Set **Amplitude** (0–2°): the radius along the axis for the ellipse, half the
   sweep for the triangle.
4. Shape it per mode:
   - **Ellipse** — **Ratio** is the width across the axis relative to the
     length along it: `1.00` is a circle, smaller values flatten it into an
     ellipse, and `0` (the readout says `line`) collapses it onto the axis, a
     back-and-forth line. **Exposure Window** is a two-ended slider: the part
     of each revolution the cameras expose, read out in milliseconds within the
     period (`0.0–95.0 ms` at 10 Hz).
   - **Triangle** — the mirrors sweep from one end of the axis to the other in
     one base period and back in the next, so a full triangle takes *twice* the
     **Scan Frequency** period, and the cameras take two frames per cycle: one
     on the way out, one on the way back. **Rising Window** and **Falling
     Window** set what part of each sweep is exposed, in milliseconds within
     that sweep. With **Sync Windows** on (the default) the falling window
     copies the rising one's timing and its slider is greyed out; turn Sync off
     to set it separately. Same timing means each window counts from the start
     of its own sweep, and the return sweep starts from the far end, so a window
     that is not centred in the sweep exposes opposite ends of the line on the
     two frames. The frame from the return sweep is flipped upside down
     before you (or the ring reader) see it, so both frames of a cycle read the
     same way up. On a camera that falls back to a timed exposure (see *What
     the exposure override does*) the **Falling Window** readout ends in
     `(timed: rising length)`: both frames then expose for as long as the
     rising window, whatever the falling slider's end says.
5. Press **Start Scan** (it stays disabled until the three cameras are leased —
   hover the row to see what it is waiting for). The path goes solid and the
   status line next to the button — repeated in the drawer's **Status** row —
   shows what is running, for example `ellipse · 10.0 Hz · 100.0 ms · 0.0–95.0
   ms` (mode, frequency, period, exposure window) or `triangle · 10.0 Hz · 200.0
   ms · 5.0–95.0 + 105.0–195.0 ms` (the two windows, timed within the doubled
   period). Hover it for the trigger bookkeeping.
6. Adjust anything while it runs. Axis, amplitude, ratio, the windows, aiming
   and the vergence controls take effect without interrupting the scan;
   changing **Mode** or **Scan Frequency** restarts it on the new period — unless
   the controller's clock link has lapsed meanwhile: the scan then stops (*idle —
   stopped*) until the clock recovers, and you press **Start Scan** again.
7. Press **Stop Scan** to end it. The mirrors glide back to the aiming center.

The scan needs a controller with firmware 2.2.0 or later: the pattern runs on
the controller itself, which fires the camera triggers at exact points along
the path. On older firmware **Start Scan** is refused and the hover says why.

The commanded path is exact, but the mirrors themselves roll off at high
frequency, so the path you actually see shrinks as you raise the frequency. That
is physical, not a bug — pick the highest frequency where it is still usable.

The **voltage bars** under the fovea views draw that commanded path in volt
space — faint before you start, solid while it runs — with the crosshair parked
on its center. They show the shape the mirror is asked to trace, not a moving
dot: at 10 revolutions per second a marker would only flicker.

### What the exposure override does

While the scan runs MirrorLink takes over both fovea cameras' **trigger** and
**exposure**: each camera is triggered by the controller at the start of a
window and exposes for exactly as long as the window lasts, so a frame covers
precisely the stretch of path drawn thick on the wide view. It does not change
anything saved in [Manage Cameras](./manage-cameras.md): the pre-scan settings
are remembered when the scan starts and written back when it stops or when you
leave the app.

A camera model that cannot take the trigger's length as its exposure falls back
to a fixed exposure as long as the first window; the status line then ends in
`· timed`. The status line turns amber when the cameras stop answering the
trigger (no exposure has completed for two scan periods — also mid-run, after
good frames, e.g. a trigger cable coming loose), or when the scan cannot run exactly as set — its hover starts with
*Exposure mismatch —* and names why. Hover it while idle to see what the
current settings would run.

| Amber reason | What it means, what to do |
|---|---|
| trigger rate above the camera's maximum frame rate | The cameras cannot take frames that fast — lower **Scan Frequency**. |
| exposures closer than the sensor readout | Two exposures END closer together than the sensor needs to read out a frame — in triangle mode make both windows end at the same point of their sweep (**Sync Windows** does this), or lower **Scan Frequency**. |
| exposure windows too close for reliable flipping at this frequency | The two triangle frames are too close together in time to tell apart which one to flip — widen the spacing between the windows, or lower **Scan Frequency**. |
| unequal windows: Timed exposure gives both the rising window's length | On a timed-fallback camera with **Sync Windows** off, the camera takes the rising window's length for both frames; set the windows equal (or turn Sync on) if that is not what you want. |
| Timed exposure would run into the next trigger | On a timed-fallback camera the exposure the camera can take is longer than a whole sweep (its minimum exposure is above one sweep — the **Scan Frequency** period; a triangle's full period is two sweeps), so a frame would still be exposing when the next trigger arrives — lower **Scan Frequency**. Shortening the windows does not help: the app already keeps a shorter exposure inside its sweep. |
| Timed exposure clamped to the camera's exposure range | On a timed-fallback camera the window is longer or shorter than the camera can expose — change the window's length. |
| controller clock calibration lapsed | The controller's clock link stopped answering mid-scan, so the frames can no longer be timed against the path — check the controller's connection. The scan keeps running meanwhile, but a **Mode** or **Scan Frequency** change stops it until the clock recovers (then press **Start Scan**). |
| replacement swap unconfirmed — the mirror may run the previous edit | A live edit did not get through cleanly and the controller may be running either the old or the new path. Make any change to the scan's aim or shape (even back to the same value) — steer, verge/shift, amplitude, ratio, axis or windows; a **Mode** or **Scan Frequency** change also settles it. **Gain**, **Ring Reader** and PID edits do not. On a timed-fallback camera the exposure stays at the shorter window meanwhile. |

If **Start Scan** is refused the status line reads *idle — refused* and its
hover carries the reason: no cameras leased; no controller connected; the
controller firmware is too old; the controller clock is not calibrated yet —
wait a moment and press again; a camera rejected the settings (*exposure
override failed*); or the controller could not start the pattern
(*trajectory start failed*).

If a running scan is stopped under you, the status line reads *idle — stopped*
(amber) and its hover says why: the controller ended the run or cancelled it;
the controller disconnected; a **Mode** / **Scan Frequency** restart failed
(*scan restart failed*); after a live edit, a timed-fallback camera rejected
its new exposure (*exposure re-apply failed*), the triangle's frame flipping
could not be rebuilt (*flip pipe rebuild failed*) or the re-upload ended the
run (*live trajectory re-upload ended the run*); or the controller's clock had lapsed when
you changed **Mode** or **Scan Frequency** (*controller clock calibration
lapsed — press Start once it recovers*).

Either message stays put until you press **Start Scan** (which checks again) or
**Stop Scan** — it is not re-checked on its own, so the hover ends with *Press
Start to re-check.*

### Reading the emitter

The **Ring Reader** switch in the drawer's right column (under **Scan Frequency**, above
**Status**) turns the decoder on. It is **off by default** — it reads every fovea frame on
its own worker thread, so it is only worth paying for when you are actually reading an
emitter. It becomes available once the cameras are leased.

The reader needs a closed path: on the line (**Ratio** `0`) and the **Triangle** pattern
there is no ring to find, and it reports `no ring`.

With it on, and while the scan runs, MirrorLink decodes the ring in every fovea frame —
separately for each eye — and annotates the view:

- The **circle** it found, in that eye's color. Solid means the frame decoded; dim and
  dashed means it found a ring but could not read it.
- A short amber **arc** marking the *leader*, the start-of-message burst — where the
  message begins. (For which way it runs, hover the readout.)
- **Ticks** crossing the ring at the message's internal boundaries — long ticks between
  fields (gap, leader, length, data, checksum), short ticks between data bytes.

Under each view a one-line readout shows the decoded text and the measured width of one
emitter slot (`px/chip`); it reads `idle` while the scan is not running and `reading…`
until the first frame is read (the Ring View strips' captions say the same). Hover it for the full text, the raw hex and the reading
direction. When a frame
fails, the line shows why and keeps the last message that did decode, so a good read stays
on screen:

| Reason | What to do |
|---|---|
| `no ring` | No circular track was found — the emitter is out of frame, too dim (raise **Gain**), or the pattern is not a closed loop (a line or the triangle). |
| `no leader` | A ring, but no start marker: usually too dim or the emitter is not sending this format. |
| `below resolution` | The message is too long for the ring you are drawing. Raise **Amplitude** (Scan Pattern pane), or shorten the emitter's message. |
| `low contrast @ bit N` | The chips have blurred together at that point in the message — the dot is too big for the chip arc. Raise **Amplitude** (Scan Pattern pane), shorten the message, or improve focus. The hover shows the measured contrast. |
| `chip period inconsistent with LEN` | What was read as a message does not fill the ring the way its length field says — usually a mis-locked start marker on a noisy frame. |
| `no terminating gap`, `truncated` | The ring was garbled — check focus, exposure (the **Status** line must not be amber) and that the emitter's cycle matches the scan frequency. |
| `crc mismatch` | The message arrived damaged. Single frames fail all the time; a *persistent* failure means the emitter's rate and the scan frequency disagree. |

Nothing is corrected: a bad frame is dropped and the next revolution is a fresh read. That
is why the readout can flicker between a decode and a reason while the last good value
stays visible. Turning the switch off removes the annotations and the readout rows
entirely, and stops the decoding work.

### Looking inside the decoder

**Ring View** — the row of buttons under the **Center Wide** view — draws what the decoder
actually sees, one strip per eye, right below it. It needs **Ring Reader** on (drawer,
right column), and it only draws while the scan runs.

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
there. More gain also means more noise — widen the exposure window (or lower the scan
frequency) first when you can.

Note that the slider has no right-click reset: that would slam a live camera to
its minimum gain mid-alignment.

Dragging Gain does not disturb a running scan: the pattern runs on the
controller, so the mirrors keep moving while the cameras are being written.

## Capturing a ring frame

The title-bar camera button (or `Cmd/Ctrl-S`) grabs ONE full-depth shot — the left and
right fovea frames and the wide view — and opens the capture preview window, where
**Save** writes them to your save directory. Each image lands as `<name>.png` or
`<name>.tiff` (16-bit for the foveae) beside a `<name>.json` of its metadata.

The fovea images are saved exactly as the camera saw them: **not** straightened against a
mirror position, because a frame that integrated a stretch of the scan has no single one. That
raw ring is what an offline decoder needs.

The JSON carries the app's state at that moment under `mirror_link`: the scan timing (or
null if you were not scanning), what the **Ring Reader** last made of each eye — the circle
it fitted, the chip width, the failure reason — the vertical shift, the verge distance,
the baseline, and where you were aiming. So a frame that failed to decode on the rig can
be re-analyzed later with everything the reader saw attached to it.

## Recording

The title-bar record button (or `Cmd/Ctrl-R`) writes the raw left, center, and
right streams to a `.fcap` file, exactly as in the other apps — see
[Recording and Capture](./recording-and-capture.md). You
cannot switch away from MirrorLink while a recording is running; stop it first.

## Related

- [Manual Control](./manual-control.md) — the same steering bench without the
  scan, plus set-points and still capture.
- [Manage Cameras](./manage-cameras.md) — the exposure and frame-rate settings
  the scan temporarily overrides.
