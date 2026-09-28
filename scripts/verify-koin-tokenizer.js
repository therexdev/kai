"use strict";
// Explicit operator/CI download, never called by the scheduler or app startup.
const fs = require("fs"), path = require("path"), os = require("os");
const { hash } = require("../lib/koin-network/job-protocol");
const { loadTokenizer } = require("../lib/koin-network/tokenizer");
const manifest = require("../lib/koin-network/tokenizers/qwen25-1.5b.json");
async function install(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, expected, limit] of [["tokenizer.json", manifest.tokenizerHash, 16000000], ["tokenizer_config.json", manifest.configHash, 131072]]) {
    const file = path.join(directory, name);
    if (fs.existsSync(file) && hash(fs.readFileSync(file)) === expected) continue;
    const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${name}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw Error(`Tokenizer download HTTP ${r.status}`);
    let size = 0; const chunks = [];
    for await (const chunk of r.body) { size += chunk.length; if (size > limit) throw Error("Tokenizer download too large"); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== expected) throw Error("Downloaded tokenizer hash mismatch");
    fs.writeFileSync(file + ".tmp", bytes); fs.renameSync(file + ".tmp", file);
  }
  return loadTokenizer(directory, manifest);
}
if (require.main === module) {
  const directory = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "kai-tokenizer-"));
  install(directory).then((adapter) => {
    console.log(JSON.stringify({ model: manifest.model, revision: manifest.revision,
      vectorsPassed: manifest.vectors.length, promptTokens: adapter.input([{ role: "user", content: "What is 2 + 2?" }]), directory }));
  }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { install };
