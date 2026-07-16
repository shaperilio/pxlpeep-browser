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

- **Manifest V3**, cross-browser (Chrome + Firefox) from one manifest, `chrome.*` namespace
  (no polyfill). Background is an ephemeral service worker (Chrome) / event page (Firefox) via
  a dual `background` key (`service_worker` + `scripts`). Permissions are just `contextMenus` +
  `host_permissions:["<all_urls>"]` — the content script's `matches:["<all_urls>"]` drives
  injection; the host permission is only for the viewer's cross-origin image fetch.
- **`content/takeover.js`** — the takeover. A `document_start`, `<all_urls>` content script. It
  checks `document.contentType` and does nothing unless the page is a standalone image
  document. On one, it covers the native view (a CSSOM-styled `<div>`, not a CSP-blockable
  `<style>`) and loads `main.js` into the page's **main world** (a `<script src>` at the
  web-accessible `content/main.js`). Running in the image document's own top-level context keeps
  the app's image fetch in the same **cache partition** the browser already populated — a hit,
  not a re-download. Same URL, no redirect.
  - **Hybrid CSP/sandbox fallback:** some image responses are sandboxed and/or carry a strict
    CSP (e.g. Google Photos sends `default-src 'none'` + sandbox), which blocks the injected
    main-world script from ever running. `takeover.js` detects that the app UI
    (`#pxlpeep-toolbar`) never appeared and messages the background to redirect the tab to
    `viewer.html` — our own extension origin, immune to the page's CSP/sandbox. That redirect's
    fetch lands in a different partition (re-download), but such responses are near-always
    no-store / auth'd = uncacheable anyway, so nothing is lost.
- **`background/worker.js`** — MV3 background. No `webRequest`. Hosts the "pxlpeep" image
  context menu (`contexts:["image"]`): an explicit parent — Chrome force-collapses 2+ items
  into a submenu anyway — with **View image** (this tab, `tabs.update`) and **Open image in
  new tab** (`tabs.create`), both opening `viewer.html?url=<srcUrl>`. The parent's icon is a
  Firefox-only `menus` feature added via UA sniff (Chrome throws on `icons` but decorates the
  top-level entry with the extension icon automatically). Also hosts the fallback-redirect
  message handler for `takeover.js`.
- **`viewer.html` + `viewer.js`** — the **forced** entry point, used by both the context menu
  and the CSP/sandbox fallback. `viewer.js` parses `?url=` into `window.__pxlpeepImageUrl`; the
  HTML loads `viewer.js` then `content/main.js`. Because it's our own extension page it bypasses
  any page CSP/sandbox and fetches with host permissions — so it works even on images served
  with a non-image Content-Type.
- **`content/main.js`** (~1700 lines) — **the entire app**, self-contained vanilla JS, zero
  dependencies, no bundler, no build step. Unchanged by the MV3 port: it runs in the page's main
  world both in-place (injected by `takeover.js`) and under `viewer.html`, and reads
  `window.__pxlpeepImageUrl || location.href`, so one file serves both paths.

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

## Why in-place takeover (and the paths not taken)

The MV3 in-place takeover replaced two earlier designs; the history explains the constraints:

- **Original MV2 (pre-MV3):** blocking `webRequest.onHeadersReceived` detected an image
  `main_frame` response, **cancelled** it, and redirected the tab to `viewer.html`. It worked
  but was effectively Firefox-only (blocking `webRequest` is gone in Chrome MV3), needed heavy
  permissions, and re-downloaded the image (the cancel discarded the download, and the viewer
  fetch is a different cache partition than the original top-level load).
- **A brief, reverted MV3 "inject-on-top"** (reverted in commit `80add57`, "Go back to V2"):
  let the browser render the native image and injected `main.js` on top via a two-step
  `onHeadersReceived` → `tabs.onUpdated` dance, storing tab IDs in an **in-memory `Set`**. That
  Set is wiped when the service worker is evicted between the two events → injection silently
  fails. **Do NOT reinstate this.**

The in-place content-script takeover avoids both: no `webRequest`, genuinely cross-browser,
minimal permissions, and a same-partition cache hit for normal images. A `document_start`
content script was verified to run on the browser's synthetic image document in **both** Chrome
and Firefox. The only case it can't do in place — sandboxed / strict-CSP responses — is caught
by the hybrid fallback above.

Cross-browser gotchas learned here: modern **Chrome also exposes the `browser` global**, so it
can't distinguish Chrome from Firefox (use a UA sniff for Firefox-only bits like menu `icons`).
**Firefox has no background service worker** (as of 2026), hence the dual `background` key —
which makes Chrome log a harmless `'background.scripts' requires manifest version of 2 or lower`
warning; the real fix is per-browser manifests at store-packaging time (see `ROADMAP.md`).

## Testing / verification

No tests are checked in; `node_modules`, `package.json`, and the test artifacts are all
gitignored, so there's no committed harness. There is no build — `node --check` on the JS files
(`content/takeover.js`, `background/worker.js`, `content/main.js`) is the syntax gate.

**Playwright verification pattern:** spin a local `http` server that serves the extension files
AND a controllable image endpoint, then drive headless Chromium. Two angles:
- Load `viewer.html?url=<localImage>` directly and assert on network request counts and
  `window.__pxlpeep.S` — the controllable endpoint can return 503/404/garbage-bytes/hang to
  drive every error path deterministically.
- Load the **unpacked extension** and navigate to a local image to exercise the in-place
  takeover; serve an image with `Content-Security-Policy: default-src 'none'` + sandbox headers
  to reproduce the Google-Photos class of failure and assert the fallback redirect fires.
- Firefox behavior, the context menu (native UI), and real-site auth can't be covered
  headlessly — load the unpacked extension in each browser and test by hand.

Set up Playwright ad hoc when needed (`npm init -y && npm i -D playwright && npx playwright
install chromium`), run scratch harnesses from the repo root, delete after.

## Conventions

- Prettier: 100 col, 2-space, double quotes, es5 trailing commas (`prettier.config.json`).
- Vanilla JS only, no framework, no build. Styling via `Object.assign(el.style, {...})`.
- Shell: this is a Windows repo. The Bash tool uses POSIX sh; the PowerShell tool uses
  PS syntax — don't mix (`@'...'@` here-strings are PowerShell-only).
- Git: `origin` is `github-shaperilio:shaperilio/pxlpeep-browser`.
