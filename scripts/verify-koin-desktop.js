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

test("native desktop session approval -> authenticated funded ledger -> bounded reservations and recovery", async t => {
  const { setup, sign } = require("./helpers/koin-delegation-fixture"), { nextId } = require("./helpers/koin-funding-fixture");
  const { EventEmitter } = require("events");
  const { FundedSessionClient } = require(path.join(appRoot, "electron/koin-session-client"));
  const { createSessionReview } = require(path.join(appRoot, "electron/koin-session-review"));
  const f = await setup(t);
  f.head.last_irreversible_block = "101"; f.block.block_id = nextId; f.block.block_height = "101";
  f.block.block.id = nextId; f.block.block.header.height = "101";
  const config = { ...f.proposal, schedulerUrl: f.base, target: f.target, session: f.id };
  let signatures = 0;
  const options = { config, file: path.join(f.dir, "desktop-approval.json"), clock: f.config.koinFundedSessions.clock,
    authorize: async () => ({ accountId: f.account.id, grantId: f.grant.id, owner: f.owner, sessionToken: f.token }),
    sign: async bytes => { signatures++; return sign(bytes); } };
  const client = new FundedSessionClient(options), window = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  window.webContents = new EventEmitter();
  const run = createSessionReview({ client, dialog: { showMessageBox: async () => ({ response: 1 }) } });
  const approved = await run(window, "review"); assert.equal(approved.state, "active", JSON.stringify(approved)); assert.equal(signatures, 1);
  const saved = JSON.parse(fs.readFileSync(options.file)), approval = { delegationId: approved.id };
  for (const n of ["one", "two"]) await f.ledger.reserveDelegated({ ...f.request(approval, n), observationId: saved.observationId });
  const reopened = new FundedSessionClient(options);
  assert.equal((await reopened.status()).remainingJobs, 1); assert.equal((await reopened.retry()).id, approved.id); assert.equal(signatures, 1);
  assert.equal((await reopened.revoke()).state, "revoked"); await f.restart();
  assert.equal((await new FundedSessionClient(options).retry()).state, "revoked"); assert.equal(signatures, 1);
  assert.equal(f.accounts.spendableGrant(f.account.id, f.grant.id).remainingMicro, 1000000);
});

