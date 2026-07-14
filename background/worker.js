// pxlpeep background script (MV2)
// Detects top-level image navigations and injects the content script.

const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif",
  "image/webp", "image/bmp", "image/tiff", "image/avif",
  "image/svg+xml", "image/x-portable-pixmap",
]);

console.log("[pxlpeep] background script loaded");

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== "main_frame") return;

    const ct = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === "content-type")
      ?.value?.split(";")[0].trim().toLowerCase();

    console.log("[pxlpeep] onHeadersReceived", details.url, "ct=", ct);

    if (!ct || !IMAGE_TYPES.has(ct)) return;

    const viewerUrl = browser.runtime.getURL("viewer.html")
      + "?url=" + encodeURIComponent(details.url);
    console.log("[pxlpeep] navigating tab to", viewerUrl);
    browser.tabs.update(details.tabId, { url: viewerUrl });
    return { cancel: true };
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders", "blocking"]
);

// ── Context menu: "Open image in pxlpeep" ────────────────────────────────────
// Right-clicking an image offers to open it in pxlpeep. We point the new tab at
// the viewer directly (viewer.html?url=…) instead of the raw image URL. Going
// through the viewer — rather than relying on the onHeadersReceived redirect
// above — forces pxlpeep to take over even when the image is served with a
// non-image Content-Type (which the interceptor would skip), and avoids the
// brief flash of the browser's native image view. It's an <img> element, so we
// already know the bytes decode.
browser.contextMenus.removeAll().then(() => {
  browser.contextMenus.create({
    id: "pxlpeep-open-image",
    title: "Open image in pxlpeep",
    contexts: ["image"],
    // Icon makes our item findable in Firefox's crowded image context menu
    // (Firefox-only menus feature; ignored by Chrome).
    icons: { "16": "loupe.iconset/icon_16x16.png", "32": "loupe.iconset/icon_32x32.png" },
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "pxlpeep-open-image" || !info.srcUrl) return;
  const viewerUrl = browser.runtime.getURL("viewer.html")
    + "?url=" + encodeURIComponent(info.srcUrl);
  browser.tabs.create({
    url: viewerUrl,
    active: true,
    openerTabId: tab?.id,
    index: tab ? tab.index + 1 : undefined,
  });
});
