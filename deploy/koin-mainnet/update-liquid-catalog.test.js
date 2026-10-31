"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { update, health, BASE, INSTALLED, LOCKS, UNIT, REQUIRED } = require("./update-liquid-catalog");
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", ORIGIN = "https://credits.koinosai.com", APPROVE = "a".repeat(64);
const guestCapabilities = target => ({ ok: true, capabilities: { deviceFreeCredits: 1, scope: "device-free", freeOnly: true, algorithm: "Ed25519",
  serviceOrigin: ORIGIN, schedulerUrl: ORIGIN + "/scheduler", target, challengeTtlMs: 300000, sessionTtlMs: 86400000 } });
function fixture(t, installed = INSTALLED[0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-readiness-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = { work: root, releases: path.join(root, "releases"), config: path.join(root, "config"), state: path.join(root, "state"), unit: path.join(root, UNIT) };
  for (const dir of [p.releases, p.config, p.state]) fs.mkdirSync(dir);
  const current = path.join(p.releases, installed); fs.mkdirSync(current);
  const target = "b".repeat(40), calls = [], logs = [], policy = path.join(p.config, "runtime.json"), keys = path.join(p.config, "runtime-keys.json");
  const oldPolicies = [{ schema: 1, model: "koinos-smart", minPass: 12, maxLatencyMs: 30000, reviewedEvidenceHash: "old-reviewed-policy" }];
  const nextPolicies = {schema:1,policyHash:"e".repeat(64),models:[{tariff:{model:"lfm3-1.7b"}}],qualificationPolicies:[]};
  const models = [{ model: "koinos-smart", modelHash: "c".repeat(64), policyHash: "d".repeat(64), minPass: 3, total: 3, maxLatencyMs: 30000 }];
  const original = { schema: 2, mode: "mainnet-pilot", accountMode: "public", schedulerUrl: ORIGIN + "/scheduler", policyHash: "a".repeat(64),
    purchaseQuoteBudget: { schema: 1, dailyQuoteAuthorizationUsdAtoms: "100000000", accountDailyQuoteAuthorizationUsdAtoms: "100000000" },
    qualificationPolicies: oldPolicies, freePolicy: { dailyLimit: "retained" }, tariff: { price: "retained" }, roles: { claims: "retained" },
    deployment: { product: "prepaid-usd-v1", chainId: CHAIN, credits: "18QmSHrMszxmYPaDB1jxzY35vYDcG6aomN", creditsHash: "0x1220" + "b".repeat(64) } };
  const originalBytes = Buffer.from(JSON.stringify(original, null, 2) + "\n");
  const reviewRuntime = bytes => {
    const value = JSON.parse(bytes), already = JSON.stringify(value.catalogExtension) === JSON.stringify(nextPolicies);
    if (!already && JSON.stringify(value.qualificationPolicies) !== JSON.stringify(oldPolicies)) throw Error("Unknown existing model admission policy");
    value.catalogExtension = nextPolicies;
    return { bytes: already ? bytes : Buffer.from(JSON.stringify(value, null, 2) + "\n"), already,
      review: { schema: 2, kind: "runtime-readiness", reviewHash: APPROVE, models, catalogPolicyHash:"e".repeat(64), eligibilityCreated: false } };
  };
  fs.writeFileSync(policy, originalBytes); fs.chmodSync(policy, 0o640); fs.writeFileSync(keys, "private-fixture-key", { mode: 0o600 });
  const records = Object.fromEntries(["accounts.sqlite", "payments.sqlite", "reward-journal.sqlite", "purchase-quotes.sqlite", "quote-anchor", "automatic-qualification.json.models/smart.json", "qualification-evidence/existing-signed-results.json", "provider-devices/devices.sqlite"].map(name => [name, path.join(p.state, name)]));
  for (const [name, file] of Object.entries(records)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "existing:" + name); }
  const unit = Buffer.from(`[Service]\nUser=kai-koin-prepaid\nGroup=kai-koin-prepaid\nWorkingDirectory=${current}\nExecStart=${process.execPath} ${current}/test-server.js\nEnvironment=KAI_KOIN_TEST_CONFIG_DIR=${p.config}\nEnvironment=KAI_KOIN_TEST_STATE_DIR=${p.state}\nEnvironment=KAI_KOIN_TEST_PORT=3109\nEnvironmentFile=${p.config}/account.env\nReadWritePaths=${p.state}\nReadOnlyPaths=${p.config}\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nUMask=0077\n`);
  fs.writeFileSync(p.unit, unit); fs.chmodSync(p.unit, 0o644);
  let active = "active", changed = REQUIRED.join("\n"), dirty = "", failProbe = false, hook = () => {}, dropins = "", stopStatus = "0";
  const run = (exe, args) => {
    calls.push([exe, ...args]); hook(exe, args);
    if (exe === "git") {
      if (args[0] === "rev-parse") return target;
      if (args[0] === "status") return dirty;
      if (args[0] === "diff") { assert.equal(args[2], BASE); return changed; }
      if (args[0] === "archive") fs.writeFileSync(args.find(a => a.startsWith("--output=")).slice(9), "source-fixture");
    }
    if (exe === process.execPath && args[0] === "--test" && failProbe) throw Error("Readiness probe failed");
    if(exe === "tar" && args[0] === "-cpf") fs.writeFileSync(args[1],"consistent-state-backup");
    if (exe === "systemctl") {
      if (args[0] === "stop") active = "inactive";
      if (args[0] === "start") active = "active";
      if (args[0] === "show") return { WorkingDirectory: fs.readFileSync(p.unit, "utf8").match(/^WorkingDirectory=(.+)$/m)?.[1], ActiveState: active, ExecMainStatus: stopStatus, DropInPaths: dropins, FragmentPath: p.unit }[args.at(-1).split("=")[1]];
    }
    return "";
  };
  return { p, target, current, calls, logs, policy, keys, records, unit, originalBytes, original, nextPolicies, models, reviewRuntime,
    options: { approve: APPROVE, paths: p, run, log: s => logs.push(s), checkHealth: async () => {}, prepare:async()=>{}, reviewRuntime },
    set changed(v) { changed = v; }, set dirty(v) { dirty = v; }, set failProbe(v) { failProbe = v; }, set hook(v) { hook = v; }, set dropins(v) { dropins = v; }, set stopStatus(v) { stopStatus = v; },
    preserved() {
      const value = JSON.parse(fs.readFileSync(policy)), prior = structuredClone(original); delete value.catalogExtension;
      assert.deepEqual(value, prior); assert.equal(fs.statSync(policy).mode & 0o777, 0o640); assert.equal(fs.statSync(p.unit).mode & 0o777, 0o644);
      assert.equal(fs.readFileSync(keys, "utf8"), "private-fixture-key"); assert.ok(!logs.join("\n").includes("private-fixture"));
    },
    unchanged() { assert.deepEqual(fs.readFileSync(policy), originalBytes); assert.deepEqual(fs.readFileSync(p.unit), unit); this.preserved(); },
  };
}

