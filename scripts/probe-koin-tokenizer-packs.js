"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const P = require("../lib/koin-network/job-protocol");
const { loadTokenizer } = require("../lib/koin-network/tokenizer");
const { install } = require("../lib/koin-network/tokenizer-pack");
const { compareRuntime } = require("../lib/koin-network/runtime-tokenizer-calibration");
const { prepare } = require("./prepare-koin-tokenizer");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tokenizer-packs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenizer = { version: "1.0", truncation: null, padding: null, added_tokens: [], normalizer: null,
    pre_tokenizer: { type: "Whitespace" }, post_processor: null, decoder: null,
    model: { type: "WordLevel", vocab: { "[UNK]": 0, hello: 1, world: 2 }, unk_token: "[UNK]" } };
  const config = { chat_template: "{{ bos_token }}{% for message in messages %}{{ message.content }} {% endfor %}", bos_token: { content: "" }, eos_token: "", unk_token: "[UNK]" };
  const artifacts = { "tokenizer.json": Buffer.from(JSON.stringify(tokenizer)), "tokenizer_config.json": Buffer.from(JSON.stringify(config)) };
  const manifest = { schema: 1, mode: "shadow", model: "koinos-fast", modelHash: require("../deploy/koin-mainnet/model-rates.proposal.json").models.find(m => m.model === "koinos-fast").modelHash,
    repository: "fixture/tokenizer", revision: "a".repeat(40), tokenizerHash: P.hash(artifacts["tokenizer.json"]), configHash: P.hash(artifacts["tokenizer_config.json"]),
    templateHash: P.hash(config.chat_template), reference: "Fixture only; not actual model evidence", vectors: [
      { text: "hello", count: 1, idsHash: P.hash("[1]") },
      { text: "héllo", count: 3, idsHash: P.hash("[0,0,0]") },
      { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }], count: 2, idsHash: P.hash("[1,2]"), promptHash: P.hash("hello world ") }
    ] };
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return new Response(artifacts[url.split("/").at(-1)]); };
  return { directory, artifacts, manifest, calls, fetchImpl };
}

test("pinned generic pack installation is idempotent and never overwrites changed files", async t => {
  const f = fixture(t), adapter = await install(f.directory, f.manifest, { fetchImpl: f.fetchImpl });
  assert.equal(adapter.input([{ role: "user", content: "hello" }]), 1);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(url => url.includes("/resolve/" + "a".repeat(40) + "/")));
  await install(f.directory, f.manifest, { fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 2);
  fs.writeFileSync(path.join(f.directory, "tokenizer.json"), "{}");
  await assert.rejects(install(f.directory, f.manifest, { fetchImpl: f.fetchImpl }), /checksum changed/);
  assert.equal(fs.readFileSync(path.join(f.directory, "tokenizer.json"), "utf8"), "{}");
});

test("pack pins reject repository traversal, symlinks and wrong downloaded bytes", async t => {
  const f = fixture(t);
  await assert.rejects(install(f.directory, { ...f.manifest, repository: "../evil/tokenizer" }, { fetchImpl: f.fetchImpl }), /manifest/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(install(f.directory, f.manifest, { fetchImpl: async () => new Response("wrong") }), /hash mismatch/);
  assert.equal(fs.existsSync(path.join(f.directory, "tokenizer.json")), false);
  const elsewhere = path.join(f.directory, "elsewhere"); fs.writeFileSync(elsewhere, f.artifacts["tokenizer.json"]);
  fs.symlinkSync(elsewhere, path.join(f.directory, "tokenizer.json"));
  assert.throws(() => loadTokenizer(f.directory, f.manifest), /artifact/);
  await assert.rejects(install(f.directory, f.manifest, { fetchImpl: f.fetchImpl }), /artifact/);
});

test("runtime calibration compares exact IDs and stays explicitly outside model admission", async t => {
  const f = fixture(t), adapter = await install(f.directory, f.manifest, { fetchImpl: f.fetchImpl });
  const seen = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); seen.push(body);
    assert.equal(url, "http://127.0.0.1:8080/tokenize"); assert.equal(options.redirect, "error");
    assert.equal(body.add_special, false); assert.equal(body.parse_special, true);
    return Response.json({ tokens: adapter.encode(body.content) });
  };
  const report = await compareRuntime(adapter, f.manifest, { endpoint: "http://127.0.0.1:8080", fetchImpl });
  assert.equal(report.runtimeTokenizerVerified, true); assert.equal(report.productionApproved, false); assert.equal(report.serverModelIdentityVerified, false);
  assert.equal(seen.length, 3); assert.ok(!JSON.stringify(report).includes("héllo"));
  await assert.rejects(compareRuntime(adapter, f.manifest, { endpoint: "http://127.0.0.1:8080", fetchImpl: async () => Response.json({ tokens: [2] }) }), /does not match/);
  await assert.rejects(compareRuntime(adapter, f.manifest, { endpoint: "https://public.example", fetchImpl }), /loopback/);
});

