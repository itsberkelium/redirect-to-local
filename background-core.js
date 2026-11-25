const extensionAPI = globalThis.browser ?? globalThis.chrome;
let settings = null;
let paused = false;
let settingsLoaded = false;
let pauseLoaded = false;
let revision = 0;
const probes = new Map();
// Storage waits here between the redirect and the commit of the localhost page.
const pendingWrites = new Map();
const PENDING_MS = 15000;
const TAB_LOAD_MS = 8000;
// Questions to the user ("carry data over?") wait here until answered.
const asks = new Map();
const ASK_MS = 5 * 60 * 1000;

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


// These two run inside web pages, so they must not use anything outside their own body.
function readStorage() {
  return {
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage))
  };
}

function writeStorage(local, session) {
  for (const [key, value] of Object.entries(local)) {
    try { localStorage.setItem(key, value); } catch {}
  }
  for (const [key, value] of Object.entries(session)) {
    try { sessionStorage.setItem(key, value); } catch {}
  }
}

async function copyCookies(settings) {
  const cookies = await extensionAPI.cookies.getAll({ url: settings.url });
  // One cookie that the browser refuses, such as a __Host- cookie, must not stop the others.
  await Promise.allSettled(cookies.map((cookie) => (
    extensionAPI.cookies.set(RedirectLocal.toLocalCookie(cookie, settings.port))
  )));
}

async function runReadStorage(tabId) {
  const [result] = await extensionAPI.scripting.executeScript({ target: { tabId }, func: readStorage });
  return result.result;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      extensionAPI.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, change) => { if (id === tabId && change.status === "complete") finish(); };
    const timer = setTimeout(finish, TAB_LOAD_MS);
    extensionAPI.tabs.onUpdated.addListener(onUpdated);
    // The tab can finish loading before the listener exists.
    extensionAPI.tabs.get(tabId).then((tab) => { if (tab.status === "complete") finish(); }, finish);
  });
}

// A new tab has empty sessionStorage, so this path can supply only localStorage.
async function readViaTemporaryTab(settings) {
  const url = new URL("/robots.txt", settings.url);
  url.searchParams.set(RedirectLocal.CARRY_PARAM, "1");
  const tab = await extensionAPI.tabs.create({ url: url.href, active: false });
  try {
    await waitForTabLoad(tab.id);
    const { localStorage } = await runReadStorage(tab.id);
    return { localStorage, sessionStorage: {} };
  } finally {
    await extensionAPI.tabs.remove(tab.id).catch(() => {});
  }
}

async function readSourceStorage(tabId, settings) {
  const tab = await extensionAPI.tabs.get(tabId);
  // The tab still shows the website: read its live storage, sessionStorage included.
  if (tab.url && new URL(tab.url).host === new URL(settings.url).host) return runReadStorage(tabId);
  if (!settings.carry.localStorage) return null;
  return readViaTemporaryTab(settings);
}

// Copies cookies now and returns the storage to write after localhost commits.
// A failed copy never blocks the redirect.
async function collectCarry(tabId, settings) {
  const carry = settings.carry;
  if (!RedirectLocal.hasCarry(carry) || tabId < 0) return null;
  const payload = { localStorage: {}, sessionStorage: {} };
  if (carry.cookies) await copyCookies(settings).catch(() => {});
  if (carry.localStorage || carry.sessionStorage) {
    const stored = await readSourceStorage(tabId, settings).catch(() => null);
    if (stored && carry.localStorage) payload.localStorage = stored.localStorage;
    if (stored && carry.sessionStorage) payload.sessionStorage = stored.sessionStorage;
  }
  return payload;
}

function queueCarry(tabId, port, payload) {
  if (!payload || tabId < 0) return;
  if (!Object.keys(payload.localStorage).length && !Object.keys(payload.sessionStorage).length) return;
  pendingWrites.set(tabId, { port, payload, expires: Date.now() + PENDING_MS });
}

extensionAPI.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const pending = pendingWrites.get(details.tabId);
  if (!pending) return;
  const url = new URL(details.url);
  if (url.hostname !== "localhost" || Number(url.port) !== pending.port) return;
  pendingWrites.delete(details.tabId);
  if (Date.now() > pending.expires) return;
  extensionAPI.scripting.executeScript({
    target: { tabId: details.tabId, frameIds: [0] },
    injectImmediately: true,
    func: writeStorage,
    args: [pending.payload.localStorage, pending.payload.sessionStorage]
  }).catch(() => {});
}, { url: [{ hostEquals: "localhost" }] });

extensionAPI.tabs.onRemoved.addListener((tabId) => pendingWrites.delete(tabId));

function shouldAsk(settings) {
  return settings.warn === true && RedirectLocal.hasCarry(settings.carry);
}

// The tab keeps showing the website while the user answers, so its live storage stays readable.
async function askAboutCarry(tabId, redirectUrl, settings) {
  if (tabId < 0 || [...asks.values()].some((ask) => ask.tabId === tabId)) return;
  const id = crypto.randomUUID();
  asks.set(id, { tabId, redirectUrl, settings, created: Date.now() });
  const page = new URL(extensionAPI.runtime.getURL("confirm.html"));
  page.searchParams.set("id", id);
  page.searchParams.set("site", new URL(settings.url).host);
  page.searchParams.set("port", settings.port);
  page.searchParams.set("carry", RedirectLocal.CARRY_KEYS.filter((key) => settings.carry[key]).join(","));
  try {
    await extensionAPI.windows.create({ url: page.href, type: "popup", width: 440, height: 420 });
  } catch {
    asks.delete(id);
  }
}

async function answerAsk(id, answer) {
  const ask = asks.get(id);
  if (!ask) return;
  asks.delete(id);
  if ((answer !== "carry" && answer !== "plain") || paused || Date.now() - ask.created > ASK_MS) return;
  try {
    const tab = await extensionAPI.tabs.get(ask.tabId);
    const host = new URL(ask.settings.url).host;
    // Do nothing if the user already left the website while the question was open.
    if (![tab.url, tab.pendingUrl].some((url) => url && new URL(url).host === host)) return;
    const payload = answer === "carry" ? await collectCarry(ask.tabId, ask.settings) : null;
    queueCarry(ask.tabId, ask.settings.port, payload);
    await extensionAPI.tabs.update(ask.tabId, { url: ask.redirectUrl });
  } catch {
    // A closed tab leaves nothing to redirect.
  }
}

extensionAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== extensionAPI.runtime.id || message?.type !== "carry-answer") return;
  void answerAsk(message.id, message.answer);
  sendResponse();
});

extensionAPI.tabs.onRemoved.addListener((tabId) => {
  for (const [id, ask] of asks) if (ask.tabId === tabId) asks.delete(id);
});
