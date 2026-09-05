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

  // Pick the image the user actually SEES under the point. Three stacking realities to handle:
  //  - a plain <img>, or one behind a transparent overlay (Instagram) — found via the hit-test stack;
  //  - a lightbox/carousel "enlarged" image shown click-through (pointer-events:none) over a backdrop,
  //    which elementsFromPoint skips — so we'd otherwise grab a thumbnail behind it;
  //  - several such slides stacked in the exact same box (current + prev/next), where only the current
  //    is really visible: the adjacent ones are hidden by an ANCESTOR's opacity/visibility (their own
  //    style still says visible), and the current one paints on top.
  // Strategy: collect every image covering the point, keep only the effectively-visible ones, and pick
  // the topmost by paint order (hit-test depth, then z-index, then DOM order).
  function imageUrlAt(x, y) {
    const stack = deepStack(x, y);
    const rankOf = new Map();
    stack.forEach((el, i) => rankOf.set(el, i));
    // Paint rank: index in the hit-test stack (lower = more on top). A click-through image isn't in the
    // stack, so borrow the rank of its nearest ancestor that IS (its lightbox/backdrop container).
    const paintRank = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const r = rankOf.get(n);
        if (r !== undefined) return r;
      }
      return Infinity;
    };
    // Effectively visible: nothing up the ancestor chain is display:none / visibility:hidden / opacity:0.
    // (A per-element opacity check misses adjacent lightbox slides hidden via their container's opacity.)
    const effVisible = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        if (parseFloat(cs.opacity) === 0) return false;
      }
      return true;
    };
    const zOf = (el) => {
      const z = parseInt(getComputedStyle(el).zIndex, 10);
      return Number.isNaN(z) ? 0 : z;
    };

    const cands = [];
    // Hit-testable images already under the point (topmost-first in the stack).
    stack.forEach((el, i) => {
      const u = urlOfEl(el);
      if (u && effVisible(el))
        cands.push({ url: u, rank: i, z: zOf(el), dom: -1 });
    });
    // Click-through images covering the point (lightbox / carousel overlays). Rect-filter first so
    // getComputedStyle / effVisible run only for the few images actually under the cursor.
    let dom = 0;
    for (const el of document.querySelectorAll("img, video[poster], image")) {
      dom++;
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      if (getComputedStyle(el).pointerEvents !== "none") continue; // hit-testable → already covered
      if (!effVisible(el)) continue;
      const u = urlOfEl(el);
      if (u) cands.push({ url: u, rank: paintRank(el), z: zOf(el), dom });
    }
    if (!cands.length) {
      return nearestImage(stack[0] || document.elementFromPoint(x, y), x, y);
    }
    // Topmost wins: lowest paint rank, then highest z-index, then latest in DOM order (paints on top).
    cands.sort((a, b) => a.rank - b.rank || b.z - a.z || b.dom - a.dom);
    return cands[0].url;
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
