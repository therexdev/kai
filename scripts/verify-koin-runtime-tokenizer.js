"use strict";
// Read-only local inference-runtime comparison; no chat, payment or admission.
const fs = require("fs"), crypto = require("crypto");
const { read } = require("../lib/koin-network/test-config");
const { loadTokenizer, LIMITS } = require("../lib/koin-network/tokenizer");
const { compareRuntime } = require("../lib/koin-network/runtime-tokenizer-calibration");

async function modelHash(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000000000) throw Error("Bounded regular GGUF model file required");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), digest = crypto.createHash("sha256");
  try {
    const before = fs.fstatSync(fd);
    let bytes = 0;
    for await (const chunk of fs.createReadStream(file, { fd, autoClose: false })) { bytes += chunk.length; if (bytes > 100000000000) throw Error("Model file too large"); digest.update(chunk); }
    const after = fs.fstatSync(fd);
    if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("Model file changed while reading");
    return digest.digest("hex");
  } finally { fs.closeSync(fd); }
}
if (require.main === module) {
  Promise.resolve().then(async () => {
    const [directory, manifestFile, endpoint, modelFile] = process.argv.slice(2);
    if (process.argv.length !== 6) throw Error("Usage: node scripts/verify-koin-runtime-tokenizer.js PACK_DIRECTORY MANIFEST.json http://127.0.0.1:PORT GGUF_FILE");
    const manifest = JSON.parse(read(manifestFile, LIMITS.manifest)), adapter = loadTokenizer(directory, manifest);
    if (await modelHash(modelFile) !== manifest.modelHash) throw Error("Local model hash differs from the pinned catalog package");
    const report = await compareRuntime(adapter, manifest, { endpoint });
    console.log(JSON.stringify({ ...report, localModelFileVerified: true }, null, 2));
  }).catch(e => { console.error(e instanceof SyntaxError ? "Invalid runtime calibration JSON" : e.message); process.exitCode = 1; });
}
module.exports = { modelHash };
