"use strict";
// Mistral 7B v0.3's GGUF uses native SentencePiece-style score BPE.
// Each text fragment after a parsed control token receives an unconditional
// space prefix. HF Metaspace's conditional prefix does not preserve this.
function derive(fields) {
  const tokens = fields["tokenizer.ggml.tokens"], scores = fields["tokenizer.ggml.scores"], types = fields["tokenizer.ggml.token_type"];
  if (fields["tokenizer.ggml.model"] !== "llama" || fields["tokenizer.ggml.pre"] !== "default" || ![undefined, true].includes(fields["tokenizer.ggml.add_space_prefix"]) ||
      !Array.isArray(tokens) || tokens.length !== 32768 || !Array.isArray(scores) || scores.length !== tokens.length || !Array.isArray(types) || types.length !== tokens.length ||
      tokens.some(t => typeof t !== "string" || !t.length || Array.from(t).length > 128) || scores.some(x => !Number.isFinite(x)) || types.some(t => ![1, 2, 3, 6].includes(t))) throw Error("Unsupported Mistral SentencePiece metadata");
  const indexes = new Map(tokens.map((t, i) => [t, i])), byScore = new Map();
  if (indexes.size !== tokens.length) throw Error("Duplicate Mistral token");
  for (let i = 0; i < tokens.length; i++) if (types[i] === 1) {
    const same = byScore.get(scores[i]) || []; same.push(tokens[i]); byScore.set(scores[i], same);
  }
  // The sole tied score in this pinned vocabulary is the set of one to
  // sixteen spaces. Longest-first merge priority reproduces native leftmost
  // growth of those runs; all other normal token scores must remain unique.
  for (const [score, same] of byScore) if (same.length > 1 && (score !== -1000000000 || same.some(t => !/^▁{1,16}$/.test(t)))) throw Error("Unsupported Mistral tied token scores");
  const all = [];
  for (let index = 0; index < tokens.length; index++) {
    if (types[index] !== 1) continue;
    const chars = Array.from(tokens[index]), local = [];
    for (let cut = 1; cut < chars.length; cut++) {
      const left = chars.slice(0, cut).join(""), right = chars.slice(cut).join(""), li = indexes.get(left), ri = indexes.get(right);
      if (li !== undefined && ri !== undefined && types[li] === 1 && types[ri] === 1)
        local.push({ left, right, score: scores[index], leftScore: scores[li], rightScore: scores[ri], length: chars.length, cut });
    }
    local.sort((a, b) => b.leftScore - a.leftScore || b.rightScore - a.rightScore || a.cut - b.cut);
    all.push(...local);
    if (all.length > 2000000) throw Error("Mistral merge bound exceeded");
  }
  all.sort((a, b) => b.score - a.score || b.length - a.length);
  const unknown = fields["tokenizer.ggml.unknown_token_id"];
  if (!Number.isSafeInteger(unknown) || types[unknown] !== 2) throw Error("Mistral unknown token required");
  return { version: "1.0", truncation: null, padding: null,
    added_tokens: tokens.flatMap((t, i) => types[i] === 2 || types[i] === 3 ? [{ id: i, content: t, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }] : []),
    normalizer: { type: "Sequence", normalizers: [{ type: "Prepend", prepend: " " }, { type: "Replace", pattern: { String: " " }, content: "▁" }] },
    pre_tokenizer: null, post_processor: null,
    decoder: { type: "Sequence", decoders: [{ type: "Replace", pattern: { String: "▁" }, content: " " }, { type: "ByteFallback" }, { type: "Fuse" }] },
    model: { type: "BPE", dropout: null, unk_token: tokens[unknown], continuing_subword_prefix: null, end_of_word_suffix: null,
      fuse_unk: true, byte_fallback: true, ignore_merges: false, vocab: Object.fromEntries(tokens.map((t, i) => [t, i])), merges: all.map(m => [m.left, m.right]) } };
}
module.exports = { derive };
