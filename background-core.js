const extensionAPI = globalThis.browser ?? globalThis.chrome;
let settings = null;
let paused = false;
let settingsLoaded = false;
let pauseLoaded = false;
let revision = 0;
const probes = new Map();

function applySettings(value) {
  settingsLoaded = true;
  revision += 1;
  try {
    settings = RedirectLocal.parseSettings(value);
  } catch {
    settings = null;
  }
}

function applyPaused(value) {
  pauseLoaded = true;
  paused = value === true;
  revision += 1;
}

// Register listeners synchronously so either browser can wake the background.
extensionAPI.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) applySettings(changes.settings.newValue);
  if (area === "local" && changes.paused) applyPaused(changes.paused.newValue);
});

const ready = extensionAPI.storage.local.get(["settings", "paused"]).then((stored) => {
  if (!settingsLoaded) applySettings(stored.settings);
  if (!pauseLoaded) applyPaused(stored.paused);
}).catch(() => {});

function isLocalhostRunning(port) {
  // Share only in-flight probes; do not cache a stale up/down result.
  if (probes.has(port)) return probes.get(port);
  const probe = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      // Any HTTP response (including 404/405/500) proves the server is listening.
      // HEAD avoids downloading a page. Manual redirects never probe a remote site.
      await fetch(`http://localhost:${port}/`, {
        method: "HEAD",
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  })();
  probes.set(port, probe);
  probe.finally(() => probes.delete(port));
  return probe;
}

