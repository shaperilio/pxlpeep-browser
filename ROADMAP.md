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

### 5. Restore the 16-bit / high-bit-depth pipeline — HIGH VALUE
See `PARITY.md` §1. The C++ app is fundamentally a high-bit-depth inspector (16-bit, 14-bit
RAW; readouts / Fit+User scale / colorbar over 0–65535). The browser port decodes through an
8-bit canvas and hardcodes `bpp:8`, silently truncating every 16-bit image to 8 bits — the
core dynamic range of a *pixel-value inspector* is lost.
- **Approach:** a real in-JS 16-bit decoder (TIFF / PNG-16 → `Uint16`/`Float32`) feeding the
  existing Float32 GPU texture path. The shader's `uMaxRaw` machinery is already threaded for it
  (the "dead generality" in CLAUDE.md). Pairs with TIFF support (`PARITY.md` §6).
- Big effort, shared by both targets; arguably the highest-value single feature for what
  pxlpeep fundamentally *is*.

### 6. Back-port the "free wins" from the C++ original (`PARITY.md` §5)
Small portable behaviors the browser port dropped; do as a batch.
- ✅ **Ctrl+3–7 center / corner positioning** — done (`e7bb475`), confirmed working in a real
  browser (the `Ctrl+<number>` binding reaches the page; it isn't eaten by tab-switching).
- **Recompute min/max after white balance** so Fit-scale + colorbar track the correction
  (currently ignored — a real gap).
- **Fit min/max over per-channel values, not luminance** (color images differ from desktop).
- **Clipboard copy (Ctrl+C)** of the mapped image / screenshot (Ctrl+C is free now that saves
  moved to Ctrl+S variants).
- **Self-documenting "save mapped" filenames** (encode palette/fn/scale/dip/rotation).
- **Reload control** (clear `_sourceBlobPromise` + re-run `startLoad`; F5/Ctrl+R are
  browser-reserved, so a toolbar button).
- **Show EXIF firmware** (already parsed into `S.exif.firmware`, just not displayed) + app
  version in the help header.

## Platforms

### Tauri desktop wrapper
For the native "double-click a local file opens pxlpeep" experience the browser extension
can't provide (OS file associations point at apps, not extensions). `content/main.js` is
self-contained vanilla JS + WebGL2, so it can be reused almost verbatim inside a Tauri
shell (lightweight, OS webview). Gives real file associations + single-window behavior.

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
