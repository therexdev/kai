"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const https = require("node:https"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { PinnedRpcProvider, rpcDiagnostics } = require("../lib/koin-network/rpc-provider");
const { createRpcTransport, MAX_BODY_BYTES } = require("../lib/koin-network/rpc-http");
const { endpointStats } = require("../lib/koin-network/rpc-scheduler");
const chainId = "recovery-fixture-chain";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rpc-tls-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Disposable TLS identity, trusted only by this fixture's injected request.
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const cert = fs.readFileSync(path.join(dir, "cert.pem")), sockets = new Set();
  const f = { mode: "healthy", calls: [], active: 0, peak: 0, closed: 0 };
  const server = https.createServer({ cert, key: fs.readFileSync(path.join(dir, "key.pem")) }, (req, res) => {
    (async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); f.calls.push(body);
      if (f.mode === "headers") return;
      if (f.mode === "body" || (f.mode === "broadcast" && body.method === "chain.submit_transaction")) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); return;
      }
      if (f.mode === "error") { res.writeHead(503); res.write("unavailable"); return; }
      if (f.mode === "redirect") { res.writeHead(302, { Location: f.url + "/redirected" }); res.end(); return; }
      if (f.mode === "oversize") { res.writeHead(200); res.end(Buffer.alloc(MAX_BODY_BYTES + 1, 32)); return; }
      if (f.mode === "drop") { res.writeHead(200); res.write("{"); setImmediate(() => res.destroy()); return; }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
        result: body.method === "chain.get_chain_id" ? { chain_id: f.mode === "wrong-chain" ? "other" : chainId } : { ok: true } }));
    })().catch(() => res.destroy());
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  f.url = "https://127.0.0.1:" + server.address().port;
  f.fetchImpl = createRpcTransport({ request: (url, options, callback) => {
    assert.equal(options.agent, false);
    const req = https.request(url, { ...options, ca: cert }, callback);
    f.active++; f.peak = Math.max(f.peak, f.active);
    req.once("close", () => { f.active--; f.closed++; });
    return req;
  } });
  f.provider = (options = {}) => new PinnedRpcProvider([f.url], chainId, { fetchImpl: f.fetchImpl, ...options });
  return f;
}
test("real HTTPS header/body stalls release both RPC slots after deadlines, repeatedly, without a process restart", { timeout: 10000 }, async t => {
  const f = await fixture(t), p = f.provider({ timeoutMs: 300, attemptTimeoutMs: 300 });
  for (const mode of ["headers", "body", "headers", "body"]) {
    f.mode = mode;
    const failed = await Promise.allSettled([p.getChainId(), p.getChainId()]);
    assert.ok(failed.every(r => r.status === "rejected" && r.reason.code === "koin_rpc_unavailable"));
    f.mode = "healthy";
    assert.equal(await f.provider().getChainId(), chainId);
    assert.equal(f.active, 0);
  }
  assert.ok(f.peak <= 2); assert.equal(f.closed, f.calls.length);
});
test("a queued broadcast cancelled behind stalled sockets never sends later", { timeout: 5000 }, async t => {
  const f = await fixture(t); f.mode = "headers";
  const p = f.provider({ timeoutMs: 400, attemptTimeoutMs: 400 });
  const holders = Promise.allSettled([p.getChainId(), p.getChainId()]);
  while (f.calls.length < 2) await pause(5);
  const controller = new AbortController();
  const queued = p.call("chain.submit_transaction", { broadcast: true }, { signal: controller.signal });
  controller.abort(); await assert.rejects(queued, /stopped/); await holders;
  f.mode = "healthy"; assert.equal(await f.provider().getChainId(), chainId);
  assert.equal(f.calls.filter(row => row.method === "chain.submit_transaction").length, 0);
  assert.ok(f.peak <= 2);
});
test("a broadcast whose response stalls has one attempt and no automatic rebroadcast on recovery", { timeout: 5000 }, async t => {
  const f = await fixture(t); f.mode = "broadcast";
  const p = new PinnedRpcProvider([f.url, "https://unused-backup.invalid"], chainId,
    { fetchImpl: f.fetchImpl, timeoutMs: 600, attemptTimeoutMs: 300 });
  const transaction = { id: "saved-transaction", signatures: ["private-fixture"] };
  await assert.rejects(p.call("chain.submit_transaction", { broadcast: true, transaction }), /temporarily unavailable/);
  f.mode = "healthy"; assert.equal(await f.provider().getChainId(), chainId);
  assert.deepEqual(f.calls.filter(row => row.method === "chain.submit_transaction").map(row => row.params.transaction), [transaction]);
});
test("unfinished HTTP errors, truncated responses and oversized bodies cannot poison later RPC reads", { timeout: 10000 }, async t => {
  const f = await fixture(t), p = f.provider({ timeoutMs: 2000, attemptTimeoutMs: 2000 });
  for (const mode of ["error", "drop", "oversize"]) {
    f.mode = mode;
    await assert.rejects(p.getChainId(), error => {
      assert.equal(error.code, "koin_rpc_unavailable");
      if (mode === "error") assert.equal(rpcDiagnostics(error)[0].httpStatus, 503);
      return true;
    });
    assert.equal(f.active, 0); f.mode = "healthy";
    if (mode === "error") {
      const before = f.calls.length;
      await assert.rejects(p.getChainId(), error => rpcDiagnostics(error)[0]?.kind === "cooldown");
      assert.equal(f.calls.length, before, "A throttled endpoint stays quiet until recovery is due");
      await pause(endpointStats(f.url).cooldownRemainingMs + 5);
    }
    assert.equal(await p.getChainId(), chainId);
  }
});
test("real transport preserves safe read fallback, redirect refusal and chain pinning", { timeout: 10000 }, async t => {
  const f = await fixture(t), g = await fixture(t);
  f.mode = "error";
  const fetchImpl = (url, options) => (url === f.url ? f : g).fetchImpl(url, options);
  const p = new PinnedRpcProvider([f.url, g.url], chainId, { fetchImpl });
  assert.deepEqual(await p.call("chain.get_head_info", {}), { ok: true });
  assert.equal(p.readGeneration, 1);
  for (const mode of ["redirect", "wrong-chain"]) {
    await pause(endpointStats(f.url).cooldownRemainingMs + 5);
    f.mode = mode; const before = f.calls.length, backupBefore = g.calls.length;
    await assert.rejects(new PinnedRpcProvider([f.url, g.url], chainId, { fetchImpl }).call("chain.read_contract", {}),
      mode === "redirect" ? /refused/ : /chain mismatch/);
    assert.equal(f.calls.length, before + 1); assert.equal(g.calls.length, backupBefore);
  }
});
test("default transport bypasses global fetch and still rejects an untrusted TLS certificate", { timeout: 5000 }, async t => {
  const f = await fixture(t), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw Error("Global fetch must not carry scheduler RPC"); };
  try {
    const p = new PinnedRpcProvider([f.url], chainId, { timeoutMs: 1000, attemptTimeoutMs: 1000 });
    await assert.rejects(p.getChainId(), /temporarily unavailable/);
    assert.equal(calls, 0); assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = original; }
});
