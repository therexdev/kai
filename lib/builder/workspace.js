"use strict";
// Source handling only. Nothing in a workspace is executed by the web server.
const fs = require("fs"), path = require("path");
const { fail } = require("./store");
const MAX_FILES = 512, MAX_BYTES = 8000000, MAX_FILE_BYTES = 1000000;
const isPluginTemplate = template => ["plugin", "plugin-chain"].includes(template);
const isSourceTemplate = template => ["contract", "workspace"].includes(template) || isPluginTemplate(template);
function sourcePath(name, { web = false } = {}) {
  if (typeof name !== "string" || name.length > 160 ||
      !(web ? /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(ts|tsx|jsx|js|cjs|mjs|json|proto|md|yaml|yml|html|css|svg|txt|sql|toml)$/ : /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(ts|js|cjs|json|proto|md|yaml|yml)$/).test(name)) return false;
  return name.split("/").every(part =>
    /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part) && !part.endsWith(".") &&
    !/^(node_modules|build|dist|vendor|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function validateSource(files, options) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw fail("Invalid project files.");
  const names = Object.keys(files), seen = new Set();
  if (!names.length || names.length > MAX_FILES) throw fail("Keep between 1 and 512 source files.");
  let bytes = 0;
  for (const name of names) {
    if (!sourcePath(name, options)) throw fail("Unsupported source path: " + name);
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw fail("File names must be unique regardless of letter case.");
    seen.add(folded);
    if (typeof files[name] !== "string" || files[name].includes("\0")) throw fail("Files must be text.");
    const size = Buffer.byteLength(files[name]);
    if (size > MAX_FILE_BYTES) throw fail("Keep each source file under 1 MB.");
    bytes += size;
  }
  for (const name of seen) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join("/"))) throw fail("A path cannot be both a file and a folder.");
    }
  }
  if (bytes > MAX_BYTES) throw fail("Keep this project under 8 MB.");
  return { ok: true, bytes, checks: ["Source paths", "File count", "Project size"], compiled: false,
    note: "Source checks only. Use Builds & tests for compiler and test results; those results apply to their exact source hash." };
}
function inspectSource(files, options) {
  let result;
  try { result = validateSource(files, options); }
  catch (e) { return { ok: false, compiled: false, diagnostics: [{ severity: "error", path: "", message: e.message }] }; }
  const diagnostics = [];
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith(".json")) {
      try { JSON.parse(content); }
      catch (e) { diagnostics.push({ severity: "error", path: name, message: String(e.message).slice(0, 300) }); }
    }
  }
  diagnostics.push({ severity: "info", path: "", message: result.note });
  return { ...result, ok: !diagnostics.some(d => d.severity === "error"), diagnostics };
}
function contractStarter(title) {
  const root = path.join(__dirname, "../../templates/builder/contract"), files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = path.posix.join(dir === root ? "" : path.relative(root, dir).split(path.sep).join("/"), entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else files[relative] = fs.readFileSync(path.join(root, relative), "utf8");
    }
  };
  walk(root);
  files["README.md"] = "# " + title.replace(/[\r\n]/g, " ") + "\n\n" + files["README.md"];
  validateSource(files);
  return files;
}
const contractReference = `This is a Koinos AssemblyScript contract source workspace, not a managed App v1 frontend.
Read the existing project, preserve its behavior and propose actual source/test changes. You may create, edit or delete text source files with safe relative paths; maximum 512 files / 8 MB, 1 MB per file. No hidden files, secrets, generated build artifacts, dependencies or path traversal.
Changes are proposals: the user must review and apply them before they become the saved source. Say "proposed" rather than claiming changes were applied.
validate_project checks source paths, size and JSON format only. Read read_capabilities for the current runner status. Use run_project for actual compile/test results when configured. Only those results prove execution of that exact source, never a security audit, browser test or blockchain deployment. The fixed runner does not run npm scripts or custom compiler transforms. Explain toolchain changes in README.md.
The starter uses @koinos/sdk-as with AssemblyScript, protobuf, as-pect and MockVM. AssemblyScript is not general TypeScript. The entrypoint calls main() at module startup. An API key or WIF must never be included in source. Support only Kondor and KOIN Vault for eventual wallet flows. Preview and existing managed App v1 publishing do not execute or deploy this custom contract.
For multi-contract applications, declare separate Koinos contract and Node service test targets in kai.project.json. Work in coherent stages and use search_files, read_file and edit_file instead of loading an entire large project. Custom deployment and wallet signing remain separate from compilation and testing.`;
function workspaceStarter(title) {
  const files = Object.fromEntries(Object.entries(contractStarter(title)).map(([name, text]) => ["contracts/counter/" + name, text]));
  files["kai.project.json"] = JSON.stringify({ schema: 1, targets: [require("./build-config").counterTarget("contracts/counter"), { id: "service", type: "node-test", root: "services", tests: ["feed.test.cjs"] }] }, null, 2) + "\n";
  files["services/feed.cjs"] = '"use strict";\n// Pure projection example; no RPC or database is connected yet.\nexports.latest = records => [...records].sort((a, b) => b.sequence - a.sequence).slice(0, 20);\n';
  files["services/feed.test.cjs"] = 'const { test } = require("node:test");\nconst assert = require("node:assert/strict");\nconst { latest } = require("./feed.cjs");\ntest("feed orders records without changing the input", () => {\n  const input = [{ sequence: 1 }, { sequence: 3 }, { sequence: 2 }];\n  assert.deepEqual(latest(input).map(x => x.sequence), [3, 2, 1]);\n  assert.equal(input[0].sequence, 1);\n});\n';
  files["frontend/index.html"] = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Application workspace</title></head><body><main><h1>Application workspace</h1><p>Add your frontend here. Wallet, RPC and hosting integration are separate implementation steps.</p></main></body></html>\n';
  files["README.md"] = "# " + title.replace(/[\r\n]/g, " ") + "\n\nA multi-component Koinos project. contracts/counter is a working starter contract; services contains a pure feed projection and Node tests. frontend is an integration placeholder, not a deployed app.\n\nDeclare targets in kai.project.json. Compile the counter and run its MockVM tests. Run service tests separately. Add profile, posts and relationship contracts, an indexer and frontend integration in reviewed stages. There is no indexer, social network, deployment or real wallet integration implemented by this starter.\n";
  return files;
}
module.exports = { sourcePath, validateSource, inspectSource, contractStarter, workspaceStarter, contractReference, isPluginTemplate, isSourceTemplate, MAX_FILES, MAX_BYTES };
