"use strict";
// Separate entry point and state. Never imported by the production server.
const http = require("http"), path = require("path"), crypto = require("crypto");
const { configuration, read, loadKeys } = require("./lib/koin-network/test-config");
const { TestRuntime } = require("./lib/koin-network/test-runtime");
function createHandler({ runtime, config, secret, authApp }) {
  const wire = require("./lib/koin-network/payment-network").protocol({ chainId: config.deployment.chainId, domain: require("./lib/koin-network/payment-mode").testDomain(config.deployment, config.schedulerUrl) });
  const json = (res, code, value) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  return async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(req.url, "http://test");
      if (authApp && require("./lib/credit-account-web").handles(url.pathname)) return authApp(req, res);
      if (url.pathname === "/health" && req.method === "GET") return json(res, 200, { mode: config.mode, chainId: config.deployment.chainId, mainnetPaymentsEnabled: wire.paymentsEnabled, product: config.deployment.product || "legacy-reservations", purchaseQuotesUnlimited: require("./lib/koin-network/product").isUsd(config.deployment), providerQualificationRecovery: runtime.qualifier?.recoveryVersion === 1 ? 1 : 0, modelReadinessAdmission: runtime.qualifier?.readinessVersion === 1 ? 1 : 0, lastSuccess: (runtime.prepaid ? runtime.lastServing : runtime.lastSuccess) || null, lastSettlementSuccess: runtime.lastSuccess || null, rewardSummaryVersion: typeof runtime.rewardSummary === "function" ? 1 : 0 });
      if (url.pathname === "/operator/status" && req.method === "GET") {
        const presented = crypto.createHash("sha256").update(String(req.headers["x-operator-secret"] || "")).digest();
        if (!crypto.timingSafeEqual(presented, crypto.createHash("sha256").update(secret).digest())) return json(res, 403, { error: "Test operator access required" });
        return json(res, 200, runtime.status());
      }
      if (!url.pathname.startsWith("/scheduler/")) return json(res, 404, { error: "Unknown Test route" });
      req.url = req.url.slice("/scheduler".length);
      if (url.pathname === "/scheduler/koin/test/lease" && req.method === "POST") {
        const token = String(req.headers.authorization || "").replace(/^Bearer /, ""), account = (runtime.accounts.creditSessionAccount || runtime.accounts.sessionAccount).call(runtime.accounts, token);
        if (!account) return json(res, 401, { error: "Test invitation required" });
        const parts = []; let size = 0; for await (const part of req) { size += part.length; if (size > 1024) throw Error("Test host request too large"); parts.push(part); }
        const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (!Object.hasOwn(value, "installation") || Object.keys(value).some(k => !["installation", "creditWallet"].includes(k))) throw Error("Exact Test installation required");
        if (account.creditScope && value.creditWallet !== account.creditWallet) throw Error("This credit session belongs to its authorized wallet");
        const wallet = require("./lib/koin-network/credit-wallet").select((runtime.accounts.creditAccountView || runtime.accounts.accountView).call(runtime.accounts, account).wallets, value);
        if (!wallet) throw Error("Test wallet invitation unavailable");
        return json(res, 200, { mode: config.mode, chainId: config.deployment.chainId, ...runtime.hosts.claim(wallet, value.installation) });
      }
      if (url.pathname === "/scheduler/koin/test/status" && req.method === "GET") {
        const token = String(req.headers.authorization || "").replace(/^Bearer /, ""), account = runtime.accounts.sessionAccount(token);
        if (!account) return json(res, 401, { error: "Test invitation required" });
        const wallets = runtime.accounts.accountView(account).wallets;
        return json(res, 200, { mode: config.mode, mainnetPaymentsEnabled: wire.paymentsEnabled, automaticPayouts: true, observedAt: runtime.clock(),
          providers: wallets.map(w => require("./lib/koin-network/provider-readiness").providerReadiness(runtime, w.address)),
          payouts: wallets.flatMap(w => runtime.claims.accountStatus(w.address)), lastCycleCheck: runtime.lastSuccess || null,
          rewardSummaries: wallets.map(w => runtime.rewardSummary(w.address)).filter(Boolean) });
      }
      if (url.pathname === "/scheduler/consume/chat/completions") {
        if (req.method !== "POST") return json(res, 405, { error: "POST required" });
        const chunks = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > 32768) throw Error("Test request too large"); chunks.push(part); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (runtime.prepaid && body.billing === "koin-" + config.deployment.product) return runtime.scheduler.koinPrepaid.work.chat(req, res, body);
        if (runtime.prepaid || body.billing !== wire.billing) throw Error("Only approved Test spending sessions are accepted");
        return runtime.scheduler.koinFundedSessions.work.chat(req, res, body);
      }
      const route = new URL(req.url, "http://test").pathname;
      if (!(runtime.prepaid && route.startsWith("/koin/prepaid/")) && !route.startsWith(wire.prefix) && !route.startsWith("/koin/provider/device/") && !["/worker/register", "/worker/heartbeat", "/worker/next-job", "/koin/provider/qualification/result", "/koin/presence", "/koin/status", "/network/models", "/network/status"].includes(route)) return json(res, 404, { error: "Route is disabled on the Test backend" });
      await runtime.scheduler.handle(req, res);
    } catch (e) { if (!res.writableEnded && !res.destroyed) json(res, 400, { error: String(e.message).slice(0, 200) }); }
  };
}
async function start(directory = process.env.KAI_KOIN_TEST_CONFIG_DIR) {
  if (!directory || !path.isAbsolute(directory)) throw Error("Absolute KAI_KOIN_TEST_CONFIG_DIR required");
  const config = configuration(JSON.parse(read(path.join(directory, "runtime.json"))));
  const wire = require("./lib/koin-network/payment-network").protocol({ chainId: config.deployment.chainId, domain: require("./lib/koin-network/payment-mode").testDomain(config.deployment, config.schedulerUrl) });
  const stateDir = process.env.KAI_KOIN_TEST_STATE_DIR;
  if (!stateDir || !path.isAbsolute(stateDir) || /\/\.koinos-ai(\/|$)|\/opt\/koinos\/kai(\/|$)/.test(stateDir)) throw Error("Separate absolute Test state directory required");
  const secret = read(path.join(directory, "operator-secret"), 256, true).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("Independent Test operator secret required");
  let publicAccounts, authApp;
  if (config.accountMode === "public") {
    // Existing verified sign-in implementation, separate Test state. No new
    // wallet, invitation or spend grant is required to receive a free grant.
    const smtp = process.env.SMTP_HOST ? require("nodemailer").createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "true",
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } } : {}),
    }) : null;
    publicAccounts = require("./lib/accounts").createAccounts({ stateDir, siteOrigin: new URL(config.schedulerUrl).origin,
      sendMail: smtp ? m => smtp.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, ...m }) : null,
      google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null });
    authApp = require("./lib/credit-account-web").createCreditAccountWeb(publicAccounts.router);
  }
  const runtime = new TestRuntime({ config, stateDir, signers: loadKeys(path.join(directory, "runtime-keys.json"), config),
    accountService: publicAccounts?.service,
    accountsFile: path.join(directory, "invitations.json"), tokenizerDir: path.join(directory, "tokenizer"),
    qualificationsFile: path.join(directory, "qualifications.json"), operatorSecret: secret });
  await runtime.client.verify();
  const server = http.createServer(createHandler({ runtime, config, secret, authApp }));
  server.requestTimeout = 190000; server.headersTimeout = 10000;
  const port = Number(process.env.KAI_KOIN_TEST_PORT || 3107); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid Test port");
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve)); await runtime.start();
  console.log(JSON.stringify({ service: "koin-test", port, network: config.deployment.network, mainnetPaymentsEnabled: wire.paymentsEnabled }));
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
module.exports = { start, createHandler };
