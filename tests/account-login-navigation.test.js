"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), express = require("express"), fs = require("node:fs"), path = require("node:path");
const { webAccountEntry } = require("../lib/web-account-entry");
async function fixture(t, ready) {
  let active = ready, calls = 0, time = 100000, fail = false;
  const app = express();
  app.use(webAccountEntry({ accounts: { accountOf: req => req.headers.cookie?.includes("fixture=verified") ? { id: "old-account" } : null }, clock: () => time, fetchImpl: async () => { calls++; if (fail) throw Error("offline"); return { ok: true, json: async () => ({ webApiVersion: 1, accountUiVersion: active ? 1 : 0 }) }; } }));
  app.get("/account", (_req, res) => res.send("existing account"));
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return { get: (route, cookie) => fetch("http://127.0.0.1:" + server.address().port + route, { redirect: "manual", headers: cookie ? { cookie } : {} }), set active(v) { active = v; time += 21000; }, set fail(v) { fail = v; time += 21000; }, get calls() { return calls; } };
}
test("public login and account switch only after the new backend is verified", async t => {
  const s = await fixture(t, false); assert.equal((await s.get("/account")).status, 200);
  assert.equal((await s.get("/login")).headers.get("location"), "https://credits.koinosai.com/account?next=/platform"); assert.equal(s.calls, 1);
  s.active = true;
  for (const [route, target] of [["/login", "/login"], ["/account", "/account"], ["/platform", "/account"]]) {
    const r = await s.get(route + "?next=//evil.test&token=private", "kai_session=private"); assert.equal(r.headers.get("location"), "https://credits.koinosai.com" + target); assert.equal(r.headers.get("set-cookie"), null); assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  }
  s.fail = true; assert.equal((await s.get("/login")).headers.get("location"), "https://credits.koinosai.com/login");
});
test("old gated tools, device codes and Google callbacks retain website authentication", async t => {
  const s = await fixture(t, true);
  assert.equal((await s.get("/account?next=/build")).headers.get("location"), "/website-login?next=%2Fbuild");
  const login = await s.get("/website-login?next=%2Flink%3Fcode%3DABCD-1234"); assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /kai_website_return/); assert.match(login.headers.get("set-cookie"), /HttpOnly/); assert.match(await login.text(), /login-email/);
  assert.equal((await s.get("/account", cookie + "; fixture=verified")).headers.get("location"), "/link?code=ABCD-1234");
  const evil = await s.get("/website-login?next=%2F%5Cevil.test", "fixture=verified"); assert.equal(evil.headers.get("location"), "/dashboard");
  assert.equal((await s.get("/account/website")).headers.get("location"), "/website-login?next=%2Faccount%2Fwebsite");
  assert.equal((await s.get("/account/website", "fixture=verified")).status, 200);
});
test("login is visible in desktop navigation and outside the mobile menu", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  assert.match(html, /href="\/login" class="login-link">Log in/); assert.match(html, /class="login-mobile" href="\/login">Log in/);
});
