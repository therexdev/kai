"use strict";
const { Provider } = require("koilib");
const { AsyncLocalStorage } = require("node:async_hooks");

const READS = new Set([
  "chain.get_chain_id", "chain.get_head_info", "chain.get_account_rc",
  "chain.get_account_nonce", "chain.read_contract", "chain.get_resource_limits",
  "chain.get_fork_heads", "transaction_store.get_transactions_by_id",
  "block_store.get_blocks_by_id", "block_store.get_blocks_by_height",
]);
function retryableMethod(method, params) {
  return READS.has(method) ||
    (method === "chain.invoke_system_call" &&
      ["get_contract_metadata", "get_contract_address"].includes(params?.name)) ||
    (method === "chain.submit_transaction" && params?.broadcast === false);
}
class RpcFailure extends Error {
  constructor(message, retryable = false, code = "koin_rpc_unavailable") {
    super(message); this.retryable = retryable; this.code = code;
  }
}
const unavailable = () => new RpcFailure(
  "KOIN RPC is temporarily unavailable. Check confirmation again shortly.", true);
const stopped = () => new RpcFailure("KOIN RPC request stopped.", false, "koin_rpc_stopped");
// All clients in this process share each endpoint's budget, including the
// independent free-allowance observer. The public node allows four in flight
// and 30 requests/second; leave headroom for other users of that node.
const endpointQueues = new Map();
const MAX_ACTIVE = 2, MAX_QUEUED = 128, START_INTERVAL_MS = 50;
const failureKinds = new Set(["queue", "cancelled", "network", "http", "json", "response", "rpc", "timeout"]);
const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);
// Operator-only diagnostics contain fixed categories and numeric transport
// facts. Never retain RPC params, bodies, signatures, URLs with query strings,
// upstream messages or arbitrary exception text.
function rpcDiagnostics(error) {
  if (!Array.isArray(error?.rpcDiagnostics)) return [];
  return error.rpcDiagnostics.slice(-3).flatMap(value => {
    if (!value || !failureKinds.has(value.kind)) return [];
    let origin;
    try { const url = new URL(value.endpoint); if (url.protocol !== "https:") return []; origin = url.origin; }
    catch { return []; }
    const row = { endpoint: origin, kind: value.kind,
      method: READS.has(value.method) || ["chain.invoke_system_call", "chain.submit_transaction"].includes(value.method) ? value.method : "other" };
    for (const key of ["httpStatus", "rpcCode", "active", "queued", "elapsedMs"])
      if (Number.isSafeInteger(value[key])) row[key] = value[key];
    if (Array.isArray(value.networkCodes)) row.networkCodes = [...new Set(value.networkCodes.filter(code => networkCodes.has(code)))].slice(0, 3);
    return [row];
  });
}
function diagnostics(error, rows) {
  Object.defineProperty(error, "rpcDiagnostics", { value: rpcDiagnostics({ rpcDiagnostics: rows }), configurable: true });
  return error;
}
function failure(error, endpoint, method, kind, extra = {}) {
  const pool = endpointQueues.get(endpoint);
  return diagnostics(error, [{ endpoint, method, kind, active: pool?.active || 0, queued: pool?.queue.length || 0, ...extra }]);
}
function endpointSlot(endpoint, signal) {
  if (signal.aborted) return Promise.reject(stopped());
  let pool = endpointQueues.get(endpoint);
  if (!pool) {
    pool = { active: 0, queue: [], nextStart: 0, timer: null };
    endpointQueues.set(endpoint, pool);
  }
  if (pool.queue.length >= MAX_QUEUED) return Promise.reject(unavailable());
  const pump = () => {
    if (pool.timer || pool.active >= MAX_ACTIVE || !pool.queue.length) return;
    const delay = pool.nextStart - performance.now();
    if (delay > 0) {
      pool.timer = setTimeout(() => { pool.timer = null; pump(); }, delay);
      return;
    }
    const waiter = pool.queue.shift();
    waiter.signal.removeEventListener("abort", waiter.cancel);
    pool.active++; pool.nextStart = performance.now() + START_INTERVAL_MS;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true; pool.active--; pump();
    });
    pump();
  };
  return new Promise((resolve, reject) => {
    const waiter = { signal, resolve, cancel: null };
    waiter.cancel = () => {
      const index = pool.queue.indexOf(waiter);
      if (index < 0) return;
      pool.queue.splice(index, 1); reject(stopped()); pump();
    };
    signal.addEventListener("abort", waiter.cancel, { once: true });
    pool.queue.push(waiter); pump();
  });
}
function rejection(error) {
  // RPC errors may contain request bodies and signatures. Inspect a bounded
  // string only to select a fixed public category, never return that string.
  let detail = "";
  if (typeof error?.message === "string") detail += error.message.slice(0, 4096);
  if (typeof error?.data === "string") detail += error.data.slice(0, 4096);
  if (/insufficient rc|insufficient mana|compute bandwidth limit|rc limit/i.test(detail))
    return new RpcFailure("KOIN RPC rejected the transaction: insufficient rc.", false, "koin_rpc_insufficient_rc");
  // Koinos JSON-RPC can return HTTP 200 while its AMQP connection to the
  // chain service is down. Match that gateway diagnostic exactly: contract
  // failures/logs mentioning AMQP are not evidence of a transport outage.
  const amqpUnavailable = typeof error?.data === "string" && error.data.length <= 4096 &&
    /^rpc failed, AMQP connection is not open$/i.test(error.data.trim());
  if (error?.code === -32603 && (amqpUnavailable ||
      /context deadline exceeded|temporarily unavailable|service unavailable|upstream timed out/i.test(detail)))
    return unavailable();
  return new RpcFailure("KOIN RPC rejected the request.", false, "koin_rpc_rejected");
}

