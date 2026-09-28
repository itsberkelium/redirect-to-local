importScripts("shared.js", "background-core.js");

// Chrome MV3 permits observing requests, but cannot hold them while we probe.
const navigations = new Map();

function withoutHash(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

async function redirectNavigation(request, navigation) {
  try {
    await ready;
    if (paused || request.method !== "GET" || navigations.get(request.tabId) !== navigation) return;
    const current = settings;
    const currentRevision = revision;
    if (!RedirectLocal.redirectTarget(request.url, current)) return;
    if (!await isLocalhostRunning(current.port)) return;

    // Do not replace a newer navigation or redirect a tab closed during the probe.
    const tab = await chrome.tabs.get(request.tabId);
    const currentUrl = tab.pendingUrl || tab.url;
    if (!currentUrl || withoutHash(currentUrl) !== withoutHash(request.url)) return;
    if (paused || revision !== currentRevision || navigations.get(request.tabId) !== navigation) return;
    const target = RedirectLocal.redirectTarget(currentUrl, current);
    if (target) await chrome.tabs.update(request.tabId, { url: target });
  } catch {
    // A closed tab, revoked access, or browser-internal page leaves navigation alone.
  } finally {
    if (navigations.get(request.tabId) === navigation) navigations.delete(request.tabId);
  }
}

chrome.webRequest.onBeforeRequest.addListener((request) => {
  if (request.tabId < 0) return;
  const navigation = { url: request.url };
  navigations.set(request.tabId, navigation);
  void redirectNavigation(request, navigation);
}, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] });

chrome.tabs.onRemoved.addListener((tabId) => navigations.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const navigation = navigations.get(tabId);
  if (navigation && change.url && withoutHash(change.url) !== withoutHash(navigation.url)) {
    navigations.delete(tabId);
  }
});
