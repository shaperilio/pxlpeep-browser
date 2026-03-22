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
