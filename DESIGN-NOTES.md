# Design notes

The *why* behind pxlpeep's interactive tools — decisions and their reasoning, including rejected
alternatives, that would otherwise live only in a chat log. Deliberately lightweight: a running
design log, **not** a formal product-design/UX document with templates to fill. What's implemented
lives in `content/main.js`; what's queued lives in `ROADMAP.md`; this captures the *rationale* so it
isn't lost or re-litigated. Sections grow as tools get designed.

---

## The Shift-drag rectangle → two tools (white balance + measure)

The Shift-drag rectangle was overloaded: it set the **white-balance ROI** *and* doubled as a
**measuring** tool. Those want *opposite* pixel snapping, so they can't share a rectangle:

- **White balance** averages a *set of whole pixels* → the region is bounded by pixel **edges**;
  snap to **corners** so the box fully encloses the pixels it averages. Diagonal/angle are
  meaningless; w×h is marginally useful.
- **Measure** reads the distance between two *points*, and a pixel's location is its **center** →
  snap to **centers**; width, height, diagonal, and angle all matter.

Decision: split into a dedicated **WB tool** and **measure tool** (the latter a *line*, not a
rectangle — see below). They coexist; neither clears the other.

## White balance tool

**Gesture.** Hold **W** + left-drag draws a corner-snapped box; on **mouse-up** it computes and
applies. `W` (not Shift) is the modifier so Shift-drag stays free for measure, and because the
drag's *type* is fixed at mouse-down, releasing W mid-drag still commits on mouse-up. **No live
preview** — a live one would feed the corrected image back into the next computation.

**Corner snap** makes WB exact: the code floors the span to whole pixels, so snapping the corners to
pixel edges means *pixels averaged == pixels enclosed*. Readout is **w×h** only.

**Stacking (the subtle one).** A new WB **composes over** the current correction rather than
replacing it — gains are computed from the **corrected** values (raw × current WB gains, clamped
0–255) and **multiplied** onto the current gains (grey/Bayer: the same, per quad).

- *Why:* "recompute based on what I currently see" is inherently path-dependent, and that's the
  intended mental model. It also buys idempotency for free — re-applying the same box sees an
  already-neutral region → unit gains → no change.
- *Rejected:* compute-from-raw + replace (the original behaviour). Idempotent too, but a new
  selection *replaces* the correction instead of stacking on it — not what we want.
- *Saturation caveat (accepted):* if a gain clips a channel past 255, the region isn't perfectly
  neutral, so a **deliberate** re-drag of the same box nudges it further — not idempotent under
  clipping. Fine, because it only happens on a deliberate re-drag and **Shift+W** is always the
  one-key clean slate.

**Persistence.** The box **stays** after applying, so you can see what drove the correction.

- **Tap W** (press + release, no drag) clears the box.
- **Alt+W** (held) momentarily **peeks at the pre-WB image** — bypasses the correction while down,
  snaps back on release. This is the quick A/B. "Original" means *WB off only*: palette, transfer
  function, and channel selection stay as set, so you compare this view with vs. without WB — not
  against the fully-raw image. It's a render-time bypass (shader runs identity gains); the stored
  `S.wbColor` is untouched.
- **Shift+W** reverts the *correction* to identity **permanently**, but **keeps the box** as a
  reference.
- **Esc** clears overlays.

## Measure tool

Hold **M** + left-drag → a **line** (two centre-snapped endpoints), labelled with a cursor-box-style
box: **dx, dy** (signed), **L** (unsigned), **θ**. Signed dx/dy are why reversing the drag flips θ by
180° — visible in the signs, cleaner than drawing a direction arrow. θ is math convention: 0° = east,
CCW positive (up = +90°), range (−180°, 180°]. **dy** is reported in the *displayed* Y convention, so
it flips sign with the `Y`-origin toggle; θ stays the visual angle (yFlip-independent) and `L` is a
magnitude. Measures **stack**; **Shift+M** pops the newest. The label box anchors in the line's
*heading* direction (which of four corners, by the sign of the screen-space delta) so it never sits
on the segment — with **hysteresis** (a ±15px Schmitt band, the chosen corner remembered on the
measure) so a near-horizontal/vertical line doesn't jitter the box side-to-side on tiny mouse
movement.

