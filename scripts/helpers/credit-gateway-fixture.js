"use strict";
// Isolated QA only. All keys, mail delivery, prices and chain evidence are fixtures.
const path = require("node:path"), http = require("node:http"), { Signer } = require("koilib");
const { fixture } = require("./koin-prepaid-fixture"), P = require("../../lib/koin-network/job-protocol");
async function service(t, { port = 0, managedFetch } = {}) {
  const f = fixture(t), mails = [], clock = f.options.clock;
  const auth = require("../../lib/accounts").createAccounts({ stateDir: path.join(f.dir, "identity"), siteOrigin: "http://localhost", sendMail: async mail => mails.push(mail) });
  const verifier = Signer.fromSeed("web-api-verifier"), address = n => Signer.fromSeed("web-api-" + n).getAddress();
  const deployment = { schema: 1, network: "mainnet", product: "prepaid-usd-v1", chainId: f.target.chainId, decimals: 8,
    rpc: ["https://fixture.invalid"], token: require("../../lib/koin-network/payment-network").MAINNET_TOKEN, tokenHash: "0x1220" + P.hash("token"),
    credits: f.target.credits, creditsHash: f.target.creditsHash, rewards: address("rewards"), rewardsHash: "0x1220" + P.hash("rewards"),
    admin: address("admin"), verifier: verifier.getAddress(), mining: address("mining"), operations: address("operations"), masterNode: require("../../lib/koin-network/product").MASTER_NODE };
  const client = new (require("../../lib/koin-network/chain").KoinChain)(deployment, { getNextNonce: async () => "KAE=", getTransactionsById: async () => ({ transactions: [] }) });
  const wire = require("../../lib/koin-network/payment-network").protocol(f.target), worker = { address: f.provider, proof: "signed", models: ["fixture"], capabilities: { [wire.capability]: 1, koinMeteredStreaming: 1 } };
  const M = require("../../lib/koin-network/managed-protocol"), { ManagedProvider, ManagedMeter } = require("../../lib/koin-network/managed-provider");
  const managed = managedFetch && new ManagedProvider({ key: "fixture-only-managed-secret", signer: verifier, verifier: verifier.getAddress(), domain: f.target.domain, clock,
    fetchImpl: async (url, init) => url.endsWith("/models") ? Response.json({ data: M.models.map(m => ({ id: m.upstream, pricing: { input: Number(m.input) / 1e14, output: Number(m.output) / 1e14, input_cache_read: Number(m.cache) / 1e14 } })) }) : managedFetch(url, init) });
  if (managed) await managed.refresh();
  const prepaid = require("../../lib/koin-network/prepaid-router").createPrepaidRouter({ ...f.options, dataDir: path.join(f.dir, "service"), accounts: auth.service, client,
    publicAccounts: true, freePolicy: { version: 1, accountDaily: "1000", networkDaily: "20000", originDaily: "10000", accountConcurrent: 4, eligibleModels: ["fixture"] },
    networkOverview: () => ({ observedAt: clock(), validUntil: clock() + 15000, models: [{ id: "fixture", available: true, providers: 1, freeEligible: true }] }),
    ...(managed ? { managed, meter: new ManagedMeter(f.meter), freePolicy: { version: 1, accountDaily: "100000000", networkDaily: "300000000", originDaily: "200000000", accountConcurrent: 4, eligibleModels: M.models.map(m => m.model) },
      networkOverview: () => ({ observedAt: clock(), validUntil: clock() + 15000, models: M.models.map(m => ({ id: m.model, available: managed.ready(m.model), providers: 1, freeEligible: true })) }) } : {}),
    qualify: () => true, accept: ({ output }) => !!output.trim(),
    purchaseQuote: async (account, dollars) => ({ args: await require("../../lib/koin-network/purchase-quote").issue({ deployment, signer: verifier, account,
      amount: require("../../lib/koin-network/purchase-quote").nativeForDollars(dollars, "25000000"), usdPerKoin: "25000000", version: 1, now: clock() }) }) });
  const confirmed = new Map(); prepaid.purchases.inspect = async (id, owner) => confirmed.get(id)?.owner === owner ? confirmed.get(id) : { state: "pending" };
  const runtime = { client, managed, config: { maxRcPerTransaction: "500000000" }, scheduler: { koinPrepaid: prepaid } };
  const gateway = require("../../lib/credit-gateway").createCreditGateway({ accounts: auth, runtime, clock });
  const web = require("../../lib/credit-account-web").createCreditAccountWeb(auth.router, { gateway: gateway.router });
  const server = http.createServer(require("../../test-server").createHandler({ runtime,
    config: { ...runtime.config, mode: "mainnet-pilot", deployment, schedulerUrl: "https://credits.fixture.invalid/scheduler" },
    secret: "a".repeat(64), authApp: web }));
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  auth.service.siteOrigin = base;
  const raw = (url, body, headers = {}, method = body ? "POST" : "GET") => fetch(base + url, { method, redirect: "manual", headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const call = async (...args) => { const r = await raw(...args); return { status: r.status, value: await r.json() }; };
  async function signup(email) {
    await call("/auth/email/start", { email }); const code = mails.at(-1).text.match(/\b(\d{6})\b/)[1];
    const response = await raw("/auth/email/verify", { email, code }), data = await response.json();
    return { cookie: response.headers.get("set-cookie").split(";")[0], account: data.account, data };
  }
  async function createKey(user, changes = {}) {
    return call("/platform/api/keys", { name: "QA app", dailyLimitAtoms: "1000", ...changes }, { cookie: user.cookie });
  }
  async function dispatch() {
    for (let i = 0; i < 200; i++) { const j = await prepaid.work.next(worker); if (j) return j; await new Promise(r => setTimeout(r, 5)); }
    throw Error("No fixture job dispatched");
  }
  async function result(job, output = "Hello", sequence) {
    const F = require("../../lib/koin-network/funded-protocol"), hash = sequence ? F.fundedChunkHash(f.target, job, output, sequence) : F.fundedResultHash(f.target, job, output);
    const signature = Buffer.from(await f.worker.signHash(hash)).toString("base64");
    const request = require("node:stream").Readable.from([Buffer.from(JSON.stringify({ jobId: job.id, output, signature, ...(sequence ? { sequence } : {}) }))]);
    request.url = wire.prefix + (sequence ? "chunk" : "result"); request.method = "POST";
    let status, value; await prepaid.handle(request, { writeHead: s => { status = s; }, end: s => { value = JSON.parse(s); } }, () => worker);
    if (status !== 200) throw Error(JSON.stringify(value));
  }
  async function link(user, signer = f.buyer) {
    const address = signer.getAddress(), ts = Date.now(), signature = Buffer.from(await signer.signHash(Buffer.from(P.hash(`link|${address}|${user.account.id}|${ts}`), "hex"))).toString("base64");
    return call("/account/wallets", { address, ts, signature }, { cookie: user.cookie });
  }
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); prepaid.close(); auth.service.db.close(); };
  t.after(close);
  return { f, auth, gateway, prepaid, runtime, base, raw, call, signup, createKey, dispatch, result, link, confirmed, server };
}
module.exports = { service };
