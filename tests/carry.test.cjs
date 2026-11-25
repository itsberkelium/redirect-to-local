const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const SOURCE = "https://example.com";
const withCarry = (carry, extra = {}) => ({ port: 3000, url: SOURCE, carry, warn: false, ...extra });

function setup({ tabs = { 1: { id: 1, url: "https://example.com/app", status: "complete" } }, cookies = [], storage = { localStorage: { a: "1" }, sessionStorage: { s: "2" } } } = {}) {
  const calls = { set: [], scripts: [], created: [], removed: [], updated: [], windows: [] };
  let committed, answerListener;
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout, crypto,
    browser: {
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
      runtime: { id: "me", getURL: (file) => `moz-extension://me/${file}`, onMessage: { addListener: (fn) => { answerListener = fn; } } },
      webNavigation: { onCommitted: { addListener: (fn) => { committed = fn; } } },
      cookies: {
        getAll: async () => cookies,
        set: async (details) => { if (details.name.startsWith("__Host-")) throw new Error("refused"); calls.set.push(details); }
      },
      scripting: { executeScript: async (options) => {
        calls.scripts.push(options);
        return [{ result: options.func.name === "readStorage" ? storage : undefined }];
      } },
      tabs: {
        get: async (id) => { if (!tabs[id]) throw new Error("closed"); return tabs[id]; },
        create: async (options) => { calls.created.push(options); tabs[99] = { id: 99, url: options.url, status: "complete" }; return tabs[99]; },
        remove: async (id) => { calls.removed.push(id); },
        update: async (id, options) => { calls.updated.push({ id, ...options }); },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onRemoved: { addListener: () => {} }
      },
      windows: { create: async (options) => { calls.windows.push(options); } }
    }
  });
  for (const file of ["shared.js", "background-core.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  return {
    core: context.RedirectLocal, calls, context,
    commit: (details) => committed({ frameId: 0, tabId: 1, ...details }),
    message: (message, sender = { id: "me" }) => answerListener(message, sender, () => {})
  };
}
const flush = () => new Promise(setImmediate);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("settings keep only boolean carry choices and default to off", () => {
  const { core } = setup();
  assert.deepEqual(plain(core.parseSettings({ port: 3000, url: SOURCE }).carry), { cookies: false, localStorage: false, sessionStorage: false });
  const parsed = core.parseSettings({ port: 3000, url: SOURCE, carry: { cookies: true, localStorage: "yes", other: true }, warn: true });
  assert.deepEqual(plain(parsed.carry), { cookies: true, localStorage: false, sessionStorage: false });
  assert.equal(parsed.warn, true);
});

test("the extension's own temporary tab is never redirected", () => {
  const { core } = setup();
  const settings = { port: 3000, url: SOURCE };
  assert.ok(core.redirectTarget(`${SOURCE}/robots.txt`, settings));
  assert.equal(core.redirectTarget(`${SOURCE}/robots.txt?${core.CARRY_PARAM}=1`, settings), null);
});

test("cookies are copied to localhost and one refused cookie does not stop the rest", async () => {
  const app = setup({ cookies: [
    { name: "__Host-a", value: "x", path: "/", secure: true, sameSite: "strict" },
    { name: "sid", value: "abc", path: "/", httpOnly: true, secure: true, sameSite: "no_restriction", session: false, expirationDate: 1900000000 },
    { name: "theme", value: "dark", path: "/app", sameSite: "lax", session: true }
  ] });
  const payload = await app.context.collectCarry(1, withCarry({ cookies: true }));
  assert.deepEqual(plain(app.calls.set), [
    { url: "http://localhost:3000/", name: "sid", value: "abc", path: "/", httpOnly: true, expirationDate: 1900000000 },
    { url: "http://localhost:3000/", name: "theme", value: "dark", path: "/app", httpOnly: false, sameSite: "lax" }
  ]);
  assert.equal(app.calls.scripts.length, 0);
  assert.deepEqual(plain(payload), { localStorage: {}, sessionStorage: {} });
});

test("a tab already on the website supplies live localStorage and sessionStorage", async () => {
  const app = setup();
  const payload = await app.context.collectCarry(1, withCarry({ localStorage: true, sessionStorage: true }));
  assert.deepEqual(plain(payload), { localStorage: { a: "1" }, sessionStorage: { s: "2" } });
  assert.equal(app.calls.created.length, 0);
});

test("only the selected storage is carried", async () => {
  const app = setup();
  const payload = await app.context.collectCarry(1, withCarry({ sessionStorage: true }));
  assert.deepEqual(plain(payload), { localStorage: {}, sessionStorage: { s: "2" } });
});

test("from another page, an inactive temporary tab supplies localStorage and is closed", async () => {
  const app = setup({ tabs: { 1: { id: 1, url: "https://other.test/", status: "complete" } } });
  const payload = await app.context.collectCarry(1, withCarry({ localStorage: true, sessionStorage: true }));
  assert.deepEqual(plain(payload), { localStorage: { a: "1" }, sessionStorage: {} });
  assert.equal(app.calls.created.length, 1);
  assert.equal(app.calls.created[0].active, false);
  assert.ok(app.calls.created[0].url.startsWith(`${SOURCE}/robots.txt?${app.core.CARRY_PARAM}=`));
  assert.deepEqual(plain(app.calls.removed), [99]);
});

