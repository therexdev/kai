"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fixture } = require("./helpers/koin-cycle-fixture"), { DAY } = require("../lib/koin-network/policy");
test("today's unsigned opening is visited before an old backlog, and historical reads rotate", async t => {
  const f = await fixture(t); f.advance(7 * DAY);
  for (let i = 2; i <= 8; i++) f.cycle.queueDay(String(i));
  const visited = []; f.cycle.advance = async epoch => { visited.push(epoch); return { epoch, action: "wait" }; };
  const runner = f.runner();
  await runner.tick({ limit: 4 }); assert.deepEqual(visited, ["8", "1", "2", "3"]);
  visited.length = 0;
  await runner.tick({ limit: 4 }); assert.deepEqual(visited, ["8", "4", "5", "6"]);
  visited.length = 0;
  await runner.tick({ limit: 4 }); assert.deepEqual(visited, ["8", "7", "1", "2"]);
});
test("pending signed envelopes keep nonce priority and an unsigned new day cannot bypass them", async t => {
  const f = await fixture(t); await f.runner().tick();
  assert.equal(f.sent.length, 1); const old = f.sent[0].id;
  f.advance(DAY); f.cycle.queueDay("2");
  const result = await f.runner().tick();
  assert.equal(result.results[0].epoch, "1");
  assert.equal(result.results.find(r => r.epoch === "2").reason, "lifecycle_nonce_busy");
  assert.equal(f.sent.length, 1); assert.equal(f.cycle.status("1").steps[0].txId, old);
});
test("a full active queue still processes recovery instead of failing before any work", async t => {
  const f = await fixture(t); f.advance(32 * DAY);
  for (let i = 2; i <= 32; i++) f.cycle.queueDay(String(i));
  const result = await f.runner().tick({ limit: 4 });
  assert.equal(result.results[0].reason, "reward_queue_full");
  assert.ok(result.results.slice(1).every(r => r.reason === "missed_reward_day"));
  assert.equal(f.cycle.days().length, 28);
  await f.runner().tick({ limit: 4 }); assert.ok(f.cycle.days().includes("33"));
});
