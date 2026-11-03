"use strict";
// Runs real compilers and tests in gVisor. No mock execution is used here.
const assert = require("node:assert/strict"), fs = require("node:fs");
const { starter } = require("../lib/builder/projects"), config = require("../lib/builder/build-config");
const { run, ready, processRun } = require("./sandbox.cjs"), { verifiedResult } = require("../lib/builder/runner");
const image = process.env.KAI_RUNNER_IMAGE;
async function execute(files, target, operation, options = {}) {
  const job = config.job({ files, target, operation }), result = await run(job, { image, ...options });
  return verifiedResult(result, job);
}
(async () => {
  await ready(image);
  const files = starter("workspace", "Integration probe");
  // These files must never be executed in the AssemblyScript build path.
  files["contracts/counter/as-pect.config.js"] = 'throw Error("PROJECT_CONFIG_EXECUTED")';
  files["contracts/counter/assembly/__tests__/Counter.spec.imports.js"] = 'throw Error("PROJECT_IMPORT_EXECUTED")';
  const compiled = await execute(files, "counter", "compile");
  assert.equal(compiled.ok, true, compiled.logs);
  assert.equal(compiled.artifacts.length, 2);
  assert.ok(compiled.artifacts.find(a => a.name === "contract.wasm").bytes > 1000);
  const repeat = await execute(files, "counter", "compile");
  assert.equal(repeat.ok, true, repeat.logs);
  assert.deepEqual(repeat.artifacts.map(a => a.sha256), compiled.artifacts.map(a => a.sha256));
  console.log("PASS actual WASM/ABI compilation, deterministic artifacts and ignored project hooks");
  const tests = await execute(files, "counter", "test");
  assert.equal(tests.ok, true, tests.logs); assert.match(tests.logs, /3 pass|3\/3|3 passed/i);
  console.log("PASS actual counter MockVM tests");
  const service = await execute(files, "service", "test");
  assert.equal(service.ok, true, service.logs); assert.match(service.logs, /# pass 1/);
  const broken = { ...files, "contracts/counter/assembly/Counter.ts": "export class Counter { this is invalid; }" };
  const error = await execute(broken, "counter", "compile");
  assert.equal(error.ok, false); assert.equal(error.artifacts.length, 0); assert.match(error.logs, /ERROR|error/);
  console.log("PASS observed compiler diagnostics and no artifacts on failure");
  const badTest = { ...files, "services/feed.test.cjs": 'require("node:test")("fails", () => { require("node:assert/strict").equal(1,2); });' };
  const failed = await execute(badTest, "service", "test");
  assert.equal(failed.ok, false); assert.match(failed.logs, /not ok/);
  const marker = "/tmp/kai-host-only-marker";
  fs.writeFileSync(marker, "host-only");
  try {
    const isolation = { ...files, "services/feed.test.cjs": `const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('host and credential isolation',async()=>{assert.equal(fs.existsSync('${marker}'),false);assert.equal(fs.existsSync('/var/run/docker.sock'),false);assert.equal(process.env.KAI_RUNNER_TOKEN,undefined);assert.equal(process.env.OPENAI_API_KEY,undefined);assert.throws(()=>fs.writeFileSync('/opt/toolchain/changed','x'));await assert.rejects(fetch('https://example.com',{signal:AbortSignal.timeout(1500)}));});` };
    const isolated = await execute(isolation, "service", "test");
    assert.equal(isolated.ok, true, isolated.logs);
  } finally { fs.unlinkSync(marker); }
  console.log("PASS failing service tests and no host/network/credential access");
  const loop = { ...files, "services/feed.test.cjs": "while(true) {}" };
  const timed = await execute(loop, "service", "test", { timeout: 5000 });
  assert.equal(timed.ok, false); assert.match(timed.logs, /deadline/);
  const running = await processRun("docker", ["ps", "-aq", "--filter", "name=kai-job-"]);
  assert.equal(running.stdout.trim(), "");
  console.log("PASS timeout and container cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
