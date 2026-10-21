"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const G = require("./prepare-provider-check-pack"), baseline = require("../deploy/koin-mainnet/qualification/fast-candidate-v1.json");
const catalog = require("../deploy/koin-mainnet/model-rates.proposal.json");
function fixture(t, template = "{% for message in messages %}{{ message.content }} {% endfor %}") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-pack-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenizer = { version: "1.0", truncation: null, padding: null, added_tokens: [], normalizer: null,
    pre_tokenizer: { type: "Whitespace" }, post_processor: null, decoder: null,
    model: { type: "WordLevel", vocab: { "[UNK]": 0, hello: 1, world: 2 }, unk_token: "[UNK]" } };
  const config = { chat_template: template, bos_token: "", eos_token: "", unk_token: "[UNK]" };
  const artifacts = { "tokenizer.json": JSON.stringify(tokenizer), "tokenizer_config.json": JSON.stringify(config) };
  for (const [name, value] of Object.entries(artifacts)) fs.writeFileSync(path.join(directory, name), value);
  const approved = catalog.models.find(m => m.model === "koinos-fast"), manifest = { schema: 1, mode: "shadow", model: approved.model, modelHash: approved.modelHash,
    repository: "fixture/tokenizer", revision: "a".repeat(40), tokenizerHash: G.hash(artifacts["tokenizer.json"]), configHash: G.hash(artifacts["tokenizer_config.json"]),
    templateHash: G.hash(template), reference: "Fixture only, not measured model quality", vectors: [
      { text: "hello", count: 1, idsHash: G.hash("[1]") }, { text: "world", count: 1, idsHash: G.hash("[2]") },
      { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }], count: 2, idsHash: G.hash("[1,2]"), promptHash: G.hash("hello world ") }
    ] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), indexed = { model: approved.model, package: approved.package, modelHash: approved.modelHash,
    repository: manifest.repository, revision: manifest.revision, manifestFileSha256: G.hash(manifestBytes) };
  return { directory, approved, indexed, manifestBytes, manifest, baseline };
}
test("candidate pack preparation is deterministic and retains all explicit baseline cases without admission claims", t => {
  const f = fixture(t), first = G.prepareModel(f), second = G.prepareModel(f);
  assert.deepEqual(first, second); assert.equal(first.cases.length, 12); assert.equal(first.vectors.length, 3);
  assert.equal(first.package, f.approved.package); assert.equal(first.modelHash, f.approved.modelHash); assert.equal(first.manifestSha256, G.hash(f.manifestBytes));
  assert.equal(first.at, Date.UTC(2026, 9, 21)); assert.equal(first.minPass, undefined);
  first.cases.forEach((c, i) => {
    assert.deepEqual(c.messages, baseline.cases[i].messages); assert.deepEqual(c.expected, baseline.cases[i].expected); assert.equal(c.id, baseline.cases[i].id);
    assert.equal(c.maxOutput, baseline.cases[i].maxOutput); assert.equal(c.promptHash, G.hash(c.prompt)); assert.ok(c.inputTokens > 0); assert.match(c.inputIdsHash, /^[a-f0-9]{64}$/);
  });
  assert.equal(first.vectors[2].text, "hello world "); assert.equal(first.vectors[2].idsHash, G.hash("[1,2]"));
  assert.equal(JSON.stringify(first).includes(f.directory), false);
});
test("exact manifest/catalog identity and actual artifact bytes are required before emitting model evidence", t => {
  const f = fixture(t);
  for (const field of ["model", "package", "modelHash", "repository", "revision", "manifestFileSha256"]) {
    assert.throws(() => G.prepareModel({ ...f, indexed: { ...f.indexed, [field]: "wrong" } }), /candidate_source_pin_mismatch/);
  }
  const changed = { ...f.manifest, tokenizerHash: "f".repeat(64) }, manifestBytes = Buffer.from(JSON.stringify(changed));
  assert.throws(() => G.prepareModel({ ...f, manifestBytes, indexed: { ...f.indexed, manifestFileSha256: G.hash(manifestBytes) } }), /artifact hash mismatch/);
  fs.writeFileSync(path.join(f.directory, "tokenizer.json"), "{}");
  assert.throws(() => G.prepareModel(f), /artifact hash mismatch/);
});
test("unsupported baseline roles and context limits fail explicitly without rewriting cases", t => {
  const f = fixture(t, "{% for message in messages %}{% if message.role == 'system' %}{{ raise_exception('unsupported role') }}{% endif %}{{ message.content }} {% endfor %}");
  assert.throws(() => G.prepareModel(f), /candidate_template_unsupported/);
  const supported = fixture(t);
  assert.throws(() => G.prepareModel({ ...supported, approved: { ...supported.approved, catalogContextTokens: 1 } }), /candidate_context_unsupported/);
  assert.equal(baseline.cases.at(-1).messages[0].role, "system");
});
test("missing prepared artifacts remain unavailable and private/unknown aliases cannot enter the mapping", () => {
  const pack = G.generate({ directories: {}, backendCommit: "a".repeat(40) });
  assert.equal(pack.status, "candidate-not-approved"); assert.equal(pack.models.length, 0); assert.equal(pack.unavailable.length, catalog.models.length);
  assert.ok(pack.unavailable.every(m => ["tokenizer-candidate-unavailable", "tokenizer-artifacts-unavailable"].includes(m.reason)));
  for (const key of ["suiteSha256", "catalogSha256", "indexSha256", "generatorSha256", "tokenizerSourceSha256"]) assert.match(pack.source[key], /^[a-f0-9]{64}$/);
  assert.throws(() => G.generate({ directories: { "private-api": "/tmp/fixture" } }), /explicit_approved_artifact_directories_required/);
  assert.throws(() => G.generate({ directories: { "koinos-fast": "relative" } }), /explicit_approved_artifact_directories_required/);
  assert.throws(() => G.generate({ directories: {}, backendCommit: "unknown" }), /backend_commit_required/);
});
test("oversized or truncated source/pack input cannot produce a partial or overwritten artifact", t => {
  const f = fixture(t), file = path.join(f.directory, "pack.json"), bytes = Buffer.from("truncated");
  assert.throws(() => G.prepareModel({ ...f, manifestBytes: bytes }), /invalid_input_json/);
  assert.throws(() => G.write(file, { models: [], unavailable: [], excessive: "x".repeat(G.MAX_PACK) }), /provider_check_pack_too_large/);
  assert.equal(fs.existsSync(file), false);
  const pack = G.generate({ directories: {}, backendCommit: "a".repeat(40) }), result = G.write(file, pack);
  assert.equal(result.sha256, G.hash(fs.readFileSync(file))); assert.equal(result.sizeBytes, fs.statSync(file).size);
  assert.throws(() => G.write(file, pack), /EEXIST/); assert.equal(G.hash(fs.readFileSync(file)), result.sha256);
  const link = path.join(f.directory, "link.json"); fs.symlinkSync(file, link);
  assert.throws(() => G.read(link, G.MAX_PACK), /bounded_regular_input_required/);
});
