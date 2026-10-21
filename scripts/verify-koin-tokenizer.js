"use strict";
// Explicit operator/CI download, never called by the scheduler or app startup.
const fs = require("fs"), path = require("path"), os = require("os");
const defaultManifest = require("../lib/koin-network/tokenizers/qwen25-1.5b.json");
const { read } = require("../lib/koin-network/test-config");
const { LIMITS } = require("../lib/koin-network/tokenizer");
const install = (directory, manifest = defaultManifest, options) => require("../lib/koin-network/tokenizer-pack").install(directory, manifest, options);
if (require.main === module) {
  Promise.resolve().then(async () => {
    if (process.argv.length > 4) throw Error("Usage: node scripts/verify-koin-tokenizer.js [DIRECTORY [MANIFEST.json]]");
    const directory = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "kai-tokenizer-"));
    const manifest = process.argv[3] ? JSON.parse(read(process.argv[3], LIMITS.manifest)) : defaultManifest;
    await install(directory, manifest);
    console.log(JSON.stringify({ model: manifest.model, revision: manifest.revision,
      vectorsPassed: manifest.vectors.length, productionApproved: false, runtimeTokenizerVerified: false, directory }));
  }).catch((e) => { console.error(e instanceof SyntaxError ? "Invalid tokenizer JSON" : e.message); process.exitCode = 1; });
}
module.exports = { install };