(Related: the `Y`-origin toggle now also **reanchors the vertical ruler ticks** to the flipped
origin — it marches the tick grid from the bottom edge up — so the "0" tick is placed instead of
just relabelling a top-anchored grid. And the top-right info box's `W×H` line shows units like every
other dimension once calibrated.)

## Cursor boxes — the P inspect tool

**Hold P** shows a live cursor readout that follows the mouse; **release P** hides it. **Click while
P is held** pins the current readout as a *frozen snapshot* and keeps a fresh one following, so you
can drop several without releasing. **Shift+P** pops the newest pin. (Space — which used to toggle a
persistent live box — is retired; the live box is now just "hold P".) Live and pinned boxes share
one renderer, so the marker is the same `+`/square that transitions at 16× — a pin dropped at low
zoom shows `+`, zoom in and it becomes the square. A pin freezes only the pixel **value** at drop
time; its X/Y/R/θ and unit annotation recompute live, so it tracks the ruler and calibration. (The
value is frozen because its display coords would mis-sample the raw texture after a rotation.) This
is ROADMAP #11.

## User units / calibration (U)

`unitPerPix` / `unitName` already existed (the ROI box dual-displayed px + units), but nothing ever
set them. **U** now calibrates off the most-recent measure line: a small in-app input (one field,
`"<number> <unit>"`, unit is free text — "parsex" welcome) sets `unitPerPix = entered / L_px`. From
then on every dimension — cursor box, info box, measure boxes, WB box — shows `value (value unit)`.
It's a custom overlay input, not `window.prompt` (WebView2 blocks that), so one path serves both
shells. **Shift+U** cancels calibration, back to pixels only. A dedicated `calibrated` flag gates
the dual display — *not* `unitPerPix===1`, which a legitimate 1-unit/px calibration would trip.

## Tool-scoped Esc

**Esc** clears the *entire* group of the most-recently-used tool (WB box / measures / latched),
tracked by a per-group sequence stamp; repeated Esc walks back tool-by-tool. **Shift+key** is the
fine granularity (pop one item from a given tool); Esc is the broom — so you can wipe a botched set
of measurements with one keystroke without nuking your white balance. When Esc reaches the WB group
it clears the *box* only; the correction is reverted solely by Shift+W. Rotating or flipping the
image **transforms** the overlays with it (measure endpoints, WB corners, latched points) so they
stay pinned to content. Each point **round-trips through raw texture coords** (old display → raw →
new display) rather than a display-space rotation — which is exact for every rotation×flip combo. A
bare display-space rotation would be wrong once a single flip is active, since the shader flips
*before* it rotates and a 90° rotation doesn't commute with a single-axis mirror. Readout boxes are
drawn axis-aligned so their text stays upright. The WB *correction* is unaffected.

## Cursor info box + position markers

- Above a zoom threshold, snap the marker to the **centre** of the pixel under the cursor (a pixel
  is identified by its centre, not a corner-of-four) and anchor the readout to it. The point is
  *screenshot legibility*: the OS cursor isn't captured, so without an on-image marker you can't
  tell which pixel the numbers describe.
- Below the threshold, drop a **`+`** at the exact point instead, so a screenshot still has a
  reference rather than a box dangling in space. Same extent as the square anchor.
- Both markers are **black-flanked-white**, so they read over any pixel value regardless of contrast.
- The info box shows the **full source path**, not just the basename.

## Pixel grid

Thin lines on pixel boundaries so a flat, constant-colour region still shows its scale when zoomed
in. Black-flanked-white (visible over any value, like the rulers). **Auto-hidden** below a zoom
threshold where the lines would collapse into mush — set to **64×**, the first zoom at which the
rulers already show one tick per pixel, so the grid appears exactly when per-pixel structure is what
you're inspecting. Toggle: **`d`** key + a `grid` toolbar button.
