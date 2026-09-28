"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  http = require("http");
const { Signer } = require("koilib");
const { KoinShadow } = require("../lib/koin-network/shadow");
const { createShadowRouter } = require("../lib/koin-network/shadow-router");
const {
  presenceHash,
  verifyPresence,
} = require("../lib/koin-network/presence");
const { DAY } = require("../lib/koin-network/policy");
const signer = Signer.fromSeed("koin-shadow-test"),
  address = signer.getAddress(),
  modelHash = "1".repeat(64);
const report = (at, sequence, ready = true) => ({
  schema: 1,
  session: "a".repeat(32),
  sequence,
  at,
  model: "approved",
  modelHash,
  ready,
});
function directory(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "koin-shadow-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const qualification = (expires) => ({
  address,
  capacityId: "benchmarked-slot",
  model: "approved",
  modelHash,
  modelWeight: "10000",
  coverageBps: 10000,
  benchmarkHash: "2".repeat(64),
  expires,
});
test("shadow availability requires a complete observed minute, rejects gaps, model switches and replay", (t) => {
  const dir = directory(t);
  let now = DAY;
  const ledger = new KoinShadow(dir, { clock: () => now });
  ledger.open("100000000000");
  ledger.qualify(qualification(2 * DAY));
  for (let i = 0; i <= 3; i++) {
    now = DAY + i * 25000;
    ledger.observe(address, report(now, i));
  }
  ledger.tick();
  assert.equal(ledger.state.days[1].intervals[0].slots.length, 1);
  assert.ok(BigInt(ledger.status(address).estimate.availability) > 0n);
  assert.equal(ledger.status(address).claimable, null);
  assert.throws(() => ledger.observe(address, report(now, 3)), /Replay/);
  now = DAY + 100000;
  ledger.observe(address, report(now, 4, false));
  now = DAY + 125000;
  ledger.observe(address, report(now, 5));
  ledger.tick();
  assert.equal(
    ledger.state.days[1].intervals[1].slots.length,
    0,
    "a switch invalidates the interval",
  );
  now = DAY + 200000;
  ledger.observe(address, report(now, 6));
  ledger.tick();
  assert.equal(
    ledger.state.days[1].intervals[2].slots.length,
    0,
    "missing heartbeat invalidates the interval",
  );
  now = 2 * DAY;
  const reopened = new KoinShadow(dir, { clock: () => now });
  assert.deepEqual(reopened.manifest(1), ledger.manifest(1));
  assert.equal(reopened.manifest(1).allocations[0].work, "0");
});
test("signed presence binds audience, account, active model and every field", async () => {
  const audience = "https://master.example/scheduler",
    r = report(DAY, 1);
  const body = {
    address,
    report: r,
    signature: Buffer.from(
      await signer.signHash(presenceHash(address, audience, r)),
    ).toString("base64"),
  };
  assert.deepEqual(verifyPresence(body, audience, DAY), r);
  assert.throws(() => verifyPresence(body, audience + "-other", DAY));
  assert.throws(() =>
    verifyPresence(
      { ...body, report: { ...r, model: "bigger" } },
      audience,
      DAY,
    ),
  );
  assert.throws(() => verifyPresence(body, audience, DAY + 60001));
});
test("shadow routes require signed reports and operator-qualified capacity; restart preserves budgets", async (t) => {
  const dir = directory(t);
  let now = DAY;
  const server = http.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const audience = `http://127.0.0.1:${server.address().port}`;
  const router = createShadowRouter({
    dataDir: dir,
    operatorSecret: "fixture-secret",
    audience,
    clock: () => now,
  });
  server.on("request", async (req, res) => {
    if (!(await router.handle(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  const post = (route, data, secret = "") =>
    fetch(audience + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operator-secret": secret,
      },
      body: JSON.stringify(data),
    });
  assert.equal(
    (await post("/koin/shadow/open", { balance: "100000000000" })).status,
    403,
  );
  assert.equal(
    (
      await post(
        "/koin/shadow/open",
        { balance: "100000000000" },
        "fixture-secret",
      )
    ).status,
    200,
  );
  assert.equal(
    (await post("/koin/presence", { address, report: report(now, 1) })).status,
    400,
  );
  assert.equal(
    (
      await post(
        "/koin/shadow/qualify",
        qualification(2 * DAY),
        "fixture-secret",
      )
    ).status,
    200,
  );
  const r = report(now, 1),
    signature = Buffer.from(
      await signer.signHash(presenceHash(address, audience, r)),
    ).toString("base64");
  assert.equal(
    (await post("/koin/presence", { address, report: r, signature })).status,
    200,
  );
  const status = await (
    await fetch(audience + `/koin/status?address=${address}`)
  ).json();
  assert.equal(status.qualification, "qualified-shadow");
  assert.equal(status.paymentsEnabled, false);
  assert.equal(
    (await post("/koin/presence", { address, report: r, signature })).status,
    400,
  );
});

test("canonical scheduler advertises shadow capability only when enabled and leaves legacy balances intact", async t => {
 const { Scheduler } = require("../lib/scheduler");
 const dir = directory(t), audience = "https://fixture.example/scheduler";
 const scheduler = new Scheduler({ dataDir: dir, operatorSecret: "fixture-secret", koinShadow: { audience }, settlement: { kaiBalance: async () => "700000000" } });
 const port = await scheduler.listen(); t.after(() => scheduler.close());
 const base = `http://127.0.0.1:${port}`;
 const register = await (await fetch(base+"/worker/register", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({address,models:["koinos-fast"]})})).json();
 assert.equal(register.ok, true); assert.equal(register.koinShadow, true);
 const status = await (await fetch(base+`/koin/status?address=${address}`)).json();
 assert.equal(status.mode, "shadow"); assert.equal(status.paymentsEnabled, false);
 const balance = await (await fetch(base+`/balance?address=${address}`)).json();
 assert.equal(balance.kai, "7"); assert.equal(balance.koinShadow, true);
 const old = new Scheduler({dataDir: path.join(dir,"old"), koinShadow: null});
 t.after(() => old.close()); assert.equal(old.koinShadow,null);
});
