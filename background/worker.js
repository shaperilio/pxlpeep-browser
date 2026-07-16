// pxlpeep background (MV3).
//
// The image takeover happens in-place via the document_start content script
// (content/takeover.js) — no webRequest. This background hosts the "pxlpeep"
// image context menu (View image / Open image in new tab) and the takeover's
// fallback: when a page's CSP/sandbox blocks the in-place script, takeover.js
// asks us to redirect the tab to the viewer. It can stay an ephemeral service
// worker (Chrome) / event page (Firefox).
//
// Uses the chrome.* namespace with callbacks so the one file works in both
// Chrome and Firefox.

// Register the menus once. onInstalled fires on install and update; removeAll
// first so an update can't hit duplicate-id errors.
//
// One "pxlpeep" parent with two actions. With 2+ items Chrome force-collapses
// them into a submenu anyway, so an explicit parent makes both browsers look
// identical: pxlpeep ▸ View image / Open image in new tab.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const parent = {
      id: "pxlpeep",
      title: "pxlpeep",
      contexts: ["image"],
    };
    // Parent icon: `icons` is a Firefox-only property and Chrome throws on it
    // (Chrome decorates the top-level entry with the extension icon on its own).
    // Can't sniff via the `browser` global — modern Chrome exposes that alias
    // too — so key off the UA (Firefox's always contains "Firefox").
    if (navigator.userAgent.includes("Firefox")) {
      parent.icons = { 16: "loupe.iconset/icon_16x16.png", 32: "loupe.iconset/icon_32x32.png" };
    }
    chrome.contextMenus.create(parent);
    chrome.contextMenus.create({
      id: "pxlpeep-view-image",
      parentId: "pxlpeep",
      title: "View image",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "pxlpeep-open-image",
      parentId: "pxlpeep",
      title: "Open image in new tab",
      contexts: ["image"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.srcUrl) return;
  // Both actions route through the viewer (viewer.html?url=…) rather than the
  // raw image URL, so they force-open even when the image is served with a
  // non-image Content-Type — the in-place content script keys off
  // document.contentType, which such responses wouldn't satisfy.
  const viewerUrl =
    chrome.runtime.getURL("viewer.html") + "?url=" + encodeURIComponent(info.srcUrl);
  if (info.menuItemId === "pxlpeep-view-image" && tab?.id != null) {
    chrome.tabs.update(tab.id, { url: viewerUrl }); // this tab
  } else if (info.menuItemId === "pxlpeep-open-image") {
    chrome.tabs.create({
      url: viewerUrl,
      active: true,
      openerTabId: tab?.id,
      index: tab ? tab.index + 1 : undefined,
    });
  }
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
