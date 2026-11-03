"use strict";
// Runs ONLY inside the disposable gVisor container. The host never imports this.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), crypto = require("node:crypto");
const pb = require("protobufjs"), descriptor = require("protobufjs/ext/descriptor");
const google = require("google-protobuf/google/protobuf/descriptor_pb"), plugin = require("google-protobuf/google/protobuf/compiler/plugin_pb");
const TOOLCHAIN = "/opt/toolchain", ROOT = "/workspace/project";
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
let logs = "";
function command(bin, args, input) {
  const result = cp.spawnSync(bin, args, { cwd: process.cwd(), input, encoding: input ? undefined : "utf8", timeout: 100000, maxBuffer: 512000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_PATH: TOOLCHAIN + "/node_modules", LANG: "C.UTF-8", NO_COLOR: "1" } });
  logs = (logs + (input ? "" : String(result.stdout || "")) + String(result.stderr || "")).slice(-48000);
  if (result.error || result.status !== 0) throw Error(result.error?.message || "Process exited with status " + result.status);
  return result.stdout;
}
function put(name, content) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(name) || name.split("/").some(s => !s || s === "." || s === ".." || s.toLowerCase() === "node_modules")) throw Error("Invalid generated source path");
  fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, content);
}
function generate(target) {
  command("protoc", ["--proto_path=.", "--proto_path=/usr/include", "--include_imports", "--descriptor_set_out=/tmp/kai.pb", ...target.protobuf]);
  const bytes = fs.readFileSync("/tmp/kai.pb"), set = google.FileDescriptorSet.deserializeBinary(bytes), request = new plugin.CodeGeneratorRequest();
  request.setProtoFileList(set.getFileList()); request.setFileToGenerateList(target.protobuf);
  const generated = command(process.execPath, [require.resolve("@koinos/as-proto-gen/lib/index")], Buffer.from(request.serializeBinary()));
  const response = plugin.CodeGeneratorResponse.deserializeBinary(generated);
  if (response.getError()) throw Error(response.getError());
  for (const file of response.getFileList()) {
    if (!file.getName().endsWith(".ts")) throw Error("Unexpected protobuf output");
    put(file.getName(), file.getContent());
  }
  put(target.entries, Object.entries(target.methods).map(([name, method]) => `export const ${name}: u32 = ${method.entry_point};`).join("\n") + "\n");
  const root = pb.Root.fromDescriptor(descriptor.FileDescriptorSet.decode(bytes), "proto3").resolveAll();
  for (const method of Object.values(target.methods)) { root.lookupType(method.argument); root.lookupType(method.return); }
  return { methods: target.methods, koilib_types: root.toJSON(), types: bytes.toString("base64") };
}
async function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 17000000) throw Error("Job input too large"); }
  const job = JSON.parse(input), target = job.target;
  fs.mkdirSync(ROOT, { recursive: true }); process.chdir(ROOT);
  for (const [name, content] of Object.entries(job.files)) {
    // as-pect discovers per-test JS imports by convention. Never copy those or
    // arbitrary package/config modules into the AssemblyScript compilation tree.
    if (target.type === "koinos-as" && !/\.(?:ts|proto)$/.test(name)) continue;
    put(name, content);
  }
  const cwd = target.root === "." ? ROOT : path.join(ROOT, target.root);
  fs.mkdirSync(cwd, { recursive: true }); process.chdir(cwd);
  fs.symlinkSync(TOOLCHAIN + "/node_modules", "node_modules", "dir");
  const artifacts = [];
  try {
    if (target.type === "node-test") {
      command(process.execPath, ["--test", "--test-reporter=tap", ...target.tests]);
    } else {
      const abi = generate(target);
      if (job.operation === "compile") {
        command(process.execPath, [TOOLCHAIN + "/node_modules/assemblyscript/bin/asc", target.entry, "--config", TOOLCHAIN + "/asconfig.json", "--binaryFile", "/tmp/contract.wasm", "--optimizeLevel", "3", "--shrinkLevel", "0"]);
        const wasm = fs.readFileSync("/tmp/contract.wasm"), abiBytes = Buffer.from(JSON.stringify(abi, null, 2));
        if (wasm.length > 2000000 || !wasm.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) throw Error("Invalid WASM artifact");
        for (const [name, bytes] of [["contract.wasm", wasm], ["contract.abi.json", abiBytes]]) artifacts.push({ name, sha256: hash(bytes), bytes: bytes.length, base64: bytes.toString("base64") });
        logs += "\nCompiled contract.wasm and contract.abi.json. No deployment was performed.\n";
      } else {
        fs.writeFileSync("/tmp/kai-test-list.json", JSON.stringify(target.tests));
        command(process.execPath, [require.resolve("@as-pect/cli/bin/asp"), "--config", TOOLCHAIN + "/pect.cjs", "--nologo"]);
      }
    }
    return { ok: true, logs, artifacts };
  } catch (error) { return { ok: false, logs: (logs + "\n" + error.message).slice(-48000), artifacts: [] }; }
}
main().then(result => process.stdout.write(JSON.stringify(result))).catch(error => { process.stdout.write(JSON.stringify({ ok: false, logs: String(error.message).slice(0, 1000), artifacts: [] })); process.exitCode = 1; });
