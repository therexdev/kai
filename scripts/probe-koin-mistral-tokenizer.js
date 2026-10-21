"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Tokenizer } = require("@huggingface/tokenizers");
const { derive } = require("../lib/koin-network/gguf-mistral-tokenizer");

// Synthetic conversion regression, not model calibration. The real native
// token-ID proofs are in the pinned Mistral manifest and GGUF source record.
function fixture() {
  const tokens = Array.from({ length: 32768 }, (_, i) => "unused-token-" + i), scores = tokens.map((_, i) => -i - 100), types = tokens.map(() => 1);
  ["<unk>", "<s>", "</s>", "[INST]", "[/INST]", "a", "b", "▁a", "▁b"].forEach((s, i) => { tokens[i] = s; });
  types[0] = 2; for (let i = 1; i <= 4; i++) types[i] = 3;
  for (let count = 1; count <= 16; count++) { tokens[8 + count] = "▁".repeat(count); scores[8 + count] = -1000000000; }
  return { "tokenizer.ggml.model": "llama", "tokenizer.ggml.pre": "default", "tokenizer.ggml.tokens": tokens,
    "tokenizer.ggml.scores": scores, "tokenizer.ggml.token_type": types, "tokenizer.ggml.unknown_token_id": 0 };
}

test("Mistral fragments receive unconditional space prefixes around parsed controls", () => {
  const tokenizer = new Tokenizer(derive(fixture()), {}), encode = text => tokenizer.encode(text, { add_special_tokens: false }).ids;
  assert.deepEqual(encode(""), []);
  assert.deepEqual(encode("a"), [7]);
  assert.deepEqual(encode(" a"), [9, 7]);
  assert.deepEqual(encode("<s>[INST] a[/INST] b"), [1, 3, 9, 7, 4, 9, 8]);
  assert.deepEqual(encode("a[INST]b"), [7, 3, 8]);
  for (let count = 1; count <= 48; count++) {
    const prefixed = count + 1, expected = Array(Math.floor(prefixed / 16)).fill(24);
    if (prefixed % 16) expected.push(8 + prefixed % 16);
    assert.deepEqual(encode(" ".repeat(count)), expected, "space run " + count);
  }
});

test("Mistral reconstruction rejects unsupported normalizers and tied nonspace scores", () => {
  const f = fixture();
  assert.throws(() => derive({ ...f, "tokenizer.ggml.add_space_prefix": false }), /Unsupported/);
  assert.throws(() => derive({ ...f, "tokenizer.ggml.pre": "unreviewed" }), /Unsupported/);
  const scores = [...f["tokenizer.ggml.scores"]]; scores[5] = scores[6];
  assert.throws(() => derive({ ...f, "tokenizer.ggml.scores": scores }), /tied token scores/);
  const tokens = [...f["tokenizer.ggml.tokens"]]; tokens[25] = tokens[26];
  assert.throws(() => derive({ ...f, "tokenizer.ggml.tokens": tokens }), /Duplicate/);
});
