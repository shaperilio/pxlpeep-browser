# pxlpeep-browser — Roadmap

Running list of planned work. Keep newest thinking here so a session can be resumed
on another machine. See `CLAUDE.md` for architecture.

## In progress / next

Nothing in flight — MV3 shipped (below). Next is whatever gets picked from **Features** or
**Polish / store prep**.

### MV3 migration — DONE (merged to `main` 2026-07; `mv3` branch deleted)
Moved off MV2 so the extension ships to Chrome *and* Firefox from one codebase, cut
permissions (easier store review), and fixed the cache-miss-vs-browser download.

**Approach — in-place content-script takeover (implemented; works in Chrome + Firefox).**
A `document_start`, `<all_urls>` content script (`content/takeover.js`) checks
`document.contentType`; on a standalone image document it suppresses the native view and
loads `main.js` in place — same URL, no redirect, no `webRequest`. `content/main.js` is
unchanged; `viewer.html`/`viewer.js` are kept as the *forced* entry point for the context
menu. Do **not** reinstate the reverted inject-on-top model (see CLAUDE.md history).

- The open question — "does a `document_start` content script run on the browser's native
  image document?" — is **resolved: yes, in both Chrome and Firefox** (verified with a
  throwaway probe).
- Permissions cut from `webRequest`/`webRequestBlocking`/`tabs`/`scripting`/`downloads`/
  `contextMenus`/`<all_urls>` down to just `contextMenus` + `host_permissions:["<all_urls>"]`.