test("manifest preparation binds catalog identity and requires independently supplied matching references", async t => {
  const f = fixture(t); await install(f.directory, f.manifest, { fetchImpl: f.fetchImpl });
  const source = Object.fromEntries(["model", "repository", "revision", "tokenizerHash", "configHash", "templateHash", "reference"].map(k => [k, f.manifest[k]]));
  const result = prepare(f.directory, source, f.manifest.vectors);
  assert.equal(result.manifest.modelHash, f.manifest.modelHash);
  assert.equal(result.report.productionApproved, false); assert.equal(result.report.runtimeTokenizerVerified, false);
  assert.throws(() => prepare(f.directory, { ...source, model: "dev-tiny" }, f.manifest.vectors), /public catalog/);
  const changed = structuredClone(f.manifest.vectors); changed[0].idsHash = P.hash("[2]");
  assert.throws(() => prepare(f.directory, source, changed), /calibration mismatch/);
});

for (const [format, firstDay, secondDay] of [["%Y-%m-%d", "2026-10-20", "2026-10-21"], ["%d %b %Y", "20 Oct 2026", "21 Oct 2026"]]) test("dated templates use signed UTC quote time across midnight: " + format, async t => {
  const f = fixture(t), before = Date.UTC(2026, 9, 20, 23, 59, 59, 999), after = before + 1;
  const config = JSON.parse(f.artifacts["tokenizer_config.json"]);
  config.chat_template = "{{ strftime_now('" + format + "') }} {% for message in messages %}{{ message.content }} {% endfor %}";
  f.artifacts["tokenizer_config.json"] = Buffer.from(JSON.stringify(config));
  f.manifest.configHash = P.hash(f.artifacts["tokenizer_config.json"]); f.manifest.templateHash = P.hash(config.chat_template);
  const ids = new (require("@huggingface/tokenizers").Tokenizer)(JSON.parse(f.artifacts["tokenizer.json"]), config).encode(firstDay + " hello world ", { add_special_tokens: false }).ids;
  Object.assign(f.manifest.vectors[2], { at: before, count: ids.length, idsHash: P.hash(JSON.stringify(ids)), promptHash: P.hash(firstDay + " hello world ") });
  const adapter = await install(f.directory, f.manifest, { fetchImpl: f.fetchImpl });
  const tariff = { model: f.manifest.model, modelHash: f.manifest.modelHash, tokenizerHash: f.manifest.tokenizerHash, templateHash: f.manifest.templateHash,
    version: 1, contextTokens: 4096, maxOutputTokens: 64, maxLatencyMs: 1000, inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "4000000" };
  const meter = new (require("../lib/koin-network/metering").Meter)([{ tariff, adapter }]), messages = [{ role: "user", content: "hello" }];
  const first = meter.quote("shadow:fixture", tariff.model, 1, messages, 16, before);
  const second = meter.quote("shadow:fixture", tariff.model, 1, messages, 16, after);
  assert.equal(first.promptHash, P.hash(firstDay + " hello "));
  assert.equal(second.promptHash, P.hash(secondDay + " hello "));
  // Dispatch/recovery must rerender with the saved quote's timestamp, even
  // after another request was quoted on the next UTC date.
  assert.equal(P.hash(meter.entry(tariff.model, 1).render(messages, first.at)), first.promptHash);
  assert.throws(() => adapter.render(messages), /integer/);
  assert.throws(() => adapter.render(messages, NaN), /integer/);
});
