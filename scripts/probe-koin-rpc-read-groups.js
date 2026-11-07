"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { AsyncLocalStorage } = require("node:async_hooks");
const { PinnedRpcProvider } = require("../lib/koin-network/rpc-provider");
const { SponsorshipReadiness } = require("../lib/koin-network/sponsorship-readiness");
const { KoinChain } = require("../lib/koin-network/chain");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function pendingReads(t) {
  const scope = new AsyncLocalStorage(), states = [], cleanup = [];
  const withSignal = (signal, run) => {
    const parent = scope.getStore();
    return scope.run(parent ? AbortSignal.any([parent, signal]) : signal, run);
  };
  const read = () => {
    const signal = scope.getStore(), row = { signal, settled: false, aborted: false }; states.push(row);
    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => { if (row.settled) return; row.settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve({}); };
      const abort = () => { row.aborted = true; timer = setTimeout(() => finish(Error("Sibling stopped")), 15); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      cleanup.push(() => finish());
    });
  };
  t.after(() => cleanup.forEach(finish => finish()));
  return { withSignal, read, states };
}

test("a failed allowance check aborts and drains siblings before allowing the next check", async t => {
  const pending = pendingReads(t), gate = new SponsorshipReadiness({ freePolicy: null, version: 1 });
  t.after(() => gate.close());
  gate.client = { provider: { withSignal: pending.withSignal },
    verify: async () => { await pause(1); throw Error("Allowance verification failed"); }, read: pending.read };
  for (let i = 0; i < 2; i++) {
    assert.equal(await gate.check(), false);
    assert.equal(pending.states.length, i + 1);
    assert.ok(pending.states.every(row => row.signal.aborted && row.aborted && row.settled), "No previous allowance read may remain active after check returns");
    assert.equal(gate.pending, null);
  }
});

test("nested pinned-provider scopes preserve outer cancellation and do not fall back after it", { timeout: 4000 }, async () => {
  let started, closed = false; const first = new Promise(resolve => { started = resolve; }), calls = [];
  const p = new PinnedRpcProvider(["https://parent-signal.invalid", "https://unused-fallback.invalid"], "fixture-chain", {
    timeoutMs: 1000, attemptTimeoutMs: 500,
    fetchImpl: (endpoint, request) => new Promise((_resolve, reject) => {
      calls.push(endpoint); started();
      const stop = () => { closed = true; reject(Error("Transport closed")); };
      request.signal.addEventListener("abort", stop, { once: true });
      if (request.signal.aborted) stop();
    }),
  });
  const parent = new AbortController(), child = new AbortController();
  const result = p.withSignal(parent.signal, () => p.withSignal(child.signal, () => p.call("chain.read_contract", {})));
  await first; parent.abort();
  await assert.rejects(result, error => error.code === "koin_rpc_stopped");
  assert.equal(closed, true);
  assert.deepEqual(calls, ["https://parent-signal.invalid"]);
  assert.equal(child.signal.aborted, false, "A composed scope does not mutate its caller's controller");
});

test("contract verification cancels and drains every parallel read while preserving the original error", async t => {
  const pending = pendingReads(t), original = Error("Pinned contract read failed");
  const client = {
    d: { token: "token", credits: "credits", rewards: "rewards" },
    provider: { withSignal: pending.withSignal,
      getChainId: async () => { await pause(1); throw original; },
      invokeGetContractAddress: pending.read, invokeGetContractMetadata: pending.read },
    read: pending.read,
  };
  await assert.rejects(KoinChain.prototype.verify.call(client), error => error === original);
  assert.equal(pending.states.length, 6);
  assert.ok(pending.states.every(row => row.aborted && row.settled), "Verification cannot leave abandoned siblings in the RPC queue");
});

