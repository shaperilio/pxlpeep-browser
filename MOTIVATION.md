# Motivation

The *why* behind pxlpeep — the real-world needs and use cases that drove its features, in the
author's own words. This is the **product / purpose** layer: what problem a capability actually solves
and the experience that motivated it. It sits alongside the other docs rather than duplicating them:

- **MOTIVATION.md** (this file) — *why* a capability exists and the real use it serves.
- **DESIGN-NOTES.md** — *how* the interactive tools are designed, and why those design choices.
- **ROADMAP.md** — *what's* planned next.

An ongoing log the author dictates; entries here inform what gets built (and can graduate into
ROADMAP items or DESIGN-NOTES rationale).

---

## Origins — pxlpeep C++

pxlpeep C++ saw several uses over the years.

### Camera / lens evaluation

The **position snaps** (center / corners) were born here. Lens image quality is **strongly dependent
on radius** — sharpness and aberrations change from the optical center outward — so you want to jump
straight to the **center** and to each **corner** to judge quality across the field. Looking at all
**four corners** together also shows whether they're **balanced**; an imbalance points to a decentered
or tilted lens/sensor rather than the design itself.

This is also **why the info box reports radius and θ**: for lens work a pixel's distance from the
optical center (and its angle) is the meaningful coordinate, not just X/Y.

Several otherwise-generic tools also grew out of camera evaluation — **white balance** among them.
This thread will be **expanded when demosaicing lands** (raw / Bayer inspection is where much of the
camera-evaluation workflow lives).

The **palettes** and **transfer functions** came from here too. False-color palettes surface
**saturation** at a glance; the **log / parabolic brighten & darken** functions let you read
**dynamic range** directly — especially on **raw images from uncalibrated cameras**, where the useful
signal can sit anywhere in the range.

### Camera calibration — fiducial target detection

A different camera workflow: developing the **calibration code** itself, specifically the stage where a
**fiducial target** is identified in an image. Four features that look generic were actually central to
that work — **reload**, **cycling through a folder of images by extension**, **multi-window sync**, and
**channel selection**. (Folder cycling and multi-window sync are **ROADMAP #4** — this is the concrete
use case driving it.)

**A worked example.** The dot-finding code might run a **blob detector** then an **ellipse fitter**, and
it would emit its own visualizations into image files. Working from a color JPG, it might write the blob
outlines to the **red** channel of a TIFF, the fitted ellipse major/minor axes to **green**, and the
pixels it was actually operating on to **blue** (perhaps just the original's green channel, or some
composite of the color channels). Then two pxlpeep windows, **synced** and cycling the whole calibration
set, would show the **source JPG** in one and the **blob/ellipse results** in the other — and if you only
cared about the blob stage, you'd view just the **red** channel of the TIFF.

This is exactly where **reload that changes nothing** is critical: when valid markers were being lost,
you'd adjust a threshold in the code, re-run it, and **reload** to see the new result *instantly, on the
very same pixels* — never losing sight of the spot you were studying.

The same held for **grid walking** — the stage that sorts the found candidate markers into the known
lattice of points that forms the target you're looking for. Running the calibration in **debug mode**,
stepping row by row and column by column, the code re-wrote the TIFF with the latest visualization at
each step; **reloading between steps turned pxlpeep into a stop-motion view of the algorithm**, making
broken logic and corner cases visible so they could be fixed. (This directly motivates a **toggleable
auto-reload / watch-the-file** capability — **ROADMAP #14** — which would turn that manual stop-motion
into a live animation.)
