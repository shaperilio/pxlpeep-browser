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

**Readout is unaffected by WB (deliberate).** Applying a white balance changes the *display* but not
the numbers in the info/cursor boxes — those always report **raw file values**. WB sits alongside the
palette and transfer function as a *display* transform; the pixel readout is *original data*. That
split is the whole point of an inspector, so it's the same reason the readout ignores the palette and
transfer function too. **Alt+W** is the A/B for what WB does to the display; the numbers stay ground
truth. (Considered showing WB-corrected values or both raw→corrected — rejected to keep the readout
unambiguously the source data.)

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
just relabelling a top-anchored grid. The flipped label rule: with the origin at the bottom, the
**bottom-most pixel reads 0** (0-based) or **1** (1-based) — i.e. the coordinate reflects across the
pixel-centre range `[0, dispH-1]` and *then* the 0/1-based offset is added, so the `0` key still
switches conventions in both origins. The ruler ticks and the cursor/info-box readout share this one
formula so they can't disagree. And the top-right info box's `W×H` line shows units like every other
dimension once calibrated.)

## Cursor boxes — the P inspect tool

**Hold P** shows a live cursor readout that follows the mouse; **release P** hides it. **Click while
P is held** pins the current readout as a *frozen snapshot* and keeps a fresh one following, so you
can drop several without releasing. **Shift+P** pops the newest pin. (Space — which used to toggle a
persistent live box — is retired; the live box is now just "hold P".) Live and pinned boxes share
one renderer, so the marker is the same `+`/square that transitions at 16× — a pin dropped at low
zoom shows `+`, zoom in and it becomes the square. A pin freezes only the **raw pixel sample** at
drop time; its X/Y/R/θ, unit annotation, **and channel on/off gating** recompute live, so it tracks
the ruler, calibration, and channel toggles — hide a channel and a pinned box's value flips to `OFF`
too. Only the raw sample is frozen (its display coords would mis-sample the raw texture after a
rotation); everything *derived* from it — coordinates, units, which channels are shown — is recomputed
each frame by `formatVal`/`pixelReadout`. This is ROADMAP #11.

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

- **The readout ALWAYS snaps to the pixel centre, at every zoom.** X/Y names the exact pixel the
  value is sampled from, and the marker sits on that same pixel — the two can never disagree. Showing
  `X=45.7` while the value is pixel 45 is misleading: the value is discrete, so its coordinate must be
  too. A pixel is identified by its centre, not a corner-of-four.
- The zoom threshold (`CURSOR_MARKER_ZOOM`, 16×) picks only the marker **glyph** — a nested **square**
  at/above it, a **`+`** below — never *whether* it snaps. Both glyphs sit at the pixel centre. The
  on-image marker exists for *screenshot legibility*: the OS cursor isn't captured, so without it you
  can't tell which pixel the numbers describe.
- Both markers are **black-flanked-white**, so they read over any pixel value regardless of contrast.
- The info box shows the **full source path**, not just the basename. On the desktop shell the
  launcher canonicalises `argv[1]` to an absolute path (stripping Windows' `\\?\` verbatim prefix),
  so the box shows the full path even when opened with a relative one.

## Non-image background

The letterbox around the image (anywhere the display UV falls outside the texture) is **Qt::darkGreen
(#008000)** — the same colour the C++ `QGraphicsView` used as its background brush. Pure identity/
fidelity: a distinctive non-black surround says "pxlpeep has this image" at a glance and matches what
long-time desktop users expect. It's a constant in the fragment shader (and the GL clear colour), so
it costs nothing.

## Pixel grid

Thin lines on pixel boundaries so a flat, constant-colour region still shows its scale when zoomed
in. Black-flanked-white (visible over any value, like the rulers). **Auto-hidden** below a zoom
threshold where the lines would collapse into mush — set to **64×**, the first zoom at which the
rulers already show one tick per pixel, so the grid appears exactly when per-pixel structure is what
you're inspecting. Toggle: **`d`** key + a `grid` toolbar button.

## Toolbar

- **Tooltips** lead with the **hotkey in brackets**, then *what it does* — `[Ctrl+1] Zoom to fit` —
  so the key is scannable at the front. Keys are sourced from the same keydown handler that owns them,
  so the two can't drift. Conditional controls say so (dip only bites on a log/parabolic transfer
  function; the grid only shows above 64×). A tooltip that just restates the label is worse than none.
- **State must be visible, never a guess.** A button whose *label changes* to name the current mode is
  ambiguous — is that the current state or what a click does? So mode selectors show all options and
  highlight the active one:
  - *Binary modes* → a **segmented pair**, active one white (`_setActive`): `0-based`/`1-based`,
    `fit`/`full`. Clicking one selects it and deselects the other.
  - *On/off toggles* → a single button, white = engaged (`flip Y`, the overlay toggles).
  - *Many-option cyclers* → **`‹ current-name ›`**: prev/next chevrons around a centred label (like
    `dip`'s `−` / value / `+`), so the middle is unmistakably the selection and the chevrons the action.
    This replaced the old single cycle-button that showed the name and stepped on click.
- **`fit` vs `full` scale.** `full` was called `user` — a lie, since the range isn't user-settable.
  `full` = the fixed `0…max`; a *real* custom range is ROADMAP #13 (mirrors the `U` units input).
- **Help ↔ toolbar grouping is deliberately NOT 1:1.** The keyboard-help overlay groups commands into
  **sections**; the toolbar splits some of those into **per-item rows** (a row label is sometimes a
  section like `channels` = R/G/B, sometimes a single item like `palette`). Trying to force identical
  structure fails because the two surfaces have different granularity. They share the same *section
  names and membership* (Mapping, Rotate/flip, Axes, …); the toolbar is just finer. The help lines are
  **generated** from `(key, description)` pairs with a fixed-width key column, so the columns always
  align in the monospace overlay font instead of relying on hand-counted spaces. As the reference
  grows, `drawHelp` **shrinks the font+pitch uniformly to fit the window height** (scaling the line
  *pitch* directly, not re-measuring `lh` — which carries a constant per-line term that wouldn't
  shrink), so the bottom sections never clip off short windows.
- **Collapse is stationary.** The title bar itself is the toggle (not a separate corner button that
  swapped in a differently-shaped float): the *same* header — "pxlpeep" + an arrow, one constant
  colour — stays put in both states, only the body below and the arrow glyph (▲/▼) change, and the box
  shrinks to the title bar when collapsed. So a click collapses and a click *in the same spot*
  re-expands, without the title jumping. Anchored to the fixed top-left corner (clear of the rulers).
