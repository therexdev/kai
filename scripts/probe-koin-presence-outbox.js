"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process"), { DatabaseSync } = require("node:sqlite");
const { fixture } = require("./helpers/koin-prepaid-fixture");
const { ProviderDevices } = require("../lib/koin-network/provider-devices");
const { presenceEventDigest } = require("../lib/koin-network/provider-presence-outbox");
const { presenceHash } = require("../lib/koin-network/presence"), D = require("../lib/koin-network/provider-device-protocol"), P = require("../lib/koin-network/job-protocol");
const schedulerUrl = "https://credits.example.com/scheduler";
function setup(t, overrides = {}) {
  const f = fixture(t), directory = f.dir + "-presence", options = { directory, schedulerUrl, target: f.target, clock: () => f.ledger.clock(), presenceOutbox: true, ...overrides };
  let devices = new ProviderDevices(options);
  t.after(() => { devices?.close(); fs.rmSync(directory, { recursive: true, force: true }); for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(directory + ".recovery-anchor.sqlite" + suffix, { force: true }); });
  async function enroll(label = "one") {
    const keys = crypto.generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const { authorization } = devices.challenge({ wallet: f.provider, deviceId: P.hash(label), publicKey });
    const walletSignature = Buffer.from(await f.worker.signHash(D.authorizationHash(authorization))).toString("base64");
    const sign = (action, digest, at = f.ledger.clock()) => D.encodeAction(authorization, walletSignature, keys.privateKey, action, digest, at);
    const approved = devices.enroll(D.decodeAction(sign("register", D.authorizationHash(authorization))));
    return { ...approved, sign, authorization, binding: { address: f.provider, providerAuthorization: approved.authorizationId, providerDeviceId: approved.deviceId } };
  }
  function report(device, sequence = 1, overrides = {}) {
    const report = { schema: 1, session: "c".repeat(32), sequence, at: f.ledger.clock(), model: "fixture", modelHash: f.tariff.modelHash, ready: true, ...overrides };
    return { report, signature: device.sign("presence", presenceHash(f.provider, schedulerUrl, report)) };
  }
  return { ...f, options, directory, enroll, report, get devices() { return devices; },
    observe(p, rewardQualified = true) { return devices.observePresence(p.signature, f.provider, p.report, { rewardQualified }); },
    restart() { devices?.close(); devices = new ProviderDevices(options); },
    close() { devices?.close(); devices = null; } };
}
function crash(f, p, beforeCommit) {
  f.close();
  const script = `const fs=require('node:fs'); const {ProviderDevices}=require(${JSON.stringify(path.resolve(__dirname, "../lib/koin-network/provider-devices"))});
    const a=JSON.parse(fs.readFileSync(0,'utf8')); const devices=new ProviderDevices({...a.options,clock:()=>a.now});
    if(a.beforeCommit){const write=devices.write.bind(devices);devices.write=fn=>write(()=>{fn();process.kill(process.pid,'SIGKILL');});}
    const result=devices.observePresence(a.signature,a.wallet,a.report,{rewardQualified:true});
    process.stdout.write(JSON.stringify(result),()=>process.kill(process.pid,'SIGKILL'));`;
  const result = spawnSync(process.execPath, ["-e", script], { input: JSON.stringify({ options: f.options, now: f.ledger.clock(), wallet: f.provider, ...p, beforeCommit }), encoding: "utf8" });
  assert.equal(result.signal, "SIGKILL", result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}
test("committed delegated presence survives process death before shadow delivery without rewriting acceptance time", async t => {
  const f = setup(t), d = await f.enroll(), p = f.report(d), acceptedAt = f.ledger.clock();
  const accepted = crash(f, p, false); f.restart(); f.time(120000);
  const [event] = f.devices.pendingPresenceEvents();
  assert.deepEqual(event, accepted.presenceEvent); assert.equal(event.acceptedAt, acceptedAt);
  assert.equal(event.digest, presenceEventDigest(event)); assert.deepEqual(event.report, p.report);
  const retry = f.observe(p, false); assert.equal(retry.duplicate, true); assert.deepEqual(retry.presenceEvent, event);
  assert.equal(f.devices.pendingPresenceStatus().pending, 1);
  assert.equal(f.devices.presence(d.binding).at, acceptedAt);
  retry.presenceEvent.report.ready = false; assert.equal(f.devices.pendingPresenceEvents()[0].report.ready, true);
});
test("process death inside the source transaction cannot commit an orphan replay watermark or event", async t => {
  const f = setup(t), d = await f.enroll(), p = f.report(d);
  crash(f, p, true); f.restart();
  assert.equal(f.devices.presence(d.binding), null); assert.deepEqual(f.devices.pendingPresenceEvents(), []);
  assert.equal(f.devices.pendingPresenceStatus().nextSequence, 1);
  assert.equal(f.observe(p).duplicate, false);
});
test("consumer commit before acknowledgment replays once and persists terminal skips atomically", async t => {
  const f = setup(t), d = await f.enroll(), first = f.observe(f.report(d), false).presenceEvent;
  f.time(10000); const second = f.observe(f.report(d, 2), true).presenceEvent;
  const file = path.join(f.dir, "presence-consumer.sqlite"); let consumer = new DatabaseSync(file);
  consumer.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE applied(id TEXT PRIMARY KEY,digest TEXT NOT NULL,outcome TEXT NOT NULL); CREATE TABLE evidence(id TEXT PRIMARY KEY,accepted_at INTEGER NOT NULL);");
  const apply = e => {
    consumer.exec("BEGIN IMMEDIATE");
    try {
      const receipt = consumer.prepare("SELECT digest FROM applied WHERE id=?").get(e.eventId);
      if (receipt) assert.equal(receipt.digest, e.digest);
      else {
        consumer.prepare("INSERT INTO applied VALUES(?,?,?)").run(e.eventId, e.digest, e.rewardQualified ? "applied" : "unqualified");
        if (e.rewardQualified) consumer.prepare("INSERT INTO evidence VALUES(?,?)").run(e.eventId, e.acceptedAt);
      }
      consumer.exec("COMMIT");
    } catch (error) { consumer.exec("ROLLBACK"); throw error; }
  };
  for (const event of f.devices.pendingPresenceEvents()) apply(event);
  consumer.close(); f.restart(); f.time(90000); consumer = new DatabaseSync(file);
  for (const event of f.devices.pendingPresenceEvents()) apply(event);
  assert.equal(consumer.prepare("SELECT count(*) n FROM applied").get().n, 2);
  assert.equal(consumer.prepare("SELECT count(*) n FROM evidence").get().n, 1);
  assert.equal(consumer.prepare("SELECT accepted_at FROM evidence").get().accepted_at, second.acceptedAt);
  assert.deepEqual(f.devices.ackPresenceEvents([first, second]), { acknowledged: 2, pending: 0 });
  assert.deepEqual(f.devices.ackPresenceEvents([first, second]), { acknowledged: 0, pending: 0 });
  consumer.close(); f.restart(); assert.deepEqual(f.devices.pendingPresenceEvents(), []);
});
test("only exact committed proof and payload recover after revocation or expiry", async t => {
  const f = setup(t), d = await f.enroll(), p = f.report(d), event = f.observe(p).presenceEvent;
  f.devices.revoke(d.sign("revoke", D.hash("revoke:" + d.authorizationId))); f.restart();
  assert.equal(f.observe(p).duplicate, true);
  const altered = { ...p.report, ready: false };
  assert.throws(() => f.observe({ report: altered, signature: p.signature }), /signature|revoked/i);
  assert.throws(() => f.observe({ report: altered, signature: d.sign("presence", presenceHash(f.provider, schedulerUrl, altered)) }), /revoked/i);
  f.devices.ackPresenceEvent(event.eventId, event.digest); f.time(2592000001); f.restart();
  assert.equal(f.observe(p).duplicate, true); assert.deepEqual(f.devices.pendingPresenceEvents(), []);
  assert.throws(() => f.devices.observePresence(p.signature, f.owner, p.report, { rewardQualified: true }), /signature|wallet|expired/i);
});
test("changed proof, payload, sequence and uncommitted stale reports cannot use exact receipts", async t => {
  const f = setup(t), d = await f.enroll(), p = f.report(d); f.observe(p); f.time(10000);
  assert.throws(() => f.observe({ ...p, signature: d.sign("presence", presenceHash(f.provider, schedulerUrl, p.report)) }), /Replayed/);
  assert.throws(() => f.observe(f.report(d, 1)), /Replayed/);
  const changed = { ...p.report, ready: false };
  assert.throws(() => f.observe({ report: changed, signature: d.sign("presence", presenceHash(f.provider, schedulerUrl, changed)) }), /Replayed/);
  const stale = f.report(d, 2); f.time(60001); assert.throws(() => f.observe(stale), /expired/i);
  assert.equal(f.devices.pendingPresenceStatus().pending, 1);
});
test("queue backpressure rolls back replay and retries succeed after ordered bounded acknowledgment", async t => {
  const f = setup(t, { maxPendingPresence: 2 }), d = await f.enroll();
  const first = f.observe(f.report(d)).presenceEvent; f.time(10000);
  const second = f.observe(f.report(d, 2)).presenceEvent; f.time(10000); const third = f.report(d, 3);
  assert.throws(() => f.observe(third), error => error.status === 503 && error.code === "PROVIDER_PRESENCE_BACKPRESSURE");
  assert.equal(f.devices.presence(d.binding).sequence, 2); assert.equal(f.devices.pendingPresenceStatus().nextSequence, 3);
  assert.throws(() => f.devices.ackPresenceEvent(second.eventId, second.digest), /source order/);
  assert.equal(f.devices.pendingPresenceStatus().pending, 2);
  assert.throws(() => f.devices.ackPresenceEvents([first, { ...second, digest: "0".repeat(64) }]), /digest changed/);
  assert.equal(f.devices.pendingPresenceStatus().pending, 2, "a failed batch rolls back earlier deletes");
  assert.throws(() => f.devices.pendingPresenceEvents(129), /batch limit/);
  assert.deepEqual(f.devices.pendingPresenceEvents(1), [first]);
  f.devices.ackPresenceEvent(first.eventId, first.digest); assert.equal(f.observe(third).presenceEvent.sequence, 3);
  assert.equal(f.devices.pendingPresenceStatus().pending, 2);
});
test("receipt storage retains pending reports plus only the latest committed report per authorization", async t => {
  const f = setup(t), d = await f.enroll(), p1 = f.report(d), first = f.observe(p1).presenceEvent;
  f.time(10000); const p2 = f.report(d, 2), second = f.observe(p2).presenceEvent;
  assert.equal(f.observe(p1).duplicate, true, "older pending report remains retryable");
  f.devices.ackPresenceEvents([first, second]); f.restart();
  assert.equal(f.observe(p2).duplicate, true); assert.throws(() => f.observe(p1), /Replayed/);
  assert.equal(f.devices.db.prepare("SELECT count(*) n FROM presence_receipts").get().n, 1);
  assert.equal(f.devices.pendingPresenceStatus().nextSequence, 3);
});
test("eligibility and monotonic acceptance are explicit and roll back on admission failure", async t => {
  const f = setup(t), a = await f.enroll("a"), b = await f.enroll("b"); f.time(1000); const p = f.report(a);
  assert.throws(() => f.devices.observePresence(p.signature, f.provider, p.report), /eligibility required/);
  assert.equal(f.devices.presence(a.binding), null); assert.equal(f.devices.pendingPresenceStatus().nextSequence, 1);
  const first = f.observe(p, false).presenceEvent; f.time(-1);
  assert.throws(() => f.observe(f.report(b)), /clock moved backwards/);
  assert.equal(f.devices.presence(b.binding), null); f.time(1);
  const second = f.observe(f.report(b)).presenceEvent; assert.equal(second.acceptedAt, first.acceptedAt); assert.equal(second.sequence, 2);
});
test("activated source rejects competing same-process and cross-process writers on every reopen", async t => {
  const f = setup(t), d = await f.enroll(), p = f.report(d);
  assert.throws(() => new ProviderDevices(f.options), /Stop every provider device writer/);
  const script = `const {ProviderDevices}=require(${JSON.stringify(path.resolve(__dirname, "../lib/koin-network/provider-devices"))});new ProviderDevices(${JSON.stringify({ ...f.options, clock: undefined })});`;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /Stop every provider device writer/);
  assert.equal(f.observe(p).duplicate, false); f.restart(); assert.equal(f.observe(p).duplicate, true);
});
test("activation is opt-in, refuses another live legacy writer, and establishes a persistent rollback floor", async t => {
  const f = setup(t, { presenceOutbox: false }), d = await f.enroll(), p = f.report(d);
  assert.equal(f.devices.pendingPresenceStatus().enabled, false); assert.equal(f.observe(p).presenceEvent, undefined);
  assert.throws(() => new ProviderDevices({ ...f.options, presenceOutbox: true }), /Stop every provider device writer/);
  assert.equal(f.devices.pendingPresenceStatus().enabled, false);
  f.close(); const upgraded = new ProviderDevices({ ...f.options, presenceOutbox: true }); upgraded.close();
  assert.throws(() => new ProviderDevices(f.options), /rollback is not supported/);
  const reopened = new ProviderDevices({ ...f.options, presenceOutbox: true });
  assert.equal(JSON.parse(reopened.db.prepare("SELECT data FROM identity WHERE id=1").get().data).presenceOutbox, 2);
  assert.equal(reopened.presence(d.binding).sequence, 1); assert.deepEqual(reopened.pendingPresenceEvents(), []);
  reopened.close();
});
test("activated missing storage and interrupted cross-anchor commits remain fail-closed", async t => {
  const f = setup(t), d = await f.enroll(); f.observe(f.report(d));
  f.devices.write(() => f.devices.db.exec("DROP TABLE presence_outbox")); f.close();
  assert.throws(() => new ProviderDevices(f.options), /presence_outbox/);
  const h = setup(t), hd = await h.enroll(); h.observe(h.report(hd));
  h.devices.write(() => h.devices.db.exec("DROP TABLE presence")); h.close();
  assert.throws(() => new ProviderDevices(h.options), /storage table missing: presence/);
  const g = setup(t), device = await g.enroll(); g.observe(g.report(device)); g.close();
  const db = new DatabaseSync(path.join(g.directory, "provider-devices.sqlite")); db.exec("UPDATE recovery_generation SET generation=generation+1"); db.close();
  assert.throws(() => new ProviderDevices(g.options), /generation mismatch|interrupted commit/);
});
