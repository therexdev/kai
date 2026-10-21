#!/usr/bin/env node
"use strict";
// Build literal, bounded inputs for the desktop's local-only provider check.
// This never runs a model, invents a quality threshold, or admits a provider.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const { loadTokenizer, manifestIdentity, LIMITS } = require("../lib/koin-network/tokenizer");
const validateBaseline = require("./evaluate-koin-qualification").suite;
const ROOT = path.resolve(__dirname, ".."), TOKENIZERS = path.join(ROOT, "lib/koin-network/tokenizers");
const FILES = { catalog: "deploy/koin-mainnet/model-rates.proposal.json", index: "lib/koin-network/tokenizers/candidates/index.json",
  suite: "deploy/koin-mainnet/qualification/fast-candidate-v1.json", tokenizerSource: "lib/koin-network/tokenizer.js" };
const MAX_PACK = 2000000, MAX_TEXT = 65536, AT = Date.UTC(2026, 9, 21);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => Object.assign(new Error(code), { code });
function read(file, max) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > max) throw fail("bounded_regular_input_required");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd), data = Buffer.alloc(max + 1); let length = 0, count;
    if (!before.isFile() || !before.size || before.size > max) throw fail("bounded_regular_input_required");
    do { count = fs.readSync(fd, data, length, data.length - length, null); length += count; } while (count && length <= max);
    const after = fs.fstatSync(fd);
    if (length > max || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail("input_changed_or_too_large");
    return data.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw fail("invalid_input_json"); }
}
function measuredText(adapter, text) {
  if (typeof text !== "string" || !text.length || Buffer.byteLength(text) > MAX_TEXT) throw fail("bounded_evidence_text_required");
  const ids = adapter.encode(text);
  if (!Array.isArray(ids) || !ids.length || ids.length > 4096 || ids.some(id => !Number.isSafeInteger(id) || id < 0)) throw fail("bounded_evidence_tokens_required");
  return { count: ids.length, idsHash: hash(JSON.stringify(ids)) };
}
function prepareModel({ approved, indexed, manifestBytes, directory, baseline, at = AT }) {
  if (!Number.isSafeInteger(at) || at < 0 || at > 253402300799999) throw fail("fixed_candidate_time_required");
  validateBaseline(baseline);
  const manifest = json(manifestBytes); manifestIdentity(manifest);
  if (!approved || !indexed || approved.model !== indexed.model || approved.package !== indexed.package || approved.modelHash !== indexed.modelHash ||
      manifest.model !== approved.model || manifest.modelHash !== approved.modelHash || manifest.repository !== indexed.repository || manifest.revision !== indexed.revision ||
      !/^[a-f0-9]{64}$/.test(indexed.manifestFileSha256 || "") || hash(manifestBytes) !== indexed.manifestFileSha256) throw fail("candidate_source_pin_mismatch");
  // The shared loader verifies tokenizer/config/template bytes and every
  // independently prepared reference vector before producing any evidence.
  const adapter = loadTokenizer(directory, manifest);
  const vectors = manifest.vectors.map((vector, i) => {
    const text = vector.messages ? adapter.render(vector.messages, vector.at ?? at) : vector.text, measured = measuredText(adapter, text);
    if (measured.count !== vector.count || measured.idsHash !== vector.idsHash || (vector.promptHash && hash(text) !== vector.promptHash)) throw fail("reference_vector_mismatch");
    return { id: "reference-" + (i + 1), text, ...measured };
  });
  const cases = baseline.cases.map(c => {
    let prompt;
    try { prompt = adapter.render(c.messages, at); }
    catch { throw fail("candidate_template_unsupported"); }
    const measured = measuredText(adapter, prompt);
    if (!Number.isSafeInteger(approved.catalogContextTokens) || measured.count + c.maxOutput > approved.catalogContextTokens) throw fail("candidate_context_unsupported");
    return { id: c.id, messages: structuredClone(c.messages), prompt, promptHash: hash(prompt), inputTokens: measured.count,
      inputIdsHash: measured.idsHash, expected: [...c.expected], maxOutput: c.maxOutput };
  });
  return { model: approved.model, package: approved.package, modelHash: manifest.modelHash, tokenizerHash: manifest.tokenizerHash,
    configHash: manifest.configHash, templateHash: manifest.templateHash, manifestSha256: indexed.manifestFileSha256, at, vectors, cases };
}
function serialize(pack) {
  const bytes = Buffer.from(JSON.stringify(pack, null, 2) + "\n");
  if (bytes.length > MAX_PACK) throw fail("provider_check_pack_too_large");
  return bytes;
}
function generate({ directories, backendCommit } = {}) {
  const inputs = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, read(path.join(ROOT, file), LIMITS.manifest)]));
  const catalog = json(inputs.catalog), index = json(inputs.index), baseline = validateBaseline(json(inputs.suite));
  if (!directories || typeof directories !== "object" || Array.isArray(directories) || Object.entries(directories).some(([model, dir]) =>
    !catalog.models.some(m => m.model === model) || typeof dir !== "string" || !path.isAbsolute(dir))) throw fail("explicit_approved_artifact_directories_required");
  backendCommit ??= execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(backendCommit)) throw fail("backend_commit_required");
  const pack = { schema: 1, status: "candidate-not-approved", source: { backendCommit, suiteSha256: hash(inputs.suite), catalogSha256: hash(inputs.catalog),
    indexSha256: hash(inputs.index), generatorSha256: hash(read(__filename, LIMITS.manifest)), tokenizerSourceSha256: hash(inputs.tokenizerSource) }, models: [], unavailable: [] };
  for (const approved of [...catalog.models].sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0)) {
    const indexed = index.models.find(m => m.model === approved.model), directory = directories[approved.model];
    if (!indexed?.manifest || !directory) {
      pack.unavailable.push({ model: approved.model, reason: !indexed?.manifest ? "tokenizer-candidate-unavailable" : "tokenizer-artifacts-unavailable" }); continue;
    }
    const file = path.resolve(TOKENIZERS, "candidates", indexed.manifest);
    if (!file.startsWith(TOKENIZERS + path.sep)) throw fail("indexed_manifest_path_required");
    try { pack.models.push(prepareModel({ approved, indexed, manifestBytes: read(file, LIMITS.manifest), directory, baseline })); }
    catch (error) {
      if (!["candidate_template_unsupported", "candidate_context_unsupported"].includes(error.code)) throw error;
      pack.unavailable.push({ model: approved.model, reason: error.code.replaceAll("_", "-") });
    }
  }
  serialize(pack); return pack;
}
function write(file, pack) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw fail("absolute_output_required");
  const bytes = serialize(pack), fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { sha256: hash(bytes), sizeBytes: bytes.length, models: pack.models.length, unavailable: pack.unavailable };
}
if (require.main === module) {
  try {
    const [mappingFile, output] = process.argv.slice(2);
    if (process.argv.length !== 4) throw fail("usage_mapping_json_new_output_json");
    const mapping = json(read(mappingFile, 65536));
    if (!mapping || Object.keys(mapping).sort().join() !== "directories,schema" || mapping.schema !== 1) throw fail("invalid_artifact_mapping");
    console.log(JSON.stringify(write(output, generate({ directories: mapping.directories })), null, 2));
  } catch (error) { console.error(error.code && /^[a-z_]+$/.test(error.code) ? error.code : "provider_check_pack_generation_failed"); process.exitCode = 1; }
}
module.exports = { generate, prepareModel, serialize, write, read, hash, MAX_PACK, MAX_TEXT, AT };
