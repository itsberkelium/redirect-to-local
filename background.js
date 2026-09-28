browser.webRequest.onBeforeRequest.addListener(async (request) => {
  await ready;
  // Avoid replaying form submissions or other requests with bodies at localhost.
  if (paused || request.method !== "GET") return {};
  const current = settings;
  const currentRevision = revision;
  const redirectUrl = RedirectLocal.redirectTarget(request.url, current);
  if (!redirectUrl) return {};
  const running = await isLocalhostRunning(current.port);
  return running && revision === currentRevision ? { redirectUrl } : {};
}, {
  urls: ["http://*/*", "https://*/*"],
  types: ["main_frame"]
}, ["blocking"]);
