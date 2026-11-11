"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process"), { fixture } = require("./helpers/koin-prepaid-fixture");
const { ProviderDevices } = require("../lib/koin-network/provider-devices"), { ShadowStore } = require("../lib/koin-network/shadow-store");
const { presenceHash } = require("../lib/koin-network/presence"), { presenceEventDigest } = require("../lib/koin-network/provider-presence-outbox");
const D = require("../lib/koin-network/provider-device-protocol"), P = require("../lib/koin-network/job-protocol");
const schedulerUrl = "https://credits.example.com/scheduler";
function setup(t) {
  const f = fixture(t), sourceDirectory = path.join(f.dir, "provider-presence"), storeDirectory = path.join(f.dir, "shadow-presence");
  const sourceOptions = { directory: sourceDirectory, schedulerUrl, target: f.target, clock: () => f.ledger.clock(), presenceOutbox: true };
  const storeOptions = { identity: { schedulerUrl, target: f.target }, clock: () => f.ledger.clock(), staging: true };
  let devices = new ProviderDevices(sourceOptions), store = new ShadowStore(storeDirectory, { ...storeOptions, create: true });
  // Each test closes the stores in finally before fixture cleanup removes the
  // containing directory; this hook is an additional idempotent cleanup guard.
  const cleanup = () => { devices?.close(); store?.close(); devices = null; store = null; };
  t.after(cleanup);
  const enroll = async label => {
    const keys = crypto.generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const { authorization } = devices.challenge({ wallet: f.provider, deviceId: P.hash(label), publicKey });
    const walletSignature = Buffer.from(await f.worker.signHash(D.authorizationHash(authorization))).toString("base64");
    const sign = (action, digest, at = f.ledger.clock()) => D.encodeAction(authorization, walletSignature, keys.privateKey, action, digest, at);
    return { ...devices.enroll(D.decodeAction(sign("register", D.authorizationHash(authorization)))), sign };
  };
  const report = (device, sequence = 1) => {
    const report = { schema: 1, session: device.deviceId.slice(0, 32), sequence, at: f.ledger.clock(), model: f.tariff.model, modelHash: f.tariff.modelHash, ready: true };
    return { report, signature: device.sign("presence", presenceHash(f.provider, schedulerUrl, report)) };
  };
  return { ...f, sourceOptions, storeOptions, sourceDirectory, storeDirectory, enroll, report, cleanup,
    get devices() { return devices; }, get store() { return store; },
    qualify(ttl = 60000) { store.qualify({ address: f.provider, capacityId: "integration-capacity", model: f.tariff.model, modelHash: f.tariff.modelHash,
      benchmarkHash: P.hash("presence-store-benchmark"), modelWeight: "10000", coverageBps: 10000, expires: f.ledger.clock() + ttl }); },
    accept(p) {
      // This is the future router's synchronous acceptance boundary: there is
      // no await or untrusted input between the eligibility read and commit.
      return devices.observePresence(p.signature, f.provider, p.report, { rewardQualified: store.hasQualifiedCapacity(f.provider, f.ledger.clock()) });
    },
    restartSource() { devices.close(); devices = new ProviderDevices(sourceOptions); },
    restartStore() { store.close(); store = new ShadowStore(storeDirectory, storeOptions); } };
}
function receipts(store) { return store.db.prepare("SELECT event_id,sequence,digest,outcome FROM ingested_events ORDER BY sequence").all().map(row => ({ ...row, outcome: JSON.parse(row.outcome) })); }
function sampleCount(store, address) { return store.db.prepare("SELECT count(*) AS n FROM presence_samples WHERE address=?").get(address).n; }
test("real delegated source events keep their digest, order and acceptance time when replay follows qualification expiry", async t => {
  const f = setup(t);
  try {
    const device = await f.enroll("delayed"); f.qualify(15000);
    const p = f.report(device), accepted = f.accept(p), event = accepted.presenceEvent, acceptedAt = f.ledger.clock();
    assert.equal(event.sequence, 1); assert.equal(event.acceptedAt, acceptedAt); assert.equal(event.rewardQualified, true);
    assert.equal(event.digest, presenceEventDigest(event)); assert.deepEqual(event.report, p.report);
    assert.equal(event.authorizationId, device.authorizationId); assert.equal(event.signature, p.signature);
    f.time(120000); f.restartSource(); f.restartStore();
    assert.equal(f.store.hasQualifiedCapacity(f.provider), false);
    const [pending] = f.devices.pendingPresenceEvents(); assert.deepEqual(pending, event);
    assert.deepEqual(f.store.ingestPresence(pending), { applied: true });
    assert.equal(f.store.getPresence(f.provider).at, acceptedAt); assert.equal(f.store.getPresence(f.provider).signedAt, p.report.at);
    assert.equal(sampleCount(f.store, f.provider), 1);
    assert.deepEqual(receipts(f.store), [{ event_id: event.eventId, sequence: event.sequence, digest: event.digest, outcome: { applied: true } }]);
    assert.equal(f.devices.pendingPresenceStatus().oldestAcceptedAt, acceptedAt);
    f.devices.ackPresenceEvent(event.eventId, event.digest); assert.equal(f.devices.pendingPresenceStatus().pending, 0);
  } finally { f.cleanup(); }
});
test("consumer process death after its real durable commit replays idempotently before source acknowledgment", async t => {
  const f = setup(t);
  try {
    const device = await f.enroll("lost-ack"); f.qualify(); const event = f.accept(f.report(device)).presenceEvent;
    f.store.close();
    const script = `const fs=require('node:fs');const {ShadowStore}=require(${JSON.stringify(path.resolve(__dirname, "../lib/koin-network/shadow-store"))});
      const a=JSON.parse(fs.readFileSync(0,'utf8'));const store=new ShadowStore(a.directory,{...a.options,clock:()=>a.now});
      const outcome=store.ingestPresence(a.event);process.stdout.write(JSON.stringify(outcome),()=>process.kill(process.pid,'SIGKILL'));`;
    const killed = spawnSync(process.execPath, ["-e", script], { input: JSON.stringify({ directory: f.storeDirectory, options: f.storeOptions, now: f.ledger.clock(), event }), encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr); assert.deepEqual(JSON.parse(killed.stdout), { applied: true });
    f.time(180000); f.restartSource(); f.restartStore();
    assert.equal(f.devices.pendingPresenceStatus().pending, 1); assert.equal(receipts(f.store).length, 1);
    const retry = f.accept({ report: event.report, signature: event.signature }); assert.equal(retry.duplicate, true); assert.deepEqual(retry.presenceEvent, event);
    assert.deepEqual(f.store.ingestPresence(f.devices.pendingPresenceEvents()[0]), { applied: true });
    assert.equal(sampleCount(f.store, f.provider), 1); assert.equal(f.store.getPresence(f.provider).at, event.acceptedAt);
    assert.equal(receipts(f.store).length, 1);
    f.devices.ackPresenceEvent(event.eventId, event.digest); f.restartSource(); f.restartStore();
    assert.equal(f.devices.pendingPresenceStatus().pending, 0); assert.equal(sampleCount(f.store, f.provider), 1);
  } finally { f.cleanup(); }
});
test("prequalification and wallet rate skips are durable terminal outcomes across retry and later qualification", async t => {
  const f = setup(t);
  try {
    const a = await f.enroll("preparation"), b = await f.enroll("second-device"), before = f.accept(f.report(a)).presenceEvent;
    assert.equal(before.rewardQualified, false); f.qualify(); f.time(10000);
    const first = f.accept(f.report(a, 2)).presenceEvent; f.time(1000);
    const rateLimited = f.accept(f.report(b)).presenceEvent;
    assert.equal(first.rewardQualified, true); assert.equal(rateLimited.rewardQualified, true);
    assert.deepEqual([before.sequence, first.sequence, rateLimited.sequence], [1, 2, 3]);
    const outcomes = f.devices.pendingPresenceEvents().map(event => f.store.ingestPresence(event));
    assert.deepEqual(outcomes, [{ applied: false, reason: "Capacity qualification required before shadow collection" }, { applied: true }, { applied: false, reason: "Presence rate exceeded" }]);
    assert.equal(sampleCount(f.store, f.provider), 1); assert.equal(f.store.getPresence(f.provider).at, first.acceptedAt);
    f.time(120000); f.restartSource(); f.restartStore();
    assert.deepEqual(f.devices.pendingPresenceEvents().map(event => f.store.ingestPresence(event)), outcomes);
    assert.equal(sampleCount(f.store, f.provider), 1); assert.equal(receipts(f.store).length, 3);
    const retry = f.accept({ signature: before.signature, report: before.report }); assert.equal(retry.duplicate, true); assert.equal(retry.presenceEvent.rewardQualified, false);
    f.devices.ackPresenceEvents([before, first, rateLimited]); assert.equal(f.devices.pendingPresenceStatus().pending, 0);
  } finally { f.cleanup(); }
});
test("a source sequence gap or modified envelope cannot advance consumer receipts or erase pending evidence", async t => {
  const f = setup(t);
  try {
    const device = await f.enroll("ordered"); f.qualify(); const first = f.accept(f.report(device)).presenceEvent;
    f.time(10000); const second = f.accept(f.report(device, 2)).presenceEvent;
    assert.throws(() => f.store.ingestPresence(second), /contiguous source order/);
    assert.equal(f.store.getPresence(f.provider), null); assert.equal(receipts(f.store).length, 0);
    assert.equal(f.devices.pendingPresenceStatus().pending, 2);
    assert.throws(() => f.store.ingestPresence({ ...first, acceptedAt: first.acceptedAt + 1 }), /digest changed/);
    assert.deepEqual(f.store.ingestPresence(first), { applied: true });
    const changed = { ...first, rewardQualified: false }; changed.digest = presenceEventDigest(changed);
    assert.throws(() => f.store.ingestPresence(changed), /event changed/);
    assert.equal(receipts(f.store).length, 1); assert.equal(sampleCount(f.store, f.provider), 1);
    assert.deepEqual(f.store.ingestPresence(second), { applied: true });
    f.devices.ackPresenceEvents([first, second]);
    assert.deepEqual(receipts(f.store).map(r => r.sequence), [1, 2]); assert.equal(f.devices.pendingPresenceStatus().pending, 0);
  } finally { f.cleanup(); }
});
test("an older committed event cannot replace newer wallet presence or revive itself with replay time", async t => {
  const f = setup(t);
  try {
    const device = await f.enroll("old-event"); f.qualify(); const event = f.accept(f.report(device)).presenceEvent;
    f.time(20000); const newer = { ...event.report, sequence: event.report.sequence + 1, at: f.ledger.clock() };
    f.store.observe(f.provider, newer); const latest = f.store.getPresence(f.provider);
    const outcome = f.store.ingestPresence(event); assert.deepEqual(outcome, { applied: false, reason: "Replayed presence" });
    assert.deepEqual(f.store.getPresence(f.provider), latest); assert.equal(sampleCount(f.store, f.provider), 1);
    f.time(240000); f.restartStore(); assert.deepEqual(f.store.ingestPresence(event), outcome);
    assert.deepEqual(f.store.getPresence(f.provider), latest); assert.equal(receipts(f.store)[0].digest, event.digest);
    f.devices.ackPresenceEvent(event.eventId, event.digest); assert.equal(f.devices.pendingPresenceStatus().pending, 0);
  } finally { f.cleanup(); }
});
