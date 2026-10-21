"use strict";
const fs = require("fs");
const { loadTokenizer } = require("../lib/koin-network/tokenizer");
const { calibrate } = require("../lib/koin-network/calibration");
const { read } = require("../lib/koin-network/test-config");
const { LIMITS } = require("../lib/koin-network/tokenizer");

try {
  const [directory, evidenceFile, manifestFile] = process.argv.slice(2);
  if (!directory || !evidenceFile || ![4, 5].includes(process.argv.length)) throw Error("Usage: node scripts/calibrate-koin-tariff.js TOKENIZER_DIRECTORY EVIDENCE.json [MANIFEST.json]");
  const manifest = manifestFile ? JSON.parse(read(manifestFile, LIMITS.manifest)) : require("../lib/koin-network/tokenizers/qwen25-1.5b.json");
  const stat = fs.statSync(evidenceFile);
  if (!stat.isFile() || stat.size > 16000000) throw Error("Evidence must be a JSON file under 16 MB");
  const evidence = JSON.parse(read(evidenceFile, 16000000));
  const report = calibrate(evidence, loadTokenizer(directory, manifest));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  // JSON parser messages can contain private excerpts; never echo them.
  process.stderr.write(error instanceof SyntaxError ? "Invalid evidence JSON\n" : error.message + "\n");
  process.exitCode = 1;
}
