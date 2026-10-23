"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), http = require("node:http"), express = require("express"), { JSDOM } = require("jsdom");
const { createCreditAccountWeb, handles } = require("../lib/credit-account-web");
const root = path.join(__dirname, "../public");
test("credit web routes reach the existing website without forwarding credentials or redirect queries", async t => {
  const router = express.Router(); router.get("/auth/session", (_req, res) => res.json({ ok: true, account: { id: "credit-account" } }));
  const server = http.createServer(createCreditAccountWeb(router)); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = "http://127.0.0.1:" + server.address().port;
  for (const route of ["/", "/dashboard", "/network", "/testers", "/app", "/docs/", "/updates", "/privacy"]) {
    assert.equal(handles(route), true);
    const response = await fetch(base + route + "?next=https://other.invalid&code=PRIVATE", { redirect: "manual", headers: { cookie: "fixture=private" } });
    assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "https://koinosai.com" + route);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
  }
  for (const route of ["/account", "/link"]) {
    const response = await fetch(base + route); assert.equal(response.status, 200);
    assert.match(await response.text(), /<body data-account-service="credits">/);
  }
  assert.equal((await (await fetch(base + "/auth/session")).json()).account.id, "credit-account");
  assert.equal((await fetch(base + "/dashboard", { method: "POST", redirect: "manual" })).status, 404);
  assert.equal(handles("/scheduler/worker/register"), false); assert.equal(handles("//other.invalid"), false);
});

test("credit page keeps auth local and sends existing account and node links to the website", async () => {
  const source = fs.readFileSync(path.join(root, "account.html"), "utf8");
  for (const credit of [true, false]) {
    const html = credit ? source.replace("<body>", '<body data-account-service="credits">') : source;
    const dom = new JSDOM(html, { url: credit ? "https://credits.koinosai.com/account" : "https://koinosai.com/account", runScripts: "outside-only" });
    const w = dom.window, requests = [];
    try {
      w.fetch = async (url, options) => {
        requests.push({ url, options });
        assert.ok(url.startsWith("/auth/") || url.startsWith("/account/"));
        return { ok: true, json: async () => ({ ok: true, account: { id: "fixture", email: "fixture@example.test", passkeys: [], wallets: [], grants: [] }, sessions: [] }) };
      };
      w.eval(fs.readFileSync(path.join(root, "i18n/catalogs.js"), "utf8"));
      w.eval(fs.readFileSync(path.join(root, "i18n/i18n.js"), "utf8"));
      for (const script of w.document.querySelectorAll("script:not([src])")) w.eval(script.textContent);
      await new Promise(r => setImmediate(r));
      assert.equal(w.document.getElementById("title").textContent, credit ? "AI credit account" : "Account");
      assert.equal(w.document.getElementById("creditServiceNote").classList.contains("hide"), !credit);
      assert.equal(w.document.getElementById("webAccessCard").classList.contains("hide"), credit);
      const dashboard = w.document.querySelector('.kai-site-links a[href*="dashboard"]');
      assert.equal(dashboard.getAttribute("href"), credit ? "https://koinosai.com/dashboard" : "/dashboard");
      assert.equal(w.document.querySelector('a[href="/auth/google"]').getAttribute("href"), "/auth/google");
      w.document.getElementById("linkCode").value = "CREDIT-CODE";
      await w.document.getElementById("linkBtn").onclick();
      assert.equal(requests.at(-1).url, "/auth/device/approve");
      assert.equal(JSON.parse(requests.at(-1).options.body).userCode, "CREDIT-CODE");
      assert.ok(!requests.some(r => /^https:/.test(r.url)));
    } finally { w.close(); }
  }
});
