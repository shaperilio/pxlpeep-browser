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

### 1. Animated GIF + modern animated variants
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

### 2. Video
Same pxlpeep functionality on video, plus frame-by-frame forward/backward.
- **Approach options:** `<video>` + `requestVideoFrameCallback` for playback + draw current
  frame to a texture; or **WebCodecs `VideoDecoder`** for precise per-frame access
  (`<video>.currentTime` seeking is not frame-accurate). Pixel analysis runs on the current
  frame.

### Shared architecture note for #1 and #2
Both turn pxlpeep from a single-image inspector into a **frame-sequence inspector**. Needs:
- A "current frame" concept in `S`, frame navigation (keys + toolbar: next/prev frame,
  maybe play/pause), and re-running the analysis pipeline per frame.
- WebCodecs (`ImageDecoder`/`VideoDecoder`) is the unifying modern API for both. Check
  browser support and how it interacts with the MV3 content-script context.
- Decide whether min/max/scale is per-frame or locked across the sequence (per-frame would
  make brightness flicker; a locked/global range is probably wanted — design decision).

### 3. Close pxlpeep (revert to native image handling)
An in-viewer way out (toolbar ✕ and/or a key, e.g. `Esc`) that tears pxlpeep down and gives
the tab back to the browser's native image view.
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
  persistent pxlpeep tab; cross-tab sync via the background service worker as a delta relay.
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
- **Approach:** a real in-JS decoder (TIFF / PNG-16 → `Uint16`/`Float32`, later float) feeding the
  existing Float32 GPU texture path. The shader's `uMaxRaw` machinery is already threaded for it
  (the "dead generality" in CLAUDE.md). Pairs with TIFF support (`PARITY.md` §6).
- **Need high-bit-depth test images — we have none** (every current fixture is ≤ 8-bit; see
  `test_images/README.md`). Key subtlety: **bit depth is not recoverable from the raw bytes** — a
  "fully white" 14-bit image and a "very bright" 16-bit image are byte-identical on disk. ImageJ's
  auto-scaling nonetheless seemed to *infer* the true bit depth, so we need fixtures that are **not
  fully white / not saturated** (partial-range 12/14/16-bit content) to experiment with that
  detection. Ties into the far-side "auto-detect real bit depth (ImageJ heuristic)" research.
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

### 7. Perceptually-uniform / cognitive-response palettes
The current palettes (`buildLUT`, ported from the C++ `colormapper.h`) were designed ad hoc for
specific past applications. Add palette(s) grounded in human perception, where equal *value* steps
map to equal *perceived* steps.
- **Perceptually-uniform greyscale:** map so the perceived lightness difference between any two
  grey values is constant across dark→light (constant ΔL\* in CIE L\*a\*b\*, converted to sRGB),
  instead of the naive linear 0–255 ramp whose perceived contrast is uneven.
- **Perceptually-uniform color maps** (the viridis / cividis / magma family) as false-color options
  — monotonic in lightness, colorblind-safe, and without the misleading bright/dark bands a naive
  rainbow produces.
- Fits the existing 256×N LUT machinery cleanly — just additional computed palette rows; the
  shader / colorbar path is unchanged.
- **References** (read Kovesi first; cite it when we implement):
  - Kovesi, "Good Colour Maps: How to Design Them" — https://arxiv.org/abs/1509.03700 — the
    authoritative design method (uniform perceptual contrast / constant lightness gradient).
    **§6 "Colours for Ternary Images" is of particular interest to pxlpeep** — it's a
    3-channel / RGB inspector, so perceptual colours for ternary (three-component) data apply
    directly, on top of the single-channel colormaps we also want.
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
- **Loupe icon** — replace Tauri's default icons with the pxlpeep loupe (`tauri icon` from a
  high-res source; the C++ `loupe.icns` / `loupe.ico` / `loupe.iconset` are the source art).

## Test fixtures

- ✅ **Copied the C++ test images** into `test_images/` (14 files) with a factual index in
  `test_images/README.md`. Each is purpose-built (format, bit depth, channels, transparency,
  tiny/odd dimensions, CMYK). Remaining: confirm/annotate the exact "what each checks" (the author
  designed them), extend the set, and wire them into the eventual CI/Playwright harness. Several are
  TIFF/CMYK, which the browser can't decode today — ties into Feature #5 (16-bit / TIFF decoder).

## Polish / store prep

- Fix icon mismatch: the `48` slot in `manifest.json` points at `icon_64x64.png`.
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
