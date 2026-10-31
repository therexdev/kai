"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { hash } = require("../lib/koin-network/job-protocol");
const G = require("../lib/koin-network/gguf-tokenizer");
const { install } = require("../lib/koin-network/tokenizer-pack");

// Tiny synthetic parser/transport fixture. Native model parity evidence is
// separately pinned in the five candidate manifests; this is not calibration.
function gguf(entries) {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const string = s => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
  const value = (type, v) => type === 8 ? string(v) : type === 4 ? u32(v) : Buffer.concat([u32(v[0]), u64(v[1].length), ...v[1].map(x => value(v[0], x))]);
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length), ...entries.flatMap(([key, type, v]) => [string(key), u32(type), value(type, v)])]);
}
function fixture(t) {
  const template = "{{ bos_token }}{% for message in messages %}{{ message.content }}{% endfor %}";
  const entries = [["tokenizer.ggml.model", 8, "gpt2"], ["tokenizer.ggml.pre", 8, "llama-bpe"],
    ["tokenizer.ggml.tokens", 9, [8, ["a", "b", "ab", "<s>", "</s>", "\uFEFF"]]],
    ["tokenizer.ggml.token_type", 9, [4, [1, 1, 1, 3, 3, 1]]], ["tokenizer.ggml.merges", 9, [8, ["a b"]]],
    ["tokenizer.ggml.bos_token_id", 4, 3], ["tokenizer.ggml.eos_token_id", 4, 4], ["tokenizer.chat_template", 8, template]];
  const bytes = gguf(entries), source = { kind: "gguf-metadata-v1", filename: "fixture.gguf", modelSize: bytes.length + 4096,
    prefixBytes: bytes.length, prefixHash: hash(bytes), converter: "llama3-bpe-v1" }, artifacts = G.derive(bytes, source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-gguf-tokenizer-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = { schema: 1, mode: "shadow", model: "fixture", repository: "fixture/public", revision: "b".repeat(40), modelHash: "c".repeat(64),
    artifactSource: source, tokenizerHash: hash(artifacts["tokenizer.json"]), configHash: hash(artifacts["tokenizer_config.json"]), templateHash: hash(template),
    vectors: [{ text: "a", count: 1, idsHash: hash("[0]") }, { text: "ab", count: 1, idsHash: hash("[2]") },
      { messages: [{ role: "user", content: "ab" }], count: 2, idsHash: hash("[3,2]"), promptHash: hash("<s>ab") }] };
  const response = () => new Response(bytes, { status: 206, headers: { "content-range": `bytes 0-${bytes.length - 1}/${source.modelSize}` } });
  return { bytes, entries, source, artifacts, directory, manifest, response };
}

test("GGUF reconstruction preserves literal BOM vocabulary entries and rejects malformed metadata", t => {
  const f = fixture(t), parsed = G.readMetadata(f.bytes);
  assert.equal(parsed.fields["tokenizer.ggml.tokens"].at(-1), "\uFEFF");
  assert.equal(parsed.metadataBytes, f.bytes.length);
  assert.throws(() => G.readMetadata(f.bytes.subarray(0, f.bytes.length - 1)), /Truncated/);
  assert.throws(() => G.readMetadata(gguf([...f.entries, f.entries[0]])), /Duplicate/);
  const oversized = Buffer.from(f.bytes); oversized.writeBigUInt64LE(4097n, 16);
  assert.throws(() => G.readMetadata(oversized), /integer/);
  assert.throws(() => G.derive(f.bytes, { ...f.source, prefixHash: "0".repeat(64) }), /hash\/length/);
  assert.throws(() => G.derive(f.bytes, { ...f.source, converter: "unreviewed" }), /source/);
  assert.throws(() => G.sourceIdentity({ ...f.source, filename: "../secret.gguf" }), /source/);
});

test("derived pack install requests one exact bounded range and preserves generated hashes", async t => {
  const f = fixture(t), calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return f.response(); };
  const adapter = await install(f.directory, f.manifest, { fetchImpl });
  assert.deepEqual(adapter.encode("ab"), [2]); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://huggingface.co/fixture/public/resolve/${"b".repeat(40)}/fixture.gguf`);
  assert.equal(calls[0].options.headers.Range, `bytes=0-${f.bytes.length - 1}`);
  assert.equal(hash(fs.readFileSync(path.join(f.directory, "tokenizer.json"))), f.manifest.tokenizerHash);
  await install(f.directory, f.manifest, { fetchImpl }); assert.equal(calls.length, 1);
});

