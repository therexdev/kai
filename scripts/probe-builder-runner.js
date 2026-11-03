"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), express = require("express");
const config = require("../lib/builder/build-config"), { starter, validate } = require("../lib/builder/projects"), { BuildStore, digest } = require("../lib/builder/store"), { Builder } = require("../lib/builder/service"), { BuildAgent } = require("../lib/builder/agent"), { RunnerClient, verifiedResult } = require("../lib/builder/runner"), { createServer } = require("../runner/server.cjs"), { dockerArgs } = require("../runner/sandbox.cjs"), { createBuilderRouter } = require("../lib/builder/router"), { createAccounts } = require("../lib/accounts");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-runner-")), image = "sha256:" + "b".repeat(64);
const report = job => ({ ok: true, sourceHash: job.sourceHash, target: job.target.id, operation: job.operation, profile: config.PROFILE, runtime: "runsc", image, durationMs: 25, logs: "fixture result (not real execution)", artifacts: [] });
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test("multi-target workspaces and large source have explicit bounded manifests", () => {
  const files = starter("workspace", "Social project");
  assert.equal(validate(files, "workspace").ok, true);
  assert.deepEqual(config.targets(files).map(t => t.id), ["counter", "service"]);
  assert.equal(config.job({ files, target: "counter", operation: "compile" }).sourceHash, digest(files));
  const manifest = JSON.parse(files["kai.project.json"]);
  manifest.targets[0].methods.increment.entry_point = manifest.targets[0].methods.get_count.entry_point = 1;
  assert.throws(() => config.targets({ ...files, "kai.project.json": JSON.stringify(manifest) }), /unique/);
  for (const root of ["../etc", "/tmp", "node_modules", "a/../b"]) {
    manifest.targets[0].root = root;
    assert.throws(() => config.targets({ ...files, "kai.project.json": JSON.stringify(manifest) }), /safe root/);
  }
  assert.throws(() => config.job({ files, target: "service", operation: "compile" }), /tests only/);
  assert.throws(() => config.job({ files, target: "missing", operation: "test" }), /available/);
  const many = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`src/a${i}.ts`, "x".repeat(15000)]));
  assert.equal(validate(many, "workspace").ok, true);
  assert.throws(() => validate({ ...many, "extra.ts": "" }, "workspace"), /512/);
  assert.throws(() => validate({ "large.ts": "x".repeat(1000001) }, "workspace"), /1 MB/);
  const large = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`src/a${i}.ts`, "x".repeat(900000)]));
  assert.throws(() => validate(large, "workspace"), /8 MB/);
});

