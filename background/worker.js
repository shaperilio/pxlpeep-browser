// pxlpeep background (MV3).
//
// The image takeover happens in-place via the document_start content script
// (content/takeover.js) — no webRequest. This background hosts the "Open image in
// pxlpeep" context menu and the takeover's fallback: when a page's CSP/sandbox
// blocks the in-place script, takeover.js asks us to redirect the tab to the
// viewer. It can stay an ephemeral service worker (Chrome) / event page (Firefox).
//
// Uses the chrome.* namespace with callbacks so the one file works in both
// Chrome and Firefox.

// Register the menu once. onInstalled fires on install and update; removeAll
// first so an update can't hit a duplicate-id error.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const props = {
      id: "pxlpeep-open-image",
      title: "Open image in pxlpeep",
      contexts: ["image"],
    };
    // A menu-item icon helps it stand out in Firefox's crowded image menu, but
    // `icons` is a Firefox-only property and Chrome throws on it. Can't sniff via
    // the `browser` global — modern Chrome exposes that alias too — so key off the
    // UA (Firefox's always contains "Firefox"; Chromium's never does).
    if (navigator.userAgent.includes("Firefox")) {
      props.icons = { 16: "loupe.iconset/icon_16x16.png", 32: "loupe.iconset/icon_32x32.png" };
    }
    chrome.contextMenus.create(props);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "pxlpeep-open-image" || !info.srcUrl) return;
  // Route through the viewer (viewer.html?url=…) rather than the raw image URL,
  // so it force-opens even when the image is served with a non-image
  // Content-Type — the in-place content script keys off document.contentType,
  // which such responses wouldn't satisfy.
  const viewerUrl =
    chrome.runtime.getURL("viewer.html") + "?url=" + encodeURIComponent(info.srcUrl);
  chrome.tabs.create({
    url: viewerUrl,
    active: true,
    openerTabId: tab?.id,
    index: tab ? tab.index + 1 : undefined,
  });
});

// Fallback for content/takeover.js: when a page's CSP/sandbox blocks the in-place
// script, redirect the tab to the viewer, which runs on our own extension origin
// (free of the page's CSP/sandbox). Navigating a tab to our own page needs no
// extra permission.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "pxlpeep-fallback" || sender.tab?.id == null) return;
  const viewerUrl =
    chrome.runtime.getURL("viewer.html") + "?url=" + encodeURIComponent(msg.url);
  chrome.tabs.update(sender.tab.id, { url: viewerUrl });
});
