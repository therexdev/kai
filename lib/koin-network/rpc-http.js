"use strict";
const https = require("node:https");
const net = require("node:net");
const { performance } = require("node:perf_hooks");
const { addressAttempt, transportDetails } = require("./rpc-diagnostics");
const MAX_BODY_BYTES = 16 * 1024 * 1024;
// Node's default 250 ms address race can discard an already reachable socket while
// JavaScript is briefly busy. Keep automatic family selection with more room
// for its callbacks; the provider's overall deadline still cancels the socket.
const ADDRESS_ATTEMPT_TIMEOUT_MS = 1000;

// The scheduler owns each RPC socket. A deadline destroys that socket and
// settles the request on close, even if headers or a body never arrive. Do not
// use the process-wide fetch connection pool for these financial RPC calls.
// This is deliberately a small JSON POST transport, not a general fetch API.
function createRpcTransport({ request = https.request } = {}) {
  return function rpcFetch(endpoint, options) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint), { signal, body } = options;
      if (url.protocol !== "https:" || url.username || url.password || url.hash ||
          options.method !== "POST" || options.redirect !== "error" || typeof body !== "string")
        throw Error("Pinned HTTPS JSON POST required");
      signal?.throwIfAborted();
      const started = performance.now(), elapsed = () => performance.now() - started;
      const detail = { phase: net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? "connect" : "lookup", bytesReceived: 0, attempts: [],
        addressAttemptTimeoutMs: ADDRESS_ATTEMPT_TIMEOUT_MS };
      let socket;
      const attempt = (address, port, family, outcome, failure) => {
        if (!addressAttempt({ address, port })) return;
        if (detail.phase === "lookup") detail.phase = "connect";
        let row = detail.attempts.find(a => a.address === address && a.port === port);
        if (!row && detail.attempts.length < 4) { row = { address, port, family }; detail.attempts.push(row); }
        if (row) { row.outcome = outcome;
          if (outcome === "started") row.startedAt = elapsed();
          if (Number.isFinite(row.startedAt)) row.elapsedMs = elapsed() - row.startedAt;
          const safe = addressAttempt({ address, port, code: failure?.code }); if (safe.code) row.code = safe.code; }
      };
      const snapshot = () => {
        // Include attempted addresses even on Node versions where a socket
        // event occurred before the request's socket listener was attached.
        for (const value of (socket?.autoSelectFamilyAttemptedAddresses || []).slice(0, 4)) {
          if (typeof value !== "string" || value.length > 52) continue;
          const split = value.lastIndexOf(":"), address = value.slice(0, split), port = Number(value.slice(split + 1));
          if (!detail.attempts.some(a => a.address === address && a.port === port)) attempt(address, port, net.isIP(address));
        }
        return transportDetails({ ...detail, elapsedMs: elapsed() });
      };
      let req, response, finished = false, error, value;
      const finish = (failure, result) => {
        if (finished) return;
        finished = true; error = failure; value = result;
        response?.destroy(); req.destroy();
      };
      const abort = () => finish(Object.assign(Error("RPC transport aborted"), { code: "ABORT_ERR" }));
      req = request(url, {
        method: "POST", agent: false, maxHeaderSize: 16384, autoSelectFamilyAttemptTimeout: ADDRESS_ATTEMPT_TIMEOUT_MS,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
          "Accept-Encoding": "identity", Connection: "close" },
      }, res => {
        response = res;
        detail.phase = "body"; detail.firstByteMs = elapsed();
        res.on("error", err => finish(err));
        res.on("aborted", () => finish(Error("Incomplete RPC response")));
        if (finished) { res.destroy(); return; }
        const status = res.statusCode, ok = status >= 200 && status < 300;
        // No redirects or error bodies are followed/consumed. Closing the
        // socket also handles an upstream that never finishes its error body.
        if (!ok) { finish(null, { ok, status, text: async () => "" }); return; }
        let size = 0; const chunks = [];
        res.on("data", chunk => {
          if (finished) return;
          size += chunk.length;
          detail.bytesReceived = size;
          if (size > MAX_BODY_BYTES) { finish(Error("RPC response too large")); return; }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (finished) return;
          if (!res.complete) { finish(Error("Incomplete RPC response")); return; }
          const text = Buffer.concat(chunks, size).toString("utf8");
          detail.phase = "complete";
          finish(null, { ok, status, text: async () => text });
        });
      });
      req.once("socket", value => {
        socket = value;
        socket.on("lookup", failure => { if (!failure) detail.phase = "connect"; detail.lookupMs = elapsed(); });
        socket.on("connectionAttempt", (address, port, family) => attempt(address, port, family, "started"));
        socket.on("connectionAttemptTimeout", (address, port, family) => attempt(address, port, family, "timeout"));
        socket.on("connectionAttemptFailed", (address, port, family, failure) => attempt(address, port, family, "failed", failure));
        socket.once("connect", () => { detail.phase = "tls"; detail.connectMs = elapsed(); attempt(socket.remoteAddress, socket.remotePort, net.isIP(socket.remoteAddress || ""), "connected"); });
        socket.once("secureConnect", () => { detail.phase = "response"; detail.tlsMs = elapsed(); });
      });
      req.on("error", err => finish(err));
      req.on("upgrade", (_res, socket) => { socket.destroy(); finish(Error("RPC protocol upgrade refused")); });
      req.once("close", () => {
        signal?.removeEventListener("abort", abort);
        if (!finished) { finished = true; error = Error("RPC connection closed before completion"); }
        // Diagnostic attachment must never alter a transport outcome.
        try { Object.defineProperty(error || value, "rpcTransport", { value: snapshot(), configurable: true }); } catch {}
        if (error) reject(error); else resolve(value);
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else req.end(body);
    });
  };
}
module.exports = { createRpcTransport, rpcFetch: createRpcTransport(), MAX_BODY_BYTES };
