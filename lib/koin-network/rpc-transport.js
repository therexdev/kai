"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { Provider } = require("koilib");
const contexts = new AsyncLocalStorage();
const safeError = e => String(e?.message || e).replace(/https?:\/\/[^\s"']+/g, "[RPC]")
  .replace(/[A-Za-z0-9_+/=-]{80,}/g, "[redacted]").slice(0, 240);
function withSignal(signal, callback) {
  signal?.throwIfAborted();
  return contexts.run(signal, callback);
}
// One HTTP attempt per invocation, including broadcasts. Durable ledgers own
// retries; a timed-out callback cannot continue submitting behind their backs.
function provider(urls, { fetch: request = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const p = new Provider(urls); let id = 0;
  p.readGeneration = 0;
  p.call = async (method, params, { signal = contexts.getStore() } = {}) => {
    signal?.throwIfAborted();
    const requestId = ++id, index = p.currentNodeId;
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(Error("KOIN RPC timeout")), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let rpcRejection = false;
    try {
      const response = await request(p.rpcNodes[index], { method: "POST", redirect: "error",
        headers: { "content-type": "application/json" }, signal: combined,
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) });
      combined.throwIfAborted();
      if (!response.ok) throw Error("KOIN RPC HTTP " + response.status);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        combined.throwIfAborted(); size += chunk.length;
        if (size > 8 * 1024 * 1024) throw Error("KOIN RPC response too large");
        chunks.push(chunk);
      }
      combined.throwIfAborted();
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.id !== requestId || value.jsonrpc !== "2.0") throw Error("KOIN RPC response identity mismatch");
      if (value.error) { rpcRejection = true; throw Error("KOIN RPC rejected: " + safeError(value.error)); }
      if (!value.result || typeof value.result !== "object" || Array.isArray(value.result)) throw Error("Missing KOIN RPC result");
      return value.result;
    } catch (e) {
      // Future reads may try the other pinned endpoint. Never replay this call.
      if (!signal?.aborted && !rpcRejection && p.currentNodeId === index && p.rpcNodes.length > 1) {
        p.currentNodeId = (index + 1) % p.rpcNodes.length; p.readGeneration++;
      }
      throw e;
    } finally { clearTimeout(timer); }
  };
  return p;
}
function submitter(client) {
  return (transaction, { signal } = {}) => withSignal(signal, async () => {
    await client.verify(); signal?.throwIfAborted();
    const value = await client.provider.call("chain.submit_transaction", { transaction, broadcast: true }, { signal });
    signal?.throwIfAborted();
    if (value.rpc_error || value.receipt?.rpc_error || value.receipt?.reverted) throw Error("KOIN submission rejected or reverted; awaiting chain reconciliation");
    if (value.receipt?.id !== transaction.id) throw Error("KOIN submission receipt missing; awaiting chain reconciliation");
    return { txId: transaction.id };
  });
}
async function resourceReadiness(client, transaction) {
  const { nonce } = require("./settlement-outbox"), h = transaction.header;
  const [current, available] = await Promise.all([
    client.provider.getNonce(h.payee || h.payer), client.provider.getAccountRc(h.payer),
  ]);
  if (!Number.isSafeInteger(current) || current < 0 || !/^\d+$/.test(String(available))) throw Error("Invalid lifecycle resource response");
  if (BigInt(current) + 1n !== BigInt(nonce(h.nonce))) return "lifecycle_nonce_unavailable";
  if (BigInt(available) < BigInt(h.rc_limit)) return "lifecycle_mana_recharging";
  return null;
}
module.exports = { provider, withSignal, submitter, safeError, resourceReadiness };
