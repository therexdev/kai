"use strict";
const http = require("node:http"), crypto = require("node:crypto");
const config = require("../lib/builder/build-config"), sandbox = require("./sandbox.cjs");
function createServer({ token, image, run = sandbox.run, ready = sandbox.ready }) {
  if (!token || token.length < 32) throw Error("Configure a separate runner transport token of at least 32 characters");
  let busy = false;
  return http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    const supplied = Buffer.from(req.headers.authorization || ""), expected = Buffer.from("Bearer " + token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(401, { error: "Unauthorized" });
    if (req.url === "/health" && req.method === "GET") {
      try { return send(200, { ok: true, ...(await ready(image)), busy }); }
      catch { return send(503, { ok: false, error: "Runner requires its pinned image and gVisor runtime" }); }
    }
    if (req.url !== "/run" || req.method !== "POST") return send(404, { error: "Not found" });
    if (busy) return send(429, { error: "Runner is busy; retry after the current build" });
    busy = true;
    try {
      let body = "", bytes = 0;
      req.setTimeout(15000, () => req.destroy());
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 17000000) { send(413, { error: "Job too large" }); req.destroy(); return; }
        body += chunk;
      }
      req.setTimeout(0);
      const job = config.job(JSON.parse(body));
      send(200, await run(job, { image }));
    } catch (error) { if (!res.headersSent && !res.destroyed) send(error.status || 503, { error: error.status ? error.message : "Runner could not finish this job" }); }
    finally { busy = false; }
  });
}
if (require.main === module) {
  const server = createServer({ token: process.env.KAI_RUNNER_TOKEN, image: process.env.KAI_RUNNER_IMAGE });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.listen(Number(process.env.KAI_RUNNER_PORT || 8092), "127.0.0.1");
}
module.exports = { createServer };
