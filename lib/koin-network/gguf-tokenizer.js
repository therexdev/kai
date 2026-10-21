"use strict";
// Explicit, bounded reconstruction from public pinned GGUF metadata. This
// never loads weights or executable model/repository code.
const { hash, digest, integer } = require("./job-protocol");
const MAX_PREFIX = 16000000;
const CONVERTERS = new Set(["llama3-bpe-v1", "gemma3-spm-bpe-v1", "qwen2-bpe-v1", "mistral-spm-bpe-v1"]);

function sourceIdentity(source) {
  const keys = "converter,filename,kind,modelSize,prefixBytes,prefixHash";
  if (!source || ![keys, "configSource," + keys].includes(Object.keys(source).sort().join()) ||
      source.kind !== "gguf-metadata-v1" || !CONVERTERS.has(source.converter) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.gguf$/.test(source.filename || "")) throw Error("Invalid derived tokenizer source");
  if (source.converter === "mistral-spm-bpe-v1") {
    const config = source.configSource;
    if (!config || Object.keys(config).sort().join() !== "repository,revision,sha256" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.repository || "") ||
        !/^[a-f0-9]{40}$/.test(config.revision || "")) throw Error("Pinned original Mistral chat configuration required");
    digest(config.sha256);
  } else if (source.configSource !== undefined) throw Error("Unexpected external tokenizer configuration");
  integer(source.prefixBytes, 24, MAX_PREFIX); integer(source.modelSize, source.prefixBytes, 34359738368);
  digest(source.prefixHash);
  return source;
}

function readMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PREFIX) throw Error("Invalid bounded GGUF prefix");
  let at = 0;
  function take(n) { if (!Number.isSafeInteger(n) || n < 0 || at + n > bytes.length) throw Error("Truncated GGUF metadata"); const start = at; at += n; return start; }
  function number(type) {
    switch (type) {
      case 0: return bytes.readUInt8(take(1));
      case 1: return bytes.readInt8(take(1));
      case 2: return bytes.readUInt16LE(take(2));
      case 3: return bytes.readInt16LE(take(2));
      case 4: return bytes.readUInt32LE(take(4));
      case 5: return bytes.readInt32LE(take(4));
      case 6: { const v = bytes.readFloatLE(take(4)); if (!Number.isFinite(v)) throw Error("Invalid GGUF number"); return v; }
      case 7: { const v = number(0); if (v > 1) throw Error("Invalid GGUF boolean"); return Boolean(v); }
      case 10: case 11: { const v = type === 10 ? bytes.readBigUInt64LE(take(8)) : bytes.readBigInt64LE(take(8)); if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw Error("Unsafe GGUF integer"); return Number(v); }
      case 12: { const v = bytes.readDoubleLE(take(8)); if (!Number.isFinite(v)) throw Error("Invalid GGUF number"); return v; }
      default: throw Error("Unsupported GGUF metadata type");
    }
  }
  function string(limit = 2000000) { const n = number(10); integer(n, 0, limit); const start = take(n), part = bytes.subarray(start, start + n); return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(part); }
  function value(type) {
    if (type === 8) return string();
    if (type !== 9) return number(type);
    const element = number(4), n = number(10); integer(n, 0, 1000000);
    if (element === 9) throw Error("Nested GGUF metadata array");
    return Array.from({ length: n }, () => element === 8 ? string() : number(element));
  }
  if (bytes.subarray(take(4), 4).toString("ascii") !== "GGUF" || number(4) !== 3) throw Error("GGUF version 3 required");
  integer(number(10), 0, 100000); const count = number(10); integer(count, 1, 4096);
  const fields = Object.create(null), seen = new Set();
  for (let i = 0; i < count; i++) {
    const key = string(1024); if (seen.has(key)) throw Error("Duplicate GGUF metadata key"); seen.add(key);
    const item = value(number(4)); if (key.startsWith("tokenizer.")) fields[key] = item;
  }
  return { fields, metadataBytes: at };
}

function vocabulary(fields, maximum = 400000) {
  const tokens = fields["tokenizer.ggml.tokens"], types = fields["tokenizer.ggml.token_type"];
  if (!Array.isArray(tokens) || tokens.length < 4 || tokens.length > maximum || !Array.isArray(types) || types.length !== tokens.length ||
      tokens.some(s => typeof s !== "string" || !s || Buffer.byteLength(s) > 65536) || new Set(tokens).size !== tokens.length ||
      types.some(t => !Number.isInteger(t) || t < 1 || t > 6)) throw Error("Invalid GGUF vocabulary");
  const vocab = Object.create(null); tokens.forEach((s, i) => { vocab[s] = i; });
  return { tokens, types, vocab };
}

