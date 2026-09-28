"use strict";
// Separate entry point and state. Never imported by the production server.
const http = require("http"), path = require("path"), crypto = require("crypto");
const { configuration, read, loadKeys } = require("./lib/koin-network/test-config");
const { TestRuntime } = require("./lib/koin-network/test-runtime");
async function start(directory = process.env.KAI_KOIN_TEST_CONFIG_DIR) {
  if (!directory || !path.isAbsolute(directory)) throw Error("Absolute KAI_KOIN_TEST_CONFIG_DIR required");
  const config = configuration(JSON.parse(read(path.join(directory, "runtime.json"))));
  const stateDir = process.env.KAI_KOIN_TEST_STATE_DIR;
  if (!stateDir || !path.isAbsolute(stateDir) || /\/\.koinos-ai(\/|$)|\/opt\/koinos\/kai(\/|$)/.test(stateDir)) throw Error("Separate absolute Test state directory required");
  const secret = read(path.join(directory, "operator-secret"), 256, true).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("Independent Test operator secret required");
  const runtime = new TestRuntime({ config, stateDir, signers: loadKeys(path.join(directory, "runtime-keys.json"), config),
    accountsFile: path.join(directory, "invitations.json"), tokenizerDir: path.join(directory, "tokenizer"),
    qualificationsFile: path.join(directory, "qualifications.json"), operatorSecret: secret });
  await runtime.client.verify();
  const json = (res, code, value) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(req.url, "http://test");
      if (url.pathname === "/health" && req.method === "GET") return json(res, 200, { mode: "test-deployment", chainId: config.deployment.chainId, mainnetPaymentsEnabled: false, lastSuccess: runtime.lastSuccess || null });
      if (url.pathname === "/operator/status" && req.method === "GET") {
        const presented = crypto.createHash("sha256").update(String(req.headers["x-operator-secret"] || "")).digest();
        if (!crypto.timingSafeEqual(presented, crypto.createHash("sha256").update(secret).digest())) return json(res, 403, { error: "Test operator access required" });
        return json(res, 200, runtime.status());
      }
      if (!url.pathname.startsWith("/scheduler/")) return json(res, 404, { error: "Unknown Test route" });
      req.url = req.url.slice("/scheduler".length);
      if (url.pathname === "/scheduler/koin/test/lease" && req.method === "POST") {
        const token = String(req.headers.authorization || "").replace(/^Bearer /, ""), account = runtime.accounts.sessionAccount(token);
        if (!account) return json(res, 401, { error: "Test invitation required" });
        const parts = []; let size = 0; for await (const part of req) { size += part.length; if (size > 1024) throw Error("Test host request too large"); parts.push(part); }
        const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (Object.keys(value).join() !== "installation") throw Error("Exact Test installation required");
        const [wallet] = runtime.accounts.accountView(account).wallets;
        if (!wallet) throw Error("Test wallet invitation unavailable");
        return json(res, 200, { mode: "test-deployment", chainId: config.deployment.chainId, ...runtime.hosts.claim(wallet.address, value.installation) });
      }
      if (url.pathname === "/scheduler/koin/test/status" && req.method === "GET") {
        const token = String(req.headers.authorization || "").replace(/^Bearer /, ""), account = runtime.accounts.sessionAccount(token);
        if (!account) return json(res, 401, { error: "Test invitation required" });
        const wallets = runtime.accounts.accountView(account).wallets;
        return json(res, 200, { mode: "test-deployment", mainnetPaymentsEnabled: false, automaticPayouts: true,
          payouts: wallets.flatMap(w => runtime.claims.accountStatus(w.address)), lastCycleCheck: runtime.lastSuccess || null });
      }
      if (url.pathname === "/scheduler/consume/chat/completions") {
        if (req.method !== "POST") return json(res, 405, { error: "POST required" });
        const chunks = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > 32768) throw Error("Test request too large"); chunks.push(part); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.billing !== "koin-funded-rehearsal") throw Error("Only approved Test spending sessions are accepted");
        return runtime.scheduler.koinFundedSessions.work.chat(req, res, body);
      }
      const route = new URL(req.url, "http://test").pathname;
      if (!route.startsWith("/koin/funded/rehearsal/") && !["/worker/register", "/worker/heartbeat", "/worker/next-job", "/koin/presence", "/koin/status", "/network/models", "/network/status"].includes(route)) return json(res, 404, { error: "Route is disabled on the Test backend" });
      await runtime.scheduler.handle(req, res);
    } catch (e) { if (!res.writableEnded && !res.destroyed) json(res, 400, { error: String(e.message).slice(0, 200) }); }
  });
  server.requestTimeout = 190000; server.headersTimeout = 10000;
  const port = Number(process.env.KAI_KOIN_TEST_PORT || 3107); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid Test port");
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve)); await runtime.start();
  console.log(JSON.stringify({ service: "koin-test", port, network: "foundation-testnet", mainnetPaymentsEnabled: false }));
  let closing = false;
  const close = () => {
    if (closing) return; closing = true; runtime.stopped = true; clearInterval(runtime.timer); server.close();
    const timer = setInterval(async () => {
      if (runtime.busy) return;
      clearInterval(timer); await runtime.close(); process.exit(0);
    }, 100); timer.unref();
    setTimeout(() => process.exit(1), 25000).unref();
  };
  process.on("SIGTERM", close); process.on("SIGINT", close);
  return { server, runtime };
}
if (require.main === module) start().catch(e => { console.error(String(e.message).slice(0, 240)); process.exitCode = 1; });
module.exports = { start };
