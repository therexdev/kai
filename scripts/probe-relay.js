#!/usr/bin/env node
/*
 * Relay probe — the whole device-relay protocol offline, no Caddy, no app.
 *
 * Spins the real Relay on a local port, runs a minimal "device" against it
 * (hello -> poll loop -> forward to a stub local /v1 API -> streamed
 * respond), then hits the public /r/<id>/v1 URL like any OpenAI client:
 *
 *   1. non-/v1 paths refused, unknown tunnel refused
 *   2. device offline -> honest 503 within the pickup window
 *   3. GET /v1/models round-trips JSON
 *   4. POST /v1/chat/completions round-trips SSE chunk by chunk
 *   5. Authorization passes through untouched (device sees the caller key)
 *   6. oversized body -> 413, wrong method -> 405
 *
 * Exits non-zero on any failure. Run: node scripts/probe-relay.js
 */
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const assert = require("node:assert");
const { Relay, tunnelIdOf } = require("../lib/relay");

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", `${name} — ${e && e.message || e}`]); }
};

(async () => {
  /* ---- stub local /v1 API (what the desktop gateway serves) ---- */
  let sawAuth = null;
  const local = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      sawAuth = req.headers.authorization || null;
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "koinos-fast" }] }));
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
        setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"world."}}]}\n\n'), 120);
        setTimeout(() => { res.write("data: [DONE]\n\n"); res.end(); }, 240);
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const localBase = `http://127.0.0.1:${local.address().port}`;

  /* ---- the real relay behind a bare http server ---- */
  const relay = new Relay({ publicBase: "http://relay.test" });
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/relay")) { req.url = req.url.slice("/relay".length) || "/"; relay.handleDevice(req, res); }
    else if (req.url.startsWith("/r")) { req.url = req.url.slice("/r".length) || "/"; relay.handlePublic(req, res); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const R = `http://127.0.0.1:${srv.address().port}`;

  const token = crypto.randomBytes(32).toString("hex");
  const id = tunnelIdOf(token);
  const auth = { authorization: `Bearer ${token}` };

  /* ---- minimal device: the loop the desktop app will run ---- */
  let deviceOn = false;
  const pollOnce = async () => {
    const r = await fetch(`${R}/relay/poll`, { headers: auth });
    if (r.status !== 200) return;
    const { job } = await r.json();
    const localRes = await fetch(localBase + job.path, {
      method: job.method,
      headers: job.headers,
      body: job.method === "GET" ? undefined : Buffer.from(job.body, "base64"),
    });
    const outHeaders = {};
    for (const k of ["content-type", "cache-control"]) if (localRes.headers.get(k)) outHeaders[k] = localRes.headers.get(k);
    await fetch(`${R}/relay/respond/${job.reqId}`, {
      method: "POST",
      headers: { ...auth, "x-kai-status": String(localRes.status), "x-kai-headers": Buffer.from(JSON.stringify(outHeaders)).toString("base64") },
      body: localRes.body,
      duplex: "half",
    });
  };
  const deviceLoop = async () => { while (deviceOn) { try { await pollOnce(); } catch { await new Promise((r) => setTimeout(r, 200)); } } };

  await test("hello derives the tunnel id from the token", async () => {
    const r = await fetch(`${R}/relay/hello`, { method: "POST", headers: auth });
    const j = await r.json();
    assert.strictEqual(j.tunnelId, id);
    assert.strictEqual(j.base, `http://relay.test/r/${id}/v1`);
  });

  await test("non-/v1 paths and unknown shapes are refused", async () => {
    assert.strictEqual((await fetch(`${R}/r/${id}/core/tools`)).status, 404);
    assert.strictEqual((await fetch(`${R}/r/nonsense/v1/models`)).status, 404);
    assert.strictEqual((await fetch(`${R}/r/${id}/v1/models`, { method: "DELETE" })).status, 405);
  });

  await test("device offline -> honest 503 within the pickup window", async () => {
    const t0 = Date.now();
    const r = await fetch(`${R}/r/${id}/v1/models`);
    assert.strictEqual(r.status, 503);
    const j = await r.json();
    assert.ok(/offline/.test(j.error.message));
    assert.ok(Date.now() - t0 < 10_000, "took too long to say offline");
  });

  deviceOn = true;
  const loops = [deviceLoop(), deviceLoop()];

  await test("GET /v1/models round-trips through the relay", async () => {
    const r = await fetch(`${R}/r/${id}/v1/models`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.data[0].id, "koinos-fast");
  });

  await test("POST chat round-trips SSE chunk by chunk with auth intact", async () => {
    const r = await fetch(`${R}/r/${id}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-api-key" },
      body: JSON.stringify({ model: "koinos-fast", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get("content-type") || "").includes("text/event-stream"));
    let body = "";
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; body += dec.decode(value, { stream: true }); }
    const text = [...body.matchAll(/data: (\{[^\n]*\})/g)].map((m) => JSON.parse(m[1])).map((f) => f.choices?.[0]?.delta?.content || "").join("");
    assert.strictEqual(text, "Hello world.");
    assert.ok(body.includes("data: [DONE]"));
    assert.strictEqual(sawAuth, "Bearer caller-api-key");
  });

  await test("oversized public body -> 413", async () => {
    const r = await fetch(`${R}/r/${id}/v1/chat/completions`, { method: "POST", body: Buffer.alloc(3 * 1024 * 1024) });
    assert.strictEqual(r.status, 413);
  });

  await test("short device token -> 401", async () => {
    const r = await fetch(`${R}/relay/hello`, { method: "POST", headers: { authorization: "Bearer short" } });
    assert.strictEqual(r.status, 401);
  });

  deviceOn = false;
  relay.stop();
  srv.close();
  local.close();
  await Promise.allSettled(loops);

  let failed = 0;
  for (const [s, name] of results) { if (s !== "ok") failed++; console.log(`  ${s === "ok" ? "✓" : "✗"} ${name}`); }
  console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
