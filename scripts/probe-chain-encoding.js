#!/usr/bin/env node
/*
 * Chain-encoding probe — the Koinos protobuf root actually resolves.
 *
 * This exists because of a near miss. Bumping protobufjs to close a batch of
 * advisories (FIND-SUP-002) looked completely safe: it is a transitive
 * dependency, the bump stayed inside the same major, koilib declares ^7.4.0
 * so the range was satisfied, and all twenty-seven probes went green.
 *
 * They went green because not one of them resolves the Koinos descriptors.
 * protobufjs 7.6.3 tightened extension resolution, and Koinos's own protos
 * use `extend google.protobuf.FieldOptions` for the btype annotations that
 * mark addresses and hashes — so every version that fixes the advisories
 * refuses to build the root at all. Settling an epoch on chain would have
 * thrown on the first encode, in production, with a green suite behind it.
 *
 * A dependency that cannot encode a transaction is not a passing build. So
 * this probe does the one thing the others never did: build the serializer
 * and encode something.
 *
 * Exits non-zero on any failure. Run: node scripts/probe-chain-encoding.js
 */
"use strict";

const assert = require("node:assert");

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", `${name} — ${e && e.message || e}`]); }
};

(async () => {
  await test("the Koinos protocol descriptors resolve under the pinned protobufjs", () => {
    const { Contract, Provider, utils } = require("koilib");
    /*
     * It has to be the Contract constructor. A bare Serializer over the token
     * ABI builds fine even on a protobufjs that cannot load Koinos at all —
     * the first version of this probe did exactly that, passed on the broken
     * pin, and would have waved the outage through. Contract is what pulls in
     * koinos/protocol, which is where the btype extensions live.
     *
     * No network: the constructor throws before any request is made.
     */
    const c = new Contract({
      id: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK",
      abi: utils.tokenAbi,
      provider: new Provider("https://api.koinos.io"),
    });
    assert.ok(c.functions, "the contract's functions were built");
  });

  await test("a transfer argument round-trips through that root", async () => {
    const { Serializer, utils } = require("koilib");
    const s = new Serializer(utils.tokenAbi.types);
    const args = {
      from: "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK",
      to: "1NsyZDCnHcm1rGFoUaUgHWs2FrsbQFqp2Q",
      value: "100000000",
    };
    // Serializing proves the btype annotations resolved: `from`/`to` are
    // base58 addresses BECAUSE of the extension this is guarding.
    const bytes = await s.serialize(args, "transfer_arguments");
    assert.ok(bytes && bytes.length > 0, "transfer_arguments serialized to bytes");
    const back = await s.deserialize(bytes, "transfer_arguments");
    assert.strictEqual(back.from, args.from, "the address decoded back to base58, not raw bytes");
    assert.strictEqual(back.to, args.to);
    assert.strictEqual(String(back.value), args.value);
  });

  await test("the pinned protobufjs is the one actually installed", async () => {
    // Read the lockfile rather than require()ing the package: protobufjs is
    // nested under koilib and its package.json is not an exported subpath, so
    // resolution is not a reliable way to ask "what is really installed".
    const fs = require("node:fs");
    const path = require("node:path");
    const pinned = require("../package.json").overrides?.protobufjs;
    assert.ok(pinned, "protobufjs is pinned deliberately — see README");

    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
    const entries = Object.entries(lock.packages || {}).filter(([k]) => k.endsWith("node_modules/protobufjs"));
    assert.ok(entries.length > 0, "protobufjs should be in the lockfile");
    for (const [where, meta] of entries) {
      assert.strictEqual(meta.version, pinned, `${where} is ${meta.version}, but the override pins ${pinned}`);
    }
  });

  let failed = 0;
  for (const [status, name] of results) {
    if (status !== "ok") failed++;
    console.log(`  ${status === "ok" ? "✓" : "✗"} ${name}`);
  }
  console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
