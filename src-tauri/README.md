# pxlpeep desktop (Tauri)

The desktop build wraps the **same** viewer as the browser extension (`../content/main.js`,
unchanged) in a native window, so double-clicking a local image file opens pxlpeep — the one thing
a browser extension can't do (OS file associations point at apps, not extensions).

## Prerequisites

### Windows (verified on Windows 11)

Three things to install:

1. **Node.js** — used only for the Tauri CLI and dev tooling; the app frontend itself has no build
   step. Get the LTS from <https://nodejs.org>, or:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
2. **Rust** via rustup, with the MSVC toolchain as default:
   ```powershell
   winget install --id Rustlang.Rustup
   rustup default stable-msvc
   ```
3. **Microsoft C++ Build Tools** — run the installer and select the **"Desktop development with
   C++"** workload: <https://visualstudio.microsoft.com/visual-studio-build-tools/>. This is the
   large download; it's what the Rust MSVC toolchain links against.

**WebView2** ships with Windows 10 (1803+) and Windows 11 — nothing to install.

> Open a fresh terminal after installing Rust so `cargo`/`rustc` are on `PATH`.

### macOS / Linux

The frontend is identical; only the native toolchain differs per OS (Xcode Command Line Tools on
macOS; `webkit2gtk` + build essentials on Linux). Follow the official list:
<https://v2.tauri.app/start/prerequisites/>.

## Build & run

From the **repo root**:

```powershell
npm install             # fetches the Tauri CLI (@tauri-apps/cli) + dev tooling
npm run desktop         # dev: compile and launch the window
npm run desktop:build   # release: installers under src-tauri/target/release/bundle/
```

Or run the compiled binary directly with an image path:

```powershell
src-tauri\target\debug\pxlpeep.exe path\to\image.png
```

The **first** build compiles a few hundred Rust crates and takes a few minutes; later builds are
incremental and fast.

## How it fits together

- `../content/desktop.html` loads `desktop.js`, then the shared `main.js`.
- `src/lib.rs` reads the image path from `argv[1]` (how a file association / "Open with" hands off a
  file) and injects `window.__pxlpeepImagePath` before any page script runs.
- `../content/desktop.js` turns that into an `asset://` URL via `convertFileSrc()` and sets
  `window.__pxlpeepImageUrl` — the same contract `viewer.js` uses in the extension, which is why
  `main.js` is shared verbatim between the extension and the desktop app.