function deriveLlama(fields) {
  if (fields["tokenizer.ggml.model"] !== "gpt2" || fields["tokenizer.ggml.pre"] !== "llama-bpe") throw Error("Llama 3 BPE metadata required");
  const { tokens, types, vocab } = vocabulary(fields), sourceMerges = fields["tokenizer.ggml.merges"];
  if (!Array.isArray(sourceMerges) || sourceMerges.length > 600000 || types.some(t => t !== 1 && t !== 3)) throw Error("Invalid Llama 3 BPE merges/types");
  const merges = sourceMerges.map(s => {
    if (typeof s !== "string") throw Error("Invalid Llama 3 BPE merge");
    const split = s.indexOf(" ", 1), a = s.slice(0, split), b = s.slice(split + 1);
    if (split < 1 || !Object.hasOwn(vocab, a) || !Object.hasOwn(vocab, b) || !Object.hasOwn(vocab, a + b)) throw Error("Invalid Llama 3 BPE merge");
    return [a, b];
  });
  // Exact llama-bpe pre-tokenizer used by native llama.cpp, not generic GPT-2.
  const pattern = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
  return { version: "1.0", truncation: null, padding: null,
    added_tokens: tokens.flatMap((s, i) => types[i] === 3 ? [{ id: i, content: s, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }] : []),
    normalizer: null, pre_tokenizer: { type: "Sequence", pretokenizers: [
      { type: "Split", pattern: { Regex: pattern }, behavior: "Isolated", invert: false },
      { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: false }] },
    post_processor: null, decoder: { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: false },
    model: { type: "BPE", dropout: null, unk_token: null, continuing_subword_prefix: null, end_of_word_suffix: null,
      fuse_unk: false, byte_fallback: false, ignore_merges: true, vocab, merges } };
}

function deriveGemma(fields) {
  const tokens = fields["tokenizer.ggml.tokens"], scores = fields["tokenizer.ggml.scores"], types = fields["tokenizer.ggml.token_type"];
  if (fields["tokenizer.ggml.model"] !== "llama" || fields["tokenizer.ggml.pre"] !== "default" ||
      fields["tokenizer.ggml.add_space_prefix"] !== false) throw Error("Unsupported Gemma tokenizer metadata");
  if (!Array.isArray(tokens) || tokens.length !== 262144 || !Array.isArray(scores) || scores.length !== tokens.length ||
      !Array.isArray(types) || types.length !== tokens.length || tokens.some(t => typeof t !== "string" || !t.length || Array.from(t).length > 128) ||
      scores.some(x => !Number.isFinite(x)) || types.some(t => ![1, 3, 4, 6].includes(t))) throw Error("Invalid Gemma vocabulary metadata");
  const normalScores = scores.filter((_, i) => types[i] === 1);
  if (new Set(normalScores).size !== normalScores.length) throw Error("Gemma normal token scores must be unique");
  const indexes = new Map(tokens.map((t, i) => [t, i]));
  if (indexes.size !== tokens.length) throw Error("Duplicate Gemma token");
  const all = [];
  for (let index = 0; index < tokens.length; index++) {
    if (types[index] !== 1) continue;
    const chars = Array.from(tokens[index]), local = [];
    for (let cut = 1; cut < chars.length; cut++) {
      const left = chars.slice(0, cut).join(""), right = chars.slice(cut).join(""), li = indexes.get(left), ri = indexes.get(right);
      if (li !== undefined && ri !== undefined && types[li] === 1 && types[ri] === 1)
        local.push({ left, right, score: scores[index], leftScore: scores[li], rightScore: scores[ri], index, cut });
    }
    local.sort((a, b) => b.leftScore - a.leftScore || b.rightScore - a.rightScore || a.cut - b.cut);
    all.push(...local);
    if (all.length > 2000000) throw Error("Gemma merge bound exceeded");
  }
  // Scores are unique for normal composite tokens. Stable ordering of their
  // valid splits mirrors the independent Python BPE reconstruction.
  all.sort((a, b) => b.score - a.score);
  const vocab = Object.fromEntries(tokens.map((t, i) => [t, i])), merges = all.map(m => [m.left, m.right]);
  const id = name => { const i = fields["tokenizer.ggml." + name + "_token_id"]; integer(i, 0, tokens.length - 1); return i; };
  const added_tokens = [];
  for (let i = 0; i < tokens.length; i++) if (types[i] === 3 || types[i] === 4)
    added_tokens.push({ id: i, content: tokens[i], single_word: false, lstrip: false, rstrip: false, normalized: false, special: types[i] === 3 });
  const tokenizer = { version: "1.0", truncation: null, padding: null, added_tokens,
    normalizer: { type: "Replace", pattern: { String: " " }, content: "▁" }, pre_tokenizer: null, post_processor: null,
    decoder: { type: "Sequence", decoders: [{ type: "Replace", pattern: { String: "▁" }, content: " " }, { type: "ByteFallback" }, { type: "Fuse" }] },
    model: { type: "BPE", dropout: null, unk_token: tokens[id("unknown")], continuing_subword_prefix: null, end_of_word_suffix: null,
      fuse_unk: true, byte_fallback: true, ignore_merges: false, vocab, merges } };
  if (typeof fields["tokenizer.chat_template"] !== "string" || !fields["tokenizer.chat_template"].length) throw Error("Missing original chat template");
  const config = { tokenizer_class: "GemmaTokenizer", bos_token: tokens[id("bos")], eos_token: tokens[id("eos")],
    unk_token: tokens[id("unknown")], pad_token: tokens[id("padding")], add_bos_token: fields["tokenizer.ggml.add_bos_token"],
    add_eos_token: fields["tokenizer.ggml.add_eos_token"], chat_template: fields["tokenizer.chat_template"], clean_up_tokenization_spaces: false };
  return { tokenizer, config };
}