test("sessionStorage alone never opens a temporary tab", async () => {
  const app = setup({ tabs: { 1: { id: 1, url: "https://other.test/", status: "complete" } } });
  await app.context.collectCarry(1, withCarry({ sessionStorage: true }));
  assert.equal(app.calls.created.length, 0);
});

test("a failed read still lets the redirect continue", async () => {
  const app = setup({ tabs: {} });
  const payload = await app.context.collectCarry(1, withCarry({ localStorage: true }));
  assert.deepEqual(plain(payload), { localStorage: {}, sessionStorage: {} });
});

test("nothing is collected when no option is on", async () => {
  const app = setup();
  assert.equal(await app.context.collectCarry(1, withCarry({})), null);
  assert.equal(app.calls.scripts.length + app.calls.set.length, 0);
});

test("queued storage is written once, at the top frame of localhost on the saved port", async () => {
  const app = setup();
  app.context.queueCarry(1, 3000, { localStorage: { a: "1" }, sessionStorage: { s: "2" } });
  app.commit({ url: "http://localhost:4000/" });
  app.commit({ url: "http://localhost:3000/", frameId: 3 });
  assert.equal(app.calls.scripts.length, 0);
  app.commit({ url: "http://localhost:3000/x" });
  assert.equal(app.calls.scripts.length, 1);
  const call = app.calls.scripts[0];
  assert.equal(call.injectImmediately, true);
  assert.deepEqual(plain(call.args), [{ a: "1" }, { s: "2" }]);
  app.commit({ url: "http://localhost:3000/y" });
  assert.equal(app.calls.scripts.length, 1);
});

test("empty storage queues nothing", () => {
  const app = setup();
  app.context.queueCarry(1, 3000, { localStorage: {}, sessionStorage: {} });
  app.commit({ url: "http://localhost:3000/" });
  assert.equal(app.calls.scripts.length, 0);
});

test("warn asks only when it is on and an option is selected", () => {
  const { context } = setup();
  assert.equal(context.shouldAsk(withCarry({ cookies: true }, { warn: true })), true);
  assert.equal(context.shouldAsk(withCarry({ cookies: true })), false);
  assert.equal(context.shouldAsk(withCarry({}, { warn: true })), false);
});

async function ask(app, settings) {
  await app.context.askAboutCarry(1, "http://localhost:3000/app", settings);
  const url = new URL(app.calls.windows[0].url);
  return url.searchParams.get("id");
}

test("the question opens one popup per tab and names the chosen options", async () => {
  const app = setup();
  const settings = withCarry({ cookies: true, localStorage: true }, { warn: true });
  await ask(app, settings);
  await app.context.askAboutCarry(1, "http://localhost:3000/app", settings);
  assert.equal(app.calls.windows.length, 1);
  assert.equal(app.calls.windows[0].type, "popup");
  const url = new URL(app.calls.windows[0].url);
  assert.equal(url.searchParams.get("carry"), "cookies,localStorage");
  assert.equal(url.searchParams.get("site"), "example.com");
});

test("answering carry copies data, then redirects the tab", async () => {
  const app = setup({ cookies: [{ name: "sid", value: "abc", path: "/" }] });
  const settings = withCarry({ cookies: true, sessionStorage: true }, { warn: true });
  const id = await ask(app, settings);
  app.message({ type: "carry-answer", id, answer: "carry" }); await flush(); await flush();
  assert.equal(app.calls.set.length, 1);
  assert.deepEqual(plain(app.calls.updated), [{ id: 1, url: "http://localhost:3000/app" }]);
  app.commit({ url: "http://localhost:3000/app" });
  assert.deepEqual(plain(app.calls.scripts.at(-1).args), [{}, { s: "2" }]);
});

test("answering without data redirects and copies nothing", async () => {
  const app = setup({ cookies: [{ name: "sid", value: "abc", path: "/" }] });
  const id = await ask(app, withCarry({ cookies: true, localStorage: true }, { warn: true }));
  app.message({ type: "carry-answer", id, answer: "plain" }); await flush();
  assert.equal(app.calls.set.length, 0);
  assert.equal(app.calls.scripts.length, 0);
  assert.equal(app.calls.updated.length, 1);
});

test("staying, a second answer, a foreign sender and a tab that left do nothing", async () => {
  const settings = withCarry({ cookies: true }, { warn: true });
  let app = setup(), id = await ask(app, settings);
  app.message({ type: "carry-answer", id, answer: "stay" }); await flush();
  app.message({ type: "carry-answer", id, answer: "plain" }); await flush();
  assert.equal(app.calls.updated.length, 0);

  app = setup(); id = await ask(app, settings);
  app.message({ type: "carry-answer", id, answer: "plain" }, { id: "other" }); await flush();
  assert.equal(app.calls.updated.length, 0);

  app = setup({ tabs: { 1: { id: 1, url: "https://other.test/", status: "complete" } } }); id = await ask(app, settings);
  app.message({ type: "carry-answer", id, answer: "plain" }); await flush();
  assert.equal(app.calls.updated.length, 0);
});
