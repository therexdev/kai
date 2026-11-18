"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), express = require("express"), http = require("node:http");
test("network account entry uses fixed destinations without forwarding queries or cookies", async t => {
  const app = express(); app.use(require("../lib/web-account-entry").webAccountEntry());
  const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = "http://127.0.0.1:" + server.address().port;
  for (const route of ["/platform", "/platform/docs"]) {
    const response = await fetch(base + route + "?next=https://other.invalid&code=private", { redirect: "manual", headers: { cookie: "legacy=private" } });
    assert.equal(response.status, 302); assert.equal(response.headers.get("location"), "https://credits.koinosai.com" + route);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal((await fetch(base + "/platform", { method: "POST", redirect: "manual" })).status, 404);
});
