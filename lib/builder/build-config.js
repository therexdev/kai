"use strict";
// Shared data-only job contract. No project module or package script is loaded.
const crypto = require("node:crypto");
const { sourcePath, validateSource } = require("./workspace");
const { fail, digest } = require("./store");
const PROFILE = "koinos-as-1.0.0-node22-v1";
const safePath = value => sourcePath(value, { web: true });
const safeRoot = value => value === "." || (typeof value === "string" && safePath(value + "/source.ts"));
const join = (root, file) => root === "." ? file : root + "/" + file;
const entrypoint = name => parseInt(crypto.createHash("sha256").update(name).digest("hex").slice(0, 8), 16);
function counterTarget(root = ".", id = "counter") {
  return { id, type: "koinos-as", root, entry: "assembly/index.ts", protobuf: ["assembly/proto/counter.proto"], entries: "assembly/entries.ts",
    methods: { get_count: { argument: "counter.Request", return: "counter.State", read_only: true }, increment: { argument: "counter.Request", return: "counter.State", read_only: false } },
    tests: ["assembly/__tests__/Counter.spec.ts"] };
}
function inferred(files) {
  if (files["assembly/proto/counter.proto"]) return [counterTarget()];
  if (files["contract/assembly/proto/counter.proto"]) return [counterTarget("contract")];
  if (files["contract/assembly/proto/app.proto"]) {
    const abi = JSON.parse(files["contract/abi/app.json"] || "{}");
    return [{ id: "app", type: "koinos-as", root: "contract", entry: "assembly/index.ts", protobuf: ["assembly/proto/app.proto"], entries: "assembly/entries.ts",
      methods: Object.fromEntries(Object.entries(abi.methods || {}).map(([name, method]) => [name, { argument: method.argument, return: method.return, read_only: method.read_only === true, entry_point: method.entry_point }])),
      tests: Object.keys(files).filter(name => name.startsWith("contract/") && name.endsWith(".spec.ts")).map(name => name.slice(9)) }];
  }
  return [];
}
function targets(files) {
  let config;
  try { config = files["kai.project.json"] ? JSON.parse(files["kai.project.json"]) : { schema: 1, targets: inferred(files) }; }
  catch { throw fail("Fix kai.project.json before building."); }
  if (!config || config.schema !== 1 || !Array.isArray(config.targets) || config.targets.length > 24)
    throw fail("kai.project.json needs schema 1 and up to 24 targets.");
  const ids = new Set();
  return config.targets.map(target => {
    if (!target || typeof target !== "object" || !/^[a-z][a-z0-9-]{0,47}$/.test(target.id || "") || ids.has(target.id)) throw fail("Build targets need unique lowercase IDs.");
    ids.add(target.id);
    if (!["koinos-as", "node-test"].includes(target.type) || !safeRoot(target.root)) throw fail("Choose a supported target type and safe root.");
    const list = (value, extension, required = false) => {
      if (!Array.isArray(value) || value.length > 128 || (required && !value.length) || new Set(value).size !== value.length) throw fail("Invalid target source list.");
      return value.map(name => {
        if (!safePath(name) || !extension.test(name) || !Object.hasOwn(files, join(target.root, name))) throw fail("Target source not found: " + String(name).slice(0, 160));
        return name;
      });
    };
    const tests = list(target.tests || [], target.type === "koinos-as" ? /\.spec\.ts$/ : /\.(?:c?js|mjs)$/);
    if (target.type === "node-test") return { id: target.id, type: target.type, root: target.root, tests };
    if (!safePath(target.entry) || !target.entry.endsWith(".ts") || !Object.hasOwn(files, join(target.root, target.entry))) throw fail("Choose an existing AssemblyScript entry file.");
    if (!safePath(target.entries) || !target.entries.endsWith(".ts")) throw fail("Choose a safe generated entrypoint file.");
    const protobuf = list(target.protobuf || [], /\.proto$/, true), methods = {};
    if (!target.methods || typeof target.methods !== "object" || Array.isArray(target.methods) || !Object.keys(target.methods).length || Object.keys(target.methods).length > 128) throw fail("Declare the target's ABI methods.");
    const points = new Set();
    for (const [name, method] of Object.entries(target.methods)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !method || !/^[A-Za-z_][\w.]{0,150}$/.test(method.argument || "") || !/^[A-Za-z_][\w.]{0,150}$/.test(method.return || "") || typeof method.read_only !== "boolean") throw fail("Invalid ABI method: " + name.slice(0, 64));
      const point = method.entry_point ?? entrypoint(name);
      if (!Number.isInteger(point) || point < 0 || point > 0xffffffff || points.has(point)) throw fail("ABI entrypoints must be unique uint32 values.");
      points.add(point); methods[name] = { argument: method.argument, return: method.return, read_only: method.read_only, entry_point: point };
    }
    return { id: target.id, type: target.type, root: target.root, entry: target.entry, entries: target.entries, protobuf, methods, tests };
  });
}
function job(input) {
  if (!input || typeof input !== "object" || !["compile", "test"].includes(input.operation)) throw fail("Choose compile or test.");
  validateSource(input.files, { web: true });
  const target = targets(input.files).find(item => item.id === input.target);
  if (!target) throw fail("Choose an available build target.");
  if (input.operation === "compile" && target.type !== "koinos-as") throw fail("This target supports tests only.");
  if (input.operation === "test" && !target.tests.length) throw fail("Add test files to this target before running tests.");
  return { operation: input.operation, target, files: input.files, sourceHash: digest(input.files), profile: PROFILE };
}
module.exports = { PROFILE, safePath, safeRoot, join, targets, job, counterTarget };
