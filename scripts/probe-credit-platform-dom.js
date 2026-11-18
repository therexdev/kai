"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { JSDOM } = require("jsdom");
const { service } = require("./helpers/credit-gateway-fixture");
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error("UI condition did not resolve"); }
test("dashboard renders live fixture balances and safely creates, copies, hides and revokes keys", async t => {
  const s = await service(t), user = await s.signup("ui@example.test");
  const response = await s.raw("/account", undefined, { cookie: user.cookie });
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const dom = new JSDOM(await response.text(), { url: s.base + "/account", runScripts: "outside-only" }); t.after(() => dom.window.close());
  const w = dom.window, $ = id => w.document.getElementById(id); let copied;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async value => { copied = value; } } });
  w.fetch = (url, options = {}) => fetch(s.base + url, { ...options, headers: { ...options.headers, cookie: user.cookie } });
  w.eval(fs.readFileSync(path.join(__dirname, "../public/platform/account-routes.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(__dirname, "../public/platform/platform.js"), "utf8"));
  await until(() => $("email").textContent === "ui@example.test");
  assert.equal($("free").textContent, "0.01"); assert.equal($("paid").textContent, "0"); assert.equal($("model-count").textContent, "1");
  assert.equal($("tokens").value, "64"); assert.equal($("chat-free").disabled, true);
  w.document.querySelector('[data-tab="keys"]').click(); await until(() => $("key-list").textContent.includes("No API keys"));
  $("key-name").value = '<img src=x onerror=alert(1)>';
  $("key-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => !$("new-key").hidden && $("key-list").querySelector("button"));
  assert.match($("secret").value, /^kai_api_/); assert.equal($("key-list").querySelector("img"), null); assert.match($("key-list").textContent, /<img/);
  assert.equal(w.localStorage.length, 0, "API secrets are never persisted by the portal");
  await $("copy-key").onclick(); assert.equal(copied, $("secret").value);
  await $("hide-key").onclick(); assert.equal($("secret").value, ""); assert.equal($("new-key").hidden, true);
  await $("key-list").querySelector("button").onclick(); assert.match($("key-list").textContent, /Inactive/);
  assert.equal((await s.call("/v1/credits", undefined, { authorization: "Bearer " + copied })).status, 401);
});
test("portal and documentation assets exist, no remote scripts, opt-in account entry", async t => {
  const s = await service(t);
  for (const url of ["/platform/docs", "/platform/assets/platform.js", "/platform/assets/platform.css", "/platform/assets/kondor.js"]) assert.equal((await s.raw(url)).status, 200, url);
  const response = await s.raw("/account"); assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "/login?next=%2Faccount");
  const source = await (await s.raw("/login")).text(); assert.match(source, /Log in or create an account/);
  const html = fs.readFileSync(path.join(__dirname, "../public/platform/index.html"), "utf8"), dom = new JSDOM(html); t.after(() => dom.window.close());
  for (const node of dom.window.document.querySelectorAll("script[src]")) assert.match(node.getAttribute("src"), /^\/platform\/assets\//);
  for (const node of dom.window.document.querySelectorAll("label[for]")) assert.ok(dom.window.document.getElementById(node.htmlFor));
});
