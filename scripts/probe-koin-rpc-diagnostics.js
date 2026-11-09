"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const https = require("node:https"), net = require("node:net");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { PinnedRpcProvider, rpcDiagnostics } = require("../lib/koin-network/rpc-provider");
const { createRpcTransport } = require("../lib/koin-network/rpc-http");
const D = require("../lib/koin-network/rpc-diagnostics");

function aggregate() {
  return Object.assign(new AggregateError([
    Object.assign(Error("private IPv4 message"), { code: "ETIMEDOUT", syscall: "connect", address: "192.0.2.1", port: 443 }),
    Object.assign(Error("private IPv6 message"), { code: "ENETUNREACH", syscall: "connect", address: "2001:db8::1", port: 443 }),
  ], "secret aggregate details"), { code: "ETIMEDOUT" });
}
test("native aggregate and fetch cause errors retain bounded IP failures without private text", async () => {
  for (const wrap of [false, true]) {
    const error = wrap ? Object.assign(Error("secret wrapper"), { cause: aggregate() }) : aggregate();
    const provider = new PinnedRpcProvider(["https://aggregate.invalid/rpc?credential=private"], "fixture", { fetchImpl: async () => { throw error; } });
    let caught; try { await provider.getChainId(); } catch (failure) { caught = failure; }
    const [row] = rpcDiagnostics(caught);
    assert.equal(row.kind, "network"); assert.deepEqual(row.networkCodes, ["ETIMEDOUT", "ENETUNREACH"]);
    assert.deepEqual(row.networkAttempts, [
      { address: "192.0.2.1", family: 4, port: 443, code: "ETIMEDOUT", syscall: "connect" },
      { address: "2001:db8::1", family: 6, port: 443, code: "ENETUNREACH", syscall: "connect" },
    ]);
    assert.ok(row.queueWaitMs >= 0); assert.doesNotMatch(JSON.stringify(row), /private|secret|credential/);
  }
});
test("cyclic or oversized error graphs inspect at most eight nodes and omit arbitrary fields", () => {
  let inspected = 0;
  const error = { get code() { inspected++; return "ETIMEDOUT"; }, errors: [] }; error.cause = error;
  for (let i = 0; i < 100; i++) error.errors.push({ get code() { inspected++; return "ENETUNREACH"; },
    address: "192.0.2.2", port: 443, syscall: "private syscall", params: "private params", message: "private message" });
  const result = D.networkDetails(error);
  assert.ok(inspected <= 8); assert.ok(result.networkAttempts.length <= 8);
  assert.doesNotMatch(JSON.stringify(result), /private|params|message/);
});
test("transport metadata is allowlisted, bounded and re-sanitized at the public diagnostics boundary", () => {
  const value = { endpoint: "https://metadata.invalid/private?secret=value", kind: "network", method: "chain.get_chain_id",
    elapsedMs: 1e12, budgetMs: -1, queueWaitMs: Infinity,
    transport: { phase: "private phase", elapsedMs: 1e12, lookupMs: -1, tlsMs: NaN, bytesReceived: Number.MAX_SAFE_INTEGER,
      headers: { authorization: "private" }, body: "private body", attempts: Array.from({ length: 100 }, () => ({
        address: "192.0.2.3", family: "private", port: 999999, code: "private", syscall: "private", outcome: "timeout", elapsedMs: 1e12,
      })) }, networkAttempts: [{ address: "private.example", code: "ETIMEDOUT" }, { address: "fe80::1%private", code: "ETIMEDOUT" }] };
  const [row] = rpcDiagnostics({ rpcDiagnostics: [value] });
  assert.equal(row.elapsedMs, 3600000); assert.equal(row.budgetMs, undefined); assert.equal(row.queueWaitMs, undefined);
  assert.equal(row.transport.phase, undefined); assert.equal(row.transport.lookupMs, undefined); assert.equal(row.transport.tlsMs, undefined);
  assert.equal(row.transport.elapsedMs, 3600000); assert.equal(row.transport.bytesReceived, 16777217);
  assert.equal(row.transport.attempts.length, 4); assert.deepEqual(row.networkAttempts, []);
  assert.doesNotMatch(JSON.stringify(row), /private|secret|authorization|headers|body/);
});