test("a reward snapshot cancels both nested pin reads and contract reads when a pin read fails", async t => {
  const { fixture } = require("./helpers/koin-cycle-fixture");
  const { RewardObserver } = require("../lib/koin-network/reward-observer");
  const f = await fixture(t), pending = pendingReads(t), original = Error("Reward pin read failed");
  f.rpc.withSignal = pending.withSignal;
  f.rpc.getChainId = async () => { await pause(1); throw original; };
  f.rpc.invokeGetContractAddress = pending.read;
  f.rpc.invokeGetContractMetadata = pending.read;
  f.rpc.readContract = pending.read;
  const observer = new RewardObserver(f.rpc, { target: f.target, clock: f.clock });
  await assert.rejects(observer.inspectCycle({ epoch: "1" }), error => error === original);
  assert.equal(pending.states.length, 9);
  assert.ok(pending.states.every(row => row.aborted && row.settled), "Snapshot failure must drain both levels before the next cycle");
});

test("a failed pinned read group removes queued siblings, closes active reads, and later uses healthy fallback", { timeout: 5000 }, async t => {
  const { readGroup } = require("../lib/koin-network/read-group");
  const endpoints = ["https://group-primary.invalid", "https://group-backup.invalid"], calls = [], closed = [];
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const twoStarted = deferred(), firstResponse = deferred(), allowClose = deferred(), scope = new AsyncLocalStorage();
  let active = 0, peak = 0, groupSignal, rejected;
  t.after(async () => {
    firstResponse.resolve(); allowClose.resolve();
    await rejected?.catch(() => {});
    await Promise.all(closed);
  });
  const p = new PinnedRpcProvider(endpoints, "fixture-chain", {
    fetchImpl: async (endpoint, request) => {
      const body = JSON.parse(request.body), signal = scope.getStore();
      const call = { endpoint, method: body.method, params: body.params, signal,
        abortedAtSend: signal?.aborted === true || request.signal.aborted, closed: false };
      calls.push(call); active++; peak = Math.max(peak, active);
      if (active === 2) twoStarted.resolve();
      let finish;
      closed.push(new Promise(resolve => { finish = () => {
        if (call.closed) return;
        call.closed = true; active--; resolve();
      }; }));
      if (signal) {
        if (calls.length === 1) {
          await firstResponse.promise; finish();
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { chain_id: "wrong-chain" } }));
        }
        const aborted = deferred(), stop = () => aborted.resolve();
        try {
          request.signal.addEventListener("abort", stop, { once: true });
          if (request.signal.aborted) stop();
          await Promise.all([aborted.promise, allowClose.promise]);
          throw Error("Transport closed after abort");
        } finally { request.signal.removeEventListener("abort", stop); finish(); }
      }
      finish();
      if (endpoint === endpoints[0]) return new Response("primary unavailable", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
        result: body.method === "chain.get_chain_id" ? { chain_id: "fixture-chain" } : { ok: true } }));
    },
  });
  const withSignal = p.withSignal.bind(p);
  p.withSignal = (signal, run) => {
    groupSignal = signal;
    return scope.run(signal, () => withSignal(signal, run));
  };
  rejected = assert.rejects(readGroup(p, Array.from({ length: 12 }, (_, index) => () => p.call("chain.read_contract", { index }))),
    error => error.code === "koin_rpc_chain_mismatch");
  await twoStarted.promise;
  assert.equal(calls.length, 2, "Two held probes leave the other ten group reads queued");
  firstResponse.resolve();
  await rejected;
  assert.equal(groupSignal.aborted, true);
  assert.ok(active > 0, "Caller cancellation can finish before physical transport cleanup");
  // Releasing the completed HTTP slot can start another queued probe before
  // its chain mismatch reaches the group. Only sends after cancellation are forbidden.
  const recovery = p.call("chain.read_contract", { recovery: true });
  allowClose.resolve();
  assert.deepEqual(await recovery, { ok: true });
  await Promise.all(closed);
  assert.equal(active, 0); assert.ok(peak <= 2);
  assert.ok(calls.every(call => !call.abortedAtSend), "No request may start after its group or attempt is cancelled");
  assert.ok(calls.filter(call => call.signal === groupSignal).every(call =>
    call.closed && call.endpoint === endpoints[0] && call.method === "chain.get_chain_id"),
  "Cancelled group probes must close without sending contract reads or trying a fallback");
  assert.ok(calls.filter(call => call.method === "chain.read_contract").every(call => call.params.recovery === true), "Cancelled queued requests cannot send later");
  assert.ok(calls.some(call => call.endpoint === endpoints[1]), "A fresh independent read may use the healthy fallback");
});
