"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), express = require("express");
const hash = value => crypto.createHash("sha256").update(value).digest("base64url");
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-workspace-")), accounts = require("../lib/accounts").createAccounts({ stateDir: dir, siteOrigin: "http://localhost" });
  let exchange, identity = { issuer: "https://credits.koinosai.com", subject: "acc_1234567890abcdef", email: "saved@example.test", emailVerified: true }, fail = false;
  let now = Date.now();
  const app = express(), sso = require("../lib/workspace-sso").workspaceSso({ accounts, clock: () => now, fetchImpl: async (url, init) => {
    assert.equal(url, "https://credits.koinosai.com/auth/workspace/exchange"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.cookie, undefined); exchange = JSON.parse(init.body);
    return { ok: !fail, text: async () => JSON.stringify(identity) };
  } });
  app.use(sso.router);
  app.get(["/chat", "/build"], (req, res) => { if (sso.enter(req, res, req.path)) res.json({ account: accounts.accountOf(req).id }); });
  app.get("/who", (req, res) => res.json(accounts.accountOf(req)));
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); accounts.service.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + server.address().port;
  return { accounts, advance: ms => { now += ms; }, get: (url, cookie) => fetch(base + url, { redirect: "manual", headers: cookie ? { cookie } : {} }), get exchange() { return exchange; }, set identity(v) { identity = v; }, set fail(v) { fail = v; } };
}
test("shared login retains the existing verified-email workspace and requires matching browser state", async t => {
  const s = await fixture(t), old = s.accounts.service._newAccount({ email: "saved@example.test" });
  const start = await s.get("/auth/workspace/start?next=%2Fbuild");
  const location = new URL(start.headers.get("location")), state = location.searchParams.get("state"), cookie = start.headers.get("set-cookie").split(";")[0];
  assert.equal(location.origin, "https://credits.koinosai.com"); assert.match(start.headers.get("set-cookie"), /HttpOnly/);
  const callback = "/auth/workspace/callback?" + new URLSearchParams({ state, code: crypto.randomBytes(32).toString("base64url") });
  assert.equal((await s.get(callback, "kai_workspace_state=wrong")).status, 401); assert.equal(s.exchange, undefined);
  const done = await s.get(callback, cookie); assert.equal(done.status, 302); assert.equal(done.headers.get("location"), "/build");
  assert.equal(hash(s.exchange.verifier), location.searchParams.get("challenge"));
  const session = done.headers.getSetCookie().find(c => c.startsWith("kai_session=")).split(";")[0];
  assert.equal((await (await s.get("/who", session)).json()).id, old.id);
  assert.equal(s.accounts.service.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
  assert.equal((await s.get(callback, cookie)).status, 401);
});
test("workspace entry receipts are single-use, account-bound, destination-bound and expire", async t => {
  const s = await fixture(t);
  const first = s.accounts.service._newAccount({ email: "saved@example.test" }), other = s.accounts.service._newAccount({ email: "other@example.test" });
  const firstSession = "kai_session=" + s.accounts.service._issueSession(first.id, "browser"), otherSession = "kai_session=" + s.accounts.service._issueSession(other.id, "other browser");
  async function approve() {
    const start = await s.get("/auth/workspace/start?next=%2Fchat"), state = new URL(start.headers.get("location")).searchParams.get("state");
    const stateCookie = start.headers.getSetCookie()[0].split(";")[0];
    const done = await s.get("/auth/workspace/callback?" + new URLSearchParams({ state, code: crypto.randomBytes(32).toString("base64url") }), stateCookie + "; " + firstSession);
    assert.equal(done.status, 302); assert.equal(done.headers.get("location"), "/chat");
    assert.ok(!done.headers.getSetCookie().some(c => c.startsWith("kai_session=")), "same account reuses its website session");
    return done.headers.getSetCookie().find(c => c.startsWith("kai_workspace_entry=")).split(";")[0];
  }
  const entry = await approve();
  assert.equal((await s.get("/chat", otherSession + "; " + entry)).status, 302);
  assert.equal((await s.get("/build", firstSession + "; " + entry)).status, 302);
  const accepted = await s.get("/chat", firstSession + "; " + entry); assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).account, first.id);
  assert.equal((await s.get("/chat", firstSession + "; " + entry)).status, 302);
  const expired = await approve(); s.advance(60001);
  assert.equal((await s.get("/chat", firstSession + "; " + expired)).status, 302);
});
test("forged identities and failed exchanges cannot create sessions, and return URLs stay allowlisted", async t => {
  const s = await fixture(t);
  for (const bad of [{ issuer: "https://evil.test", subject: "acc_1234567890abcdef", email: null }, { issuer: "https://credits.koinosai.com", subject: "acc_1234567890abcdef", email: "saved@example.test", emailVerified: false }]) {
    s.identity = bad;
    const start = await s.get("/auth/workspace/start?next=https://evil.test");
    const state = new URL(start.headers.get("location")).searchParams.get("state"), cookie = start.headers.get("set-cookie").split(";")[0];
    const done = await s.get("/auth/workspace/callback?" + new URLSearchParams({ state, code: crypto.randomBytes(32).toString("base64url") }), cookie);
    assert.equal(done.status, 401); assert.equal(done.headers.get("set-cookie"), null);
  }
  assert.equal(s.accounts.service.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 0);
  assert.equal(require("../public/account-ui/account-routes").destination("//evil.test"), "/dashboard");
  assert.equal(require("../public/account-ui/account-routes").destination("/app/history#docs"), "/app/history#docs");
});

test("opening Build from the workspace checks the current shared login even with an older website session", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-workspace-entry-"));
  const accounts = require("../lib/accounts").createAccounts({ stateDir: dir, siteOrigin: "http://localhost" });
  const old = accounts.service._newAccount({ email: "older@example.test" }), token = accounts.service._issueSession(old.id, "old browser");
  const app = express(); app.use(require("../lib/web-account-entry").webAccountEntry({ accounts, fetchImpl: async () => ({ ok: true, json: async () => ({ webApiVersion: 1, accountUiVersion: 1, workspaceUiVersion: 1, workspaceSsoVersion: 1 }) }) }));
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); accounts.service.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + server.address().port;
  const response = await fetch(base + "/website-login?next=%2Fbuild", { redirect: "manual", headers: { cookie: "kai_session=" + token } });
  assert.match(response.headers.get("location"), /^https:\/\/credits\.koinosai\.com\/auth\/workspace\/authorize\?/);
  assert.match(response.headers.get("set-cookie"), /kai_workspace_state=/);
  assert.equal((await fetch(base + "/app", { redirect: "manual" })).headers.get("location"), "/chat");
});
