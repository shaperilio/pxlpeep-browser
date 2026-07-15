// pxlpeep takeover (MV3 content script; document_start, <all_urls>).
//
// The browser renders a standalone image as a synthetic ImageDocument, and a
// document_start content script runs on it in both Chrome and Firefox (verified).
// We load main.js into the page's MAIN world (the same context viewer.html uses),
// so the app's fetch of the image stays in the image's own top-level cache
// partition — a hit, not a re-download.
//
// Hybrid fallback: some image responses (e.g. Google Photos) are sandboxed and/or
// carry `Content-Security-Policy: default-src 'none'`, which blocks the injected
// main-world script from ever running. We can't detect that ahead of time, so we
// attempt the in-place takeover and, if our UI never appears, ask the background to
// redirect the tab to viewer.html — our own extension origin, free of the page's
// CSP and sandbox. (That fetch lands in a different cache partition = re-download,
// but such responses are near-always no-store / auth'd, i.e. uncacheable anyway.)

(() => {
  if (!/^image\//i.test(document.contentType || "")) return;

  // Cover the native image immediately (no flash) with a plain <div> styled via
  // CSSOM — not a <style>/<link>, so it isn't subject to the page's CSP.
  const cover = document.createElement("div");
  cover.style.cssText = "position:fixed;inset:0;background:#1a1a1a;z-index:2147483647";
  document.documentElement.appendChild(cover);

  let settled = false;
  const settle = (ok) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (ok) {
      cover.remove(); // reveal the in-place takeover
    } else {
      // In-place didn't take (sandbox/CSP blocked main.js). Redirect via the
      // background; leave the cover up until the tab navigates away.
      chrome.runtime.sendMessage({ type: "pxlpeep-fallback", url: location.href });
    }
  };

  // main.js builds its toolbar (#pxlpeep-toolbar) synchronously when it runs, so
  // the element's presence is our "in-place takeover succeeded" signal.
  const tookOver = () => !!document.getElementById("pxlpeep-toolbar");

  const inject = () => {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/main.js");
    s.onload = () => settle(tookOver()); // ran to completion → toolbar exists
    s.onerror = () => settle(false); // blocked from loading/executing → fall back
    (document.head || document.documentElement).appendChild(s);
  };

  // Backstop: some sandbox blocks fire neither load nor error — decide by whether
  // the toolbar ever showed up.
  const timer = setTimeout(() => settle(tookOver()), 1000);

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  else inject();
})();
