"use strict";
const fs = require("node:fs"), path = require("node:path"), { fail } = require("./store");
function read(topic, startLine = 1) {
  const files = { workflow: "build-workflow.md", system: "koinos-sdk-1.0.0/system.ts", storage: "koinos-sdk-1.0.0/storage.ts", token: "koinos-sdk-1.0.0/token.ts", "mock-vm": "koinos-sdk-1.0.0/mock-vm.ts" };
  if (!Object.hasOwn(files, topic)) throw fail("Unknown build reference topic.");
  const lines = fs.readFileSync(path.join(__dirname, "../../docs/builder-reference", files[topic]), "utf8").split("\n");
  const start = Math.max(1, Math.floor(Number(startLine) || 1)), end = Math.min(lines.length, start + 149);
  return { topic, sdk: "@koinos/sdk-as 1.0.0", startLine: start, nextLine: end < lines.length ? end + 1 : null, content: lines.slice(start - 1, end).join("\n") };
}
module.exports = { read };
