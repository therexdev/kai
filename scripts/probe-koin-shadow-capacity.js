"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), { KoinShadow } = require("../lib/koin-network/shadow"), { DAY } = require("../lib/koin-network/policy");
const address = Signer.fromSeed("shadow-active-capacity").address, now = DAY + 100000;
const qualification = (capacityId, expires = now + DAY) => ({ address, capacityId, model: "approved", modelHash: "1".repeat(64), modelWeight: "10000",
  coverageBps: 10000, benchmarkHash: "2".repeat(64), expires });
const record = (capacityId, expires) => ({ ...qualification(capacityId, expires), approvedAt: DAY });
function fake(rows) {
  return Object.assign(Object.create(KoinShadow.prototype), { clock: () => now, writes: 0, save() { this.writes++; },
    state: { qualifications: Object.fromEntries(rows), presence: {}, observations: {}, budgets: {}, days: {} } });
}
test("the qualification limit counts active capacities while preserving expired identities", () => {
  const expired = fake(Array.from({ length: 10000 }, (_, i) => ["expired-" + i, record("expired-" + i, now)]));
  expired.qualify(qualification("new"));
  assert.equal(Object.keys(expired.state.qualifications).length, 10001);
  assert.deepEqual(expired.state.qualifications["expired-0"], record("expired-0", now));
  const full = fake(Array.from({ length: 10000 }, (_, i) => ["active-" + i, record("active-" + i, now + DAY)]));
  full.state.qualifications.expired = record("expired", now);
  assert.throws(() => full.qualify(qualification("new")), /capacity reached/);
  assert.throws(() => full.qualify(qualification("expired")), /capacity reached/);
  assert.equal(full.writes, 0);
  full.qualify(qualification("active-0")); assert.equal(full.writes, 1);
  assert.equal(full.expireQualifications(["active-0"]), true);
  full.qualify(qualification("expired"));
  assert.equal(Object.values(full.state.qualifications).filter(q => q.expires > now).length, 10000);
  assert.equal(Object.keys(full.state.qualifications).length, 10001);
  assert.equal(full.state.qualificationHistory, undefined, "this compatibility release does not activate qualification history");
});
test("batch retirement validates before mutation and changes only current expiry with one save", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-retirement-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new KoinShadow(dir, { clock: () => now }); ledger.open("100000000000");
  ledger.qualify(qualification("one")); ledger.qualify(qualification("two"));
  const original = structuredClone(ledger.state), originalDay = JSON.stringify(ledger.getClosedEvidence(1));
  let saves = 0; const save = ledger.save.bind(ledger); ledger.save = () => { saves++; save(); };
  for (const ids of [["one", "__proto__"], ["one", "constructor"], ["one", "invalid space"], ["one", null]]) {
    assert.throws(() => ledger.expireQualifications(ids), /Valid capacity IDs/);
    assert.deepEqual(ledger.state, original);
  }
  assert.throws(() => ledger.expireQualifications(["one"], -1), /retirement cutoff/); assert.equal(saves, 0);
  assert.equal(ledger.expireQualifications(["one", "one", "two", "unknown"]), true); assert.equal(saves, 1);
  const expected = structuredClone(original); expected.qualifications.one.expires = expected.qualifications.two.expires = now;
  assert.deepEqual(ledger.state, expected);
  assert.equal(ledger.expireQualifications(["one", "two"], now + 1), false); assert.equal(saves, 1);
  assert.equal(ledger.expireQualifications([]), false); assert.equal(saves, 1);
  const reloaded = new KoinShadow(dir, { clock: () => now });
  assert.deepEqual(reloaded.state, expected);
  assert.equal(JSON.stringify(reloaded.getClosedEvidence(1)), originalDay);
  assert.deepEqual(Object.keys(reloaded.state), Object.keys(original), "persisted schema and evidence layout stay unchanged");
});
test("unmatched retirement uses the same one-write batch path and preserves matching records", () => {
  const one = record("one", now + DAY), two = record("two", now + DAY), other = { ...record("other", now + DAY), model: "unselected" };
  const ledger = fake([["one", one], ["two", two], ["other", other]]);
  assert.equal(ledger.retireUnmatchedQualifications(["approved"], [two]), true);
  assert.equal(ledger.writes, 1); assert.equal(one.expires, now); assert.equal(two.expires, now + DAY); assert.equal(other.expires, now + DAY);
  assert.equal(ledger.retireUnmatchedQualifications(["approved"], [two]), false); assert.equal(ledger.writes, 1);
});
