"use strict";
const test = require("node:test"), assert = require("node:assert/strict"),
  fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
  express = require("express");
const { BuildStore } = require("../lib/builder/store"),
  { starter, validate } = require("../lib/builder/projects"),
  { inspectSource } = require("../lib/builder/workspace"),
  { BuildAgent } = require("../lib/builder/agent"),
  { Builder } = require("../lib/builder/service"),
  { createBuilderRouter } = require("../lib/builder/router"),
  { createAccounts } = require("../lib/accounts");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-ide-test-"));

test("source workspaces reject unsafe paths and collisions, save incomplete code, and report limited checks honestly", () => {
  const files = starter("contract", "Contract");
  assert.equal(validate(files, "contract").compiled, false);
  for (const name of ["../a.ts", "/a.ts", "a//b.ts", "a/../b.ts", "a\\b.ts", ".env.json", "node_modules/x.ts", "build/app.ts", "a./b.ts", "CON.ts", "COM1/b.ts", "index.html"]) {
    assert.throws(() => validate({ ...files, [name]: "" }, "contract"), /Unsupported/);
  }
  assert.throws(() => validate({ ...files, "ASSEMBLY/counter.ts": "" }, "contract"), /unique/);
  assert.throws(() => validate({ "a.ts": "", "a.ts/b.ts": "" }, "contract"), /file and a folder/);
  assert.throws(() => validate(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a${i}.ts`, ""])), "contract"), /64/);
  assert.throws(() => validate({ "a.ts": "x".repeat(300001) }, "contract"), /300 KB/);
  assert.equal(validate({ "assembly/Unfinished.ts": "export class {" }, "contract").ok, true);
  const report = inspectSource({ ...files, "settings.json": "{" });
  assert.equal(report.ok, false);
  assert.equal(report.compiled, false);
  assert.ok(report.diagnostics.some(d => d.path === "settings.json" && d.severity === "error"));
  assert.match(report.note, /not connected/);
  assert.throws(() => validate(files), /Unsupported/); // Managed apps cannot smuggle custom source into publishing.
});

test("AI proposals persist separately, require ownership and exact base revision, and never change published source", () => {
  const dir = temp(); let store = new BuildStore(dir);
  const files = starter("blank", "Before"), p = store.create("one", "Test", "blank", files);
  store.publish("one", p.id, 1, { contractId: "contract", chainId: "chain", network: "testnet", owner: "platform", txId: "fixture" }, "release");
  const changed = { ...files, "app.css": files["app.css"] + "\nh1{color:red}" };
  const id = store.propose("one", p.id, 1, changed, "Proposed color");
  assert.equal(store.owned("one", p.id).revision, 1);
  store.close(); store = new BuildStore(dir);
  assert.equal(store.detail("one", p.id).proposal.id, id);
  assert.throws(() => store.resolveProposal("other", p.id, id, true, 1), /not found/);
  assert.throws(() => store.propose("one", p.id, 1, changed, "Again"), /pending/);
  store.saveRevision("one", p.id, { ...files, "README.md": "Another edit" }, "Manual edit");
  assert.throws(() => store.resolveProposal("one", p.id, id, true, 2), /changed/);
  assert.equal(store.owned("one", p.id).revision, 2);
  store.resolveProposal("one", p.id, id, false);
  assert.equal(store.detail("one", p.id).proposal, null);
  const next = store.propose("one", p.id, 2, changed, "Reviewed color");
  assert.equal(store.resolveProposal("one", p.id, next, true, 2).revision, 3);
  assert.equal(store.files("one", p.id).files["app.css"], changed["app.css"]);
  assert.equal(store.publicFiles(store.publicProject(p.slug))["app.css"], files["app.css"]);
  assert.equal(store.propose("one", p.id, 3, changed, "No-op"), null);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureAgent() {
  let step = 0;
  const call = (name, args) => ({ type: "function_call", name, call_id: "c" + step, arguments: JSON.stringify(args) });
  return new BuildAgent({ key: "fixture", fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.tools.some(t => t.name === "delete_file"));
    assert.ok(!body.tools.some(t => /deploy|shell|read_app_contract|inspect_app/.test(t.name)));
    assert.match(body.instructions, /review/);
    let output;
    if (step === 0) output = [call("read_project", {})];
    if (step === 1) {
      const read = JSON.parse(body.input.find(i => i.type === "function_call_output").output);
      assert.equal(read.files["package-lock.json"], undefined);
      assert.ok(read.filePaths.includes("package-lock.json"));
      output = [call("write_files", { files: [{ path: "notes/plan.md", content: "<img src=x onerror=alert(1)>\nProposed counter documentation." }] })];
    }
    if (step === 2) output = [call("validate_project", {})];
    if (step === 3) output = [{ type: "message", content: [{ type: "output_text", text: "Proposed counter documentation. Source checks only; no compiler or test run." }] }];
    step++;
    return new Response(JSON.stringify({ status: "completed", output, usage: { total_tokens: 1 } }));
  } });
}

test("contract AI runs produce a proposal and cannot silently apply source or deploy it", async () => {
  const dir = temp(), builder = new Builder({ stateDir: dir, autoStart: false, agent: fixtureAgent() });
  const p = builder.store.create("one", "Counter", "contract", starter("contract", "Counter"));
  builder.store.enqueue("one", p.id, "edit", { prompt: "Add documentation", revision: 1, review: false });
  await builder.tick();
  const detail = builder.store.detail("one", p.id);
  assert.equal(detail.jobs[0].status, "completed");
  assert.equal(detail.project.revision, 1);
  assert.equal(detail.files["notes/plan.md"], undefined);
  assert.match(detail.proposal.files["notes/plan.md"], /Proposed/);
  builder.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("real HTTP and editor workflow creates, edits, checks, reviews, exports and imports contract source", async () => {
  const { JSDOM } = require("jsdom");
  const dir = temp(), app = express(), origin = "http://127.0.0.1";
  const accounts = createAccounts({ stateDir: dir, siteOrigin: origin });
  const builder = new Builder({ stateDir: dir, autoStart: false, agent: fixtureAgent() });
  app.use(express.json({ limit: "1mb" }), accounts.router, createBuilderRouter({ accounts, stateDir: dir, builder }).router);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = "http://127.0.0.1:" + server.address().port;
  const user = accounts.service._newAccount({ email: "ide@example.test" });
  const other = accounts.service._newAccount({ email: "other-ide@example.test" });
  const token = accounts.service._issueSession(user.id, "probe"), otherToken = accounts.service._issueSession(other.id, "probe");
  const request = (route, options = {}, session = token) => fetch(url + route, {
    ...options, headers: { ...options.headers, cookie: "kai_session=" + session, origin },
  });
  const post = (route, body, session) => request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, session);
  let dom;
  try {
    const created = await post("/build/api/projects", { template: "contract", title: "Counter" });
    assert.equal(created.status, 201);
    const { project } = await created.json(), base = "/build/api/projects/" + project.id;
    assert.equal((await post(base + "/publish", { revision: 1 })).status, 409);
    assert.equal((await request(base + "/preview")).status, 409);
    assert.equal((await post(base + "/wallet/prepare", {})).status, 409);
    assert.equal((await post(base + "/check", { files: { "a.ts": "" } }, otherToken)).status, 404);
    const exported = await (await request(base + "/export")).json();
    assert.equal((await post("/build/api/projects/import", exported)).status, 201);
    const archive = Buffer.from(await (await request(base + "/export.zip")).arrayBuffer());
    assert.ok(archive.includes(Buffer.from("source/assembly/Counter.ts")));
    assert.ok(!archive.includes(Buffer.from("site/app.html")));
    dom = new JSDOM(await (await request("/build")).text(), { url: url + "/build?project=" + project.id, runScripts: "outside-only" });
    const w = dom.window, $ = id => w.document.getElementById(id);
    w.fetch = request;
    w.confirm = () => true;
    w.KaiI18n = { setText: (n, v) => { n.textContent = typeof v === "string" ? v : v.text; }, message: (parts, ...values) => ({ text: parts.reduce((s, p, i) => s + p + (values[i] ?? ""), ""), values }), t: v => v };
    w.KaiBuildBridge = { create: () => ({ reset() {} }) };
    w.mdToHtml = require("../public/docs/md").mdToHtml;
    for (const d of w.document.querySelectorAll("dialog")) { d.showModal = () => { d.open = true; }; d.close = () => { d.open = false; }; }
    const until = async predicate => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
      assert.fail("UI did not settle: " + $("notice").textContent);
    };
    w.eval(fs.readFileSync(path.join(__dirname, "../views/build/ide.js"), "utf8"));
    w.eval(fs.readFileSync(path.join(__dirname, "../views/build/build.js"), "utf8"));
    await until(() => $("file-tree").children.length > 0);
    assert.equal($("pane-code").hidden, false);
    assert.equal($("publish").hidden, true);
    assert.equal($("preview").getAttribute("src"), null);
    $("add-file").click();
    $("source-file-path").value = "notes/manual.md";
    $("source-file-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
    $("code-editor").value = "Manual source note";
    $("code-editor").dispatchEvent(new w.Event("input"));
    $("save-files").click();
    await until(() => builder.store.owned(user.id, project.id).revision === 2 && !$("check-files").disabled);
    assert.equal(builder.store.files(user.id, project.id).files["notes/manual.md"], "Manual source note");
    $("check-files").click();
    await until(() => !$("pane-problems").hidden && !$("check-files").disabled);
    assert.match($("source-diagnostics").textContent, /not connected/);
    $("prompt").value = "Add documentation";
    $("chat-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => builder.store.detail(user.id, project.id).jobs.length > 0);
    await builder.tick();
    // Re-open via the real project switch control to refresh without waiting for polling.
    await until(() => !$("code-editor").readOnly || builder.store.detail(user.id, project.id).proposal);
    $("project-list").querySelector(".active").click();
    await until(() => !$("review-pending").hidden);
    assert.equal($("proposal-diff").querySelector("img"), null);
    assert.match($("proposal-diff").textContent, /<img src=x/);
    assert.equal($("send").disabled, false);
    assert.match($("composer-hint").textContent, /refine/);
    assert.equal(builder.store.owned(user.id, project.id).revision, 2);
    const proposalId = builder.store.detail(user.id, project.id).proposal.id;
    assert.equal((await post(base + "/proposals/" + proposalId, { action: "apply", revision: 2 }, otherToken)).status, 404);
    $("apply-proposal").click();
    await until(() => builder.store.owned(user.id, project.id).revision === 3 && $("review-pending").hidden);
    assert.match(builder.store.files(user.id, project.id).files["notes/plan.md"], /Proposed/);
    assert.equal($("send").disabled, false);
    // The existing guided creation process opens the same full source model,
    // keeping preview as the starting view for users who stay in chat.
    w.document.querySelector('[data-template="voting"]').click();
    $("project-title").value = "Guided voting";
    $("create-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await until(() => $("project-crumb").textContent === "Guided voting" && !$("check-files").disabled);
    const guidedProject = builder.store.list(user.id).find(p => p.title === "Guided voting");
    assert.ok(guidedProject.source_contract_hash);
    assert.match($("file-tree").textContent, /contract\/assembly\/App.ts/);
    assert.equal($("file-actions").hidden, false);
    $("test-preview").click();
    await until(() => !$("pane-preview").hidden && !$("test-preview").disabled);
    assert.match($("preview-label").textContent, /sample App v1/);
    assert.equal($("publish").disabled, false);
    $("tab-code").click();
    $("file-select").value = "contract/assembly/App.ts";
    $("file-select").dispatchEvent(new w.Event("change"));
    $("code-editor").value += "\n// guided custom source edit";
    $("code-editor").dispatchEvent(new w.Event("input"));
    $("save-files").click();
    await until(() => builder.store.owned(user.id, guidedProject.id).revision === 2 && !$("check-files").disabled);
    assert.equal($("publish").disabled, true);
    assert.match($("project-workflow-detail").textContent, /Contract sources changed/);
    const blocked = await post("/build/api/projects/" + guidedProject.id + "/publish", { revision: 2 });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /Contract sources changed/);
    assert.equal(builder.store.list(user.id).filter(p => p.title === "Guided voting").length, 1);
  } finally {
    dom?.window.close();
    await new Promise(resolve => server.close(resolve));
    builder.close(); accounts.service.db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
