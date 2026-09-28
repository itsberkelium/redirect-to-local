const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup({ paused = false, fetchImpl = async () => ({ status: 200 }) } = {}) {
  let listener, changed, removed, updated;
  let tab = { url: "https://example.com/a%2Fb?q=1&q=2#section" };
  const redirects = [], probes = [];
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    fetch: (...args) => { probes.push(args); return fetchImpl(...args); },
    chrome: {
      storage: {
        local: { get: async () => ({ settings: { port: 3000, url: "https://example.com" }, paused }) },
        onChanged: { addListener: fn => { changed = fn; } }
      },
      webRequest: { onBeforeRequest: { addListener: (fn, filter, extra) => {
        listener = fn;
        assert.equal(extra, undefined, "Chrome must not request blocking access");
        assert.deepEqual(Array.from(filter.types), ["main_frame"]);
      } } },
      tabs: {
        get: async () => { if (!tab) throw new Error("Tab closed"); return tab; },
        update: async (id, options) => redirects.push({ id, ...options }),
        onRemoved: { addListener: fn => { removed = fn; } },
        onUpdated: { addListener: fn => { updated = fn; } }
      }
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context));
  context.importScripts("background-chrome.js");
  return {
    redirects, probes,
    request: (values = {}) => listener({ tabId: 1, method: "GET", url: "https://example.com/a%2Fb?q=1&q=2", ...values }),
    change: values => changed(values, "local"),
    navigate: url => { tab = { url }; updated(1, { url }); },
    close: () => { tab = null; removed(1); }
  };
}
const flush = () => new Promise(setImmediate);

test("Chrome redirects a GET and preserves encoding, repeated queries and tab fragment", async () => {
  const app = setup(); app.request(); await flush();
  assert.deepEqual(app.redirects, [{ id: 1, url: "http://localhost:3000/a%2Fb?q=1&q=2#section" }]);
});

test("Chrome skips POSTs, nonmatching sites, requests without tabs and paused visits", async () => {
  for (const options of [{ method: "POST" }, { url: "https://other.test/" }, { tabId: -1 }]) {
    const app = setup(); app.request(options); await flush();
    assert.equal(app.probes.length, 0); assert.equal(app.redirects.length, 0);
  }
  const app = setup({ paused: true }); app.request(); await flush();
  assert.equal(app.probes.length, 0);
  app.change({ paused: { newValue: false } }); app.request(); await flush();
  assert.equal(app.redirects.length, 1);
});

test("Chrome leaves the original navigation alone when localhost is unavailable", async () => {
  const app = setup({ fetchImpl: async () => { throw new Error("offline"); } });
  app.request(); await flush(); assert.equal(app.redirects.length, 0);
});

test("Chrome discards stale probes after navigation, close, pause, settings edits or a POST", async () => {
  for (const change of [
    app => app.navigate("https://other.test/"),
    app => app.close(),
    app => app.change({ paused: { newValue: true } }),
    app => app.change({ settings: { newValue: { port: 4000, url: "https://example.com" } } }),
    app => app.request({ method: "POST" })
  ]) {
    let resolve;
    const app = setup({ fetchImpl: () => new Promise(done => { resolve = done; }) });
    app.request(); await flush(); change(app); resolve({ status: 200 }); await flush();
    assert.equal(app.redirects.length, 0);
  }
});
