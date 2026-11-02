"use strict";
// Source handling only. Nothing in a workspace is executed by the web server.
const fs = require("fs"), path = require("path");
const { fail } = require("./store");
const MAX_FILES = 64, MAX_BYTES = 300000;
function sourcePath(name) {
  if (typeof name !== "string" || name.length > 160 ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(ts|js|cjs|json|proto|md|yaml|yml)$/.test(name)) return false;
  return name.split("/").every(part =>
    /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part) && !part.endsWith(".") &&
    !/^(node_modules|build|dist|vendor|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function validateSource(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw fail("Invalid project files.");
  const names = Object.keys(files), seen = new Set();
  if (!names.length || names.length > MAX_FILES) throw fail("Keep between 1 and 64 source files.");
  let bytes = 0;
  for (const name of names) {
    if (!sourcePath(name)) throw fail("Unsupported source path: " + name);
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw fail("File names must be unique regardless of letter case.");
    seen.add(folded);
    if (typeof files[name] !== "string" || files[name].includes("\0")) throw fail("Files must be text.");
    bytes += Buffer.byteLength(files[name]);
  }
  for (const name of seen) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join("/"))) throw fail("A path cannot be both a file and a folder.");
    }
  }
  if (bytes > MAX_BYTES) throw fail("Keep this project under 300 KB.");
  return { ok: true, bytes, checks: ["Source paths", "File count", "Project size"], compiled: false,
    note: "Source checks only. The hosted compiler and test runner are not connected. Export the project to build and test locally." };
}
function inspectSource(files) {
  let result;
  try { result = validateSource(files); }
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
Read the existing project, preserve its behavior and propose actual source/test changes. You may create, edit or delete text source files with safe relative paths (.ts, .proto, .json, .js, .cjs, .md, .yaml, .yml); maximum 64 files / 300 KB. No hidden files, secrets, generated build artifacts, dependencies or path traversal.
Changes are proposals: the user must review and apply them before they become the saved source. Say "proposed" rather than claiming changes were applied.
validate_project checks source paths, size and JSON format only. There is no hosted compiler, shell, package manager, test runner or blockchain simulator connected yet. Never claim TypeScript compiled, tests passed, or contracts were deployed. Source may be exported for local builds/tests; explain any toolchain changes in README.md.
The starter uses @koinos/sdk-as with AssemblyScript, protobuf, as-pect and MockVM. AssemblyScript is not general TypeScript. The entrypoint calls main() at module startup. An API key or WIF must never be included in source. Support only Kondor and KOIN Vault for eventual wallet flows. Preview and existing managed App v1 publishing do not execute or deploy this custom contract.
The intended workflow is source review, isolated compile/test, reviewed wallet-signed testnet deployment, then an explicit mainnet launch. Those future steps are unavailable in this source workspace; do not invent working UI for them.`;
module.exports = { sourcePath, validateSource, inspectSource, contractStarter, contractReference, MAX_FILES };