function syntheticRequest(run) {
  return (_url, options, callback) => {
    assert.equal(options.agent, false); assert.equal(options.family, undefined); assert.equal(options.autoSelectFamilyAttemptTimeout, 1000);
    const request = new EventEmitter(), socket = new EventEmitter(); let closed = false;
    request.destroy = () => { if (!closed) { closed = true; setImmediate(() => request.emit("close")); } };
    request.end = body => setImmediate(() => { request.emit("socket", socket); run({ request, socket, options, body, callback }); });
    return request;
  };
}
const requestOptions = () => ({ method: "POST", redirect: "error", body: '{"method":"read-only-fixture"}', signal: new AbortController().signal });
test("socket failure captures the exact address timeout stage and measured attempt timings", async () => {
  const fetchImpl = createRpcTransport({ request: syntheticRequest(({ request, socket }) => {
    socket.autoSelectFamilyAttemptedAddresses = ["192.0.2.1:443", "2001:db8::1:443"];
    socket.emit("lookup", null, "192.0.2.1", 4);
    socket.emit("connectionAttempt", "192.0.2.1", 443, 4);
    socket.emit("connectionAttemptTimeout", "192.0.2.1", 443, 4);
    socket.emit("connectionAttempt", "2001:db8::1", 443, 6);
    socket.emit("connectionAttemptFailed", "2001:db8::1", 443, 6, { code: "ENETUNREACH", message: "secret" });
    request.emit("error", aggregate());
  }) });
  await assert.rejects(fetchImpl("https://socket-events.invalid", requestOptions()), error => {
    assert.equal(error.code, "ETIMEDOUT");
    const result = D.networkDetails(error), detail = result.transport;
    assert.equal(detail.phase, "connect"); assert.ok(detail.elapsedMs >= detail.lookupMs);
    assert.deepEqual(detail.attempts.map(a => [a.family, a.outcome]), [[4, "timeout"], [6, "failed"]]);
    assert.ok(detail.attempts.every(a => Number.isInteger(a.elapsedMs) && a.elapsedMs >= 0));
    assert.doesNotMatch(JSON.stringify(result), /private|secret|startedAt/); return true;
  });
});
test("real HTTPS address selection exposes native AggregateError children and socket failure events", async t => {
  // Reserve a local port while connecting to two other loopback addresses.
  // No TLS bypass or Internet dependency.
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const transport = createRpcTransport({ request: (url, options, callback) => https.request(url, { ...options,
    autoSelectFamily: true,
    lookup: (_host, _options, done) => done(null, [{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.3", family: 4 }]),
  }, callback) });
  await assert.rejects(transport(`https://native-errors.invalid:${port}`, { ...requestOptions(), signal: AbortSignal.timeout(2000) }), error => {
    assert.ok(error instanceof AggregateError);
    const detail = D.networkDetails(error);
    assert.deepEqual(detail.networkCodes, ["ECONNREFUSED"]);
    assert.deepEqual(detail.networkAttempts.map(a => a.address), ["127.0.0.2", "127.0.0.3"]);
    assert.equal(detail.transport.phase, "connect");
    assert.deepEqual(detail.transport.attempts.map(a => [a.address, a.outcome]), [["127.0.0.2", "failed"], ["127.0.0.3", "failed"]]);
    return true;
  });
});
test("an address observed only after failure does not invent a start time or outcome", async () => {
  const transport = createRpcTransport({ request: syntheticRequest(({ request, socket }) => {
    socket.autoSelectFamilyAttemptedAddresses = ["192.0.2.1:443"];
    request.emit("error", aggregate());
  }) });
  await assert.rejects(transport("https://missed-events.invalid", requestOptions()), error => {
    assert.equal(error.rpcTransport.phase, "connect");
    assert.deepEqual(error.rpcTransport.attempts, [{ address: "192.0.2.1", family: 4, port: 443 }]);
    return true;
  });
});
test("real HTTPS keeps a healthy first address through a 350 ms event-loop stall and still falls back", { timeout: 10000 }, async t => {
  const defaultAttemptTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rpc-address-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "1",
    "-subj", "/CN=address-race.invalid", "-addext", "subjectAltName=DNS:address-race.invalid"], { stdio: "ignore" });
  const cert = fs.readFileSync(path.join(dir, "cert.pem")), sockets = new Set(); let received = 0;
  const server = https.createServer({ cert, key: fs.readFileSync(path.join(dir, "key.pem")) }, (req, res) => {
    received++; req.resume(); res.end('{"ok":true}');
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `https://address-race.invalid:${server.address().port}`;
  const transport = (addresses, delayMs, comparisonTimeout) => createRpcTransport({ request: (target, options, callback) => {
    const request = https.request(target, { ...options, ca: cert, autoSelectFamily: true,
      ...(comparisonTimeout === undefined ? {} : { autoSelectFamilyAttemptTimeout: comparisonTimeout }),
      lookup: (_host, _options, done) => done(null, addresses.map(address => ({ address, family: 4 }))),
    }, callback);
    const until = performance.now() + delayMs; while (performance.now() < until) {}
    return request;
  } });
  const options = () => ({ ...requestOptions(), signal: AbortSignal.timeout(3000) });
  // The old per-address default drops the healthy first connect before the
  // event loop can observe it, then the unavailable second address fails.
  await assert.rejects(transport(["127.0.0.1", "127.0.0.2"], 350, 250)(url, options()), error =>
    error instanceof AggregateError && D.networkDetails(error).networkCodes.includes("ETIMEDOUT"));
  assert.equal(received, 0);
  const healthy = await transport(["127.0.0.1", "127.0.0.2"], 350)(url, options());
  assert.equal(await healthy.text(), '{"ok":true}');
  assert.equal(healthy.rpcTransport.addressAttemptTimeoutMs, 1000);
  assert.ok(healthy.rpcTransport.attempts.some(a => a.address === "127.0.0.1" && a.outcome === "connected"));
  assert.ok(!healthy.rpcTransport.attempts.some(a => a.address === "127.0.0.2"));
  const fallback = await transport(["127.0.0.2", "127.0.0.1"], 0)(url, options());
  assert.equal(await fallback.text(), '{"ok":true}');
  assert.deepEqual(fallback.rpcTransport.attempts.map(a => [a.address, a.outcome]), [["127.0.0.2", "failed"], ["127.0.0.1", "connected"]]);
  assert.equal(received, 2);
  const bounded = new PinnedRpcProvider([url], "fixture", { timeoutMs: 2000, attemptTimeoutMs: 100,
    fetchImpl: transport(["127.0.0.1", "127.0.0.2"], 350) });
  await assert.rejects(bounded.getChainId(), error => {
    const [row] = rpcDiagnostics(error);
    return row.kind === "timeout" && row.budgetMs === 100 && row.elapsedMs >= 350;
  });
  assert.equal(received, 2); // The provider deadline still aborts before an HTTP request reaches the server.
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), defaultAttemptTimeout);
});
test("TLS/header/body timings and DNS failures remain separate without changing responses", async () => {
  const success = createRpcTransport({ request: syntheticRequest(({ socket, callback }) => {
    socket.remoteAddress = "192.0.2.4"; socket.remotePort = 443;
    socket.emit("lookup", null, socket.remoteAddress, 4); socket.emit("connect"); socket.emit("secureConnect");
    const response = new EventEmitter(); response.statusCode = 200; response.complete = true; response.destroy = () => {};
    callback(response); response.emit("data", Buffer.from('{"ok":true}')); response.emit("end");
  }) });
  const response = await success("https://success-events.invalid", requestOptions());
  assert.equal(response.status, 200); assert.equal(await response.text(), '{"ok":true}');
  assert.equal(response.rpcTransport.phase, "complete"); assert.equal(response.rpcTransport.bytesReceived, 11);
  for (const key of ["lookupMs", "connectMs", "tlsMs", "firstByteMs", "elapsedMs"]) assert.ok(Number.isInteger(response.rpcTransport[key]));
  const dnsFailure = createRpcTransport({ request: syntheticRequest(({ request, socket }) => {
    const error = Object.assign(Error("private DNS details"), { code: "EAI_AGAIN" });
    socket.emit("lookup", error); request.emit("error", error);
  }) });
  await assert.rejects(dnsFailure("https://dns-events.invalid", requestOptions()), error => error.rpcTransport.phase === "lookup");
});
test("application deadlines report measured event-loop delay separately from configured budget", async () => {
  let started;
  const first = new Promise(resolve => { started = resolve; });
  const provider = new PinnedRpcProvider(["https://measured-deadline.invalid"], "fixture", { timeoutMs: 1000, attemptTimeoutMs: 20,
    fetchImpl: async (_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(Error("private cancellation")), { once: true }); started();
    }) });
  const pending = provider.getChainId(); await first;
  const end = performance.now() + 70; while (performance.now() < end) {}
  await assert.rejects(pending, error => {
    const [row] = rpcDiagnostics(error); assert.equal(row.kind, "timeout");
    assert.equal(row.budgetMs, 20); assert.ok(row.elapsedMs >= 65); return true;
  });
});