test("additive updater stages and probes before stop, snapshots state, preserves all credentials and supports exact repeat",async t=>{
 const f=fixture(t);let checks=0;const options={...f.options,checkHealth:async o=>{assert.equal(o.catalogPolicyHash,"e".repeat(64));checks++;}};
 const result=await update(options);f.preserved();assert.equal(result.commit,f.target);
 for(const [name,file] of Object.entries(f.records))assert.equal(fs.readFileSync(file,"utf8"),"existing:"+name);
 assert.equal(fs.readFileSync(path.join(result.backup,"state-before-update.tar"),"utf8"),"consistent-state-backup");
 assert.deepEqual(fs.readFileSync(path.join(result.backup,"previous-runtime.json")),f.originalBytes);
 const stop=f.calls.findIndex(c=>c[0]==="systemctl"&&c[1]==="stop"),probe=f.calls.findIndex(c=>c[1]==="--test"),backup=f.calls.findIndex(c=>c[0]==="tar"&&c[1]==="-cpf");assert.ok(stop>probe&&backup>stop);
 assert.equal((await update(options)).unchanged,true);assert.equal(checks,2);assert.equal(f.calls.filter(c=>c[0]==="systemctl"&&c[1]==="stop").length,1);
});
test("unreviewed source, dirty checkout, changed unit, failed probes or tokenizer preparation cannot stop service",async t=>{
 for(const mode of ["source","dirty","unit","probe","tokenizer"]){const f=fixture(t);if(mode==="source")f.changed=REQUIRED.join("\n")+"\nlib/unreviewed.js";if(mode==="dirty")f.dirty="M file";if(mode==="unit")f.dropins="override.conf";if(mode==="probe")f.failProbe=true;
  await assert.rejects(update({...f.options,...(mode==="tokenizer"?{prepare:async()=>{throw Error("download failed")}}:{})}));f.unchanged();assert.equal(f.calls.some(c=>c[0]==="systemctl"&&c[1]==="stop"),false);
 }
});
test("failure before new service start restores only code and config, never financial files",async t=>{
 const f=fixture(t);let once=true;f.hook=(exe,args)=>{if(exe==="systemctl"&&args[0]==="daemon-reload"&&once){once=false;throw Error("reload failed");}};
 await assert.rejects(update(f.options),/reload failed/);f.unchanged();for(const [name,file] of Object.entries(f.records))assert.equal(fs.readFileSync(file,"utf8"),"existing:"+name);
});
test("health failure after start retains the new catalog and new receipts; never restores stale money snapshots",async t=>{
 const f=fixture(t);await assert.rejects(update({...f.options,checkHealth:async()=>{fs.appendFileSync(f.records["payments.sqlite"],":new receipt");throw Error("public endpoint delayed")}}),/endpoint delayed/);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.policy)).catalogExtension,f.nextPolicies);assert.ok(fs.readFileSync(f.p.unit,"utf8").includes(f.target));assert.ok(fs.readFileSync(f.records["payments.sqlite"],"utf8").endsWith(":new receipt"));
 assert.ok(f.logs.some(x=>x.includes("retained for recovery")));assert.equal(f.calls.filter(c=>c[0]==="systemctl"&&c[1]==="stop").length,1);
});
test("catalog migration cannot change old prices, grant budgets, accounts or existing free model order",()=>{
 const fn=require("./update-liquid-catalog").onlyAdmissionChanged,old={policyHash:"base",models:[1],freePolicy:{accountDaily:"100",eligibleModels:["old"]}},next={...old,catalogExtension:{},freePolicy:{accountDaily:"100",eligibleModels:["old","lfm3-1.7b"]}};
 fn(JSON.stringify(old),JSON.stringify(next));for(const change of [x=>x.policyHash="changed",x=>x.models=[2],x=>x.freePolicy.accountDaily="1000",x=>x.freePolicy.eligibleModels=["lfm3-1.7b"]]){const bad=structuredClone(next);change(bad);assert.throws(()=>fn(JSON.stringify(old),JSON.stringify(bad)));}
});
