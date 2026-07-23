# pxlpeep — C++ ↔ browser parity

What the desktop C++ pxlpeep (`C:\Users\barf\pxlpeep`, ~4k LOC: `MainDialog.*`, `ImageWindow.cpp`
[2376], `ImageData.cpp`, `colormapper.h`) does that the browser port dropped or changed. Captured
by reading the source directly. Use this to steer the Tauri desktop build and to decide what's worth
back-porting to the browser. See `ROADMAP.md` for the queued items; see `CLAUDE.md` for the current
browser architecture.

Categories: **desktop-only** (filesystem / OS-window-manager bound), **portable** (belongs in shared
`content/main.js`), **already-ported**.

---

## 1. The big one — 16-bit / high-bit-depth pipeline (portable, MAJOR loss)

pxlpeep is *fundamentally a high-bit-depth inspector*. The C++ loads 16-bit greyscale, 16-bit color,
and 14-bit RAW, and every readout / Fit+User auto-scale / log+parabolic transfer function / colorbar
operates over the full **0–65535** domain (`ImageData`: `ushort*` storage, `BPP` 1/4/8/14/16).

The browser port **silently truncates everything to 8-bit**: it decodes through an 8-bit canvas
`getImageData` and hardcodes `bpp:8` (`main.js:601`), so `uMaxRaw` is always 255 and the whole
dynamic range collapses to 0–255. This is the single biggest capability lost — for a *pixel-value
inspector*, losing the low 8 bits of a 16-bit image is the core feature quietly disappearing.

- **Restore path:** a real in-JS 16-bit decoder (TIFF / PNG-16 → `Uint16`/`Float32` array) feeding
  the existing Float32 GPU texture path. The shader's `uMaxRaw` machinery is *already* threaded for
  this (the "dead generality" noted in `CLAUDE.md`). Big effort, high value, and shared by both
  targets. Tauri can also lean on a native decoder.

## 2. Sync architecture — the centerpiece for multi-window / multi-tab

The desktop feature you want to revive. The mechanism, precisely, then the design decision.

**Event-replay, not state-replication.** Each viewer's input handler (a) emits a signal carrying the
*raw event* + its window ID, then (b) runs the handler locally. `MainDialog` relays the raw event to
every *other* window's `handle*(event, forwarded=true)`. Loop-safety: only the raw Qt overrides emit;
the forwarded `handle*` calls never re-emit. Originator is skipped by window ID.
(`ImageWindow.cpp:578-701, 2412-2435`; `MainDialog.cpp:100-181`.)

**What is broadcast is the input, not the resulting state** — "wheel +120", "V pressed", "pan Δ",
*not* "zoom=4" / "palette=Viridis". Every receiver re-derives from **its own** current state
(`map++` from its own colormap, `zoomLevel += 1` from its own level, scrollbars nudged by the drag Δ).
This is what keeps windows deliberately **out of phase** — set a colormap on group A, later add group
B to the sync, and subsequent changes move both while preserving their offset. **This is the intended
design, not a bug.**

**Two different "out of phase" — keep one, fix the other:**
- ✅ **Intentional offset** (the feature): windows at deliberately different palette/zoom/pan; relative
  stepping preserves the gap. Keep this.
- ⚠️ **Accidental drift** (a C++ imperfection): the zoom anchor is the *source* window's **viewport
  pixel** mapped through **each** receiver's own transform, and pan is applied as **scrollbar
  (viewport-pixel) deltas** — so at different zooms the same pixel Δ = different *image-space* motion,
  and windows that started aligned progressively drift. C++ papers over this with `resetWheelAccumulator()`
  (phase-align on sync-enable) and absolute escape hatches (Ctrl+2 1:1, Ctrl+3 center).
  (`ImageWindow.cpp:675-694, 608-666`.)
- **Our port should express continuous deltas in IMAGE coordinates** (zoom anchor, pan Δ, ROI corners
  in image space; discrete steps like `palette++` / `zoomLevel ±1` stay relative). That preserves the
  deliberate offset **and** eliminates the accidental drift — strictly better than the original.
  **(Decided: proceed this way. If the C++ drift turns out to be intentional after all, it's
  cheap to fudge back in.)**

**What syncs vs. stays local** (C++ gates locals with `!forwarded`):
- **Synced:** zoom, pan, ROI select, and all display toggles — colormap (V), transfer fn (F), dip
  (+/-), channels (R/G/B = XOR toggle; **Shift+R/G/B = absolute set**, one of the few re-converging
  ops), rotate (A), flip (L/T), scaling mode (S), overlays (I/Space/C/X/Y/0), placements (Ctrl+1-7).
- **Local only:** window move/snap/geometry, per-pixel cursor readout, white balance (explicitly
  `if(forwarded) break;`), all file/clipboard/reload ops. Prev/next *does* replicate but each window
  walks *its own* folder. (Two latent C++ bugs: Ctrl+F4 replicates close to all windows while Ctrl+W
  is local; Alt+digit bucket-copy replicates as a file op — both from a missing `!forwarded` guard.)

**Groups:** C++ has a **single global on/off, no groups** (`syncWindows` bool). Your "selectable per
window-set" is a genuine *extension* — a viewer holds a group id; broadcast within the group; expose
absolute "align to this window" / 1:1 / center as re-sync escape hatches.

**Transport per target:**
- **Tauri:** all viewers share one process → in-process event bus / direct calls. Easy. Prototype the
  sync engine here.
