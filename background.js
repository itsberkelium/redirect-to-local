browser.webRequest.onBeforeRequest.addListener(async (request) => {
  await ready;
  // Avoid replaying form submissions or other requests with bodies at localhost.
  if (paused || request.method !== "GET") return {};
  const current = settings;
  const currentRevision = revision;
  const redirectUrl = RedirectLocal.redirectTarget(request.url, current);
  if (!redirectUrl) return {};
  const running = await isLocalhostRunning(current.port);
  if (!running || revision !== currentRevision) return {};
  if (shouldAsk(current)) {
    // Let the website load; the answer decides whether and how to redirect.
    await askAboutCarry(request.tabId, redirectUrl, current);
    return {};
  }
  const payload = await collectCarry(request.tabId, current);
  if (revision !== currentRevision) return {};
  queueCarry(request.tabId, current.port, payload);
  return { redirectUrl };
}, {
  urls: ["http://*/*", "https://*/*"],
  types: ["main_frame"]
}, ["blocking"]);
