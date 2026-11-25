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
    if (shouldAsk(current)) {
      await askAboutCarry(request.tabId, RedirectLocal.redirectTarget(request.url, current), current);
      return;
    }
    const payload = await collectCarry(request.tabId, current);

    // Do not replace a newer navigation or redirect a tab closed during the probe.
    const tab = await chrome.tabs.get(request.tabId);
    const currentUrl = tab.pendingUrl || tab.url;
    if (!currentUrl || withoutHash(currentUrl) !== withoutHash(request.url)) return;
    if (paused || revision !== currentRevision || navigations.get(request.tabId) !== navigation) return;
    const target = RedirectLocal.redirectTarget(currentUrl, current);
    if (!target) return;
    queueCarry(request.tabId, current.port, payload);
    await chrome.tabs.update(request.tabId, { url: target });
  } catch {
    // A closed tab, revoked access, or browser-internal page leaves navigation alone.
  } finally {
    if (navigations.get(request.tabId) === navigation) navigations.delete(request.tabId);
  }
}

function startNavigation(request) {
  if (request.tabId < 0) return;
  const navigation = { url: request.url };
  navigations.set(request.tabId, navigation);
  void redirectNavigation(request, navigation);
}

chrome.webRequest.onBeforeRequest.addListener(
  startNavigation,
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] }
);

// In-page navigations (history.pushState or replaceState) send no network request,
// so webRequest cannot see them. A history update is never a form submission, so it is a GET.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  startNavigation({ tabId: details.tabId, method: "GET", url: details.url });
}, { url: [{ schemes: ["http", "https"] }] });

chrome.tabs.onRemoved.addListener((tabId) => navigations.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const navigation = navigations.get(tabId);
  if (navigation && change.url && withoutHash(change.url) !== withoutHash(navigation.url)) {
    navigations.delete(tabId);
  }
});
