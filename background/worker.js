// pxlpeep background (MV3).
//
// The image takeover happens in-place via the document_start content script
// (content/takeover.js) — no webRequest. This background hosts the "pxlpeep"
// context menu (View image / Open image in new tab), remembers the image URL that
// content/imgdetect.js finds under the cursor (so the menu works on overlay-hidden /
// background images), and handles the takeover's fallback: when a page's CSP/sandbox
// blocks the in-place script, takeover.js asks us to redirect the tab to the viewer.
// It can stay an ephemeral service worker (Chrome) / event page (Firefox).
//
// Uses the chrome.* namespace with callbacks so the one file works in both
// Chrome and Firefox.

// content/imgdetect.js reports the image URL under the cursor on each right-click — covering images
// Chrome's hit-test misses (behind transparent overlays, CSS background-images, SVG <image>, video
// posters). We stash it per tab and use it in onClicked when Chrome gave us no info.srcUrl. Kept in
// memory: the message that sets it wakes the SW, and the click that reads it follows within seconds.
const lastImg = {};

// Register the "pxlpeep" context menu on install/update; `removeAll` first so an update can't hit
// duplicate-id errors. The menu uses `contexts:["all"]` (not just "image") so it CAN appear over
// overlay-hidden / background images that Chrome's own hit-test misses — but it's created HIDDEN and
// shown per right-click only when content/imgdetect.js actually finds an image under the cursor (see
// setMenuVisible + onMessage). That keeps it from showing as a dead entry on empty page space.
// Under the default
// "spanning" incognito mode a single shared SW serves normal + incognito windows, so the menu
// shows in BOTH. We deliberately do NOT use `"incognito":"split"`: it would let the viewer load
// in incognito, but its separate, lazily-started SW can't reliably register this menu there, so
// the menu goes missing. Incognito clicks are handled by navigating to the raw image URL instead
// (see onClicked below, and CLAUDE.md).
//
// One "pxlpeep" parent with two actions. With 2+ items Chrome force-collapses them into a submenu
// anyway, so an explicit parent makes both browsers look identical: pxlpeep ▸ View image / Open
// image in new tab.
function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    const parent = {
      id: "pxlpeep",
      title: "pxlpeep",
      contexts: ["all"],
      visible: false,
    };
    // Parent icon: `icons` is a Firefox-only property and Chrome throws on it (Chrome decorates
    // the top-level entry with the extension icon on its own). Can't sniff via the `browser`
    // global — modern Chrome exposes that alias too — so key off the UA.
    if (navigator.userAgent.includes("Firefox")) {
      parent.icons = {
        16: "loupe.iconset/icon_16x16.png",
        32: "loupe.iconset/icon_32x32.png",
      };
    }
    chrome.contextMenus.create(parent);
    chrome.contextMenus.create({
      id: "pxlpeep-view-image",
      parentId: "pxlpeep",
      title: "View image",
      contexts: ["all"],
    });
    chrome.contextMenus.create({
      id: "pxlpeep-open-image",
      parentId: "pxlpeep",
      title: "Open image in new tab",
      contexts: ["all"],
    });
  });
}
chrome.runtime.onInstalled.addListener(registerMenus);

// Show/hide the pxlpeep parent (its submenu follows). Called from onMessage the instant the detector
// reports what's under the cursor on right-button PRESS — before the menu is built on release — so
// the item is already in the right state when the menu opens. Errors (e.g. the menu not yet created
// on a brand-new install) are swallowed via lastError.
function setMenuVisible(visible) {
  chrome.contextMenus.update(
    "pxlpeep",
    { visible },
    () => void chrome.runtime.lastError,
  );
}

// The menu is one global UI object, but "should it show" is per right-click location, decided by the
// content script — which doesn't run on chrome:// pages, the Web Store, or other extensions' pages.
// Reset to hidden when focus or navigation moves somewhere we might not hear from, so a menu shown on
// an image page can't linger as a dead entry there.
chrome.tabs.onActivated.addListener(() => setMenuVisible(false));
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "loading") setMenuVisible(false);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Prefer Chrome's resolved URL for a real image target; else the URL content/imgdetect.js found
  // under the cursor (overlay-hidden / background images).
  const src = info.srcUrl || (tab?.id != null ? lastImg[tab.id] : null);
  if (!src) return;
  // Normal windows route through the viewer (viewer.html?url=…) rather than the raw image URL, so
  // they force-open even when the image is served with a non-image Content-Type (the in-place
  // content script keys off document.contentType, which such responses wouldn't satisfy).
  //
  // Incognito/private windows can't be sent to the viewer — it's an extension page, and Chrome's
  // spanning mode won't load one into an incognito tab's main frame. So there we navigate to the
  // raw image URL and let the in-place takeover (a content script, which DOES run in incognito)
  // handle it. That covers image Content-Types (the common case); rarer non-image / CSP-blocked
  // images just aren't reachable via the menu in incognito.
  const target = tab?.incognito
    ? src
    : chrome.runtime.getURL("viewer.html") + "?url=" + encodeURIComponent(src);
  if (info.menuItemId === "pxlpeep-view-image" && tab?.id != null) {
    chrome.tabs.update(tab.id, { url: target }); // this tab
  } else if (info.menuItemId === "pxlpeep-open-image") {
    chrome.tabs.create({
      url: target,
      active: true,
      openerTabId: tab?.id,
      index: tab ? tab.index + 1 : undefined,
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  // content/imgdetect.js: remember the image URL under the cursor for the next menu click, and show
  // the pxlpeep menu only when there actually is one (hide it otherwise). Fired on right-button press,
  // before the menu is built on release, so this lands in time.
  if (msg?.type === "pxlpeep-imgctx") {
    lastImg[tabId] = msg.url || null;
    setMenuVisible(!!msg.url);
    return;
  }

  // content/takeover.js fallback: a page's CSP/sandbox blocked the in-place script — redirect the
  // tab to the viewer, which runs on our own extension origin (free of the page's CSP/sandbox).
  // Navigating a tab to our own page needs no extra permission.
  if (msg?.type === "pxlpeep-fallback") {
    const viewerUrl =
      chrome.runtime.getURL("viewer.html") +
      "?url=" +
      encodeURIComponent(msg.url);
    chrome.tabs.update(tabId, { url: viewerUrl });
  }
});

// Drop a tab's remembered image URL when it closes, so the map can't grow without bound.
chrome.tabs.onRemoved.addListener((tabId) => {
  delete lastImg[tabId];
});
