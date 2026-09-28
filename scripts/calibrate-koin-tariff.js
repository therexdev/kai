"use strict";
const fs = require("fs");
const { loadTokenizer } = require("../lib/koin-network/tokenizer");
const { calibrate } = require("../lib/koin-network/calibration");
const manifest = require("../lib/koin-network/tokenizers/qwen25-1.5b.json");

try {
  const [directory, evidenceFile] = process.argv.slice(2);
  if (!directory || !evidenceFile || process.argv.length !== 4) throw Error("Usage: node scripts/calibrate-koin-tariff.js TOKENIZER_DIRECTORY EVIDENCE.json");
  const stat = fs.statSync(evidenceFile);
  if (!stat.isFile() || stat.size > 16000000) throw Error("Evidence must be a JSON file under 16 MB");
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  const report = calibrate(evidence, loadTokenizer(directory, manifest));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  // JSON parser messages can contain private excerpts; never echo them.
  process.stderr.write(error instanceof SyntaxError ? "Invalid evidence JSON\n" : error.message + "\n");
  process.exitCode = 1;
}
