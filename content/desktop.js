// pxlpeep desktop (Tauri) entry shim — the counterpart to viewer.js in the extension.
//
// Rust injects window.__pxlpeepImagePath before any page script runs: the file passed on
// the command line, which is how a file association / "Open with" hands us an image. We
// turn it into an asset:// URL that the app's existing fetch path can read, then main.js
// picks it up exactly as it does under viewer.html.
//
// This is the desktop half of the environment seam. main.js itself is unchanged and stays
// unaware of which shell it's running in — it just reads window.__pxlpeepImageUrl.

const path = window.__pxlpeepImagePath;
if (path) {
  window.__pxlpeepImageUrl = window.__TAURI__.core.convertFileSrc(path);
}

// Desktop half of the environment seam (see the `env` block in content/main.js).
// Only the keys that differ from the browser defaults go here; main.js merges this
// over its defaults, so anything omitted (save, copyImage) inherits the browser
// behavior. isDesktop switches on the desktop-only reload (Ctrl+R / F5) — the one
// free win that is genuinely target-specific: in a native window there's no browser
// chrome to refresh, so the app has to own the keystroke.
//
// A native Save-As dialog and native clipboard are deliberately NOT wired yet: the
// browser default (download-anchor + async Clipboard API) may work as-is inside
// WebView2, and if it doesn't, the fix is a per-method override right here — not a
// change to main.js. That assessment waits for a real desktop build.
window.__pxlpeepEnv = {
  isDesktop: true,
};
