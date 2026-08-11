# Building pxlpeep (browser extension)

`npm run build` produces a complete, loadable extension for **both** browsers at once:

- `build/chrome/` — for Chrome (and other Chromium browsers: Edge, Brave, …)
- `build/firefox/` — for Firefox

There is no bundler and no transpile step: the "build" just copies the source files and writes a
per-browser `manifest.json`. `build/` is **not** committed — an unpacked extension isn't
installable by end users without the stores (see [Distribution](#distribution)).

## Prerequisites

**Node.js 18 or newer** — that is the _only_ requirement to build the extension. The build script
uses just the Node standard library, so **you do not even need `npm install`**.

- Install the current LTS from <https://nodejs.org/> (or your OS package manager).
- Check you're good to go:
  ```bash
  npm run check:prereqs
  ```
  It reports your Node version and confirms you're ready (it does **not** install anything — Node
  is a one-time standard install). `npm run build` runs this check automatically first.

_(Optional, and not needed to build: `npm install` pulls the dev tooling — Prettier for
`npm run format`, and the Tauri CLI for the separate desktop app. The desktop app additionally needs
Rust — see `src-tauri/README.md`. Neither is required for the browser extension.)_

## Build

```bash
git clone <repo-url>
cd pxlpeep-browser
npm run build
```

That writes `build/chrome/` and `build/firefox/`. Build just one with `npm run build:chrome` or
`npm run build:firefox`. Re-run after editing any source file (it's fast — it only copies).

## Load it in a browser

### Chrome / Chromium

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`build/chrome`** folder.
4. To use it in Incognito: open the extension's **Details** and enable **Allow in incognito**.

After a rebuild, click the **reload** (↻) icon on the extension card. If you changed the manifest
(e.g. switched branches), **remove and re-add** it instead — Chrome doesn't always apply manifest
changes (especially the incognito mode) on a plain reload.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select **`build/firefox/manifest.json`**.
3. To use it in Private Windows: on the add-on's entry in `about:addons`, allow it to **Run in
   Private Windows**.

This is a **temporary** install — it's removed when you close Firefox. A permanent install requires
a signed `.xpi` from Mozilla (AMO); see [Distribution](#distribution).

## Distribution

The unpacked `build/` folders are for **development and store submission**, not for handing to end
users directly:

- **Chrome** blocks installing extensions from outside the Chrome Web Store for normal users
  (Developer-mode _Load unpacked_ is a developer action, and Chrome nags/disables such extensions).
- **Firefox** won't permanently install an unsigned extension at all — it must be **signed by
  Mozilla (AMO)**.

So the real "anyone can install it" path is the two stores: **Chrome Web Store** and **Firefox
AMO**. To submit, zip the corresponding `build/<browser>/` folder and upload it (AMO also signs it).
Automating that packaging + upload is the publish-workflow item in `ROADMAP.md`.

## Desktop app

The native desktop build (Tauri) is separate and reuses `content/main.js` verbatim — it does **not**
use these extension manifests. See `src-tauri/README.md`.

## How it works (for maintainers)

- `manifest.base.json` — the committed source of the manifest keys common to both browsers.
- `scripts/build-extension.js` — copies the extension files into `build/<target>/` and writes a
  per-browser `manifest.json`. The only difference is `background`: Chrome `service_worker`, Firefox
  `scripts`. Both use the default `"spanning"` incognito mode (see `CLAUDE.md` for why not `"split"`).
  The version is injected from `package.json`.
- The version lives only in `package.json` and is stamped elsewhere by `scripts/stamp-version.js`
  (see `CLAUDE.md` → Conventions → Versioning). Bumping is release-gated — don't bump per change.
