#!/usr/bin/env node
"use strict";
// Explicit-suite, local-only candidate measurements. This never creates provider
// eligibility, signs a result, configures a service, or calls the network API.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const pins = require("../lib/koin-network/tokenizers/qwen25-1.5b.json");
const { manifestIdentity, LIMITS } = require("../lib/koin-network/tokenizer");
const approvedModels = require("../deploy/koin-mainnet/model-rates.proposal.json").models;
const candidateIndex = require("../lib/koin-network/tokenizers/candidates/index.json");
const TOKENIZER_ROOT = path.join(__dirname, "../lib/koin-network/tokenizers");
const SUITE_FILE = path.join(__dirname, "../deploy/koin-mainnet/qualification/fast-candidate-v1.json");
// The largest current approved package is approximately 20 GB. Keep reads
// finite while allowing its exact pinned bytes; file size never proves identity.
const MAX_RESPONSE = 262144, MAX_MODEL = 32 * 1024 ** 3, MAX_SUITE = 2000000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
function endpoint(value) {
  // Check the literal form before URL normalization: shorthand IPv4, hostnames,
  // hidden credentials and alternate paths must never become permitted targets.
  if (typeof value !== "string" || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(value)) throw fail("explicit_loopback_endpoint_required");
  const parsed = new URL(value);
  if (!parsed.port || Number(parsed.port) > 65535) throw fail("explicit_loopback_endpoint_required");
  return parsed.origin;
}
function suite(value, manifest = pins) {
  const legacy = value?.schema === 1, keys = legacy ? "cases,id,model,modelHash,schema,status,templateHash,tokenizerHash" :
    "cases,id,model,modelHash,package,schema,status,templateHash,tokenizerHash";
  if (!value || Object.keys(value).sort().join() !== keys || ![1, 2].includes(value.schema) || value.status !== "candidate-not-approved" ||
      (legacy ? value.id !== "fast-candidate-v1" || manifest.model !== pins.model : !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value.id))) throw fail("invalid_candidate_suite");
  const approved = approvedModels.find(m => m.model === manifest.model && m.modelHash === manifest.modelHash);
  if (!approved || (!legacy && value.package !== approved.package)) throw fail("candidate_package_mismatch");
  for (const name of ["model", "modelHash", "tokenizerHash", "templateHash"]) if (value[name] !== manifest[name] || (legacy && value[name] !== pins[name])) throw fail("candidate_pin_mismatch");
  if (!Array.isArray(value.cases) || (legacy ? value.cases.length !== 12 : !value.cases.length || value.cases.length > 32)) throw fail("invalid_candidate_cases");
  const ids = new Set();
  for (const c of value.cases) {
    if (!c || Object.keys(c).sort().join() !== "expected,id,maxOutput,messages" || !(legacy ? /^[a-z-]{1,64}$/ : /^[a-zA-Z0-9_-]{1,64}$/).test(c.id) || ids.has(c.id) ||
        !Number.isSafeInteger(c.maxOutput) || c.maxOutput < 1 || c.maxOutput > (legacy ? 256 : Math.min(4096, approved.catalogContextTokens))) throw fail("invalid_candidate_case");
    ids.add(c.id);
    if (!Array.isArray(c.messages) || !c.messages.length || c.messages.length > 8 || c.messages.some(m => !m ||
        Object.keys(m).sort().join() !== "content,role" || !["user", "assistant", "system"].includes(m.role) ||
        typeof m.content !== "string" || Buffer.byteLength(m.content) > 4096)) throw fail("invalid_candidate_messages");
    if (!Array.isArray(c.expected) || !c.expected.length || c.expected.length > 8 || c.expected.some(s =>
        typeof s !== "string" || !s.trim() || s !== s.trim() || Buffer.byteLength(s) > (legacy ? 256 : 65536))) throw fail("invalid_candidate_answers");
  }
  return structuredClone(value);
}
function readJson(file, max, label) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw fail("absolute_" + label + "_file_required");
  let fd;
  try {
    const link = fs.lstatSync(file);
    if (!link.isFile() || link.isSymbolicLink()) throw fail("regular_" + label + "_file_required");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !before.size || before.size > max) throw fail("bounded_" + label + "_file_required");
    const buffer = Buffer.alloc(max + 1); let length = 0, count;
    do { count = fs.readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length <= max);
    if (length > max) throw fail("bounded_" + label + "_file_required");
    const after = fs.fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail(label + "_changed_during_read");
    const bytes = buffer.subarray(0, length);
    let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw fail("invalid_" + label + "_json"); }
    return { value, sha256: hash(bytes) };
  } catch (error) {
    if (error.code && /^[a-z_]+$/.test(error.code)) throw error;
    throw fail(label + "_file_unavailable");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function loadSelection({ model = pins.model, manifestFile } = {}) {
  const approved = approvedModels.find(m => m.model === model), indexed = candidateIndex.models.find(m => m.model === model);
  if (!approved || !indexed || indexed.modelHash !== approved.modelHash || indexed.package !== approved.package) throw fail("approved_model_required");
  let file = manifestFile;
  if (file === undefined) {
    if (!indexed.manifest) throw fail("candidate_manifest_unavailable");
    file = path.resolve(TOKENIZER_ROOT, "candidates", indexed.manifest);
    if (!file.startsWith(TOKENIZER_ROOT + path.sep)) throw fail("invalid_indexed_manifest_path");
  }
  const loaded = readJson(file, LIMITS.manifest, "manifest");
  try { manifestIdentity(loaded.value); } catch { throw fail("invalid_candidate_manifest"); }
  const manifest = loaded.value;
  if (manifest.model !== model || manifest.modelHash !== approved.modelHash || manifest.repository !== indexed.repository || manifest.revision !== indexed.revision ||
      (indexed.manifestFileSha256 && loaded.sha256 !== indexed.manifestFileSha256)) throw fail("candidate_manifest_pin_mismatch");
  return { approved, manifest, manifestSha256: loaded.sha256, manifestSource: manifestFile === undefined ? "checked-in-candidate" : "explicit-candidate" };
}
function loadSuite(file = SUITE_FILE, manifest = pins) {
  const loaded = readJson(file, MAX_SUITE, "suite");
  return { ...loaded, value: suite(loaded.value, manifest) };
}
async function hashModel(file, expected = pins.modelHash) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw fail("absolute_model_file_required");
  let handle;
  try {
    const link = fs.lstatSync(file);
    if (!link.isFile() || link.isSymbolicLink()) throw fail("regular_model_file_required");
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !before.size || before.size > MAX_MODEL) throw fail("bounded_model_file_required");
    const digest = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    let total = 0, count;
    do {
      ({ bytesRead: count } = await handle.read(buffer, 0, buffer.length, null));
      total += count;
      if (total > MAX_MODEL) throw fail("bounded_model_file_required");
      if (count) digest.update(buffer.subarray(0, count));
    } while (count);
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail("model_changed_during_read");
    const sha256 = digest.digest("hex");
    if (sha256 !== expected) throw fail("model_hash_mismatch");
    return { sha256, sizeBytes: total, hashVerified: true, loadedRuntimeIdentity: "unverified" };
  } catch (error) {
    if (error.code && /^[a-z_]+$/.test(error.code)) throw error;
    throw fail("model_file_unavailable");
  } finally { if (handle) await handle.close(); }
}
async function boundedJson(response) {
  if (!response.body) throw fail("empty_runtime_response");
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE) throw fail("runtime_response_too_large");
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw fail("invalid_runtime_json"); }
  } finally { try { await reader.cancel(); } catch {} }
}
async function measureCases({ base, candidate, manifest = pins, runtimeModel, passes = 1, timeoutMs = 120000, fetchImpl = fetch }) {
  base = endpoint(base); candidate = suite(candidate, manifest);
  if (typeof runtimeModel !== "string" || !runtimeModel.trim() || runtimeModel.length > 256 || /[\x00-\x1f]/.test(runtimeModel)) throw fail("invalid_runtime_model");
  if (!Number.isSafeInteger(passes) || passes < 1 || passes > 3 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fail("invalid_measurement_bounds");
  const results = [], startedAt = new Date().toISOString(); let interrupted = false;
  outer: for (let pass = 1; pass <= passes; pass++) for (const c of candidate.cases) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), start = performance.now();
    const item = { pass, caseId: c.id, passed: false };
    try {
      const response = await fetchImpl(base + "/v1/chat/completions", { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: runtimeModel, messages: c.messages,
          temperature: 0, max_tokens: c.maxOutput, stream: false }) });
      if (!response.ok) { try { await response.body?.cancel(); } catch {} throw fail("runtime_http_" + response.status); }
      const answer = await boundedJson(response), choice = answer.choices?.[0], output = choice?.message?.content;
      if (typeof output !== "string" || Buffer.byteLength(output) > 65536 || !["stop", "length"].includes(choice.finish_reason)) throw fail("invalid_runtime_answer");
      item.output = output; item.outputHash = hash(output); item.finishReason = choice.finish_reason;
      item.passed = choice.finish_reason === "stop" && c.expected.includes(output.trim());
      if (typeof answer.model === "string" && answer.model.length <= 256) item.runtimeReportedModel = answer.model;
    } catch (error) {
      item.error = controller.signal.aborted ? "runtime_timeout" : /^runtime_http_\d{3}$|^(runtime_response_too_large|empty_runtime_response|invalid_runtime_json|invalid_runtime_answer)$/.test(error.code || "") ? error.code : "runtime_request_failed";
      interrupted = true;
    } finally { clearTimeout(timer); item.elapsedMs = Math.round(performance.now() - start); results.push(item); }
    // One failed transport terminates this measurement instead of silently
    // retrying, producing duplicated work, or waiting through many timeouts.
    if (interrupted) break outer;
  }
  const latencies = results.filter(r => !r.error).map(r => r.elapsedMs).sort((a, b) => a - b);
  return { startedAt, completedAt: new Date().toISOString(), complete: !interrupted, passes, timeoutMs,
    requestedCalls: candidate.cases.length * passes, completedCalls: results.length, passed: results.filter(r => r.passed).length,
    latencyMs: { minimum: latencies[0] ?? null, median: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      maximum: latencies.at(-1) ?? null }, results };
}
function outputDestination(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file) throw fail("absolute_new_output_required");
  const directory = path.dirname(file), stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("real_output_directory_required");
  try { fs.lstatSync(file); throw fail("output_already_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
function writeReport(file, report) {
  outputDestination(file);
  const bytes = JSON.stringify(report, null, 2) + "\n", fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return hash(bytes);
}
function argumentsFor(args) {
  const names = { "--endpoint": "base", "--model-file": "modelFile", "--output": "output", "--runtime-model": "runtimeModel", "--passes": "passes", "--timeout-ms": "timeoutMs",
    "--model": "model", "--manifest": "manifestFile", "--suite": "suiteFile" }, options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || !value || Object.hasOwn(options, key)) throw fail("invalid_arguments");
    options[key] = ["passes", "timeoutMs"].includes(key) ? Number(value) : value;
  }
  if (!options.base || !options.modelFile || !options.output) throw fail("invalid_arguments");
  return options;
}
async function evaluate(options) {
  const base = endpoint(options.base), selection = loadSelection(options);
  if (selection.manifest.model !== pins.model && options.suiteFile === undefined) throw fail("explicit_model_suite_required");
  const loaded = loadSuite(options.suiteFile, selection.manifest); outputDestination(options.output);
  const modelFile = await hashModel(options.modelFile, selection.manifest.modelHash), runtimeModel = options.runtimeModel || loaded.value.model;
  const measurement = await measureCases({ ...options, base, candidate: loaded.value, manifest: selection.manifest, runtimeModel });
  const report = { schema: 1, kind: "local-qualification-candidate-measurement", status: "candidate-not-approved",
    signed: false, providerEligibilityCreated: false, runtimeReady: false, suiteSha256: loaded.sha256, suite: loaded.value,
    model: selection.approved.model, package: selection.approved.package,
    tokenizerManifest: { sha256: selection.manifestSha256, source: selection.manifestSource, value: selection.manifest, artifactsVerified: false },
    modelFile, inference: { endpoint: base, protocol: "openai-chat-completions", requestedModel: runtimeModel, temperature: 0,
      loadedModelVerified: false, networkQualificationPathVerified: false }, measurement,
    limits: ["The GGUF file hash is verified; this does not prove which file the separate running process loaded.",
      "Local chat-completions measurements do not exercise the signed network prompt, metering, or qualification path.",
      "The selected manifest identifies exact candidate tokenizer/template pins; this command does not verify tokenizer artifact bytes or vectors.",
      "This explicit candidate suite is not an approved quality threshold, reward weight, security evaluation, or public certification."] };
  const sha256 = writeReport(options.output, report);
  return { output: options.output, sha256, status: report.status, complete: measurement.complete, passed: measurement.passed,
    completedCalls: measurement.completedCalls, requestedCalls: measurement.requestedCalls, providerEligibilityCreated: false };
}
function printSummary(result, io = process) {
  io.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // A complete measurement with wrong answers remains useful evidence. An
  // interrupted measurement is saved too, but must fail an operator pipeline.
  io.exitCode = result.complete ? 0 : 2;
}
if (require.main === module) evaluate(argumentsForSafe()).then(result => printSummary(result)).catch(error => {
  console.error(/^[a-z_]+$/.test(error.code || "") ? error.code : "candidate_measurement_failed"); process.exitCode = 1;
});
function argumentsForSafe() {
  try { return argumentsFor(process.argv.slice(2)); }
  catch { console.error("Usage: node scripts/evaluate-koin-qualification.js --endpoint http://127.0.0.1:PORT --model-file ABS_GGUF --output ABS_NEW_JSON [--model APPROVED_ALIAS --suite ABS_SUITE_JSON] [--manifest ABS_MANIFEST_JSON] [--runtime-model NAME] [--passes 1..3] [--timeout-ms 1000..120000]"); process.exit(1); }
}
module.exports = { endpoint, suite, loadSelection, loadSuite, hashModel, boundedJson, measureCases, outputDestination, writeReport, argumentsFor, evaluate, printSummary, MAX_RESPONSE, MAX_MODEL, MAX_SUITE };