// Koilib's default shared cursor aborts instead of trying a backup. Its optional
// retry loop also retries broadcasts. Override only the transport: all inherited
// serializers and helpers still use this call, and writes have one attempt.
class PinnedRpcProvider extends Provider {
  #endpoints; #chainId; #fetch; #timeoutMs; #attemptTimeoutMs; #signals = new AsyncLocalStorage();
  #preferred = 0; #lastAccepted = 0; #generation = 0; #requestId = 0;
  // Each endpoint attempt includes a chain-id probe followed by the requested
  // operation. Allow both reads to finish on a slow node, and leave a full
  // backup attempt after a stalled primary without removing the total bound.
  constructor(rpc, chainId, { fetchImpl = globalThis.fetch, timeoutMs = 45000, attemptTimeoutMs = 20000 } = {}) {
    if (!Array.isArray(rpc) || !rpc.length || rpc.length > 3 || new Set(rpc).size !== rpc.length ||
        typeof chainId !== "string" || !chainId || typeof fetchImpl !== "function" ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 45000 ||
        !Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 10 || attemptTimeoutMs > timeoutMs)
      throw Error("Invalid pinned KOIN RPC settings");
    const endpoints = Object.freeze(rpc.map(value => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw Error("Pinned HTTPS KOIN RPC required");
      return value;
    }));
    super(endpoints);
    Object.defineProperty(this, "rpcNodes", { value: endpoints, writable: false, configurable: false });
    this.#endpoints = endpoints; this.#chainId = chainId; this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs; this.#attemptTimeoutMs = attemptTimeoutMs;
  }
  withSignal(signal, run) { return this.#signals.run(signal, run); }
  get readGeneration() { return this.#generation; }
  async #request(endpoint, method, params, signal) {
    signal.throwIfAborted();
    // Waiting is inside the existing attempt deadline. Keep the slot until
    // the response body is consumed; cancellation never permits a late send.
    let release;
    try { release = await endpointSlot(endpoint, signal); }
    catch (error) { throw failure(error, endpoint, method, signal.aborted ? "cancelled" : "queue"); }
    try { return await this.#requestInSlot(endpoint, method, params, signal); }
    finally { release(); }
  }
  async #requestInSlot(endpoint, method, params, signal) {
    signal.throwIfAborted();
    const id = ++this.#requestId;
    let response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, jsonrpc: "2.0", method, params }), signal,
        redirect: "error",
      });
    } catch (error) { throw failure(unavailable(), endpoint, method, "network", {
      networkCodes: [error, error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors : [])].map(e => e?.code),
    }); }
    signal.throwIfAborted();
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => {});
      const error = [403, 429].includes(response?.status) || response?.status >= 500 ? unavailable() : new RpcFailure("KOIN RPC refused the request.");
      throw failure(error, endpoint, method, "http", { httpStatus: response?.status });
    }
    let json;
    try {
      const body = await response.text();
      signal.throwIfAborted();
      if (body.length > 16 * 1024 * 1024) throw Error("Response too large");
      json = JSON.parse(body);
    } catch { throw failure(unavailable(), endpoint, method, "json"); }
    if (!json || typeof json !== "object" || Array.isArray(json) || json.jsonrpc !== "2.0" || json.id !== id ||
        (Object.hasOwn(json, "result") === Object.hasOwn(json, "error"))) throw failure(unavailable(), endpoint, method, "response");
    if (Object.hasOwn(json, "error")) throw failure(rejection(json.error), endpoint, method, "rpc", { rpcCode: json.error?.code });
    return json.result;
  }
  async #attempt(endpoint, method, params, remaining, signal) {
    const controller = new AbortController();
    let timer, onAbort, phase = "chain.get_chain_id";
    const task = async () => {
      const chain = await this.#request(endpoint, "chain.get_chain_id", {}, controller.signal);
      if (chain?.chain_id !== this.#chainId)
        throw new RpcFailure("Deployment chain mismatch", false, "koin_rpc_chain_mismatch");
      if (method === "chain.get_chain_id") return chain;
      controller.signal.throwIfAborted();
      phase = method;
      return this.#request(endpoint, method, params, controller.signal);
    };
    try {
      return await Promise.race([task(), new Promise((_, reject) => {
        onAbort = () => { controller.abort(); reject(stopped()); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer = setTimeout(() => { controller.abort(); reject(failure(unavailable(), endpoint, phase, "timeout", { elapsedMs: remaining })); }, remaining);
      })]);
    } catch (error) {
      if (signal?.aborted) throw stopped();
      throw error instanceof RpcFailure ? error : unavailable();
    } finally {
      clearTimeout(timer); controller.abort();
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  async call(method, params, { signal } = {}) {
    const scoped = this.#signals.getStore();
    if (scoped) signal = signal ? AbortSignal.any([signal, scoped]) : scoped;
    if (signal?.aborted) throw stopped();
    const captured = structuredClone(params), retry = retryableMethod(method, captured);
    const preferred = this.#preferred, deadline = Date.now() + this.#timeoutMs;
    const count = retry ? this.#endpoints.length : 1, failures = [];
    for (let attempt = 0; attempt < count; attempt++) {
      if (signal?.aborted) throw stopped();
      const index = (preferred + attempt) % this.#endpoints.length;
      const remaining = Math.min(this.#attemptTimeoutMs, deadline - Date.now());
      if (remaining <= 0) throw unavailable();
      try {
        const result = await this.#attempt(this.#endpoints[index], method, captured, remaining, signal);
        if (signal?.aborted) throw stopped();
        // Count every accepted endpoint transition, including a late old
        // primary response, so concurrent A/B/A reads cannot form a snapshot.
        if (index !== this.#lastAccepted) { this.#lastAccepted = index; this.#generation++; }
        // A late primary success does not undo a healthy fallback preference.
        if (attempt > 0) this.#preferred = index;
        return result;
      } catch (error) {
        failures.push(...rpcDiagnostics(error));
        if (!(error instanceof RpcFailure) || !error.retryable || attempt + 1 >= count) throw diagnostics(error, failures);
      }
    }
    throw unavailable();
  }
}
module.exports = { PinnedRpcProvider, rpcDiagnostics };
