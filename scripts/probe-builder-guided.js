"use strict";
const test = require("node:test"), assert = require("node:assert/strict"),
  fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { BuildStore, digest } = require("../lib/builder/store"),
  { starter, validate, html } = require("../lib/builder/projects"),
  { BuildAgent } = require("../lib/builder/agent"),
  { Builder } = require("../lib/builder/service"),
  { PUBLISHING_PROTOCOL } = require("../lib/builder/chain"),
  { bundle: exportZip } = require("../lib/builder/export"),
  guided = require("../lib/builder/guided");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-guided-test-"));

test("opening full source preserves identity, live data and history; edits cannot hide behind the managed template", () => {
  const dir = temp(), store = new BuildStore(dir);
  try {
    const frontend = starter("voting", "Vote"), project = store.create("one", "Vote", "voting", frontend);
    store.publish("one", project.id, 1, { contractId: "existing-app", guardId: "existing-guard", chainId: "chain", network: "testnet", owner: "owner", txId: "tx" }, "release");
    const before = store.owned("one", project.id);
    assert.throws(() => store.attachSources("other", project.id, 1), /not found/);
    assert.throws(() => store.attachSources("one", project.id, 0), /changed/);
    assert.equal(store.attachSources("one", project.id, 1).revision, 2);
    let detail = store.detail("one", project.id);
    for (const key of ["id", "slug", "contract_id", "guard_id", "live_revision", "platform_owner"])
      assert.equal(detail.project[key], before[key]);
    assert.equal(detail.workspace.mode, "full");
    assert.equal(detail.workspace.publishAvailable, true);
    assert.ok(detail.files["contract/assembly/App.ts"]);
    assert.ok(detail.files["contract/assembly/Guard.ts"]);
    assert.ok(detail.files["contract/assembly/__tests__/App.spec.ts"]);
    assert.ok(detail.files["contract/assembly/proto/app.proto"]);
    assert.ok(detail.files["contract/abi/app.json"]);
    assert.deepEqual(store.publicFiles(store.publicProject(project.slug)), frontend);
    assert.equal(validate(detail.files).compiled, false);
    assert.ok(html(detail.files).includes("kai-app-request"));
    assert.ok(!html(detail.files).includes(detail.files["contract/assembly/App.ts"]));
    assert.throws(() => validate({ ...detail.files, "contract/../server.js": "" }), /Unsupported/);
    assert.throws(() => validate({ ...detail.files, "contract/assembly/app.ts": "" }), /unique/);
    const full = detail.files, edited = { ...full, "contract/assembly/App.ts": full["contract/assembly/App.ts"] + "\n// user edit\n" };
    const proposal = store.propose("one", project.id, 2, edited, "Proposed contract edit");
    store.resolveProposal("one", project.id, proposal, true, 2);
    detail = store.detail("one", project.id);
    assert.equal(detail.workspace.contractEdited, true);
    assert.throws(() => guided.assertPublish(detail.project, detail.files), /Contract sources changed/);
    const changedZip = exportZip(detail.project, detail).toString();
    assert.ok(changedZip.includes("// user edit"));
    assert.ok(changedZip.includes("source/index.html"));
    assert.ok(!changedZip.includes("site/app.html"));
    assert.ok(!changedZip.includes("contract/contract.wasm"));
    // Removing the entire folder cannot turn a full project back into a legacy
    // frontend and silently publish the original bytecode.
    store.saveRevision("one", project.id, frontend, "Removed contract folder");
    detail = store.detail("one", project.id);
    assert.equal(detail.workspace.publishAvailable, false);
    assert.throws(() => guided.assertPublish(detail.project, detail.files), /Contract sources changed/);
    store.saveRevision("one", project.id, full, "Restored original source");
    detail = store.detail("one", project.id);
    guided.assertPublish(detail.project, detail.files);
    assert.ok(exportZip(detail.project, detail).includes(Buffer.from("site/app.html")));
    // Import trusts server provenance only, regardless of hashes in an export.
    const imported = store.create("one", "Imported", "voting", edited);
    assert.equal(imported.source_contract_hash, guided.bundle().sourceHash);
    assert.equal(store.detail("one", imported.id).workspace.publishAvailable, false);
    assert.throws(() => guided.assertPublish({ ...detail.project, source_app_hash: "old-build" }, full), /older contract build/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("guided AI reads and edits frontend and contract source in the same reviewable revision", async () => {
  const files = guided.augment(starter("board", "Community"));
  let step = 0;
  const agent = new BuildAgent({ key: "fixture", fetchImpl: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.tools.some(t => t.name === "read_file"));
    assert.ok(body.tools.some(t => t.name === "inspect_app"));
    assert.ok(!body.tools.some(t => /compile|sign|deploy|shell/.test(t.name)));
    assert.match(body.instructions, /same|share one project/);
    const call = (name, args) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: String(step) });
    let output;
    if (step === 0) output = [call("read_project", {})];
    if (step === 1) {
      const info = JSON.parse(body.input.find(i => i.type === "function_call_output").output);
      assert.ok(info.files["index.html"]);
      assert.equal(info.files["contract/package-lock.json"], undefined);
      assert.ok(info.filePaths.includes("contract/assembly/App.ts"));
      output = [call("read_file", { path: "contract/assembly/App.ts" })];
    }
    if (step === 2) output = [call("write_files", { files: [
      { path: "app.css", content: files["app.css"] + "\nh1{color:purple}" },
      { path: "contract/assembly/App.ts", content: files["contract/assembly/App.ts"] + "\nexport function example(): i32 { return 1; }\n" },
    ] })];
    if (step === 3) output = [call("validate_project", {})];
    if (step === 4) {
      const report = JSON.parse(body.input.filter(i => i.type === "function_call_output").at(-1).output);
      assert.equal(report.compiled, false);
      output = [{ type: "message", content: [{ type: "output_text", text: "Proposed frontend and contract edits. The contract needs compilation and testing." }] }];
    }
    step++;
    return new Response(JSON.stringify({ status: "completed", output }));
  } });
  const dir = temp(), builder = new Builder({ stateDir: dir, autoStart: false, agent });
  try {
    const p = builder.store.create("one", "Community", "board", files);
    builder.store.enqueue("one", p.id, "edit", { revision: 1, prompt: "Update the frontend and contract", review: false });
    await builder.tick();
    let d = builder.store.detail("one", p.id);
    assert.equal(d.jobs[0].status, "completed");
    assert.equal(d.project.revision, 1);
    assert.match(d.proposal.files["app.css"], /purple/);
    assert.match(d.proposal.files["contract/assembly/App.ts"], /function example/);
    builder.store.resolveProposal("one", p.id, d.proposal.id, true, 1);
    d = builder.store.detail("one", p.id);
    assert.equal(d.project.id, p.id);
    assert.equal(d.project.revision, 2);
    assert.equal(d.workspace.publishAvailable, false);
  } finally { builder.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unchanged guided sources keep the existing publish worker; changed contracts are refused before signer access", async () => {
  const dir = temp(), calls = [], kit = guided.bundle();
  const signer = { configured: true, call: async (action, payload) => {
    calls.push({ action, payload });
    if (action === "status") return { contractHash: kit.appHash, guardHash: kit.guardHash, publishingProtocol: PUBLISHING_PROTOCOL };
    return { contractId: "existing-app", guardId: "existing-guard", chainId: "test-chain", network: "testnet", owner: "owner", txId: "fixture" };
  } };
  const builder = new Builder({ stateDir: dir, autoStart: false, signer, chain: { config: { chainId: "test-chain", network: "testnet" } } });
  try {
    const files = guided.augment(starter("blank", "App")), p = builder.store.create("one", "App", "blank", files);
    builder.store.enqueue("one", p.id, "publish", { revision: 1 });
    await builder.tick();
    let d = builder.store.detail("one", p.id);
    assert.equal(d.jobs[0].status, "completed");
    assert.equal(d.project.live_revision, 1);
    assert.equal(calls.at(-1).payload.hash, digest(files));
    const frontendEdit = { ...files, "app.css": files["app.css"] + "\nh1{color:red}" };
    builder.store.saveRevision("one", p.id, frontendEdit, "Frontend edit");
    builder.store.enqueue("one", p.id, "publish", { revision: 2 });
    await builder.tick();
    d = builder.store.detail("one", p.id);
    assert.equal(d.project.contract_id, "existing-app");
    assert.equal(d.project.live_revision, 2);
    const callCount = calls.length;
    builder.store.saveRevision("one", p.id, { ...frontendEdit, "contract/assembly/App.ts": "// edited" }, "Contract edit");
    builder.store.enqueue("one", p.id, "publish", { revision: 3 });
    await builder.tick();
    d = builder.store.detail("one", p.id);
    assert.equal(d.jobs[0].status, "failed");
    assert.match(d.jobs[0].error, /Contract sources changed/);
    assert.equal(d.project.live_revision, 2);
    assert.equal(calls.length, callCount);
  } finally { builder.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
