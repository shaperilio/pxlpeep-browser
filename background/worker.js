// pxlpeep background service worker
// Detects top-level image navigations and injects the content script.

const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif",
  "image/webp", "image/bmp", "image/tiff", "image/avif",
  "image/svg+xml", "image/x-portable-pixmap",
]);

const pendingTabs = new Set();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== "main_frame") return;
    const ct = details.responseHeaders
      ?.find(h => h.name.toLowerCase() === "content-type")
      ?.value?.split(";")[0].trim().toLowerCase();
    if (ct && IMAGE_TYPES.has(ct)) {
      pendingTabs.add(details.tabId);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && pendingTabs.has(tabId)) {
    pendingTabs.delete(tabId);
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/main.js"],
    }).catch(err => console.error("pxlpeep inject error:", err));
  }
});

chrome.tabs.onRemoved.addListener(tabId => pendingTabs.delete(tabId));
