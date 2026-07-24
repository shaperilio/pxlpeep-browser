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
