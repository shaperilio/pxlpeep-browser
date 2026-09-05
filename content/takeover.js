// pxlpeep takeover (MV3 content script; document_start, <all_urls>).
//
// The browser renders a standalone image as a synthetic ImageDocument, and a
// document_start content script runs on it in both Chrome and Firefox (verified).
// We load main.js into the page's MAIN world (the same context viewer.html uses),
// so the app's fetch of the image stays in the image's own top-level cache
// partition — a hit, not a re-download.
//
// Hybrid fallback: some image responses carry a strict CSP (e.g. Bluesky and
// Google Photos send `Content-Security-Policy: default-src 'none'`, sometimes with
// `sandbox`). Two distinct things can go wrong, and both are handled by redirecting
// the tab to viewer.html — our own extension origin, free of the page's CSP/sandbox:
//   1. The injected main.js `<script>` is blocked outright (script-src) → `onerror`.
//   2. Chrome lets the injected extension script RUN, but `default-src 'none'` still
//      blocks main.js's main-world fetch of the image, so it can't display anything.
//      `onload` fires, so we must NOT treat that as success — main.js signals the real
//      outcome (image loaded vs fetch failed) via a <html> data-* attribute we observe.
// (The viewer fetch lands in a different cache partition = re-download, but these
// responses are near-always no-store / auth'd, i.e. uncacheable anyway.)

(() => {
  if (!/^image\//i.test(document.contentType || "")) return;

  // Cover the native image immediately (no flash) with a plain <div> styled via
  // CSSOM — not a <style>/<link>, so it isn't subject to the page's CSP.
  const cover = document.createElement("div");
  cover.style.cssText =
    "position:fixed;inset:0;background:#1a1a1a;z-index:2147483647";
  document.documentElement.appendChild(cover);

  const tookOver = () => !!document.getElementById("pxlpeep-toolbar");

  let terminal = false;
  let revealed = false;
  let timer = 0;
  const reveal = () => {
    if (!revealed) {
      revealed = true;
      cover.remove(); // show the in-place app
    }
  };
  const finish = (fallback) => {
    if (terminal) return;
    terminal = true;
    clearTimeout(timer);
    obs.disconnect();
    if (fallback) {
      // In-place can't display the image (script blocked, or its fetch blocked by the
      // page CSP). Redirect to viewer.html via the background; keep the cover up until
      // the tab navigates away.
      chrome.runtime.sendMessage({
        type: "pxlpeep-fallback",
        url: location.href,
      });
    } else {
      reveal();
    }
  };

  // main.js (main world) reports the real outcome of its image load on <html>, which we can read from
  // this isolated world: `data-pxlpeep-ok` = rendered, `data-pxlpeep-err` = fetch/decode failed.
  const obs = new MutationObserver(() => {
    const de = document.documentElement;
    if (de.hasAttribute("data-pxlpeep-err")) finish(true);
    else if (de.hasAttribute("data-pxlpeep-ok")) finish(false);
  });
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-pxlpeep-ok", "data-pxlpeep-err"],
  });

  const inject = () => {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/main.js");
    // Script executed in the main world → reveal the in-place UI (toolbar + "Loading…"). NOT terminal:
    // a CSP-blocked fetch fails only after this, so we keep watching main.js's ok/err signal.
    s.onload = () => reveal();
    // Script blocked outright (page CSP script-src) → straight to the viewer.
    s.onerror = () => finish(true);
    (document.head || document.documentElement).appendChild(s);
    // Backstop if main.js never signals (e.g. it threw before startLoad): keep in-place if it built its
    // toolbar, else fall back. Timed from *injection*, not document_start, so a slow image load (which
    // delays DOMContentLoaded, and with it this inject) doesn't burn the budget before main.js runs.
    timer = setTimeout(() => finish(!tookOver()), 8000);
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  else inject();
})();
