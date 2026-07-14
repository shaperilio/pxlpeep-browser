# pxlpeep-browser — Wishlist / Roadmap

Running list of planned work. Keep newest thinking here so a session can be resumed
on another machine. See `CLAUDE.md` for architecture.

## In progress / next

### MV3 migration (branch: `mv3`)
Move off MV2 so the extension can ship to Chrome *and* Firefox from one codebase, cut
permissions (easier store review), and fix the cache-miss-vs-browser download.
- **Approach:** in-place content-script takeover at `document_start` (check
  `document.contentType`, take over in place — no redirect, no `webRequest`). **Do NOT**
  reinstate the MV3 inject-on-top model that was already reverted (see CLAUDE.md history).
- Open question: confirm a static `<all_urls>` `document_start` content script reliably
  runs on the browser's native image document in both Chrome and Firefox. If not, fall
  back to a single non-blocking `onHeadersReceived` → `tabs.update` redirect to
  `viewer.html` (costs a brief flash of the native image, but deterministic).

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

## Platforms

### Tauri desktop wrapper
For the native "double-click a local file opens pxlpeep" experience the browser extension
can't provide (OS file associations point at apps, not extensions). `content/main.js` is
self-contained vanilla JS + WebGL2, so it can be reused almost verbatim inside a Tauri
shell (lightweight, OS webview). Gives real file associations + single-window behavior.

## Polish / store prep

- Fix icon mismatch: the `48` slot in `manifest.json` points at `icon_64x64.png`.
- Remove leftover `console.log` debug lines in `background/worker.js`.
- Write a privacy policy (required by stores given broad host permissions; states no data
  collected, only fetches the image you opened).
- Chrome Web Store: needs MV3, one-time $5 registration. Firefox AMO: MV2 still accepted,
  free; add `browser_specific_settings.gecko.id`.
- **Download progress UI** — deferred. Only worth building if we stay on the redirect
  architecture; the in-place MV3 takeover makes it moot (browser already downloaded, our
  fetch is a cache hit). A minimal "Loading…" placeholder already exists.

## Done (recent session)

- `35c2c50` — fetch source image once, reuse the Blob (2–3 requests → 1).
- `7175a9a` — surface fetch errors with a retryable DOM overlay + 30s timeout.
- `d714ecd` — auto-retry transient server errors (429/502/503/504) with backoff +
  `Retry-After`.
