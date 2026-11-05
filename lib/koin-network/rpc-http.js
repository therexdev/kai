"use strict";
const https = require("node:https");
const MAX_BODY_BYTES = 16 * 1024 * 1024;

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
      let req, response, finished = false, error, value;
      const finish = (failure, result) => {
        if (finished) return;
        finished = true; error = failure; value = result;
        response?.destroy(); req.destroy();
      };
      const abort = () => finish(Object.assign(Error("RPC transport aborted"), { code: "ABORT_ERR" }));
      req = request(url, {
        method: "POST", agent: false, maxHeaderSize: 16384,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
          "Accept-Encoding": "identity", Connection: "close" },
      }, res => {
        response = res;
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
          if (size > MAX_BODY_BYTES) { finish(Error("RPC response too large")); return; }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (finished) return;
          if (!res.complete) { finish(Error("Incomplete RPC response")); return; }
          const text = Buffer.concat(chunks, size).toString("utf8");
          finish(null, { ok, status, text: async () => text });
        });
      });
      req.on("error", err => finish(err));
      req.on("upgrade", (_res, socket) => { socket.destroy(); finish(Error("RPC protocol upgrade refused")); });
      req.once("close", () => {
        signal?.removeEventListener("abort", abort);
        if (!finished) { finished = true; error = Error("RPC connection closed before completion"); }
        if (error) reject(error); else resolve(value);
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else req.end(body);
    });
  };
}
module.exports = { createRpcTransport, rpcFetch: createRpcTransport(), MAX_BODY_BYTES };
