"use strict";
// Optional cross-repository integration: node scripts/verify-koin-desktop.js ../kaiapp
// Uses real Core, account routes, Scheduler and Worker with a local deterministic
// inference fixture. No external service, price feed, chain RPC or funds.
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http");
const express = require("express"), { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler"), { createAccounts } = require("../lib/accounts");
const { Meter } = require("../lib/koin-network/metering"), P = require("../lib/koin-network/job-protocol");
if (!process.argv[2]) throw Error("Pass the kaiapp checkout path");
const appRoot = path.resolve(process.argv[2]);
const { createCore } = require(path.join(appRoot, "core/server"));
const { Worker } = require(path.join(appRoot, "core/lib/worker"));

test("desktop chat -> real account grant -> master -> desktop worker -> verified answer", { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koin-desktop-master-"));
  const site = express(), accountRoutes = createAccounts({ stateDir: path.join(dir, "accounts") });
  site.use((req, res, next) => req.path.startsWith("/scheduler/") ? next() : express.json()(req, res, next));
  site.use(accountRoutes.router);
  const server = http.createServer(site);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`, schedulerUrl = base + "/scheduler";
  let core, master, worker, engine;
  t.after(async () => {
    await worker?.stop(); await core?.stop();
    server.closeAllConnections(); await new Promise(r => server.close(r));
    if (engine) { engine.closeAllConnections(); await new Promise(r => engine.close(r)); }
    await master?.close(); accountRoutes.service.db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const old = process.env.KAI_KOIN_SHADOW_CONSUMER_URL;
  process.env.KAI_KOIN_SHADOW_CONSUMER_URL = schedulerUrl;
  try { core = await createCore({ dataDir: path.join(dir, "desktop"), port: 0, onEvent() {} }); }
  finally { if (old === undefined) delete process.env.KAI_KOIN_SHADOW_CONSUMER_URL; else process.env.KAI_KOIN_SHADOW_CONSUMER_URL = old; }
  core.account.wallet.create({ password: "isolated fixture wallet" });
  core.settings.set("earn.schedulerUrl", schedulerUrl); core.settings.set("network.privacyMode", "network");
  const accounts = accountRoutes.service, account = accounts._newAccount({ email: "cross-repo@example.invalid" });
  const token = accounts._issueSession(account.id, "fixture"); core.account._saveToken(token);
  const owner = core.account.wallet.address, ts = Date.now(), expiresAt = ts + 3600000, maxMicro = 1000000;
  const signOwner = text => core.account.wallet.signHash(Buffer.from(P.hash(text), "hex"));
  accounts.linkWallet(account, { address: owner, ts, signature: await signOwner(`link|${owner}|${account.id}|${ts}`) });
  const grant = accounts.grantSpend(account, { address: owner, ts, expiresAt, maxMicro,
    signature: await signOwner(`spend|${owner}|${account.id}|${maxMicro}|${expiresAt}|${ts}`) });
  const signer = Signer.fromSeed("cross-repo-fixture-provider"), address = signer.getAddress();
  const signWorker = async bytes => Buffer.from(await signer.signHash(bytes)).toString("base64");
  const tariff = { model: "koinos-fast", version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"),
    templateHash: P.hash("template"), inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000",
    maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 };
  const encode = text => [...Buffer.from(text)], meter = new Meter([{ tariff,
    adapter: { ...tariff, render: JSON.stringify, encode, input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } }]);
  const session = P.hash("cross-repo-session");
  master = new Scheduler({ dataDir: path.join(dir, "master"), accounts, operatorSecret: "fixture-only",
    koinWork: { domain: "shadow:cross-repo", meter, qualify: a => a === address, accept: ({ output }) => output === "4",
      consumerWaitMs: 8000, consumerBindings: [{ accountId: account.id, grantId: grant.id, session, model: tariff.model, version: 1, maxOutput: 16 }] } });
  master.koinWork.ledger.importSimulationGrant({ id: session, owner, policyHash: meter.policyHash,
    amount: "10000", perJob: "1000", maxJobs: 2, expires: expiresAt });
  site.use("/scheduler", (req, res) => master.handle(req, res).catch(e => { res.status(500).json({ error: e.message }); }));
  let generations = 0;
  engine = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const b = JSON.parse(raw); res.setHeader("content-type", "application/json");
    if (req.url === "/tokenize") res.end(JSON.stringify({ tokens: encode(b.content) }));
    else { assert.equal(b.n_predict, 16); generations++; res.end(JSON.stringify({ content: "4" })); }
  });
  await new Promise(r => engine.listen(0, "127.0.0.1", r));
  const catalog = { aliases: { "koinos-fast": { package: "fixture" } }, packages: { fixture: { sha256: tariff.modelHash } } };
  worker = new Worker({ schedulerUrl, wallet: { address, signHash: signWorker }, models: { catalog }, koinShadowJobs: true,
    runtime: { status: () => ({ runtime: { kind: "llamacpp" } }), acquireFor: async () => ({ endpoint: `http://127.0.0.1:${engine.address().port}`, release() {} }) },
    onEvent: e => { if (["worker:shadow-job-done", "worker:job-failed"].includes(e.type)) worker.running = false; } });
  const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const at = Date.now(), registration = await post(schedulerUrl + "/worker/register", { address, ts: at,
    signature: await signWorker(Buffer.from(P.hash(`register|${address}|${at}`), "hex")), models: ["koinos-fast"], capabilities: { ramGb: 8, koinShadowJobs: 1 } });
  const registered = await registration.json(); worker.token = registered.token; assert.ok(worker.token, JSON.stringify(registered));
  const desktopUrl = `http://127.0.0.1:${await core.start()}`, id = P.hash("cross-repo-request");
  core.account.wallet.signHash = () => { throw Error("Chat must reuse its grant"); };
  const body = { model: "koinos-network", messages: [{ role: "user", content: "What is two plus two?" }], max_tokens: 16, koin_request_id: id };
  const pending = post(desktopUrl + "/v1/chat/completions", body);
  for (let i = 0; i < 200 && !master.koinWork.ledger.db.prepare("SELECT 1 FROM jobs WHERE id=?").get(id); i++) await new Promise(r => setTimeout(r, 5));
  worker.running = true; await worker._run();
  const response = await pending, result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.choices[0].message.content, "4");
  assert.match(result.warning, /no KOIN was spent/); assert.equal(result.koin.paymentsEnabled, false);
  assert.equal(generations, 1); assert.equal(worker.stats.shadowJobsDone, 1); assert.equal(worker.stats.jobsDone, 0);
  assert.equal(accounts.spendableGrant(account.id, grant.id).remainingMicro, maxMicro); assert.deepEqual(master.usage, {});
  const retry = await post(desktopUrl + "/v1/chat/completions", { ...body, stream: true });
  assert.equal(retry.status, 200); assert.match(await retry.text(), /no KOIN was spent/); assert.equal(generations, 1);
});