test("source blobs preserve versions, legacy snapshots, rollback and account isolation", () => {
  const dir = temp(), store = new BuildStore(dir);
  try {
    const files = starter("workspace", "Source"), p = store.create("one", "Source", "workspace", files);
    const count = store.db.prepare("SELECT count(*) n FROM source_blobs").get().n;
    store.saveRevision("one", p.id, { ...files, "notes.md": "changed" }, "edit");
    assert.equal(store.db.prepare("SELECT count(*) n FROM source_blobs").get().n, count + 1);
    assert.deepEqual(store.files("one", p.id, 1).files, files);
    assert.throws(() => store.files("two", p.id, 1), /not found/);
    store.db.prepare("UPDATE revisions SET files=? WHERE project_id=? AND revision=1").run(JSON.stringify(files), p.id);
    assert.deepEqual(store.files("one", p.id, 1).files, files);
    assert.throws(() => store.transaction(() => { store.saveRevision("one", p.id, { ...files, "rollback.md": "rollback-unique" }, "edit"); throw Error("rollback"); }), /rollback/);
    assert.equal(store.owned("one", p.id).revision, 2);
    assert.equal(store.db.prepare("SELECT count(*) n FROM source_blobs WHERE content='rollback-unique'").get().n, 0);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the sandbox policy requires an immutable image, gVisor and no host mounts or network", () => {
  assert.throws(() => dockerArgs("node:22", "job"), /immutable/);
  const args = dockerArgs(image, "job");
  for (const required of ["--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000"]) assert.ok(args.includes(required));
  assert.equal(args.some(a => a === "-v" || a.startsWith("--volume") || a.startsWith("--mount") || a.startsWith("--privileged")), false);
  assert.throws(() => new RunnerClient({ url: "http://192.0.2.2", token: "fixture" }).endpoint("/run"), /configuration/);
  assert.throws(() => new RunnerClient({ url: "https://user:pass@example.test", token: "fixture" }).endpoint("/run"), /configuration/);
});

test("worker requires its own token and rejects overlapping or mismatched jobs", async () => {
  const files = starter("workspace", "Build"), token = "fixture-" + "a".repeat(32);
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const server = createServer({ token, image, ready: async () => ({ profile: config.PROFILE, image, runtime: "runsc" }), run: async job => { entered(); await new Promise(resolve => { release = resolve; }); return report(job); } });
  const url = await listen(server), client = new RunnerClient({ url, token });
  try {
    assert.equal((await fetch(url + "/health")).status, 401);
    assert.equal((await client.health()).ready, true);
    const first = client.run({ files, target: "service", operation: "test" }); await started;
    await assert.rejects(() => client.run({ files, target: "service", operation: "test" }), /busy/);
    release(); const result = await first; assert.equal(result.sourceHash, digest(files));
    const job = config.job({ files, target: "service", operation: "test" });
    for (const change of [{ sourceHash: "wrong" }, { runtime: "runc" }, { image: "node:22" }, { target: "counter" }, { operation: "compile" }]) assert.throws(() => verifiedResult({ ...report(job), ...change }, job), /match/);
  } finally { release?.(); await close(server); }
});

test("compiled artifact hashes, ABI and result identity are verified before storage", () => {
  const files = starter("workspace", "Build"), job = config.job({ files, target: "counter", operation: "compile" });
  const artifact = (name, data) => { const bytes = Buffer.from(data); return { name, bytes: bytes.length, base64: bytes.toString("base64"), sha256: crypto.createHash("sha256").update(bytes).digest("hex") }; };
  const artifacts = [artifact("contract.wasm", [0,97,115,109,1,0,0,0]), artifact("contract.abi.json", JSON.stringify({ methods: job.target.methods, koilib_types: {}, types: "AA==" }))];
  const value = { ...report(job), artifacts };
  assert.equal(verifiedResult(value, job).artifacts.length, 2);
  assert.throws(() => verifiedResult({ ...value, artifacts: [{ ...artifacts[0], sha256: "a".repeat(64) }, artifacts[1]] }, job), /checksum/);
  assert.throws(() => verifiedResult({ ...value, artifacts: [artifacts[0], artifacts[0]] }, job), /artifact/);
  assert.throws(() => verifiedResult({ ...value, ok: false }, job), /artifact/);
});

test("real HTTP build jobs enforce account ownership and exact saved revision; results become stale after edits", async () => {
  const dir = temp(), app = express(), server = require("node:http").createServer(app), origin = await listen(server);
  const accounts = createAccounts({ stateDir: dir, siteOrigin: origin }), runner = { configured: true, async run(input) { return report(config.job(input)); }, async health() { return { ready: true }; } };
  const builder = new Builder({ stateDir: dir, autoStart: false, runner });
  app.use(express.json({ limit: "17mb" }), accounts.router, createBuilderRouter({ accounts, stateDir: dir, builder }).router);
  const user = accounts.service._newAccount({ email: "run@example.test" }), other = accounts.service._newAccount({ email: "other-run@example.test" });
  const cookie = accounts.service._issueSession(user.id, "probe"), otherCookie = accounts.service._issueSession(other.id, "probe");
  const files = starter("workspace", "Targets"), p = builder.store.create(user.id, "Targets", "workspace", files), base = "/build/api/projects/" + p.id;
  const post = (route, body, token = cookie) => fetch(origin + route, { method: "POST", headers: { cookie: "kai_session=" + token, origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(base + "/runs", { revision: 1, target: "service", operation: "test" }, otherCookie)).status, 404);
    assert.equal((await post(base + "/runs", { revision: 2, target: "service", operation: "test" })).status, 409);
    assert.equal((await post(base + "/runs", { revision: 1, target: "service", operation: "test" })).status, 200);
    await builder.tick();
    const detail = builder.store.detail(user.id, p.id);
    assert.equal(detail.builds[0].ok, true); assert.equal(detail.builds[0].matchesSource, true);
    assert.equal(detail.project.revision, 1); assert.equal(detail.jobs[0].status, "completed");
    builder.store.saveRevision(user.id, p.id, { ...files, "notes.md": "new" }, "edit");
    assert.equal(builder.store.detail(user.id, p.id).builds[0].matchesSource, false);
    assert.throws(() => builder.store.buildArtifact(other.id, p.id, detail.builds[0].id, "contract.wasm"), /not found/);
    assert.equal((await post(base + "/publish", { revision: 2 })).status, 409);
  } finally { await close(server); builder.close(); accounts.service.store?.close?.(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("AI works in bounded file ranges, sees real diagnostics and proposes a focused tested repair", async () => {
  const files = starter("workspace", "Fix"), runs = []; let step = 0;
  const calls = [
    ["read_capabilities", {}], ["read_project", {}], ["search_files", { query: "latest", path_prefix: "services/" }],
    ["read_file", { path: "services/feed.cjs", start_line: 1, line_count: 3 }],
    ["run_project", { target: "service", operation: "test" }],
    ["edit_file", { path: "services/feed.cjs", old_text: "slice(0, 20)", new_text: "slice(0, 10)" }],
    ["run_project", { target: "service", operation: "test" }], ["run_project", { target: "service", operation: "test" }], ["validate_project", {}],
  ];
  const agent = new BuildAgent({ key: "fixture", fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), previous = body.input.filter(i => i.type === "function_call_output").at(-1);
    if (step === 1) assert.equal(JSON.parse(previous.output).hostedTests, true);
    if (step === 2) { const read = JSON.parse(previous.output); assert.ok(read.filePaths.includes("services/feed.cjs")); assert.equal(read.files["services/feed.cjs"], undefined); }
    if (step === 5) assert.match(previous.output, /expected ten records/);
    if (step === 7) assert.equal(JSON.parse(previous.output).ok, true);
    if (step === 8) assert.match(previous.output, /two build\/test runs/);
    const call = calls[step++];
    return new Response(JSON.stringify({ status: "completed", output: call ? [{ type: "function_call", name: call[0], arguments: JSON.stringify(call[1]), call_id: String(step) }] : [{ type: "message", content: [{ type: "output_text", text: "Proposed a focused repair. Service tests passed for this proposal; no deployment." }] }] }));
  } });
  const result = await agent.run({ files, template: "workspace", messages: [], prompt: "Fix the feed", runnerConfigured: true, runProject: async input => { runs.push(input); return { ...report(config.job(input)), ok: runs.length > 1, logs: runs.length === 1 ? "expected ten records" : "passed" }; } });
  assert.equal(runs.length, 2); assert.equal(result.changed, true); assert.match(result.files["services/feed.cjs"], /slice\(0, 10\)/);
  assert.notEqual(digest(runs[0].files), digest(runs[1].files)); assert.equal(files["services/feed.cjs"].includes("slice(0, 20)"), true);
});
