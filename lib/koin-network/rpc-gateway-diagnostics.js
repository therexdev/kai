"use strict";
const MAX_ERROR_BYTES = 8192, ERROR_READ_MS = 200;
const messages = new Map([
  ["-32005:RPC rate limit", "rate_limit"], ["-32005:API rate limit", "rate_limit"],
  ["-32005:RPC busy; retry later", "busy"], ["-32005:API busy", "busy"],
  ["-32001:Local Mainnet RPC is not ready", "node_not_ready"],
  ["-32002:Local RPC unavailable or response exceeded limits", "node_unavailable"],
  ["-32002:RPC request cancelled", "cancelled"],
  ["-32002:Contract metadata unavailable; retry or use another RPC", "metadata_unavailable"],
]);
const reasons = new Set(messages.values());
function classify(text, requestId) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_ERROR_BYTES) return {};
    const v = JSON.parse(text), e = v?.error;
    if (v?.jsonrpc !== "2.0" || (v.id !== requestId && v.id !== null) || Object.hasOwn(v, "result") ||
        !Number.isInteger(e?.code) || typeof e.message !== "string" || e.message.length > 100) return {};
    const gatewayReason = messages.get(e.code + ":" + e.message);
    return gatewayReason ? { gatewayReason, rpcCode: e.code } : {};
  } catch { return {}; }
}
function safe(value) {
  return reasons.has(value?.gatewayReason) ? { gatewayReason: value.gatewayReason,
    ...([-32001, -32002, -32005].includes(value.rpcCode) && { rpcCode: value.rpcCode }) } : {};
}
// Injected fetch transports use this bounded reader; the native transport
// classifies bytes before closing its socket and never exposes the raw body.
async function read(response, requestId, signal) {
  if (reasons.has(response?.gatewayReason)) return safe(response);
  if (![429, 503].includes(response?.status) || !/^application\/json(?:;|$)/i.test(response.headers?.get?.("content-type") || "") ||
      !response.body?.getReader) return {};
  let reader, timer, abort, size = 0; const chunks = [];
  try {
    reader = response.body.getReader();
    return await Promise.race([
      (async () => {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > MAX_ERROR_BYTES) return {};
          chunks.push(Buffer.from(value));
        }
        return classify(Buffer.concat(chunks).toString("utf8"), requestId);
      })(),
      new Promise(resolve => {
        abort = () => resolve({}); signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        timer = setTimeout(abort, ERROR_READ_MS);
      }),
    ]);
  } catch { return {}; }
  finally {
    clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort);
    // Keep the caller's slot until cancellation settles, including injected
    // streaming transports. The native transport already waits for socket close.
    if (reader) { try { await reader.cancel(); } catch {} finally { reader.releaseLock(); } }
  }
}
module.exports = { classify, safe, read, reasons, MAX_ERROR_BYTES, ERROR_READ_MS };
