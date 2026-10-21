"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"),
  path = require("node:path"), http = require("node:http"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const E = require("./evaluate-koin-qualification"), candidate = E.loadSuite().value;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-quality-candidate-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
async function server(t, handler) {
  const s = http.createServer(handler); await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }));
  return `http://127.0.0.1:${s.address().port}`;
}
const answer = (output, finish = "stop") => new Response(JSON.stringify({ model: "fixture-local-runtime", choices: [{ message: { content: output }, finish_reason: finish }] }));
test("versioned candidate is tied to exact model/tokenizer pins and declares no admission threshold", () => {
  assert.equal(candidate.cases.length, 12); assert.equal(candidate.status, "candidate-not-approved"); assert.equal(candidate.minPass, undefined);
  assert.match(candidate.cases.find(c => c.id === "ryb-colors").messages[0].content, /traditional RYB/);
  assert.throws(() => E.suite({ ...candidate, modelHash: digest("other model") }), /candidate_pin_mismatch/);
  assert.throws(() => E.suite({ ...candidate, minPass: 7 }), /invalid_candidate_suite/);
});
test("local runtime URL rejects remote targets, URL normalization tricks and embedded credentials", () => {
  assert.equal(E.endpoint("http://127.0.0.1:1234/"), "http://127.0.0.1:1234"); assert.equal(E.endpoint("http://[::1]:1234"), "http://[::1]:1234");
  for (const url of ["https://127.0.0.1:1234", "http://localhost:1234", "http://127.1:1234", "http://2130706433:1234", "http://0x7f000001:1234",
    "http://127.0.0.2:1234", "http://example.com:1234", "http://127.0.0.1", "http://user@127.0.0.1:1234", "http://127.0.0.1:1234/a",
    "http://127.0.0.1:1234?x=1", "http://127.0.0.1:1234#x", "http://127.0.0.1:99999", " http://127.0.0.1:1234"]) assert.throws(() => E.endpoint(url), undefined, url);
});
test("actual model bytes are hashed, wrong pins and symlink model files are rejected", async t => {
  const dir = directory(t), file = path.join(dir, "model.gguf"), bytes = Buffer.from("fixture file, not a real model"); fs.writeFileSync(file, bytes);
  assert.deepEqual(await E.hashModel(file, digest(bytes)), { sha256: digest(bytes), sizeBytes: bytes.length, hashVerified: true, loadedRuntimeIdentity: "unverified" });
  await assert.rejects(E.hashModel(file), /model_hash_mismatch/);
  const link = path.join(dir, "link.gguf"); fs.symlinkSync(file, link); await assert.rejects(E.hashModel(link, digest(bytes)), /regular_model_file_required/);
});
test("local measurement sends only the fixed suite with bounded deterministic inference and exports exact results", async t => {
  const seen = [], base = await server(t, (req, res) => {
    let text = ""; req.on("data", data => text += data); req.on("end", () => {
      const input = JSON.parse(text), c = candidate.cases[seen.length]; seen.push({ route: req.url, input });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "fixture", choices: [{ message: { content: c.expected[0] }, finish_reason: "stop" }] }));
    });
  });
  const result = await E.measureCases({ base, candidate, runtimeModel: "fixture" });
  assert.equal(result.complete, true); assert.equal(result.passed, 12); assert.equal(result.completedCalls, 12);
  for (let i = 0; i < seen.length; i++) {
    assert.equal(seen[i].route, "/v1/chat/completions"); assert.deepEqual(seen[i].input.messages, candidate.cases[i].messages);
    assert.equal(seen[i].input.max_tokens, candidate.cases[i].maxOutput); assert.equal(seen[i].input.temperature, 0); assert.equal(seen[i].input.stream, false);
    assert.equal(result.results[i].outputHash, digest(candidate.cases[i].expected[0])); assert.ok(Number.isSafeInteger(result.results[i].elapsedMs));
  }
});
test("wrong answers and truncated answers remain failed measurements without changing the candidate", async () => {
  let calls = 0;
  const result = await E.measureCases({ base: "http://127.0.0.1:1234", candidate, runtimeModel: "fixture", fetchImpl: async () => {
    const c = candidate.cases[calls++]; return calls === 1 ? answer("wrong") : calls === 2 ? answer(c.expected[0], "length") : answer("\n" + c.expected[0] + "\n");
  } });
  assert.equal(result.complete, true); assert.equal(result.passed, 10); assert.equal(result.results[0].passed, false); assert.equal(result.results[1].passed, false);
});
test("redirects never contact a second endpoint and terminate after one request", async t => {
  let destinationCalls = 0; const destination = await server(t, (_, res) => { destinationCalls++; res.end("{}"); });
  const base = await server(t, (_, res) => { res.writeHead(302, { location: destination }); res.end(); });
  const result = await E.measureCases({ base, candidate, runtimeModel: "fixture" });
  assert.equal(destinationCalls, 0); assert.equal(result.complete, false); assert.equal(result.completedCalls, 1); assert.equal(result.results[0].error, "runtime_request_failed");
});
test("oversized, malformed and HTTP error responses are bounded and never leak server error text", async () => {
  for (const [response, expected] of [
    [new Response("x".repeat(E.MAX_RESPONSE + 1)), "runtime_response_too_large"],
    [new Response("private runtime error text"), "invalid_runtime_json"],
    [new Response("private error", { status: 503 }), "runtime_http_503"]
  ]) {
    const result = await E.measureCases({ base: "http://127.0.0.1:1234", candidate, runtimeModel: "fixture", fetchImpl: async () => response });
    assert.equal(result.completedCalls, 1); assert.equal(result.results[0].error, expected); assert.equal(JSON.stringify(result).includes("private"), false);
  }
});
test("timeout aborts the active request and does not automatically retry", async () => {
  let calls = 0;
  const result = await E.measureCases({ base: "http://127.0.0.1:1234", candidate, runtimeModel: "fixture", timeoutMs: 1000,
    fetchImpl: (_, options) => new Promise((resolve, reject) => { calls++; options.signal.addEventListener("abort", () => reject(Error("private detail"))); }) });
  assert.equal(calls, 1); assert.equal(result.complete, false); assert.equal(result.results[0].error, "runtime_timeout");
});
test("report files are private, exclusive and hashed without changing an existing artifact", t => {
  const dir = directory(t), file = path.join(dir, "measurement.json"), report = { status: "candidate-not-approved" };
  const checksum = E.writeReport(file, report); assert.equal(checksum, digest(fs.readFileSync(file))); assert.deepEqual(JSON.parse(fs.readFileSync(file)), report);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.throws(() => E.writeReport(file, { changed: true }), /output_already_exists/);
  const link = path.join(dir, "link.json"); fs.symlinkSync(file, link); assert.throws(() => E.writeReport(link, report), /output_already_exists/);
});
test("CLI stops before inference when the supplied local file is not the pinned model", t => {
  const dir = directory(t), file = path.join(dir, "wrong.gguf"), output = path.join(dir, "measurement.json"); fs.writeFileSync(file, "wrong model");
  const run = spawnSync(process.execPath, [path.join(__dirname, "evaluate-koin-qualification.js"), "--endpoint", "http://127.0.0.1:1234", "--model-file", file, "--output", output], { encoding: "utf8" });
  assert.equal(run.status, 1); assert.equal(run.stderr.trim(), "model_hash_mismatch"); assert.equal(fs.existsSync(output), false);
});
test("CLI summary preserves incomplete evidence while reporting a failed pipeline status", async t => {
  const measurement = await E.measureCases({ base: "http://127.0.0.1:1234", candidate, runtimeModel: "fixture", fetchImpl: async () => new Response("unavailable", { status: 503 }) });
  const output = path.join(directory(t), "partial.json"), sha256 = E.writeReport(output, { measurement });
  let text = ""; const io = { stdout: { write: value => text += value }, exitCode: null };
  E.printSummary({ output, sha256, complete: measurement.complete }, io);
  assert.equal(io.exitCode, 2); assert.equal(JSON.parse(text).sha256, digest(fs.readFileSync(output)));
  assert.equal(JSON.parse(fs.readFileSync(output)).measurement.results[0].error, "runtime_http_503");
  text = ""; E.printSummary({ complete: true, passed: 0, completedCalls: 12 }, io);
  assert.equal(io.exitCode, 0, "wrong answers do not invalidate a completed measurement"); assert.equal(JSON.parse(text).passed, 0);
});
function modelSuite(selection) {
  const { manifest, approved } = selection;
  return { schema: 2, id: "fixture-only-three-cases-v1", status: "candidate-not-approved", model: manifest.model,
    package: approved.package, modelHash: manifest.modelHash, tokenizerHash: manifest.tokenizerHash, templateHash: manifest.templateHash,
    // Test-only suite: these cases exercise evaluator behavior, not this model's quality or an admission policy.
    cases: ["first", "second", "third"].map((id, i) => ({ id, maxOutput: 512 + i, messages: [{ role: "user", content: "Fixture " + id }], expected: ["Fixture answer " + id] })) };
}
test("approved larger-model selection binds package and exact checked-in manifest, retaining Fast defaults", t => {
  const fast = E.loadSelection(), large = E.loadSelection({ model: "qwen25-32b" });
  assert.equal(fast.manifest.model, candidate.model); assert.equal(fast.manifest.modelHash, candidate.modelHash);
  assert.equal(large.approved.package, "qwen2.5-32b-instruct-q4_k_m@1"); assert.equal(large.manifest.model, "qwen25-32b");
  const file = path.join(directory(t), "manifest.json"), source = path.join(__dirname, "../lib/koin-network/tokenizers/candidates/qwen25-32b.json");
  fs.copyFileSync(source, file);
  const explicit = E.loadSelection({ model: "qwen25-32b", manifestFile: file });
  assert.equal(explicit.manifestSha256, digest(fs.readFileSync(source))); assert.equal(explicit.manifestSource, "explicit-candidate");
  const changed = structuredClone(explicit.manifest); changed.templateHash = digest("other template"); fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => E.loadSelection({ model: "qwen25-32b", manifestFile: file }), /candidate_manifest_pin_mismatch/);
  for (const model of ["dev-tiny", "__proto__", "private-api", "../qwen25-32b"]) assert.throws(() => E.loadSelection({ model }), /approved_model_required/);
  const gemma = E.loadSelection({ model: "gemma3-27b" }), gemmaFile = path.join(__dirname, "../lib/koin-network/tokenizers/candidates/gemma3-27b.json");
  assert.equal(gemma.manifest.model, "gemma3-27b"); assert.equal(gemma.manifest.modelHash, "4e83142e3ad3719ac61334f70a956dcc60bbba8adb29de5114161310bb9f7170");
  assert.equal(gemma.manifest.modelHash, gemma.approved.modelHash); assert.equal(gemma.manifestSha256, digest(fs.readFileSync(gemmaFile)));
  assert.equal(gemma.manifest.mode, "shadow"); assert.equal(gemma.manifestSource, "checked-in-candidate");
  const index = require("../lib/koin-network/tokenizers/candidates/index.json"), indexed = index.models.find(m => m.model === gemma.manifest.model);
  assert.equal(index.productionApproved, false); assert.equal(indexed.runtimeModelVerified, false); assert.equal(indexed.paidAdmission, false);
});
test("new suites require exact model package/pins and explicit bounded cases without inventing quality thresholds", () => {
  const selection = E.loadSelection({ model: "qwen25-32b" }), input = modelSuite(selection), manifest = selection.manifest;
  assert.deepEqual(E.suite(input, manifest), input); assert.equal(E.suite(input, manifest).cases.length, 3);
  assert.throws(() => E.suite({ ...input, package: E.loadSelection().approved.package }, manifest), /candidate_package_mismatch/);
  for (const name of ["model", "modelHash", "tokenizerHash", "templateHash"]) assert.throws(() => E.suite({ ...input, [name]: "wrong" }, manifest), /candidate_pin_mismatch/);
  assert.throws(() => E.suite({ ...input, minPass: 2 }, manifest), /invalid_candidate_suite/);
  assert.throws(() => E.suite({ ...input, cases: [] }, manifest), /invalid_candidate_cases/);
  assert.throws(() => E.suite({ ...input, cases: Array(33).fill(input.cases[0]) }, manifest), /invalid_candidate_cases/);
  assert.throws(() => E.suite({ ...input, cases: [input.cases[0], input.cases[0]] }, manifest), /invalid_candidate_case/);
  assert.throws(() => E.suite({ ...input, cases: [{ ...input.cases[0], maxOutput: 4097 }] }, manifest), /invalid_candidate_case/);
  assert.throws(() => E.suite(candidate, manifest), /invalid_candidate_suite/);
});
test("larger-model measurement executes only its explicit suite and selected runtime alias", async () => {
  const selection = E.loadSelection({ model: "qwen25-32b" }), input = modelSuite(selection), seen = [];
  const result = await E.measureCases({ base: "http://127.0.0.1:1234", candidate: input, manifest: selection.manifest,
    runtimeModel: selection.manifest.model, passes: 2, fetchImpl: async (_, options) => {
      const c = input.cases[seen.length % input.cases.length]; seen.push(JSON.parse(options.body)); return answer(c.expected[0]);
    } });
  assert.equal(result.complete, true); assert.equal(result.completedCalls, 6); assert.equal(result.passed, 6);
  seen.forEach((request, i) => { assert.equal(request.model, "qwen25-32b"); assert.deepEqual(request.messages, input.cases[i % 3].messages); assert.equal(request.max_tokens, input.cases[i % 3].maxOutput); });
  let calls = 0;
  await assert.rejects(E.measureCases({ base: "http://127.0.0.1:1234", candidate: input, runtimeModel: "qwen25-32b",
    fetchImpl: async () => { calls++; return answer("unexpected"); } }), /candidate_package_mismatch|candidate_pin_mismatch/);
  assert.equal(calls, 0);
});
test("explicit candidate files reject symlinks, excessive size, malformed JSON and cross-model manifests", t => {
  const dir = directory(t), selection = E.loadSelection({ model: "qwen25-32b" }), file = path.join(dir, "suite.json"), link = path.join(dir, "link.json");
  fs.writeFileSync(file, JSON.stringify(modelSuite(selection))); fs.symlinkSync(file, link);
  assert.throws(() => E.loadSuite(link, selection.manifest), /regular_suite_file_required/);
  assert.throws(() => E.loadSelection({ model: "qwen25-32b", manifestFile: link }), /regular_manifest_file_required/);
  assert.throws(() => E.loadSuite("relative.json", selection.manifest), /absolute_suite_file_required/);
  fs.writeFileSync(file, Buffer.alloc(E.MAX_SUITE + 1));
  assert.throws(() => E.loadSuite(file, selection.manifest), /bounded_suite_file_required/);
  assert.throws(() => E.loadSelection({ model: "qwen25-32b", manifestFile: file }), /bounded_manifest_file_required/);
  fs.writeFileSync(file, "private malformed contents"); assert.throws(() => E.loadSuite(file), /^Error: invalid_suite_json$/);
  fs.writeFileSync(file, JSON.stringify(E.loadSelection().manifest));
  assert.throws(() => E.loadSelection({ model: "qwen25-32b", manifestFile: file }), /candidate_manifest_pin_mismatch/);
});
test("model cap admits the approved 32B package size range while refusing larger files before hashing", async t => {
  assert.equal(E.MAX_MODEL, 32 * 1024 ** 3); assert.ok(E.MAX_MODEL > 20000000000);
  const file = path.join(directory(t), "oversized-sparse.gguf"), fd = fs.openSync(file, "w");
  try { fs.ftruncateSync(fd, E.MAX_MODEL + 1); } finally { fs.closeSync(fd); }
  await assert.rejects(E.hashModel(file), /bounded_model_file_required/);
});
test("non-Fast CLI requires a model-specific suite and refuses wrong GGUF bytes before inference", t => {
  const dir = directory(t), modelFile = path.join(dir, "wrong.gguf"), output = path.join(dir, "result.json"), suiteFile = path.join(dir, "suite.json");
  const selection = E.loadSelection({ model: "qwen25-32b" }); fs.writeFileSync(modelFile, "fixture wrong model"); fs.writeFileSync(suiteFile, JSON.stringify(modelSuite(selection)));
  const args = [path.join(__dirname, "evaluate-koin-qualification.js"), "--endpoint", "http://127.0.0.1:1234", "--model", "qwen25-32b", "--model-file", modelFile, "--output", output];
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" }); assert.equal(missing.status, 1); assert.equal(missing.stderr.trim(), "explicit_model_suite_required");
  const wrong = spawnSync(process.execPath, [...args, "--suite", suiteFile], { encoding: "utf8" }); assert.equal(wrong.status, 1); assert.equal(wrong.stderr.trim(), "model_hash_mismatch");
  assert.equal(fs.existsSync(output), false);
  const parsed = E.argumentsFor([...args.slice(1), "--suite", suiteFile, "--manifest", "/explicit/manifest.json"]);
  assert.equal(parsed.model, "qwen25-32b"); assert.equal(parsed.suiteFile, suiteFile); assert.equal(parsed.manifestFile, "/explicit/manifest.json");
  assert.throws(() => E.argumentsFor([...args.slice(1), "--model", "koinos-fast"]), /invalid_arguments/);
});
