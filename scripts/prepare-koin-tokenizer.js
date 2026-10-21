"use strict";
// Assemble independently generated reference vectors into a pinned candidate.
// This prepares local artifacts only; it cannot install runtime policy.
const fs = require("fs");
const { read } = require("../lib/koin-network/test-config");
const { loadTokenizer, manifestIdentity, LIMITS } = require("../lib/koin-network/tokenizer");
const { hash } = require("../lib/koin-network/job-protocol");
const catalog = require("../deploy/koin-mainnet/model-rates.proposal.json");

function prepare(directory, source, references) {
  const sourceKeys = "configHash,model,reference,repository,revision,templateHash,tokenizerHash";
  if (!source || ![sourceKeys, "artifactSource," + sourceKeys].includes(Object.keys(source).sort().join()) ||
      typeof source.reference !== "string" || !source.reference.trim() || source.reference.length > 500) throw Error("Exact independently pinned tokenizer source required");
  const model = catalog.models.find(m => m.model === source.model);
  if (!model) throw Error("Model is not in the approved public catalog");
  const manifest = { schema: 1, mode: "shadow", ...structuredClone(source), modelHash: model.modelHash, vectors: structuredClone(references) };
  manifestIdentity(manifest);
  if (!manifest.vectors.some(v => v.messages?.length > 1) || !manifest.vectors.some(v => typeof v.text === "string" && /[^\x00-\x7f]/.test(v.text))) throw Error("Independent multilingual and multi-turn reference vectors required");
  loadTokenizer(directory, manifest);
  return { manifest, report: { schema: 1, model: model.model, modelHash: model.modelHash, manifestHash: hash(JSON.stringify(manifest)),
    vectorsPassed: references.length, candidatePrepared: true, productionApproved: false, runtimeTokenizerVerified: false,
    caveat: "Reference-vector parity verifies tokenizer implementation only. Loaded model, quality, latency and provider qualification remain separate checks." } };
}
if (require.main === module) {
  try {
    const [directory, sourceFile, referencesFile, output] = process.argv.slice(2);
    if (process.argv.length !== 6) throw Error("Usage: node scripts/prepare-koin-tokenizer.js DIRECTORY SOURCE.json REFERENCES.json OUTPUT.json");
    const result = prepare(directory, JSON.parse(read(sourceFile, LIMITS.manifest)), JSON.parse(read(referencesFile, LIMITS.manifest)));
    const fd = fs.openSync(output, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(result.manifest, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    console.log(JSON.stringify(result.report, null, 2));
  } catch (e) { console.error(e instanceof SyntaxError ? "Invalid tokenizer preparation JSON" : e.message); process.exitCode = 1; }
}
module.exports = { prepare };
