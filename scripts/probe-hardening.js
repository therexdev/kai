#!/usr/bin/env node
/*
 * Hardening probe — the two scheduler findings from the external review
 * (therexdev/kaiapp#2) that need no protocol change, proven against a real
 * Scheduler on a real socket.
 *
 *   FIND-AVL-001  public routes buffered request bodies with no ceiling, and
 *                 /scheduler is mounted ahead of express.json, so nothing
 *                 else was going to stop it either. One anonymous POST could
 *                 grow the heap until the process died.
 *   FIND-CFG-001  every privileged route read
 *                   if (this.operatorSecret && header !== secret) refuse
 *                 which refuses nobody when the secret is unset. A deploy
 *                 that forgot KAI_OPERATOR_SECRET published epoch closing,
 *                 revocation and job injection to the internet — and looked
 *                 completely healthy from outside.
 *
 * Both cases below fail on the pre-fix scheduler.
 *
 * Exits non-zero on any failure. Run: node scripts/probe-hardening.js
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");
const { Scheduler } = require("../lib/scheduler");

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", `${name} — ${e && e.message || e}`]); }
};

/** A scheduler on a real port, with or without an operator secret. */
async function spin({ operatorSecret = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-harden-"));
  const sched = new Scheduler({ dataDir, operatorSecret, onEvent: () => {} });
  const server = http.createServer((req, res) => {
    sched.handle(req, res).catch((err) => {
      // Mirrors server.js: anything the scheduler does not answer itself
      // becomes a 500. A 413 must never arrive here.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err.message), via: "outer-500" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((r) => server.close(r)),
  };
}

(async () => {
  /* ------------------------------------------------ FIND-AVL-001 */

  await test("an oversized body is refused with 413, not swallowed as 500", async () => {
    const s = await spin();
    try {
      // 4 MiB against a 2 MiB ceiling. Small enough to run anywhere, large
      // enough that the old code would have concatenated every byte.
      const res = await fetch(`${s.base}/worker/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(4 * 1024 * 1024),
      });
      assert.strictEqual(res.status, 413, `expected 413, got ${res.status}`);
      const j = await res.json();
      assert.match(String(j.error), /too large/i);
      assert.notStrictEqual(j.via, "outer-500", "the scheduler must answer this itself");
    } finally {
      await s.stop();
    }
  });

  await test("a body under the ceiling still works", async () => {
    const s = await spin();
    try {
      // Registration carries a models list and capabilities; ordinary size.
      const res = await fetch(`${s.base}/worker/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK", models: ["koinos-fast"], capabilities: { ramGb: 16 } }),
      });
      assert.strictEqual(res.status, 200, `honest registration must still pass, got ${res.status}`);
      const j = await res.json();
      assert.ok(j.token, "a real registration returns a worker token");
    } finally {
      await s.stop();
    }
  });

  await test("the refusal does not depend on the route", async () => {
    const s = await spin();
    try {
      // The relayed consumer path is the other anonymous public POST that
      // takes a body — same reader, same ceiling.
      const res = await fetch(`${s.base}/consume/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "y".repeat(4 * 1024 * 1024),
      });
      assert.strictEqual(res.status, 413, `expected 413, got ${res.status}`);
    } finally {
      await s.stop();
    }
  });

  /* ------------------------------------------------ FIND-CFG-001 */

  const PRIVILEGED = [
    ["POST", "/operator/revoke"],
    ["POST", "/operator/unrevoke"],
    ["POST", "/operator/enqueue"],
    ["POST", "/epoch/close"],
    ["GET", "/operator/epochs"],
  ];

  await test("with NO operator secret, every privileged route is closed", async () => {
    const s = await spin({ operatorSecret: null });
    try {
      for (const [method, route] of PRIVILEGED) {
        const res = await fetch(s.base + route, {
          method,
          ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
        });
        assert.strictEqual(
          res.status, 503,
          `${method} ${route} answered ${res.status} with no secret configured — this is the fail-open`,
        );
        const j = await res.json();
        assert.match(String(j.error), /operator secret/i, `${route} should say why`);
      }
    } finally {
      await s.stop();
    }
  });

  await test("with a secret set, the wrong one is refused and the right one works", async () => {
    const s = await spin({ operatorSecret: "correct-horse-battery-staple" });
    try {
      const missing = await fetch(`${s.base}/operator/epochs`);
      assert.strictEqual(missing.status, 401, "no header must be refused");

      const wrong = await fetch(`${s.base}/operator/epochs`, { headers: { "x-operator-secret": "nope" } });
      assert.strictEqual(wrong.status, 401, "a wrong secret must be refused");

      // A prefix of the real secret must not be treated as the real secret.
      const prefix = await fetch(`${s.base}/operator/epochs`, { headers: { "x-operator-secret": "correct-horse" } });
      assert.strictEqual(prefix.status, 401, "a prefix must be refused");

      const right = await fetch(`${s.base}/operator/epochs`, {
        headers: { "x-operator-secret": "correct-horse-battery-staple" },
      });
      assert.strictEqual(right.status, 200, "the operator must still get in");
    } finally {
      await s.stop();
    }
  });

  await test("public routes are unaffected by the operator gate", async () => {
    const s = await spin({ operatorSecret: null });
    try {
      // Closing the operator routes must not close the network itself.
      const res = await fetch(`${s.base}/epoch/current`);
      assert.strictEqual(res.status, 200, `/epoch/current should stay public, got ${res.status}`);
    } finally {
      await s.stop();
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
