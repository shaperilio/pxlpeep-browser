# pxlpeep-browser

Browser-extension port of the C++ desktop app **pxlpeep** (a Qt/FreeImage power-user
image inspector). When you open a direct image URL, pxlpeep takes over the page and
replaces the browser's native image view with a WebGL2 pixel inspector: nearest-neighbor
zoom/pan, live per-pixel readout, rulers, ROI distance/area with calibration, false-color
palettes + colorbar, log/parabolic transfer functions, per-channel solo, saturation
warnings, rotate/flip, ROI-sampled white balance (incl. Bayer-quad grey WB), EXIF, and
export (original / palette-mapped / screenshot).

Ported from the C++ original by shaperilio. Provenance noted at `content/main.js:2`.

## Architecture

- **Manifest V2** (Firefox-oriented; uses `browser.*`, persistent background page).
- **`background/worker.js`** — the interception. Blocking `webRequest.onHeadersReceived`
  detects `main_frame` responses with an image `Content-Type`, cancels the request, and
  redirects the tab to `viewer.html?url=<original URL>`.
- **`viewer.html` + `viewer.js`** — trivial glue. `viewer.js` parses `?url=` into
  `window.__pxlpeepImageUrl`; the HTML loads `viewer.js` then `content/main.js`.
- **`content/main.js`** (~1700 lines) — **the entire app**, self-contained vanilla JS,
  zero dependencies, no bundler, no build step. Loaded as a raw `<script>`.

### Key patterns in main.js
- Single mutable global state object **`S`**; a manual `requestFrame()` render loop and
  `refresh()`/`refreshToolbar()` — immediate-mode-GUI style carried over from the C++.
- Enums are plain objects mirroring C++ enums; channels are bitmask flags.
- **`Renderer`** — WebGL2; a big fragment shader does all pixel mapping on the GPU
  (channel select, WB, transfer functions, palette LUT, saturation warnings, rotate/flip).
- A second 2D **overlay canvas** draws the info box, rulers, colorbar, ROI, help.
- **`getSourceBlob(url)`** — fetches the source image **exactly once** (memoized) and the
  Blob is reused for pixel decode, EXIF parse, and save. Includes a 30s `AbortController`
  timeout, typed errors (`FetchError` with `kind`: http/timeout/network/decode), automatic
  backoff-retry for transient statuses (429/502/503/504, honoring `Retry-After`), and a
  retryable DOM error overlay (`setStatus`/`showLoadError`).
- Test hooks are exposed on `window.__pxlpeep` at the bottom of the file.

### C++ leftovers worth knowing
- `loadImage` always sets `bpp:8` (canvas readback ceiling), yet `maxRaw`/bit-depth
  machinery is threaded through as if higher depths were possible — dead generality.
- The multi-channel palette path reproduces a C++ BGRA-blue-byte quirk deliberately, to
  match the original's output.

## MV2 vs MV3 — important history

The project was briefly MV3 and **reverted** to MV2 (commit `80add57`). MV3 removed
blocking `webRequest`, so the MV3 version couldn't cancel/redirect; instead it let the
browser render the native image and injected `main.js` on top via a two-step
`onHeadersReceived` → `tabs.onUpdated` dance, storing tab IDs in an **in-memory `Set`**.
That Set is wiped when the MV3 service worker is evicted between the two events → injection
silently fails. That flakiness is why MV2 came back.

**Planned MV3 approach (see WISHLIST):** do NOT reinstate the inject-on-top model. Prefer
an **in-place content-script takeover** — a `document_start` content script that checks
`document.contentType`, and if it's an image, takes over the page in place (same URL, no
redirect). This is genuinely cross-browser (Chrome + Firefox), needs no `webRequest`, cuts
permissions (easier store review), and fixes the cache-miss issue (the browser already
downloaded the image; our same-origin fetch is a cache hit). MV3 work happens on the
`mv3` branch; `main` stays the known-good MV2 build.

## Testing / verification

No tests are checked in (`.gitignore` excludes the harness). `playwright` is a devDep.
There is no build; `node --check content/main.js` is the syntax gate.

**Verification pattern used this session** (Playwright): spin a local `http` server that
serves the extension files AND a controllable image endpoint, load
`viewer.html?url=<localImage>` in headless chromium, then assert on network request counts
and on `window.__pxlpeep.S`. A controllable endpoint can return 503/404/garbage-bytes/hang
to drive every error path deterministically. Scratch harnesses were run from the repo root
(so `node_modules` resolves) and deleted after.

**Gotcha:** the checked-out `node_modules` had a corrupted Playwright install (stripped
`.js` + browser binaries). Repair with `npm install && npx playwright install chromium`.

## Conventions

- Prettier: 100 col, 2-space, double quotes, es5 trailing commas (`prettier.config.json`).
- Vanilla JS only, no framework, no build. Styling via `Object.assign(el.style, {...})`.
- Shell: this is a Windows repo. The Bash tool uses POSIX sh; the PowerShell tool uses
  PS syntax — don't mix (`@'...'@` here-strings are PowerShell-only).
- Git: `origin` is `github-shaperilio:shaperilio/pxlpeep-browser`.
