"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const U = require("./update-purchase-limit"), Prior = require("./update-native-qualification"), Web = require("./update-web-api");
test("purchase update uses the existing state-preserving updater and exact installed base", async () => {
  const previous = Web.update; let received;
  Web.update = async options => { received = options; return "verified"; };
  try { assert.equal(await U.update({ repo: "/fixture" }), "verified"); } finally { Web.update = previous; }
  assert.equal(received.repo, "/fixture");
  assert.equal(received.releasePolicy.BASE, "65c1d21b85705cd26acc63bd1eedaf5af4ef6400");
  assert.equal(received.checkHealth, U.health);
  for (const probe of Prior.PROBES) assert.ok(U.PROBES.includes(probe));
  for (const lock of Prior.LOCKS) assert.ok(U.LOCKS.includes(lock));
  assert.ok(U.ALLOWED.has("lib/koin-network/purchase-limits.js"));
  assert.ok(!U.ALLOWED.has("lib/koin-network/prepaid-ledger.js"));
});
test("health verifies the limit on both origins while retaining previous health checks", async () => {
  const previous = Prior.health;
  Prior.health = async ({ fetchImpl }) => { for (const origin of ["http://127.0.0.1:3109", "https://credits.koinosai.com"]) await fetchImpl(origin + "/health"); return true; };
  try {
    for (const broken of [null, "http:", "https:"]) {
      const options = { fetchImpl: async url => new Response(JSON.stringify({ creditPurchaseLimitVersion: 1,
        maxCreditPurchaseUsd: broken && url.startsWith(broken) ? "10" : "1000" })) };
      if (broken) await assert.rejects(U.health(options), /not active/); else assert.equal(await U.health(options), true);
    }
  } finally { Prior.health = previous; }
});