test("approved funded session -> real desktop chat -> signed worker -> verified response and prepared settlement", { timeout: 20000 }, async t => {
  const { setup, owner } = require("./helpers/koin-delegation-fixture"), { nextId } = require("./helpers/koin-funding-fixture");
  const { FundedSessionClient } = require(path.join(appRoot, "electron/koin-session-client"));
  const signer = Signer.fromSeed("funded-cross-provider"), address = signer.getAddress();
  const f = await setup(t, { realClock: true, model: "koinos-fast", work: { qualify: a => a === address, waitMs: 8000 } });
  f.head.last_irreversible_block = "101"; f.block.block_id = nextId; f.block.block_height = "101";
  f.block.block.id = nextId; f.block.block.header.height = "101";
  const site = express(), routes = createAccounts({ stateDir: path.join(f.dir, "accounts") });
  site.use((req, res, next) => req.path.startsWith("/scheduler/") ? next() : express.json()(req, res, next));
  site.use(routes.router); site.use("/scheduler", (req, res) => f.scheduler.handle(req, res).catch(e => res.status(500).json({ error: e.message })));
  const server = http.createServer(site); await new Promise(r => server.listen(0, "127.0.0.1", r));
  const schedulerUrl = `http://127.0.0.1:${server.address().port}/scheduler`;
  let core, worker, engine, signatures = 0, generations = 0;
  t.after(async () => {
    await worker?.stop(); await core?.stop();
    server.closeAllConnections(); await new Promise(r => server.close(r)); routes.service.db.close();
    engine?.closeAllConnections(); if (engine) await new Promise(r => engine.close(r));
  });
  core = await createCore({ dataDir: path.join(f.dir, "desktop"), port: 0, onEvent() {} });
  core.account.wallet.importWif({ wif: owner.getPrivateKey("wif"), password: "isolated fixture" });
  core.account._saveToken(f.token); core.settings.set("earn.schedulerUrl", schedulerUrl);
  core.settings.set("network.privacyMode", "network");
  const config = { ...f.proposal, schedulerUrl, target: f.target, session: f.id };
  const options = { config, file: path.join(f.dir, "desktop-approval.json"),
    authorize: (pin, signal, opts) => core.account.shadowAuthorization(pin, signal, opts),
    sign: bytes => { signatures++; return core.account.wallet.signHash(bytes); } };
  const client = new FundedSessionClient(options); await client.approve(await client.prepare());
  core.gateway.koinFundedConsume = request => client.consume(request);
  core.account.wallet.signHash = () => { throw Error("A chat request cannot ask for another wallet signature"); };
  const encode = text => [...Buffer.from(text)];
  engine = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const b = JSON.parse(raw); res.setHeader("content-type", "application/json");
    if (req.url === "/tokenize") res.end(JSON.stringify({ tokens: encode(b.content) }));
    else { generations++; res.end(JSON.stringify({ content: "4" })); }
  });
  await new Promise(r => engine.listen(0, "127.0.0.1", r));
  const sign = async bytes => Buffer.from(await signer.signHash(bytes)).toString("base64");
  const catalog = { aliases: { "koinos-fast": { package: "fixture" } }, packages: { fixture: { sha256: P.hash("model") } } };
  worker = new Worker({ schedulerUrl, wallet: { address, signHash: sign }, models: { catalog }, koinFundedRehearsalJobs: true,
    runtime: { status: () => ({ runtime: { kind: "llamacpp" } }), acquireFor: async () => ({ endpoint: `http://127.0.0.1:${engine.address().port}`, release() {} }) },
    onEvent: e => { if (["worker:funded-rehearsal-job-done", "worker:job-failed"].includes(e.type)) worker.running = false; } });
  const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) });
  const at = Date.now(), registration = await post(schedulerUrl + "/worker/register", { address, ts: at,
    signature: await sign(Buffer.from(P.hash(`register|${address}|${at}`), "hex")), models: ["koinos-fast"], capabilities: { ramGb: 8, koinFundedRehearsalJobs: 1 } });
  const registered = await registration.json(); worker.token = registered.token; assert.ok(worker.token, JSON.stringify(registered));
  const desktopUrl = `http://127.0.0.1:${await core.start()}`;
  for (const n of ["first", "second"]) {
    const id = P.hash("funded-cross-" + n), body = { model: "koinos-network", messages: [{ role: "user", content: "2+2?" }], max_tokens: 16, koin_request_id: id };
    const pending = post(desktopUrl + "/v1/chat/completions", body);
    for (let i = 0; i < 300 && !f.ledger.job(id); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(f.ledger.job(id), "desktop must reserve before worker polling");
    worker.running = true; await worker._run();
    const response = await pending, answer = await response.json();
    assert.equal(response.status, 200, JSON.stringify(answer)); assert.equal(answer.choices[0].message.content, "4");
    assert.equal(answer.koin.state, n === "first" ? "prepared" : "verified"); assert.match(answer.warning, /no KOIN was spent/);
    const retry = await post(desktopUrl + "/v1/chat/completions", { ...body, stream: true });
    assert.equal(retry.status, 200); assert.match(await retry.text(), /data: \[DONE\]/);
  }
  assert.equal(generations, 2); assert.equal(signatures, 1); assert.equal(worker.stats.fundedRehearsalJobsDone, 2);
  assert.equal(worker.stats.jobsDone, 0); assert.deepEqual(f.scheduler.usage, {});
  assert.equal(f.accounts.spendableGrant(f.account.id, f.grant.id).remainingMicro, 1000000);
  await client.revoke();
  const rejected = await post(desktopUrl + "/v1/chat/completions", { model: "koinos-network", messages: [{ role: "user", content: "new" }] });
  assert.equal(rejected.status, 502); assert.equal(generations, 2); assert.equal(signatures, 1);
});
