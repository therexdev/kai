"use strict";

/*
 * Probe: git-carried env channel + store fail-safe.
 *
 * FAILS on old code (no lib/env-file.js; openStore("sqlite") crashes the
 * boot when the backend can't open; /api/health silent about the store).
 * PASSES on the new code. Run: node scripts/probe-env-config.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let n = 0;
function check(name, fn) {
  n++;
  fn();
  console.log(`ok ${n} - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-envprobe-"));

check("env-file loader exists and parses KEY=VALUE, comments, quotes", () => {
  const { loadEnvFile } = require("../lib/env-file"); // throws on old code
  const f = path.join(tmp, "a.env");
  fs.writeFileSync(f, [
    "# comment",
    "",
    "KAI_PROBE_A=plain",
    'KAI_PROBE_B="quoted value"',
    "KAI_PROBE_C='single'",
    "not a line",
    "=nokey",
    "9BAD=leading-digit",
  ].join("\n"));
  const env = {};
  const r = loadEnvFile(f, env);
  assert.deepStrictEqual(env, { KAI_PROBE_A: "plain", KAI_PROBE_B: "quoted value", KAI_PROBE_C: "single" });
  assert.deepStrictEqual(r.applied.sort(), ["KAI_PROBE_A", "KAI_PROBE_B", "KAI_PROBE_C"]);
});

check("real env wins — file never overwrites a set key", () => {
  const { loadEnvFile } = require("../lib/env-file");
  const f = path.join(tmp, "b.env");
  fs.writeFileSync(f, "KAI_PROBE_X=from-file\nKAI_PROBE_Y=fills-gap\n");
  const env = { KAI_PROBE_X: "from-real-env" };
  const r = loadEnvFile(f, env);
  assert.strictEqual(env.KAI_PROBE_X, "from-real-env");
  assert.strictEqual(env.KAI_PROBE_Y, "fills-gap");
  assert.deepStrictEqual(r.skipped, ["KAI_PROBE_X"]);
});

check("missing file is a no-op, not a crash", () => {
  const { loadEnvFile } = require("../lib/env-file");
  const env = {};
  const r = loadEnvFile(path.join(tmp, "does-not-exist.env"), env);
  assert.deepStrictEqual(env, {});
  assert.deepStrictEqual(r, { applied: [], skipped: [] });
});

check("openStore falls back to json LOUDLY when sqlite cannot open", () => {
  const { openStore } = require("../lib/durable-store");
  const dir = path.join(tmp, "badstore");
  fs.mkdirSync(path.join(dir, "kai-store.sqlite"), { recursive: true }); // a DIR where the DB file goes
  const store = openStore(dir, "sqlite"); // old code: throws here
  assert.strictEqual(store.mode, "json", "fallback engages json");
  assert.ok(store.degraded && /sqlite-unavailable/.test(store.degraded), "degradation is recorded for /api/health");
  store.close();
});

check("openStore sqlite still opens normally when it can", () => {
  const { openStore } = require("../lib/durable-store");
  const dir = path.join(tmp, "goodstore");
  const store = openStore(dir, "sqlite");
  assert.strictEqual(store.mode, "sqlite");
  assert.strictEqual(store.degraded, undefined);
  store.saveBalances({ probe: 1 });
  assert.deepStrictEqual(store.loadBalances(), { probe: 1 });
  store.close();
});

check("server boots the loader before any env-reading module", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const loaderAt = src.indexOf("lib/env-file");
  const schedulerAt = src.indexOf('require("./lib/scheduler")');
  assert.ok(loaderAt > 0, "server.js wires the env-file loader"); // old code: -1
  assert.ok(schedulerAt > loaderAt, "loader runs before the scheduler require (KAI_* read at require time)");
  assert.ok(src.indexOf('require("express")') > loaderAt, "loader is ahead of the module block");
});

check("health reports the store that actually engaged", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/api\/health[\s\S]{0,600}store:/.test(src), "/api/health carries store mode"); // old code: absent
  assert.ok(/scheduler\.store\?\.degraded/.test(src), "degradation is surfaced");
});

check("deploy/app.env oracle block survives the parser as valid sources", () => {
  // The KAI_PRICE_SOURCES value is raw JSON full of quotes, braces and
  // colons — exactly the shape a naive KEY=VALUE parser mangles. Assert the
  // real file round-trips into the sources the oracle actually consumes.
  const { loadEnvFile } = require("../lib/env-file");
  const { parseSources } = require("../lib/oracle");
  const env = {};
  loadEnvFile(path.join(__dirname, "..", "deploy", "app.env"), env);
  if (env.KAI_PRICE_SOURCES === undefined) return; // rehearsal not enabled — fine
  const srcs = parseSources(env.KAI_PRICE_SOURCES);
  assert.strictEqual(srcs.length, 2, "median-of-two: both feeds parse");
  for (const s of srcs) {
    assert.ok(/^https:\/\//.test(s.url), "feeds are https");
    assert.ok(s.path && typeof s.path === "string", "each feed names its value path");
  }
  const floor = Number(env.KAI_PRICE_FLOOR_USD);
  const ceil = Number(env.KAI_PRICE_CEIL_USD);
  const ref = Number(env.KAI_REF_USD);
  assert.ok(floor > 0 && ceil > floor, "floor/ceil bracket is sane (oracle throws otherwise)");
  assert.ok(ref > floor && ref < ceil, "anchor sits inside the breaker bracket");
  const step = Number(env.KAI_PRICE_MAX_STEP_PCT);
  assert.ok(step > 0 && step <= 25, "step cap is a real brake, not wide open");
});

check("deploy/app.env exists, has no secret-shaped entries, flips the store", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "deploy", "app.env"), "utf8");
  assert.ok(/^KAI_STORE=sqlite$/m.test(src), "sqlite flip is present");
  assert.ok(!/KAI_REPUTATION_ENFORCE=/m.test(src.replace(/^#.*$/gm, "")), "reputation gate stays unarmed");
  // Secret hygiene: none of the on-box-only names may appear as live keys.
  for (const bad of ["WIF", "PASSWORD", "TOKEN", "SECRET"]) {
    assert.ok(!new RegExp(`^[A-Z_]*${bad}[A-Z_]*=`, "m").test(src.replace(/^#.*$/gm, "")), `no ${bad}-like key in git`);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nprobe-env-config: ${n}/${n} checks passed`);