- **Browser:** pxlpeep tabs are isolated. **In-place** tabs live on the *image's* origin, so
  `BroadcastChannel` can't reach across them — sync must route through the **background service
  worker** as a relay. **But** if pxlpeep runs in *our own* `viewer.html` tabs (extension origin),
  same-origin `BroadcastChannel` / shared state Just Works. → **This is the real argument for your
  "manage our own pxlpeep tabs" idea:** it's not just a playlist, it's what makes browser sync
  tractable. Likely shape: in-place takeover stays the default single-image quick-look; a **"pxlpeep
  workspace" (viewer-based) tab** is the opt-in surface for multi-image + sync.

**Shared core:** the sync *engine* (delta model + groups + the relative/absolute op split) and the
image-list/frame navigation live in `main.js`; only the **transport** and the **image source** differ
per target. This is the multi-`S`-instances + sync-layer evolution of the single-`S` model.

## 3. Folder navigation → browser "playlist" (desktop-only mechanism, portable idea)

- **Arrow keys** cycle prev/next image; list = **same directory + same extension, files only,
  non-recursive**, **natural/numeric sort** (`img2` before `img10`), **wrap-around** both ends. Live
  re-scan of the dir on every step (picks up added/removed files). 10-slot in-memory LRU cache keyed
  by path+mtime for instant back/forth. (`ImageWindow.cpp:2524-2612`.)
- **Desktop-only** as written (filesystem enumeration). The *logic* is portable — numeric sort is
  `Intl.Collator({numeric:true})`; wrap-around is trivial — but there's **no list to walk** from an
  image URL.
- **Browser adaptation:** the "own pxlpeep tabs" playlist. Context-menu "send image to pxlpeep"
  appends a URL to a workspace tab's list; arrows walk the list. Same-extension grouping becomes an
  optional filter on the playlist.

## 4. Window management / snapping (desktop-only — Tauri gets it, browser can't)

Frameless viewer windows with **app-defined keyboard tiling**: Ctrl+←/→ = left/right half, Ctrl+Shift
+arrows = top quarters, Alt+Shift+arrows = bottom quarters, Ctrl+↑ = maximize, Ctrl+↓ = restore;
re-pressing the same direction **spills onto the adjacent monitor** (multi-display, left-to-right
ordered). Right-drag moves the window. (`ImageWindow.cpp:1530-1716, 2075-2153`.) All pure OS
window-geometry; **not** replicated across synced windows. No browser analog for a tab; Tauri
reimplements via window move/resize (and it's the whole reason the C++ windows are frameless).

## 5. Portable, low-hanging fruit missing from the browser

Worth adding to the shared core (benefits both targets); mostly small:
- **Ctrl+3–7 center / corner image placement** — portable, not yet ported (Ctrl+1 fit / Ctrl+2 1:1
  already are). `ImageWindow.cpp:703-757`.
- **Recompute min/max after white balance** so Fit-scale + colorbar track the correction. The JS WB
  handlers never call `recalcScale()`, so Fit/colorbar currently ignore WB entirely. Real behavioral
  gap. `main.js:1154-1164, 1441-1449`.
- **Fit min/max over per-channel values, not luminance** — JS uses luminance for color images
  (`main.js:595-597`); C++ uses per-channel sample range, so Fit bounds differ.
- **Clipboard copy (Ctrl+C) of mapped image / screenshot** — Ctrl+C is now free (saves moved to
  Ctrl+S variants); achievable via the async Clipboard API from the existing composited canvas.
- **Parameter-encoded "save mapped" filenames** — C++ bakes palette/fn/scale/dip/rotation into the
  filename (self-documenting). Reconstructable from `S`. JS currently uses `_mapped_<timestamp>`.
- **Reload control** — clear `_sourceBlobPromise` + re-run `startLoad` from a toolbar button (F5/Ctrl+R
  are browser-reserved).
- **Show EXIF firmware / app version** — `S.exif.firmware` is already parsed but never displayed;
  `manifest.version` could show in the help header. Trivial, low value.

## 6. Formats (portable via decoders; mostly desktop-realistic)

C++ via FreeImage opens **TIFF** (incl. 16-bit), **PSD**, and **headerless RAW Bayer** dumps
(dimension-guessed from a sensor-size table, 14-bit — this feeds the Bayer-quad grey WB that *is*
ported). Browsers decode none of these, and for TIFF the takeover wouldn't even fire (browsers offer
it as a download, not an inline image document). Tauri can use native decoders; the browser would need
JS parsers (TIFF is the only broadly worthwhile one, and it pairs with the 16-bit pipeline in §1).

## 7. WB semantics differ (behavioral note, not strictly "lost")

C++ WB is **destructive + cumulative** — it multiplies the stored pixels and repeated WB *compounds*
(iterate: correct, then correct again on corrected data). JS WB is **non-destructive + single-shot** —
gains are shader uniforms computed from the *original* pixels and each WB *replaces* the last
(`main.js:726-772, 1157-1163`). The JS approach is cleaner, but the "iterate on corrected data"
workflow is gone; to match C++, multiply new gains into the existing `S.wbColor/wbGrey` and compute
new ROI averages from post-WB values.

## 8. Not actually lost (dead generality)

`minIndex`/`maxIndex` (pixel index of min/max) is computed in C++ but **unused** in the desktop UI
(grep-confirmed zero uses) — safe to keep omitting.
