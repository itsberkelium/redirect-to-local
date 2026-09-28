const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup({ stored = { port: 3000, url: "https://example.com" }, paused = false, fetchImpl = async () => ({ status: 200 }), timer = setTimeout } = {}) {
  let listener;
  let changed;
  const requests = [];
  const context = vm.createContext({
    URL, AbortController, setTimeout: timer, clearTimeout,
    fetch: (...args) => { requests.push(args); return fetchImpl(...args); },
    browser: {
      storage: {
        local: { get: async () => ({ settings: stored, paused }) },
        onChanged: { addListener: (callback) => { changed = callback; } }
      },
      webRequest: { onBeforeRequest: { addListener: (callback, filter, extra) => {
        listener = callback;
        assert.deepEqual(Array.from(filter.types), ["main_frame"]);
        assert.deepEqual(Array.from(extra), ["blocking"]);
      } } }
    }
  });
  for (const file of ["shared.js", "background-core.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  return {
    core: context.RedirectLocal,
    request: (url = "https://example.com/test?a=b", method = "GET") => listener({ url, method }),
    change: (settings) => changed({ settings: { newValue: settings } }, "local"),
    pause: (value) => changed({ paused: { newValue: value } }, "local"),
    requests
  };
}

test("preserves encoded paths, repeated queries, and fragment when provided", async () => {
  const app = setup();
  const result = await app.request("https://example.com/a%2Fb/c?x=1&x=2&q=a%20b#part");
  assert.equal(result.redirectUrl, "http://localhost:3000/a%2Fb/c?x=1&x=2&q=a%20b#part");
  assert.equal(app.requests[0][0], "http://localhost:3000/");
  assert.equal(app.requests[0][1].method, "HEAD");
});

test("restores saved pause state, skips probes, and resumes using saved settings", async () => {
  const app = setup({ paused: true });
  assert.equal((await app.request()).redirectUrl, undefined);
  assert.equal(app.requests.length, 0);
  app.change({ port: 4000, url: "https://example.com" });
  assert.equal((await app.request()).redirectUrl, undefined);
  app.pause(false);
  assert.equal((await app.request()).redirectUrl, "http://localhost:4000/test?a=b");
});

test("pausing during a probe prevents its redirect even if resumed before completion", async () => {
  let resolveProbe;
  const app = setup({ fetchImpl: () => new Promise((resolve) => { resolveProbe = resolve; }) });
  const pending = app.request();
  await new Promise(setImmediate);
  app.pause(true);
  app.pause(false);
  resolveProbe({ status: 200 });
  assert.equal((await pending).redirectUrl, undefined);
});

test("pause changes during initialization do not discard saved settings", async () => {
  const app = setup();
  app.pause(true);
  assert.equal((await app.request()).redirectUrl, undefined);
  app.pause(false);
  assert.ok((await app.request()).redirectUrl);
});

test("normalizes settings and rejects invalid ports, protocols, and local sources", () => {
  const { core } = setup();
  assert.equal(core.parseSettings({ port: "03000", url: "Example.com/path?q=x" }).url, "https://example.com");
  for (const port of ["", "0", "65536", "3.5", "3e3", "abc"]) {
    assert.throws(() => core.parseSettings({ port, url: "example.com" }));
  }
  for (const url of ["", "bad host", "ftp://example.com", "https://user:pass@example.com", "localhost", "127.0.0.1", "http://[::1]", "app.localhost"]) {
    assert.throws(() => core.parseSettings({ port: 3000, url }));
  }
});

test("matches HTTP and HTTPS but not other hosts, subdomains, or ports", async () => {
  const app = setup();
  for (const url of ["https://www.example.com/a", "https://example.com.evil.test/a", "https://other.test/a", "https://example.com:8443/a", "http://localhost:3000/a"]) {
    assert.equal((await app.request(url)).redirectUrl, undefined);
  }
  assert.equal(app.requests.length, 0);
  assert.equal((await app.request("http://example.com/a")).redirectUrl, "http://localhost:3000/a");
});

test("leaves navigation alone when offline, unconfigured, or posting a form", async () => {
  const offline = setup({ fetchImpl: async () => { throw new Error("connection refused"); } });
  assert.equal((await offline.request()).redirectUrl, undefined);
  const empty = setup({ stored: null });
  assert.equal((await empty.request()).redirectUrl, undefined);
  const app = setup();
  assert.equal((await app.request("https://example.com/submit", "POST")).redirectUrl, undefined);
  assert.equal(app.requests.length, 0);
});

test("any HTTP status proves reachability and results are not cached", async () => {
  let online = true;
  const app = setup({ fetchImpl: async () => {
    if (!online) throw new Error("offline");
    return { status: 405 };
  } });
  assert.ok((await app.request()).redirectUrl);
  online = false;
  assert.equal((await app.request()).redirectUrl, undefined);
  assert.equal(app.requests.length, 2);
});

test("timeout releases the original navigation", async () => {
  const app = setup({
    timer: (callback) => setTimeout(callback, 5),
    fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    })
  });
  assert.equal((await app.request()).redirectUrl, undefined);
});

test("shares concurrent probes and ignores results after settings change", async () => {
  let resolveProbe;
  const app = setup({ fetchImpl: () => new Promise((resolve) => { resolveProbe = resolve; }) });
  const first = app.request();
  const second = app.request();
  await new Promise(setImmediate);
  assert.equal(app.requests.length, 1);
  app.change({ port: 4000, url: "https://example.com" });
  resolveProbe({ status: 200 });
  assert.equal((await first).redirectUrl, undefined);
  assert.equal((await second).redirectUrl, undefined);
  app.change(undefined);
  assert.equal((await app.request()).redirectUrl, undefined);
});