function deriveQwen(fields) {
  if (fields["tokenizer.ggml.model"] !== "gpt2" || !["qwen2", "deepseek-r1-qwen"].includes(fields["tokenizer.ggml.pre"]))
    throw Error("Qwen 2 BPE metadata required");
  const { tokens, types, vocab } = vocabulary(fields), sourceMerges = fields["tokenizer.ggml.merges"];
  if (!Array.isArray(sourceMerges) || sourceMerges.length > 600000 || types.some(t => ![1, 3, 4, 5].includes(t)))
    throw Error("Invalid Qwen 2 BPE merges/types");
  const merges = sourceMerges.map(s => {
    if (typeof s !== "string") throw Error("Invalid Qwen 2 BPE merge");
    const split = s.indexOf(" ", 1), a = s.slice(0, split), b = s.slice(split + 1);
    if (split < 1 || !Object.hasOwn(vocab, a) || !Object.hasOwn(vocab, b) || !Object.hasOwn(vocab, a + b))
      throw Error("Invalid Qwen 2 BPE merge");
    return [a, b];
  });
  // Native llama.cpp qwen2 preserves the supplied UTF-8 bytes. The upstream
  // Transformers artifact applies NFC, which changes decomposed accents and
  // therefore cannot be used to meter the GGUF runtime. Derive from its own
  // vocabulary, merges and special-token types with no Unicode normalization.
  const pattern = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
  return { version: "1.0", truncation: null, padding: null,
    // b10423 also promotes the literal </s> vocabulary entry to control/EOG
    // even though Qwen GGUF labels it normal. Preserve that native parse_special
    // behavior instead of merely copying the serialized token-type table.
    added_tokens: tokens.flatMap((s, i) => types[i] === 3 || types[i] === 4 || s === "</s>" ? [{ id: i, content: s, single_word: false,
      lstrip: false, rstrip: false, normalized: false, special: types[i] === 3 || s === "</s>" }] : []),
    normalizer: null, pre_tokenizer: { type: "Sequence", pretokenizers: [
      { type: "Split", pattern: { Regex: pattern }, behavior: "Isolated", invert: false },
      { type: "ByteLevel", add_prefix_space: false, trim_offsets: false, use_regex: false }] },
    post_processor: null, decoder: { type: "ByteLevel", add_prefix_space: false, trim_offsets: false, use_regex: false },
    model: { type: "BPE", dropout: null, unk_token: null, continuing_subword_prefix: null, end_of_word_suffix: null,
      fuse_unk: false, byte_fallback: false, ignore_merges: false, vocab, merges } };
}

function derive(bytes, source) {
  sourceIdentity(source);
  if (bytes.length !== source.prefixBytes || hash(bytes) !== source.prefixHash) throw Error("GGUF prefix hash/length mismatch");
  const { fields } = readMetadata(bytes), { tokens } = vocabulary(fields);
  if (source.converter === "mistral-spm-bpe-v1") {
    const tokenizer = require("./gguf-mistral-tokenizer").derive(fields);
    // The tokenizer comes from the exact GGUF. The separately pinned original
    // chat configuration retains its explicit system-role support; inference
    // receives the same rendered prompt that the meter counts.
    return { "tokenizer.json": Buffer.from(JSON.stringify(tokenizer)) };
  }
  const gemma = source.converter === "gemma3-spm-bpe-v1" ? deriveGemma(fields) : null;
  const tokenizer = gemma ? gemma.tokenizer : source.converter === "qwen2-bpe-v1" ? deriveQwen(fields) : deriveLlama(fields);
  function special(key) { const id = fields["tokenizer.ggml." + key + "_token_id"]; integer(id, 0, tokens.length - 1); return tokens[id]; }
  const config = gemma ? gemma.config : { bos_token: special("bos"), eos_token: special("eos"), chat_template: fields["tokenizer.chat_template"] };
  if (typeof config.chat_template !== "string" || !config.chat_template || Buffer.byteLength(config.chat_template) > 1000000) throw Error("Original GGUF chat template required");
  return { "tokenizer.json": Buffer.from(JSON.stringify(tokenizer)), "tokenizer_config.json": Buffer.from(JSON.stringify(config)) };
}
module.exports = { sourceIdentity, readMetadata, derive, MAX_PREFIX };
