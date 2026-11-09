"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { EventEmitter, once } = require("node:events"), { spawn } = require("node:child_process");
const { startRuntimeServer, createHandler } = require("../test-server");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const phase of ["verify", "tick"]) test(`real SIGTERM during initial ${phase} drains safely and exits normally`, { timeout: 10000 }, async t => {
  const script = `
    const http = require('node:http');
    const { startRuntimeServer } = require(${JSON.stringify(require.resolve("../test-server"))});
    let release, closed = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const send = type => process.send({ type, busy: runtime.busy, availabilityBusy: runtime.availabilityBusy, closed });
    const runtime = {
      busy: false, availabilityBusy: false,
      client: { verify: async () => { if (${JSON.stringify(phase)} === 'verify') { send('waiting'); await pending; } } },
      start: async () => { runtime.busy = true; runtime.availabilityBusy = true; send('waiting'); await pending; },
      stopScheduling: () => send('stopping'),
      close: async () => {
        if (runtime.busy || runtime.availabilityBusy) throw Error('Closed while busy');
        closed++; await new Promise(resolve => process.send({ type: 'closed' }, resolve));
      },
    };
    process.on('message', message => {
      if (message === 'release') { runtime.busy = false; release(); send('released'); }
      if (message === 'inspect') send('inspected');
      if (message === 'release-availability') runtime.availabilityBusy = false;
    });
    startRuntimeServer({ runtime, server: http.createServer(), port: 0, onReady: () => send('ready') })
      .catch(() => process.exit(2));
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const messages = [], waiters = new Map(); let stderr = "";
  child.stderr.on("data", value => { stderr += value; });
  child.on("message", value => { messages.push(value); waiters.get(value.type)?.(value); waiters.delete(value.type); });
  const message = type => messages.find(v => v.type === type) || new Promise(resolve => waiters.set(type, resolve));
  const exited = once(child, "exit");
  await message("waiting"); child.kill("SIGTERM"); await message("stopping");
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  child.send("release"); await message("released");
  if (phase === "tick") {
    child.send("inspect"); const state = await message("inspected");
    assert.equal(state.busy, false); assert.equal(state.availabilityBusy, true); assert.equal(state.closed, 0);
    child.send("release-availability");
  }
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  assert.equal(messages.filter(v => v.type === "closed").length, 1);
  assert.ok(!messages.some(v => v.type === "ready"), "interrupted startup must not announce ready or schedule another pass");
});

test("shutdown waits for active HTTP work and repeated signals do not close runtime twice", async t => {
  const signals = new EventEmitter(), accepted = deferred(), exits = [];
  let response, stops = 0, closes = 0;
  const runtime = { client: { verify: async () => {} }, start: async () => {},
    stopScheduling: () => { stops++; }, close: async () => { closes++; } };
  const server = http.createServer((_req, res) => { response = res; accepted.resolve(); });
  t.after(() => server.closeAllConnections());
  const running = await startRuntimeServer({ runtime, server, port: 0, signals, exit: code => exits.push(code) });
  const ended = new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}`, { agent: false }, res => {
    res.resume(); res.once("end", resolve);
  }).on("error", reject));
  await accepted.promise;
  signals.emit("SIGTERM"); signals.emit("SIGINT"); await turn();
  assert.equal(stops, 1); assert.equal(closes, 0); assert.deepEqual(exits, []);
  response.end("finished"); await ended; await running.close();
  assert.equal(closes, 1); assert.deepEqual(exits, [0]);
  assert.equal(signals.listenerCount("SIGTERM"), 0); assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("shutdown never forces a busy pass out and keeps its drain poll alive through asynchronous close", async () => {
  const signals = new EventEmitter(), exits = [], closeWork = deferred();
  let poll, cleared = false, closeCalls = 0;
  const timers = { setInterval: (callback, ms) => {
    assert.equal(ms, 100); poll = callback;
    return { unref: () => { throw Error("Drain timer must remain referenced"); } };
  }, clearInterval: () => { cleared = true; } };
  const runtime = { busy: true, availabilityBusy: true, client: { verify: async () => {} }, start: async () => {},
    stopScheduling: () => {}, close: async () => { closeCalls++; await closeWork.promise; } };
  const server = http.createServer(), running = await startRuntimeServer({ runtime, server, port: 0, signals, timers, exit: code => exits.push(code) });
  const httpClosed = once(server, "close"); signals.emit("SIGTERM"); await httpClosed; await turn();
  // Three hundred 100 ms polls span the former forced-exit deadline.
  for (let i = 0; i < 300; i++) poll();
  assert.equal(closeCalls, 0); assert.deepEqual(exits, []); assert.equal(cleared, false);
  runtime.busy = false; poll(); await turn(); assert.equal(closeCalls, 0);
  runtime.availabilityBusy = false; poll(); await turn();
  assert.equal(closeCalls, 1); assert.deepEqual(exits, []); assert.equal(cleared, false);
  closeWork.resolve(); await running.close();
  assert.equal(cleared, true); assert.deepEqual(exits, [0]);
});

test("startup verification failure closes resources and removes handlers with a failure exit", async () => {
  const signals = new EventEmitter(), exited = deferred(), server = http.createServer(); let closes = 0;
  const runtime = { client: { verify: async () => { throw Error("Initial verification failed"); } },
    start: async () => { throw Error("Must not start after failed verification"); },
    stopScheduling: () => {}, close: async () => { closes++; } };
  await assert.rejects(startRuntimeServer({ runtime, server, port: 0, signals, exit: exited.resolve }), /Initial verification failed/);
  assert.equal(await exited.promise, 1); assert.equal(closes, 1);
  assert.equal(server.listening, false); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("a port binding failure rejects startup and drains resources without starting financial work", async t => {
  const occupied = http.createServer(); await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const signals = new EventEmitter(), exited = deferred(), server = http.createServer(); let closes = 0, starts = 0;
  const runtime = { client: { verify: async () => {} }, start: async () => { starts++; },
    stopScheduling: () => {}, close: async () => { closes++; } };
  await assert.rejects(startRuntimeServer({ runtime, server, port: occupied.address().port, signals, exit: exited.resolve }),
    error => error.code === "EADDRINUSE");
  assert.equal(await exited.promise, 1); assert.equal(closes, 1); assert.equal(starts, 0);
  assert.equal(server.listening, false); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("a stopped runtime rejects newly dispatched scheduler requests while keeping health readable", async () => {
  let calls = 0;
  const runtime = { stopped: true, scheduler: { handle: async () => { calls++; } } };
  const config = { mode: "mainnet-pilot", schedulerUrl: "https://credits.invalid/scheduler",
    deployment: { chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: "fixture", product: "prepaid-usd-v1" } };
  const handler = createHandler({ runtime, config, secret: "a".repeat(64) });
  const request = async url => {
    let status, value;
    await handler({ url, method: "GET", headers: {} }, { setHeader() {}, writeHead(code) { status = code; }, end(body) { value = JSON.parse(body); } });
    return { status, value };
  };
  assert.equal((await request("/scheduler/worker/next-job")).status, 503);
  assert.equal(calls, 0); assert.equal((await request("/health")).status, 200);
});