- **CSP/sandbox images (e.g. Google Photos)** are handled by a **hybrid fallback**: those
  responses are sandboxed and/or carry `Content-Security-Policy: default-src 'none'`, which
  blocks the injected main-world `main.js`. `takeover.js` attempts the in-place takeover and,
  if the app UI (`#pxlpeep-toolbar`) never appears, messages the background to redirect the
  tab to `viewer.html` (our own origin, free of the page CSP/sandbox). Normal images stay
  in-place (same-partition cache hit); only the blocked minority redirect (a re-download,
  but those are near-always no-store/auth'd = uncacheable anyway).

## Features

### 1. Animated GIF + modern animated variants — NEEDS DESIGN
Support multi-frame images with **all existing pxlpeep functionality**, plus
**frame-by-frame forward/backward** navigation.
- Also cover animated **WebP**, **APNG**, **animated AVIF**. Investigate **Live Photos /
  Motion Photos** (Apple: HEIC still + separate MOV; Google: MP4 embedded in JPEG) —
  these are usually *paired/embedded*, not a single animated file; may need format-specific
  extraction. Mark as research.
- **Approach:** `<img>`/canvas only gives the *current* frame. Use the **WebCodecs
  `ImageDecoder`** API — it decodes animated GIF/WebP/AVIF/PNG and exposes frame count +
  per-frame decode (`decode({frameIndex})`). Each decoded frame flows into the existing
  pixel pipeline (Float32 upload, min/max, palette, WB, readout).

### 2. Video — NEEDS DESIGN
Same pxlpeep functionality on video, plus frame-by-frame forward/backward.
- **Approach options:** `<video>` + `requestVideoFrameCallback` for playback + draw current
  frame to a texture; or **WebCodecs `VideoDecoder`** for precise per-frame access
  (`<video>.currentTime` seeking is not frame-accurate). Pixel analysis runs on the current
  frame.

### Shared architecture note for #1 and #2 — the design gate
Both are **NEEDS DESIGN**: they turn pxlpeep from a single-image inspector into a **frame-sequence
inspector**, which is a real architecture shift, not a drop-in. Settle the open questions below (esp. the
per-frame-vs-locked scale call and the frame-navigation UX) before building either. Needs:
- A "current frame" concept in `S`, frame navigation (keys + toolbar: next/prev frame,
  maybe play/pause), and re-running the analysis pipeline per frame.
- WebCodecs (`ImageDecoder`/`VideoDecoder`) is the unifying modern API for both. Check
  browser support and how it interacts with the MV3 content-script context.
- Decide whether min/max/scale is per-frame or locked across the sequence (per-frame would
  make brightness flicker; a locked/global range is probably wanted — design decision).

### 3. Close pxlpeep (revert to native image handling)
An in-viewer way out (toolbar ✕ and/or a key) that tears pxlpeep down and gives the tab back to the
browser's native image view.
- **In-place path:** straightforward teardown — remove the canvases/toolbar/status overlay,
  un-hide the native `<img>`, restore the body styles, unhook the window listeners
  (keydown/keyup/resize), clear `window.__pxlpeepActive`.
- **Viewer path (context menu / CSP-sandbox fallback):** the extension page has no native
  view — "close" means navigating the tab back to the raw image URL. But that re-runs
  `content/takeover.js`, which takes over again (and for CSP/sandboxed images bounces right
  back to the viewer — an infinite loop). Needs a one-shot per-tab suppression flag the
  takeover consults, e.g. `chrome.storage.session` keyed by tab id, set by the background
  just before navigating. (SW in-memory state is NOT reliable for this — that's the eviction
  bug that killed the old inject-on-top design.)

### 4. Multi-image navigation + cross-viewer sync (parity with the C++ original) — NEEDS DESIGN
The desktop C++ app did a lot the browser port dropped. **Full capture in `PARITY.md`**
(read that first — it has the exact sync mechanism, the delta-vs-drift design call, and the
back-portable items). The gist:
- **Launcher window** — up to ~10 viewers open at once.
- **Sync propagates state *changes* (deltas), not absolute state**, across a sync group — so
  windows deliberately stay "out of phase": set a colormap on group A, *then* add group B to
  the sync, and subsequent colormap changes affect both while preserving their existing offset.
  Want the sync group **selectable per window-set**, not just global all-or-nothing.
- **Arrow-key folder navigation** — left/right cycle images of the *same extension in the same
  directory*, so parallel JPG/PNG sets can be driven in separate synced windows.
- **App-defined window snapping** (full / half-vertical / quarter desktop) for OSes without
  Windows-style snap.

Desktop vs browser split (the portability discipline for the Tauri work):
- **Desktop-only** (filesystem / window-manager bound): folder-by-extension navigation, window
  snapping.
- **Browser adaptation:** rather than one viewer per native image URL, **manage our own pxlpeep
  tabs** — a context-menu "send image to pxlpeep" appends to a *cycling playlist* in a
  persistent pxlpeep tab; cross-tab sync via the background service worker as a delta relay. Context
  menu might include, for example, "pxlpeep -> view to the right" or similar, which sends the
  selected image to the next pxlpeep tab to the right of the current tab, thus allowing the user to
  organize things by leveraging the browser's built-in tab organization tools.
- **Shared core:** the sync engine (delta model + selectable groups) and frame/image-list
  navigation live in `content/main.js` so both targets reuse them. This is a real evolution of
  the single-`S`-object model → multiple `S` instances + a sync layer.

Prereq done: C++ capture is in `PARITY.md`. Biggest separate finding: the browser port
silently truncates the C++ app's **16-bit pipeline** to 8-bit (see `PARITY.md` §1) — the core
"pixel inspector" dynamic range is lost; restoring it needs a JS 16-bit decoder feeding the
existing Float32 texture path.

### 5. Restore the high-bit-depth pipeline (16 / 32 / float)
See `PARITY.md` §1. The C++ handles 16-bit and 14-bit, with readouts / Fit+User scale / colorbar
spanning the full range. The browser port decodes through an 8-bit canvas and hardcodes `bpp:8`, so
any high-bit-depth source is silently truncated to 8 bits — a real lost capability for inspecting
scientific / medical / RAW images, even if much of pxlpeep's value is in the features that already
work fine at 8-bit. **No reason to cap at 16-bit** — design for 16, **32-bit, and eventually
floating-point** images too.
- **Decoder — PLAN OF RECORD: vendor `geotiff.js`** (MIT, pure JS, no wasm; mapping / geospatial
  pedigree). `readRasters()` returns **native-bit-depth typed arrays** — `Uint16Array` / `Float32Array`
  / `Float64Array` — feeding straight into the existing Float32 GPU texture path (the shader's `uMaxRaw`
  "dead generality" is already threaded for it). Robust where it counts: LZW / Deflate / PackBits, tiled
  + BigTIFF, horizontal predictors, true float samples. Ships a prebuilt UMD bundle exposing a `GeoTIFF`
  global, so we **vendor one reviewed file** (`content/vendor/geotiff.js`) loaded before `main.js`
  (viewer.html + the takeover path) — **no bundler, no build step, CSP-clean** (pure JS, no wasm /
  `SharedArrayBuffer`); its async API fits `getSourceBlob`. **This is the project's first runtime
  dependency** — when it lands, soften `CLAUDE.md`'s "zero dependencies" to "one vendored decoder, still
  no build step." Pairs with TIFF support (`PARITY.md` §6).
  - **Rejected alternatives:** hand-rolling (scope + maintenance we don't want to own); UTIF.js (tiny,
    but its convenience output is 8-bit RGBA — fights the native-bit-depth goal); wasm-vips (~4.6 MB +
    requires `SharedArrayBuffer` / cross-origin isolation — too heavy for a viewer).
  - **Companion:** real 16-bit **PNG** values (not canvas-truncated) via **UPNG.js** (Photopea, MIT,
    single file) if/when wanted — separate from the TIFF path.
  - geotiff gives the **declared** bit depth for free (it's in the TIFF header); inferring the *true
    dynamic range* (a 16-bit file holding 12/14-bit data) is the separate research bit below.
- **Need high-bit-depth test images — we have none** (every current fixture is ≤ 8-bit; see
  `test_images/README.md`). Key subtlety: **bit depth is not recoverable from the raw bytes** — a
  "fully white" 14-bit image and a "very bright" 16-bit image are byte-identical on disk. ImageJ's
  auto-scaling nonetheless seemed to *infer* the true bit depth, so we need fixtures that are **not
  fully white / not saturated** (partial-range 12/14/16-bit content) to experiment with that
  detection. Ties into the far-side "auto-detect real bit depth (ImageJ heuristic)" research.
- **Unlocks diverging palettes.** Float / non-integer data is naturally **signed / centred**
  (deviations, residuals, ± ranges), which is exactly where **diverging colormaps** (e.g.
  blue↔white↔red about a reference) belong — see #7. Add them together with a settable reference / zero
  point once this lands.
- Big effort, shared by both targets.

### 6. Back-port the "free wins" from the C++ original (`PARITY.md` §5)
Small portable behaviors the browser port dropped. **Sequencing:** they are not uniformly
target-independent — they split into *pure core* (identical in both targets, safe anytime) and
*env-touching* (land differently per target, so do them **after** the Tauri env seam exists and
implement them once through the abstraction rather than twice and reconciling).

**Pure core — safe anytime:**
- ✅ **Ctrl+3–7 center / corner positioning** — done (`e7bb475`), confirmed working in a real
  browser (the `Ctrl+<number>` binding reaches the page; it isn't eaten by tab-switching).
- ✅ **Recompute min/max after white balance** so Fit-scale + colorbar track the correction —
  done (`51d2eae`); `recomputeMinMax()` folds the WB gains in and re-runs on every WB apply.
- ✅ **Fit min/max over per-channel values, not luminance** — done (`51d2eae`); a single
  saturated channel now drives Fit scaling, matching the desktop.
- ✅ **Show EXIF Software/firmware field + app version in help header** — both done. Firmware
  display (`51d2eae`): the standard EXIF `Software` tag (0x0131), parsed into `S.exif.firmware`,
  shown in the info box and toolbar (make/date/firmware now HTML-escaped, closing an injection
  hole). App version: the help header now reads `pxlpeep <version>` from the `PXLPEEP_VERSION`
  constant. This unblocked a versioning decision — the repo is now **CalVer `YY.M.micro`** (started
  `26.7.0`), single source of truth in `package.json`, propagated by `npm run stamp` to the manifest
  / tauri.conf / Cargo.toml / the `main.js` constant (see CLAUDE.md → Conventions). Fixed the prior
  `1.0.0` vs `0.1.0` drift. (Distinct from the C++'s *camera-specific* MakerNote sensor/DSP/battery
  temperatures — single-vendor, deliberately not ported.)

**Env-touching — the `window.__pxlpeepEnv` seam now exists.** Browser defaults live in
`content/main.js` (download-anchor save + async Clipboard API); the Tauri shell overrides
individual keys in `content/desktop.js` via `Object.assign` (not `||`), so it can flip one flag —
today just `isDesktop:true` — and inherit the rest. Output features route through it, written once:
- ✅ **Clipboard copy** of the mapped image (**Ctrl+C**) / on-screen screenshot (**Ctrl+Shift+C**) —
  browser side done via `env.copyImage` (Clipboard API, PNG). Saves moved off Ctrl+C onto the
  Ctrl+S family; help text corrected. **Verified working in a real WebView2 build (CDP):** the async
  Clipboard API *write* succeeds silently with the keypress gesture — no native backend needed.
  (Clipboard *read* prompts for permission, but our copy path only writes, so that's irrelevant.)
- ✅ **Self-documenting "save mapped" filenames** — done via `mappedSuffix()`: readable tokens
  encoding scaling / transfer fn / palette / dip / rotation / flips / channels, e.g.
  `rgb_fit_logDark_cmap1_dip1.50_rot270_flipV_-GB.png` (the C++'s raw-int `_s0_f2_m5_r3`, made
  legible). Routed through `env.save`, so the native Save-As dialog reuses it verbatim in Tauri.
- ✅ **Reload control** — implemented. `reloadImage()` clears `_sourceBlobPromise` and re-runs
  `startLoad` (re-fetch, re-decode, re-parse EXIF); bound to **Ctrl+R / F5**, gated on
  `env.isDesktop` so the browser still lets those keys refresh the tab. `content/desktop.js` sets
  `isDesktop:true`. Browser-verified with `isDesktop` mocked: direct reload re-fetches; browser-mode
  F5/Ctrl+R don't hijack; desktop-mode F5 and Ctrl+R each re-fetch. Becomes useful in the browser
  too once the playlist/workspace lands (a bare tab refresh would then discard accumulated state).
  **Verified in a real `tauri build --debug` window via CDP:** physical F5 and Ctrl+R both reach the
  page handler and fire `reloadImage` (one asset re-fetch, in-page sentinel survives → no full-page
  reload); WebView2 does not eat them.
- ⚠️ **Desktop save UX — a native Save-As dialog is still wanted.** Verified via CDP: the browser
  download anchor *does* fire a real download in WebView2 (`downloadWillBegin` → `completed`), so
  saving works — but via WebView2's download flyout to the Downloads folder, not a Save-As dialog.
  The filename was also coming out as the percent-encoded asset path; **fixed** (`79c218a`) by
  deriving names from the real path (`S.imagePath` / `imageBaseName`), so mapped now writes
  `rgb_user_linear_grey.png`. Polish: a per-method `env.save` override in `desktop.js` calling the
  Tauri dialog + fs plugins for a real Save-As (pick location/name, drop the download flyout).

### 7. Perceptually-uniform / cognitive-response palettes — sequential maps done enough for now
`CET-L07` landed (perceptually-uniform blue→magenta→white, per-byte-safe; the `colourmaptest.png` fixture
was added to judge maps). **Decision (2026-08-02): no more sequential / greyscale perceptual maps for now —
we're good.** The ad-hoc `buildLUT` palettes (ported from the C++ `colormapper.h`) plus CET-L07 cover the
need. The greyscale / viridis-family bullets below are retained only as the design method if we ever
revisit; what stays genuinely open are the two that depend on *other* work first — **diverging** (gated on
the float pipeline, #5) and **ternary / isoluminant** (needs a new multi-channel colour path, #17).
- **Perceptually-uniform greyscale:** map so the perceived lightness difference between any two
  grey values is constant across dark→light (constant ΔL\* in CIE L\*a\*b\*, converted to sRGB),
  instead of the naive linear 0–255 ramp whose perceived contrast is uneven.
- **Perceptually-uniform color maps** (the viridis / cividis / magma family) as false-color options
  — monotonic in lightness, colorblind-safe, and without the misleading bright/dark bands a naive
  rainbow produces.
- **Sequential + greyscale maps fit the existing 256×N LUT cleanly** — just additional computed
  palette rows; the shader / colorbar path is unchanged. The LUT is **1D**: one scalar → one colour.
- **Diverging maps** (blue↔white↔red about a reference) are also 1D and slot into the same machinery,
  but only make sense once data can be **signed / centred** — i.e. the float / non-integer pipeline
  (**#5**). Defer them until then, with a settable reference / zero point.
- **Ternary / isoluminant multi-channel maps are the exception — they do NOT fit the current path.**
  See the ternary note under References; they need a new multi-channel colour path, not more LUT rows.
- **References** (read Kovesi first; cite it when we implement):
  - Kovesi, "Good Colour Maps: How to Design Them" — https://arxiv.org/abs/1509.03700 — the
    authoritative design method (uniform perceptual contrast / constant lightness gradient).
    **§6 "Colours for Ternary Images" is of particular interest to pxlpeep** — it's a
    3-channel / RGB inspector, so perceptual colours for ternary (three-component) data are a natural
    fit. **But the current paletting cannot express them:** the LUT is strictly 1D (scalar → colour),
    and the multi-channel path runs each channel through that *same* 1D LUT and keeps only one byte
    (the C++ BGRA-blue quirk in `main.js`) — there is no way to assign three isoluminant colours and
    blend them. Ternary therefore needs a **new multi-channel colour path** (per-channel isoluminant
    colour + additive blend, or a dedicated multi-channel shader branch) — a separate, larger task
    from the 1D maps, overlapping the > 3-channel / "layers" work (#17).
  - https://colorcet.com/ — Kovesi's CET maps with data + test images (the applied output).
  - https://colorcet.holoviz.org/ — Python packaging; reference RGB values to check our LUT.
  - https://bids.github.io/colormap/ — "A Better Default Colormap" (viridis origin; accessible
    intro to perceptual uniformity).

### 8. User-definable colormaps
Let users supply their own colormap by dropping numbers into a text file pxlpeep reads — e.g. a
simple list of RGB triples (256 rows, or a few control points interpolated), and ideally ingest
colorcet's downloadable CSVs directly. Reuses the same LUT machinery as #7 (just another palette
row built from external data). No need to design now.
- Loading mechanism differs by target: Tauri reads a file / config dir directly; the browser
  can't freely read local files, so a file picker / drag-drop / paste-into-settings. Decide later.

### 9. "About" panel (both targets)
An about panel — version, credit to the C++ original (shaperilio) + author, project link. Render it
as a **canvas overlay** using the existing status/error/help overlay pattern (`setStatus` /
`showLoadError` in `main.js`) so it's shared between the extension and the desktop app. Surface it
from the desktop app menu, and in the browser from the toolbar or a key (e.g. `?`).

### 10. Clipboard input + file-triage (remaining C++ help-menu shortcuts) — Tauri-only
Reconciling against the C++ help menu surfaced these, not ported and not previously captured.
**All of #10 is Tauri/desktop-only:** the browser extension only ever *inspects the image you
navigated to* (takeover / context menu), so it has no surface for pasting or opening arbitrary new
content — and it can't touch the filesystem anyway.
- **Paste image / URL from clipboard (Ctrl+V)** — paste a bitmap, or text that is a URL (download +
  inspect), via the Tauri clipboard. The URL half overlaps the existing viewer entry point. **Note:
  clipboard *read* pops a WebView2 "allow/block" permission prompt** (confirmed in the desktop CDP
  test — *write* is silent, but `navigator.clipboard.read()` prompts). So implement paste through the
  **Tauri clipboard-manager plugin** (native read, no web permission prompt), not the web Clipboard
  API — which is the reason this whole item is Tauri-only anyway.
- **Clipboard monitor / auto-open on copy (Ctrl+Alt+V)** — background-poll the clipboard and open any
  newly copied image/URL ("copy an image anywhere, it appears in pxlpeep"). Desktop-only (continuous
  polling isn't appropriate for a content script).
- **Delete current image to trash (Del)** — **wanted, in the C++ form** (two-stage, so nothing is
  irrecoverably destroyed mid-session): Del *moves* the current image into a `.pxlpeep_trash`
  subfolder of its directory. On app exit, if the trash holds anything, prompt *"Do you really want
  me to delete the trash folder?"* — on confirm, hard-delete the files and remove the emptied
  `.pxlpeep_trash` folder(s); otherwise leave them in place. Desktop-only (the browser can't/shouldn't
  touch the filesystem); the on-exit prompt lives in the app lifecycle, so it depends on the
  single-instance / main-window work.
- **Bucket sort (Alt+0-9)** — copy the current file into a `pxlpeep_bucket_N` folder for rapid
  triage/culling of a directory. Desktop-only; pairs with folder navigation (Feature #4).

### 11. Latched / multiple info boxes (screenshot annotation)
The cursor box's snap-to-pixel marker exists precisely so a screenshot is self-explanatory — the OS
cursor isn't captured, so the anchored marker shows which pixel the numbers describe. Extension: let
the user **drop several** anchored boxes on one image to annotate multiple points in a single
screenshot. Possible interaction: hold Space to show the live cursor box, **click to latch** a copy
to that pixel (each latched box keeps its own marker + X/Y/R/θ/value); some key clears them.
Cross-target (both the extension and the desktop app). `S` would need an array of latched readouts
that `drawAll` renders alongside the live one.

### 12. Surface the gesture tools in the toolbox — NEEDS DESIGN
The toolbar mirrors nearly every keyboard command now (a discoverability surface for new users — the
author lives in the keys and originally had no toolbar). The exceptions are the **gesture tools**,
which have deliberately key-centric UX that doesn't reduce to a button:
- **White balance** — hold `W` + drag a box (corner-snapped); `Alt+W` peek; `Shift+W` reset. (A lone
  `reset` toolbar button was tried and removed — half a tool reads as a no-op until you've computed a
  balance, so there's *no* WB toolbar affordance now until this whole family is designed.)
- **Measure** — hold `M` + drag a line; `Shift+M` pops the last.
- **Point / inspect (P)** — hold `P` for a live cursor box; click to pin; `Shift+P` pops the last.
- **Calibrate (U)** — sets units off the last measure; `Shift+U` cancels.
- **Esc** — clears the newest tool group.

These need real interaction design, not a checkbox. Candidate shape: **"arm the tool" mode buttons**
(click to enter WB/measure/inspect mode, then drag/click on the image; click again or Esc to exit) plus
a one-line **hint** in the toolbar showing the active tool's gesture, so a mouse-only user can discover
and drive them. Open questions: does a persistent "mode" fight the current hold-key model (which is
modeless — the tool is active only while the key is down)? Should the toolbar buttons be momentary
(press-and-hold analog) or sticky modes? How do peek (`Alt+W`) and undo (`Shift+*`) map to buttons?
Decide before building; the goal is *every command reachable from both surfaces* without breaking the
fast key-driven flow. (Context: this was split out of the key↔toolbar parallelism pass, which mirrored
all the easy button-shaped commands — zoom/position/reload/copy/channels/rotate/flip/axes/save/JPEG —
and left these for design.)

### 13. User-settable display scale (a real "custom" range) — mirror the units-calibration flow
The scale control is `fit` (auto min/max from the data) vs `full` (the fixed `0…max` range). "full"
was called "user" — a misnomer, since there is currently **no way for the user to actually set the
range**. Add a real user-settable range: a small in-app input (min + max) reached from the toolbar / a
key, exactly like the `U` units-calibration overlay that sets `unitPerPix`. Typing values switches to a
**custom** scale mode (the numbers drive `S.userMin`/`S.userMax` + `recalcScale`; colorbar and readout
follow). Keep `fit` and `full` as presets; **custom** becomes a third state once a range is entered.
Reuse the calibration overlay-input pattern (WebView2 blocks `window.prompt`, so one custom input
serves both shells). (Split out of the toolbar pass, where the `user`→`full` rename fixed the
misleading label but left the underlying gap.)

### 14. Toggleable auto-reload — watch the file (desktop-first)
A toggle that makes pxlpeep **watch the current image file** and reload it automatically whenever it
changes on disk, reusing the "reload changes nothing" semantics (keep zoom / pan / overlays) so the view
stays pinned as the pixels update.

Motivation (see `MOTIVATION.md` → *Camera calibration*): when debugging detection code that re-writes a
visualization image at each step, **manual** reload already gives a stop-motion view of the algorithm;
auto-reload turns it into a **live animation** — step the debugger (or let a pipeline run) and watch
pxlpeep update in place. Also covers the tweak-threshold-and-re-run loop hands-free.

- **Desktop (Tauri):** native file-watch (e.g. the `notify` crate) → emit an event → frontend calls
  `reloadImage()` (keep-view). Debounce rapid writes; tolerate truncated / mid-write reads (retry).
- **Browser:** no filesystem to watch; a remote URL could be polled via conditional requests
  (ETag / Last-Modified), but that's rarely the use case — desktop-first, browser maybe-later.
- **Toggle:** off by default (you don't always want the view refreshing under you); a control in the
  `image` toolbar row next to reload, plus a key.

### 15. White-balance-active indicator
Surface, visibly, when a **custom (non-identity) white balance is in effect** — right now nothing in the
UI says WB is on, so its side effects look like bugs. Concrete case that prompted this: an 8-bit JPG
showed a **"fit" scale of 0–300**, impossible for 8-bit — because WB gains (> 1) push the corrected
values past 255 and the Fit range tracks the corrected data. With no WB indicator, that 0–300 is
baffling.

- **Indicator:** a lit "WB" marker (toolbar / info box / colorbar title) whenever the stored WB gains
  (`S.wbColor` or the Bayer-quad gains) differ from identity — ideally showing the gains on hover.
- Consider having the **colorbar / scale readout flag that the range reflects WB-corrected values**
  (vs. raw), so a super-255 Fit range reads as intentional rather than a bug.
- Ties into the WB tool (see `DESIGN-NOTES.md`) and its eventual toolbar surfacing (ROADMAP #12).

### 16. Optional WB-corrected pixel readout
Today the info / cursor / P boxes always show **raw** file values — WB is display-only (see
`DESIGN-NOTES.md` → the WB-stays-raw decision). Playing with the **Alt+W peek** surfaced a real use case
for the opposite: sometimes you want the readout to show the **WB-corrected** value (what the display
actually shows after the gains) — e.g. to confirm a region reads neutral after balancing.

Design questions for later:
- A **toggle** (raw ↔ corrected), or show **both** (`raw → corrected`)? Which readouts — info box,
  cursor / P boxes, latched pins, all of them?
- How to make it unambiguous which is shown (ties to the **WB-active indicator, ROADMAP #15**).
- Keep **raw as the default / ground truth** (the whole point of an inspector); corrected is opt-in.
- Corrected values can exceed 255 (gains > 1) — same clip / range questions as the scale.

### 17. More than 3 channels ("layers") — RESEARCH, pretty unexplored
Display images with **more than 3 channels** — multispectral / hyperspectral, or the **"layers"** model
familiar from mapping / GIS (each channel a named layer you show / hide / assign a colour to). Today
pxlpeep assumes ≤ 3 (grey or RGB) end-to-end: the decode, the `S.channels` bitmask (R/G/B = 1/2/4), the
three channel toggles, the shader's 1D-LUT + multi-channel path, and the readout all bake in that
assumption. Open questions:
- **Sources** that carry > 3 channels — multi-sample / multi-page TIFF, OpenEXR, ENVI / GeoTIFF, … —
  tie into the decoder work (#5).
- **UI:** a channel / **layer list** (name, show / hide / solo, assign a colour) instead of three R/G/B
  buttons; what "the image" even means at 8 or 200 bands (pick 3 to map to RGB? composite?).
- **Colour assignment:** per-layer colour + blend — this is the *same* new multi-channel colour path the
  **ternary / isoluminant** maps in #7 need (neither fits the 1D LUT).
- **Naming:** past 3, "channels" reads oddly — "layers" (mapping usage) may fit better.

### 18. Multi-channel saturation display — NEEDS DESIGN
The `Grey+sat` / `Inv. grey+sat` palettes flag under/over-exposure in **single-channel** view (blue =
floor, red = ceiling). On a **colour image** (2+ channels) they currently degenerate to the per-channel
byte of the sat LUT — no real warning. Goal: **show where each channel saturates** when more than one is
selected. The per-channel byte swap can't carry this — a warning must *override the pixel with a distinct
colour*, which a per-channel byte can't inject — so it needs a **dedicated multi-channel branch** (extend
`satWarn(scalar)` → `satWarnMulti(R,G,B)`), triggered by the grey+sat palettes.

Design questions to settle:
- **Raw vs displayed clipping.** Today `satWarn` fires on the *mapped* value, so the warning shifts as you
  change the scale / transfer function. For inspection (especially camera eval) you usually want **raw**
  channel clipping — the value at its floor/ceiling in the *source* — which is physical and
  scale-independent. Lean: raw; consider switching the single-channel warning to raw too, for consistency.
- **Which channel, or just "clipped here"?** (A) any-channel — one colour if *any* active channel clips;
  (B) **per-channel complementary markers** — encode *which* channel(s) blew (R-only → cyan, G → magenta,
  B → yellow, pairs → the third channel's colour, all three → white), mirrored for the floor; (C) keep the
  true-colour / per-byte image and overlay the marker only on clipped pixels. Lean: **B** — for colour
  work, *which* channel is the whole point.
- **Both ends** — crushed floor *and* blown ceiling, per channel. Keep both.
- Legible colour code + thresholds (exact 0/max vs a near-threshold) TBD.

Ties to the per-byte colour work (#7) and the camera-evaluation use in `MOTIVATION.md` (blown channels are
a core thing to catch). Independent of the per-byte swap itself.

### 19. Auto display limits — ZScale + percentile clipping (scale pickers, not transfer functions)
Robust, automatic black/white-point selection for the **scale** — more ways to set `S.scaleMin` / `S.scaleMax`,
alongside the existing **fit** (data min/max) and **full** (`0…max`) presets and the user-settable **custom**
range (#13). Keep the distinction sharp: these are **limit pickers**, orthogonal to and composable with the
log / parabolic / gamma / asinh **transfer functions** — pick the range here, then whatever transfer function
remaps *within* it. They are not curves and do not belong in the function cycle.
- **Percentile / percentage clipping** — put the black / white points at settable low / high percentiles (e.g.
  1 % / 99 %) of the value distribution, ignoring outliers. Cheap: build a histogram (or sort a subsample) and
  read the cut points. A few hot / dead pixels then stop blowing the whole range the way raw min/max (**fit**)
  does.
- **ZScale** (IRAF / DS9 algorithm) — sample the image, sort the samples, fit a line to the central portion of
  the sorted values, derive `z1` / `z2` from the median and the fitted slope scaled by a contrast factor.
  Purpose-built for high-dynamic-range / astronomical data where the signal of interest occupies a thin slice
  of the range; robust to the bright tail that wrecks min/max.
- **Fit:** both slot into the existing scale-mode machinery — add them as scale presets next to fit / full /
  custom; each just computes `scaleMin` / `scaleMax`, then `recalcScale` (colorbar + readout follow).
  Subsample for speed on large images (both are `O(sample)`): percentile needs a histogram / partial sort,
  ZScale the line-fit.
- Pairs naturally with the high-bit-depth pipeline (#5), where plain min/max is least useful (huge ranges,
  sparse signal), and with the WB-past-max case (#15) where the nominal ceiling no longer bounds the data.

### 20. Alternative transfer functions (gamma adopted; asinh / normalized log surveyed, not planned)
Standard image-stretch curves surveyed against pxlpeep's own log / parabolic. **Update (2026-08-02): gamma was
adopted** (single-entry, `S.dipFactor` = exponent — see below); **asinh and normalized log remain
surveyed-but-not-planned.** The current parabolic + log brighten/darken stay as-is — deliberately *drastic*,
arrived at through experimentation; gamma joined them because it's the standard single-knob stretch and worth
playing with. asinh / normalized log are recorded only so the option is documented — revisit those only if a
concrete need appears.

Normalized forms below use input `x ∈ [0,1]` (the value after the scale maps it in) → output `y ∈ [0,1]`; `a`
is the primary knob (`b`, `c`, … if more were ever needed — none of these need a second). For reference,
pxlpeep's own two in that same normalized space:
- **Parabolic (current):** `y = 2(1−a)x² + (2a−1)x`, clamped. `a` = dip (brighten); darken uses `1/a`;
  `a = 1` → identity. (Derived from `parabolicResponse` in `content/main.js`; verified to match numerically.)
- **Log (current):** `y ∝ log₁₀(a²·x)`, floored at 0 then min–max rescaled. `a` = dip; brighten multiplies
  (`a²·x`), darken divides (`x∕a²`). The `a²` mainly sets where the dark end clips to black — it cancels out of
  the rescaled shape — so this never reaches identity and is the most aggressive shadow-lift of the set (the
  reason "more drastic" is by design).

The surveyed alternatives, for the record:
- **Gamma / power** — ✅ *implemented* (single `gamma` entry; `S.dipFactor` is the exponent, `dip = 1` identity,
  `< 1` brightens, `> 1` darkens; applied over the scale range like parabolic — `y = x^dip` normalized to
  `[scaleMin,scaleMax]`). `y = xᵃ`. `a` = exponent; one monotonic knob spans *both* directions (no separate
  brighten/darken modes), and it subsumes √ (`a = 0.5`) and x² (`a = 2`) — the tidiest single control, which is
  why it went in first.
- **Normalized log (DS9 / astropy `LogStretch`)** — `y = log(1 + a·x) ∕ log(1 + a)`. `a` = strength (astropy
  default 1000). Endpoint-clean (defined at `x = 0` via the `+1`, pinned to `y(1) = 1`) and genuinely tunable —
  the better-behaved cousin of the current log. `a → 0` → linear. Brighten-only (darken is its inverse,
  "power-dist").
- **Asinh (Lupton / DS9 `AsinhStretch`)** — `y = asinh(x∕a) ∕ asinh(1∕a)`, with `asinh(z) = ln(z + √(z²+1))`.
  `a` = soft-knee location (astropy default ~0.1). Linear for `x ≪ a`, logarithmic for `x ≫ a` — the only curve
  here that stays *linear near zero*, so it lifts faint detail without exploding noise and handles signed /
  near-zero data gracefully (relevant once the float pipeline #5 lands). `a → ∞` → linear; `sinh` is the darken
  mirror.

These are **scale-independent shape choices**, orthogonal to the auto-limit pickers in #19 (ZScale / percentile
set the *range*; these remap *within* it). If ever revisited: **gamma** is the most attractive as a unifier (one
knob, both directions), and **asinh** is the one that would add a genuinely new capability the current set lacks
(linear-near-zero, signed-data-friendly) — most relevant alongside the float / diverging-palette work (#5, #7).

### 21. Open RAW containers — DNG-scoped, sensor-plane inspection (builds on #5)
Open **digital-negative RAW as high-bit-depth sensor data** — the raw CFA (Bayer) mosaic shown as a
single-channel 16-bit image (actual per-photosite values, saturation, noise). That's the pixel-inspector view
that fits pxlpeep's camera-eval purpose — **not** a RAW *converter*: we deliberately skip develop-to-RGB
(demosaic + WB + colour matrix + gamma). Demosaicing stays the separate optional colour step (far side).

**Plan of record — write our own, scoped to DNG, on top of `geotiff.js` (#5).** RAW files are TIFF/EP-based
containers, so the container layer is just TIFF IFD reading — which geotiff already does. The user's instinct
holds: for the container it really is "just read the header."
- **Uncompressed DNG:** geotiff hands back the CFA plane as `Uint16Array` directly → display via the #5
  16-bit pipeline. Nearly free once #5 lands.
- **Compressed DNG (+ Canon lossless):** add a **lossless-JPEG decoder** (ITU-T.81 Huffman — a *different*
  codec from the baseline JPEG that browsers / geotiff handle; bounded, ~few hundred LOC). Opens most DNGs.
- Read `CFAPattern` / `BlackLevel` / `WhiteLevel` to interpret the plane; feed the existing Bayer-quad WB and
  (later) demosaicing.

**Scope discipline is the point:** DNG is an open, documented Adobe standard, and the sensor-plane focus keeps
us on the easy side of the compression wall. We do **not** chase proprietary CR3 / NEF / ARW / etc. — each is
its own reverse-engineering rabbit hole (the reason libraw/dcraw are enormous). Vendoring **libraw-wasm** would
open every camera but is explicitly **rejected**: multi-MB wasm blob, CSP `wasm-unsafe-eval` / `SharedArrayBuffer`
friction, and it develops to RGB rather than exposing sensor values — wrong shape and weight for this project.

- **Depends on #5** (geotiff container reading + the Float32 / 16-bit pipeline). Pairs with **demosaicing**
  (far side) for the optional colour view. **Distinct from** the far-side *headerless* raw — those carry no
  header at all; this is the opposite, a fully self-describing container.

### 22. LRU WebGL-context budget — stop hogging the ~16-context pool
Each pxlpeep tab holds a live WebGL context, and browsers cap how many can be live at once (Chrome ~16;
Firefox its own, GPU-dependent). Enough open pxlpeep tabs starve each other — and other sites — of contexts,
producing the "WebGL2 lost / unavailable" states (now *surfaced* with a clear message + a `webglcontextlost`
listener in `content/main.js`, but not yet *mitigated*).

**Idea (author's):** cap pxlpeep at **N live contexts, LRU-evicted** (default **4**). The N most-recently-viewed
tabs keep their context, so flipping between a couple of tabs never flashes; a tab that falls out of the
top-N **releases** its context to free the slot; on refocus it **re-acquires** — recreate the context and
re-upload from the retained `S.image.data` (no re-fetch, no re-decode — just the CPU→GPU texture push) — and
evicts the new least-recently-used tab.

Mechanism / gotchas:
- **Coordinator = the background service worker**, holding the LRU list of pxlpeep tab IDs. Each tab reports
  focus via the Page Visibility API (`visibilitychange`); the SW ranks recency and messages tabs to `release`
  (when they drop past N) or `re-acquire` (on refocus).
- **State must survive SW eviction** — persist the LRU list in `chrome.storage.session`, **not** an in-memory
  `Set` (that eviction bug is exactly what killed the reverted inject-on-top design; see CLAUDE.md history).
- **Main-world bridge:** the in-place `main.js` runs in the page's **main world** and has **no `chrome.*`** —
  so `release`/`re-acquire` route SW ↔ `takeover.js` (content script) ↔ `main.js` via `window.postMessage`.
  (The `viewer.html` path has `chrome.runtime` directly, so it's simpler there.)
- **Release** = deliberately drop the context (`WEBGL_lose_context.loseContext()` or tear down the renderer);
  **re-acquire** = the same path a `webglcontextrestored` auto-recover would use (rebuild program/buffers/LUT +
  re-upload the image texture).
- **Released-tab UX (design):** the 2D overlay (rulers / info / ROI) is WebGL-independent and could stay
  visible; the image re-appears on refocus. Decide the paused-state look.
- **N is user-configurable** (see #23): default 4, floor 1, ceiling ≈ browser cap − headroom.

Overlaps the multi-tab work (#4). The send-to-specific-tab playlist (#4) reduces the need (one tab → one
context), but this budget still helps whenever a user deliberately keeps several pxlpeep tabs open.

### 23. User settings (options page + `chrome.storage`)
No settings surface exists today. Add one: an extension **options page** (`options_ui`, embedded in the
browser's extensions page, or a full `options_page`) backed by **`chrome.storage.sync`** (synced across the
user's devices, ~100 KB quota; fall back to `storage.local` for anything larger). Storage is readable from the
SW, content scripts, and extension pages — **but not the page main world directly**, so a setting is either
passed into `main.js` at injection by the content script, or consumed only in the SW / content-script layer.

**Flagship setting: max live WebGL contexts (N)** for the LRU budget (#22) — consumed by the SW, so it needs
**no** main-world plumbing (clean first case). Other candidates once the plumbing exists: default palette /
transfer function / scale mode, force-JPEG default, auto-reload default (#14). Start minimal.

## Platforms

### Tauri desktop wrapper
Native "double-click a local file opens pxlpeep" (OS file associations point at apps, not
extensions). `content/main.js` is reused **verbatim** inside the Tauri shell — see
`src-tauri/README.md` for build prereqs.

- ✅ **Shell done** (`44803bb`): a native window loads the shared viewer via
  `content/desktop.html` + `desktop.js`, opening the image passed on the command line
  (argv → init-script → `convertFileSrc` → `main.js`, unchanged). Verified end-to-end over CDP.
- **File-open dialog** — *imperative.* An "open image" action that pops the standard OS open-file
  dialog (Tauri `dialog` plugin). TBD whether to populate the dialog filter with the image
  extensions we know we can decode (vs. just an all-files option). Naturally lives with the
  main-window design below.
- **Single-instance + coordinating "main window"** (design TBD — notes only). Replicate the C++
  model: exactly one running instance; a small "main window" that coordinates viewer windows.
  Double-clicking an associated image launches the app + opens a viewer; **subsequent** double-clicks
  open a **new viewer in the existing instance**, not a second process. Drag an image onto a viewer
  window → open it there; drag onto the main window → open a new viewer. (Tauri single-instance
  plugin + the multi-window/sync engine from Feature #4.)
- **Frameless viewer windows** (once the main window exists). Drop the OS title bar on viewer
  windows (`decorations: false`) so the pixels get the whole frame. Since that removes the drag
  handle, restore the C++ gesture: **right-button drag moves the window** (mousedown button 2 →
  Tauri `startDragging`, or manual reposition). The main window keeps normal chrome for now.
- ✅ **Loupe icon** (done): regenerated `src-tauri/icons/` from the in-repo
  `loupe.iconset/icon_256x256.png` via `npx tauri icon` (256px is ample for the Windows `.ico`, which
  tops out at 256; the mobile `android/`/`ios/` outputs and a stray `64x64.png` were pruned — this is
  desktop-only). Window / taskbar / exe icon is now the loupe. (A ≥1024px source would sharpen the
  macOS `.icns` and Store logos if we ever package those.)

## Test fixtures

- ✅ **Copied the C++ test images** into `test_images/` (14 files) with a factual index in
  `test_images/README.md`. Each is purpose-built (format, bit depth, channels, transparency,
  tiny/odd dimensions, CMYK). Remaining: confirm/annotate the exact "what each checks" (the author
  designed them), extend the set, and wire them into the eventual CI/Playwright harness. Several are
  TIFF/CMYK, which **neither target** decodes today (the desktop's WebView2 is Chromium, same codecs as
  the browser — no TIFF) — ties into Feature #5 (16-bit / TIFF decoder).

## Polish / store prep

- ✅ Fixed the manifest icon-size mismatch: the `48` slot pointed at `icon_64x64.png`; the keys now
  state each file's true size (`16 / 32 / 64 / 128`, plus `256`), so Chrome/Firefox scale honestly.
- **Per-browser manifests at packaging time.** One MV3 manifest serves both browsers via a
  dual `background` key (`service_worker` for Chrome, `scripts` for Firefox — Firefox still
  has no background service worker, confirmed 2026). Chrome loads and runs fine but shows a
  cosmetic warning: `'background.scripts' requires manifest version of 2 or lower`. It's
  harmless (Chrome ignores the key and uses the service worker) and left as-is for dev. The
  clean fix is to emit per-browser packages that each drop the other browser's key — which
  we need for the two stores anyway (Chrome Web Store vs AMO), so fold it into store
  packaging rather than bolting on a build step now.
- **Publish workflow (ideally automated) + release-time version bump.** Tie packaging to a single
  release action: compute the next CalVer from the date (`YY.M.micro`, micro = the next release that
  month), run `npm version <v> --no-git-tag-version` to bump + stamp every file (see CLAUDE.md →
  Conventions → Versioning), build the per-browser extension packages and the Tauri desktop bundles,
  and push to the Chrome Web Store / AMO / a desktop release. A helper like `scripts/next-version.js`
  (derive today's `YY.M.micro` from the current version) would make the bump fully hands-off.
  **Until this exists the version stays pinned** (currently `26.7.0`): no hand-bumping per change
  while the project is single-user — a version change should mean "a release went out", not "a
  commit landed". Depends on the per-browser-manifest split above.
- Write a privacy policy (required by stores given broad host permissions; states no data
  collected, only fetches the image you opened).
- Chrome Web Store & Firefox AMO: both now MV3. Chrome is a one-time $5 registration; AMO
  is free. Add `browser_specific_settings.gecko.id` (needed for MV3 signing on AMO).
- **Download progress UI** — deferred. Only worth building if we stay on the redirect
  architecture; the in-place MV3 takeover makes it moot (browser already downloaded, our
  fetch is a cache hit). A minimal "Loading…" placeholder already exists.

## Open-source / release

Make the repo a proper open-source project.
- **Choose a license — wants a considered, informed decision, so treat it as a real comparison,
  not a quick pick.** Candidates: MIT (simple, permissive), Apache-2.0 (permissive + explicit
  patent grant), GPL-3.0 (copyleft — derivatives stay open), MPL-2.0 (file-level copyleft, a
  middle ground). Weigh against the project's goals: adoption vs. keeping derivatives open,
  patent protection, store distribution, contribution terms, and the C++ heritage. No hard
  constraints from the code — the browser port has zero third-party deps, and the C++ original's
  Qt/FreeImage licensing does not bind the JS reimplementation. (Do a proper options write-up
  before deciding.)
- Add `LICENSE`.
- **Write a `README`** — there is none yet. What it is, a screenshot / short demo GIF, install
  (unpacked now; store links later), a keyboard/mouse cheatsheet, credit to the C++ original.
- Nice-to-haves: `CONTRIBUTING.md`, GitHub topics, a tiny CI (`node --check` + `prettier
  --check` on push).

## Far side (research / someday)

Advanced "true raw" inspection — low priority, research-y, and mostly only meaningful once the
16-bit+ pipeline (Feature #5) exists.

- **Arbitrary-bit-depth headerless raw ("true raw").** Support *any* bit depth for a headerless
  raw dump — not the 14-bit special case in the C++ (`PARITY.md` §6), which was a leftover from a
  specific years-ago task (**likely GoPro** sensor dumps — the C++ reader guesses dimensions from a
  hardcoded table of GoPro-ish sensor resolutions and assumes 14-bit). The general problem: given
  raw bytes with no header, recover dimensions, bit depth, packing, endianness, and channel layout.
- **Auto-detect the real bit depth.** ImageJ has code that infers a raw image's actual bit depth
  even when the data never reaches full-black / full-white — mechanism unknown (never looked into
  it); worth digging through ImageJ's implementation one day.
- **User-defined encoding** (alternative/complement to auto-detect): let the user declare how the
  image is encoded — width/height/bit-depth/packing/endianness/channel order — which would handle
  esoteric bit-packed formats no heuristic could guess.
- **Demosaicing.** Bayer (and other CFA) → RGB reconstruction, so raw sensor dumps can be viewed
  in color. Pairs with the raw support above and the existing Bayer-quad grey white balance
  (which only averages each 2×2 quad rather than interpolating a true color image).

## Done (recent sessions)

- `00c00f2` — fix sticky pan/ROI drag on off-window button release (pointer capture +
  self-heal; also un-sticks shift+drag ROI).
- `c20700b` — context menu: "pxlpeep" submenu with View image (this tab) / Open image in
  new tab.
- `530fee3`–`ff2e716` — **MV3 migration**: in-place takeover + CSP/sandbox hybrid fallback,
  permissions cut, CLAUDE.md rewritten. Merged to `main`.
- `187d61d` — "Open image in pxlpeep" image context-menu item (forced viewer path).
- `35c2c50` — fetch source image once, reuse the Blob (2–3 requests → 1).
- `7175a9a` — surface fetch errors with a retryable DOM overlay + 30s timeout.
- `d714ecd` — auto-retry transient server errors (429/502/503/504) with backoff +
  `Retry-After`.
