"use strict";

/*
 * Probe: the 4GB-Pi fit fix (field finding 2026-08-19).
 *
 * A 4GB Raspberry Pi reports ~3.4-3.8GB usable RAM after the GPU/kernel
 * reserve; the app rounds to whole GB and sends ramGb=3 (or 4 on a lucky
 * split). The old koinos-fast minRamGb of 4 filtered the network's smallest
 * model off the exact machine it exists for — the worker sat online with
 * models=[] and no way to see why from the outside.
 *
 * Pins, over real HTTP against a real scheduler:
 *   1. a ramGb=3 worker KEEPS koinos-fast (old code FAILS: filtered to [])
 *   2. bigger classes are still filtered at ramGb=3 (the gate still works)
 *   3. the status detail now exposes the client-reported `ram` per worker
 *      (old code FAILS: field absent) — remote diagnosis needs no box access
 *
 *   node scripts/probe-pi-fit.js
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Signer } = require("koilib");
const { Scheduler } = require("../lib/scheduler");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "probe-pi-fit-"));

function main() {
  return new Promise((resolve, reject) => {
    const sched = new Scheduler({ dataDir: tmp() });
    const srv = http.createServer((req, res) => sched.handle(req, res).catch(reject));
    srv.listen(0, "127.0.0.1", async () => {
      try {
        const base = `http://127.0.0.1:${srv.address().port}`;
        const pi = Signer.fromSeed("probe-pi-fit-worker");

        console.log("\n1) a 3GB-reporting Pi keeps koinos-fast");
        let r = await fetch(`${base}/worker/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: pi.getAddress(),
            capabilities: { ramGb: 3 },
            models: ["koinos-fast", "koinos-balanced", "gemma3-4b"],
          }),
        }).then((x) => x.json());
        check(r.ok, "registration accepted");
        let status = await fetch(`${base}/network/status`).then((x) => x.json());
        // Public status truncates addresses server-side (1ABCDE…WXYZ).
        const short = `${pi.getAddress().slice(0, 6)}…${pi.getAddress().slice(-4)}`;
        const me = (status.workers || []).find((w) => w.address === short);
        check(Boolean(me), "worker visible in status detail");
        check((me?.models || []).includes("koinos-fast"), `koinos-fast survives the 3GB fit (got [${me?.models}]) — OLD code FAILS here`);

        console.log("\n2) the gate still gates");
        check(!(me?.models || []).includes("koinos-balanced"), "8GB-class model filtered at 3GB");
        check(!(me?.models || []).includes("gemma3-4b"), "gemma3-4b (8GB) filtered at 3GB");

        console.log("\n3) reported RAM is visible from the outside");
        check(me?.ram === 3, `status detail carries ram=3 (got ${me?.ram}) — OLD code FAILS here`);

        srv.close();
        console.log(failures ? `\nPI-FIT PROBE FAILED (${failures})` : "\nPI-FIT PROBE PASSED");
        process.exit(failures ? 1 : 0);
      } catch (e) {
        reject(e);
      }
    });
  });
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
