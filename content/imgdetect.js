// pxlpeep right-click image detector (content script; document_start, <all_urls>, isolated world).
//
// Some sites hide their images from the normal "Save image / pxlpeep" context menu: a transparent
// element sits ON TOP of the real <img> (Instagram), the <img> lives inside a shadow root, or the
// picture is a CSS background-image / SVG <image> / <video poster> rather than an <img>. In those
// cases Chrome's own hit-test doesn't see an image at the cursor, so the menu's `image` context
// never fires and info.srcUrl is empty.
//
// On every right-click we find the image URL under the cursor ourselves and hand it to the
// background, which keeps the pxlpeep menu available on all contexts and, when clicked, opens
// whatever we found (falling back to Chrome's own info.srcUrl for a plain <img>).

(() => {
  function abs(u) {
    try {
      return new URL(u, location.href).href;
    } catch (_) {
      return null;
    }
  }

  // Read an image URL straight off ONE element (no descent). Order: <img> (resolved srcset via
  // currentSrc), <video poster>, SVG <image>, then any CSS background-image (skip "none" / gradients).
  function urlOfEl(el) {
    if (!el || !el.tagName) return null;
    const tag = el.tagName;
    if (tag === "IMG" && (el.currentSrc || el.src))
      return el.currentSrc || el.src;
    if (tag === "VIDEO" && el.poster) return abs(el.poster);
    if (tag === "image" && el.href && el.href.baseVal)
      return abs(el.href.baseVal);
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg !== "none" && bg.match(/url\((['"]?)([^'")]+)\1\)/);
    if (m) return abs(m[2]);
    return null;
  }

  // Full hit-test stack under the point, front-to-back, INCLUDING overlapping siblings behind the
  // topmost element (that's what makes the transparent-overlay case work). elementsFromPoint stops
  // at a shadow host, so we recurse into each open shadow root to reach images componentized inside
  // web components.
  function deepStack(x, y) {
    const out = [];
    const seen = new Set();
    (function walk(root) {
      if (!root || seen.has(root)) return;
      seen.add(root);
      for (const el of root.elementsFromPoint(x, y)) {
        if (!out.includes(el)) out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(document);
    return out;
  }

  // Fallback when nothing in the hit-test stack is an image: climb a few ancestors from the topmost
  // hit element and, at each level, take the largest <img>/<video>/SVG <image> whose box actually
  // CONTAINS the click. Requiring containment keeps us on the photo under the cursor (not an adjacent
  // avatar/icon or an off-screen carousel slide); largest-area wins so we prefer the main picture.
  function nearestImage(top, x, y) {
    let el = top;
    for (let depth = 0; el && depth < 5; el = el.parentElement, depth++) {
      if (!el.querySelectorAll) continue;
      let best = null;
      let bestArea = 0;
      for (const cand of el.querySelectorAll("img, video[poster], image")) {
        const r = cand.getBoundingClientRect();
        if (r.width < 16 || r.height < 16) continue;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        const area = r.width * r.height;
        if (area > bestArea) {
          const u = urlOfEl(cand);
          if (u) {
            best = u;
            bestArea = area;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  function imageUrlAt(x, y) {
    const stack = deepStack(x, y);
    for (const el of stack) {
      const u = urlOfEl(el);
      if (u) return u;
    }
    return nearestImage(stack[0] || document.elementFromPoint(x, y), x, y);
  }

  let lastSent; // last url (string | null) sent to the background — used to dedupe
  function report(x, y, force) {
    let url = null;
    try {
      url = imageUrlAt(x, y);
    } catch (_) {}
    if (!force && url === lastSent) return;
    lastSent = url;
    try {
      chrome.runtime.sendMessage({ type: "pxlpeep-imgctx", url });
    } catch (_) {}
  }

  // Keep the background in sync with what's under the cursor AS THE MOUSE MOVES, so by the time the
  // user right-clicks, the pxlpeep menu is already shown/hidden correctly. Detecting only at click
  // time meant racing the menu open (built on button-release) against our async show/hide message —
  // reliable on simple pages but not on heavy ones like Instagram, where the update lost the race.
  // Syncing on hover removes the race: entering an image shows the item hundreds of ms ahead of the
  // click. We only re-check when the cursor crosses into a NEW element (cheap) and only message the
  // background when the result actually changes.
  let lastTarget = null;
  addEventListener(
    "pointermove",
    (e) => {
      if (e.target === lastTarget) return;
      lastTarget = e.target;
      report(e.clientX, e.clientY, false);
    },
    true,
  );

  // The right-click itself, and keyboard-invoked menus: force a fresh assert so we recover even if the
  // service worker was evicted since the last move. Capture-phase and read-only — we never
  // preventDefault, so the page and the native menu are undisturbed.
  addEventListener(
    "pointerdown",
    (e) => {
      if (e.button === 2) report(e.clientX, e.clientY, true);
    },
    true,
  );
  addEventListener(
    "contextmenu",
    (e) => {
      report(e.clientX, e.clientY, true);
    },
    true,
  );
})();