test("derived installer rejects full downloads, wrong ranges, corrupt prefixes and altered generated pins", async t => {
  const f = fixture(t);
  await assert.rejects(install(f.directory, f.manifest, { fetchImpl: async () => new Response(f.bytes) }), /bounded range/);
  await assert.rejects(install(f.directory, f.manifest, { fetchImpl: async () => new Response(f.bytes, { status: 206, headers: { "content-range": "bytes 1-2/100" } }) }), /bounded range/);
  const wrong = Buffer.from(f.bytes); wrong[wrong.length - 1] ^= 1;
  await assert.rejects(install(f.directory, f.manifest, { fetchImpl: async () => new Response(wrong, { status: 206, headers: { "content-range": `bytes 0-${wrong.length - 1}/${f.source.modelSize}` } }) }), /hash\/length/);
  await assert.rejects(install(f.directory, { ...f.manifest, tokenizerHash: "0".repeat(64) }, { fetchImpl: async () => f.response() }), /hash mismatch/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

// Deliberately tiny byte vocabulary: regression for the real Qwen failure,
// independent of the full external model download required for native proof.
test("Qwen GGUF encoding preserves decomposed UTF-8 and native b10423 control overrides", () => {
  const mapped = Array.from({ length: 256 }, (_, b) => b >= 33 && b <= 126 || b >= 161 && b <= 172 || b >= 174 ? b : null);
  let next = 256; const tokens = mapped.map(b => String.fromCodePoint(b === null ? next++ : b));
  tokens.push("</s>", "<s>", "</end>", "<tool_call>");
  const template = "{{ bos_token }}{% for message in messages %}{{ message.content }}{% endfor %}";
  const bytes = gguf([["tokenizer.ggml.model", 8, "gpt2"], ["tokenizer.ggml.pre", 8, "qwen2"],
    ["tokenizer.ggml.tokens", 9, [8, tokens]], ["tokenizer.ggml.token_type", 9, [4, [...Array(257).fill(1), 3, 3, 4]]],
    ["tokenizer.ggml.merges", 9, [8, []]], ["tokenizer.ggml.bos_token_id", 4, 257],
    ["tokenizer.ggml.eos_token_id", 4, 258], ["tokenizer.chat_template", 8, template]]);
  const source = { kind: "gguf-metadata-v1", filename: "qwen.gguf", modelSize: bytes.length + 4096,
    prefixBytes: bytes.length, prefixHash: hash(bytes), converter: "qwen2-bpe-v1" };
  const artifacts = G.derive(bytes, source), tokenizer = new (require("@huggingface/tokenizers").Tokenizer)(
    JSON.parse(artifacts["tokenizer.json"]), JSON.parse(artifacts["tokenizer_config.json"]));
  const encode = text => tokenizer.encode(text, { add_special_tokens: false }).ids;
  assert.deepEqual(encode("e\u0301"), [101, 204, 129]);
  assert.deepEqual(encode("é"), [195, 169]);
  assert.deepEqual(encode("a</s>b<tool_call>c"), [97, 256, 98, 259, 99]);
  assert.throws(() => G.derive(bytes, { ...source, configSource: { repository: "fixture/config", revision: "a".repeat(40), sha256: "b".repeat(64) } }), /Unexpected external/);
});

test("external Mistral chat configuration requires exact immutable source identity", () => {
  const source = { kind: "gguf-metadata-v1", filename: "mistral.gguf", modelSize: 4096, prefixBytes: 1024,
    prefixHash: "a".repeat(64), converter: "mistral-spm-bpe-v1",
    configSource: { repository: "mistralai/Mistral-7B-Instruct-v0.3", revision: "b".repeat(40), sha256: "c".repeat(64) } };
  assert.equal(G.sourceIdentity(source), source);
  for (const config of [undefined, { ...source.configSource, repository: "../private/config" },
    { ...source.configSource, revision: "main" }, { ...source.configSource, extra: true }, { ...source.configSource, sha256: "bad" }]) {
    assert.throws(() => G.sourceIdentity({ ...source, configSource: config }));
  }
});

test('Liquid converter commits the upstream non-thinking choice and preserves user-defined tokens', t => {
  const f = fixture(t), entries = structuredClone(f.entries);
  entries.find(e => e[0] === 'tokenizer.ggml.pre')[2] = 'lfm2';
  entries.find(e => e[0] === 'tokenizer.ggml.token_type')[2][1][5] = 4;
  const original = '{{ bos_token }}{% if enable_thinking | default(true) %}<think>{% else %}<think></think>{% endif %}';
  entries.find(e => e[0] === 'tokenizer.chat_template')[2] = original;
  const bytes = gguf(entries), source = {...f.source, prefixBytes:bytes.length, prefixHash:hash(bytes), converter:'lfm2-bpe-no-thinking-v1'};
  const artifacts = G.derive(bytes, source), config = JSON.parse(artifacts['tokenizer_config.json']);
  const template = new (require('@huggingface/jinja').Template)(config.chat_template);
  assert.equal(template.render({bos_token:'<s>'}), '<s><think></think>');
  assert.equal(config.chat_template, '{%- set enable_thinking = false -%}' + original);
  assert.notEqual(hash(config.chat_template), hash(original));
  const tokenizer = JSON.parse(artifacts['tokenizer.json']);
  assert.equal(tokenizer.added_tokens.find(x => x.id === 5).special, false);
  assert.throws(()=>G.derive(bytes,{...source,converter:'llama3-bpe-v1'}),/metadata required/);
  entries.find(e => e[0] === 'tokenizer.chat_template')[2] = '{{bos_token}}';
  const invalid = gguf(entries);
  assert.throws(()=>G.derive(invalid,{...source,prefixBytes:invalid.length,prefixHash:hash(invalid)}),/thinking-switch/);
});
