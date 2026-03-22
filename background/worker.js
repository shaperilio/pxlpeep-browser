// pxlpeep background script (MV2)
// Detects top-level image navigations and injects the content script.

const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif",
  "image/webp", "image/bmp", "image/tiff", "image/avif",
  "image/svg+xml", "image/x-portable-pixmap",
]);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== "main_frame") return;

    const ct = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === "content-type")
      ?.value?.split(";")[0].trim().toLowerCase();

    if (!ct || !IMAGE_TYPES.has(ct)) return;

    browser.tabs.executeScript(details.tabId, {
      file: "content/main.js",
    }).catch(err => console.error("pxlpeep inject error:", err));
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);
