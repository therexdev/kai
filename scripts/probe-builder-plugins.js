"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process"), express = require("express");
const { JSDOM } = require("jsdom"), plugins = require("../lib/builder/plugins"), docs = require("../lib/builder/plugin-docs"),
  { starter, validate } = require("../lib/builder/projects"), { Builder } = require("../lib/builder/service"),
  { BuildAgent } = require("../lib/builder/agent"), { createBuilderRouter } = require("../lib/builder/router"),
  { createAccounts } = require("../lib/accounts"), core = require("./fixtures/core-plugin-package.cjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-plugins-"));
const write = (dir, files) => { for (const [name, content] of Object.entries(files)) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); } };

test("plugin starters pass the pinned Core package verifier and their exported tests", () => {
  assert.deepEqual(plugins.permissions, core.PERMISSIONS);
  for (const template of ["plugin", "plugin-chain"]) {
    const files = starter(template, "Example <plugin>"), report = plugins.inspect(files);
    assert.equal(report.ok, true); assert.equal(report.compiled, false); assert.equal(report.packageVerified, false);
    assert.ok(!files["plugin/index.html"].includes("<h1>Example <plugin>"));
    const manifest = JSON.parse(files["plugin/manifest.json"]), packaged = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith("plugin/") && name !== "plugin/manifest.json").map(([name, source]) => [name.slice(7), source]));
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const pkg = { manifest, files: packaged, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      signature: crypto.sign(null, Buffer.from(core.signingPayload(manifest, packaged)), privateKey).toString("base64") };
    assert.equal(core.verifyPackage(pkg).manifest.id, manifest.id);
    if (template === "plugin-chain") {
      assert.deepEqual(manifest.provides, [manifest.id + ".counter"]);
      assert.ok(files["contract/assembly/Counter.ts"]); assert.ok(files["contract/package-lock.json"]);
      assert.equal(JSON.parse(files["plugin/chain.json"]).contractId, "");
    }
    const dir = temp();
    try { write(dir, files); const tests = fs.readdirSync(path.join(dir, "tests")).map(name => path.join(dir, "tests", name));
      cp.execFileSync(process.execPath, ["--test", ...tests], { cwd: dir, timeout: 30000, stdio: "pipe" });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("plugin checks catch incompatible manifests without executing source or weakening contract paths", () => {
  const files = starter("plugin", "Plugin"), manifest = JSON.parse(files["plugin/manifest.json"]);
  for (const patch of [{ apiVersion: 1 }, { runtime: "native" }, { permissions: ["wallet.signTransaction"] }, { entry: "missing.html" }, { chainId: "not-a-manifest-field" }, { version: "1.0.0-beta" }]) {
    assert.equal(plugins.inspect({ ...files, "plugin/manifest.json": JSON.stringify({ ...manifest, ...patch }) }).ok, false);
  }
  const malformed = { ...files, "plugin/manifest.json": "{", "plugin/app.js": "globalThis.__unexpectedPluginExecution = true;" };
  assert.equal(validate(malformed, "plugin").ok, true); // Incomplete editor contents may be saved.
  assert.equal(plugins.inspect(malformed).ok, false); assert.equal(globalThis.__unexpectedPluginExecution, undefined);
  for (const name of ["../escape.js", ".env", "plugin/key.pem", "plugin/node_modules/library.js", "plugin/CON.js", "plugin/entry.js/more.js"]) {
    const next = { ...files, [name]: "", ...(name.includes("entry.js/") ? { "plugin/entry.js": "" } : {}) };
    assert.throws(() => plugins.validate(next));
  }
  assert.throws(() => validate({ "index.html": "<html></html>" }, "contract"), /Unsupported/);
  assert.throws(() => docs.read("../../package.json"), /reference/);
  assert.match(docs.read("author-guide").content, /not an arbitrary transaction signer/);
  assert.match(docs.read("start").content, /Referral and developer rewards/);
});

test("sandboxed starter uses Core storage, local AI and shared locale without replacing unsaved input", async () => {
  const files = starter("plugin", "Local assistant"), dom = new JSDOM(files["plugin/index.html"], { runScripts: "outside-only" });
  const w = dom.window, $ = id => w.document.getElementById(id), calls = [];
  let locale, note = "Saved note";
  w.kai = { locale: { get: async () => ({ language: "en" }), onChange: fn => { locale = fn; return () => {}; } },
    async call(method, input) {
      calls.push({ method, input });
      if (method === "storage.get") return note;
      if (method === "storage.set") { note = input.value; return true; }
      if (method === "models.list") return [{ alias: "local-model", status: "ready" }, { alias: "koinos-network:paid", status: "ready" }];
      if (method === "inference.local") return { text: "<img src=x onerror=alert(1)> A proposed idea" };
      throw Error("Unexpected Core method");
    } };
  const settle = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail("Plugin did not settle"); };
  try {
    w.eval(files["plugin/i18n.js"]); w.eval(files["plugin/app.js"]);
    await settle(() => $("model").options.length === 1 && !$("improve").disabled);
    $("note").value = "My unsaved idea"; $("note").dispatchEvent(new w.Event("input"));
    locale({ language: "es" }); assert.equal(w.document.documentElement.lang, "es"); assert.equal($("save").textContent, "Guardar notas"); assert.equal($("note").value, "My unsaved idea");
    $("improve").click(); await settle(() => !$("suggestion").hidden);
    assert.equal($("draft").querySelector("img"), null); assert.equal($("note").value, "My unsaved idea");
    $("apply").click(); $("save").click(); await settle(() => note.includes("proposed idea") && !$("save").disabled);
    assert.equal(calls.find(c => c.method === "inference.local").input.model, "local-model");
  } finally { dom.window.close(); }
});

function fixtureAgent() {
  let step = 0, contract;
  const call = (name, args) => ({ type: "function_call", name, call_id: "plugin-" + step, arguments: JSON.stringify(args) });
  return new BuildAgent({ key: "fixture", fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.tools.some(t => t.name === "read_plugin_docs"));
    assert.ok(!body.tools.some(t => /deploy|shell|inspect_app|read_app_contract|read_preview/.test(t.name)));
    assert.match(body.instructions, /not generic contract signing|not generic|not arbitrary|not generic contract/);
    let output;
    if (step === 0) output = [call("read_plugin_docs", { topic: "author-guide" })];
    if (step === 1) { assert.match(body.input.find(r => r.type === "function_call_output").output, /schema 2/); output = [call("read_project", {})]; }
    if (step === 2) {
      const project = JSON.parse(body.input.filter(r => r.type === "function_call_output").at(-1).output);
      assert.equal(project.files["contract/package-lock.json"], undefined);
      contract = project.files["contract/assembly/Counter.ts"];
      output = [call("write_files", { files: [{ path: "plugin/help.html", content: "<!doctype html><html><body>Project help</body></html>" }, { path: "contract/assembly/Counter.ts", content: contract + "\n// Reviewed paired-project edit\n" }] })];
    }
    if (step === 3) output = [call("validate_project", {})];
    if (step === 4) output = [{ type: "message", content: [{ type: "output_text", text: "Proposed paired plugin/contract edits. Static checks only." }] }];
    step++; return new Response(JSON.stringify({ status: "completed", output, usage: { total_tokens: 1 } }));
  } });
}

test("plugin HTTP/editor workflow keeps docs, reviewed AI edits and exports in one non-deployable project", async () => {
  const dir = temp(), origin = "http://127.0.0.1", app = express(), accounts = createAccounts({ stateDir: dir, siteOrigin: origin });
  let signerCalls = 0;
  const builder = new Builder({ stateDir: dir, autoStart: false, agent: fixtureAgent(), signer: { configured: true, async call() { signerCalls++; throw Error("Must not sign plugin source"); } } });
  app.use(express.json({ limit: "1mb" }), accounts.router, createBuilderRouter({ accounts, stateDir: dir, builder }).router);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }), url = "http://127.0.0.1:" + server.address().port;
  const user = accounts.service._newAccount({ email: "plugin@example.test" }), other = accounts.service._newAccount({ email: "other@example.test" });
  const token = accounts.service._issueSession(user.id, "probe"), otherToken = accounts.service._issueSession(other.id, "probe");
  const request = (route, options = {}, session = token) => fetch(url + route, { ...options, headers: { ...options.headers, cookie: "kai_session=" + session, origin } });
  const post = (route, body, session) => request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, session);
  let dom;
  try {
    assert.equal((await fetch(url + "/build/api/reference/plugins/api")).status, 401);
    const result = await (await post("/build/api/projects", { title: "Paired plugin", template: "plugin-chain" })).json(), project = result.project, base = "/build/api/projects/" + project.id;
    assert.equal(project.source_contract_hash, null);
    assert.equal((await request(base, {}, otherToken)).status, 404);
    for (const route of ["/publish", "/wallet/prepare", "/workspace"]) assert.equal((await post(base + route, { revision: 1 })).status, 409);
    assert.equal((await request(base + "/preview")).status, 409);
    const source = builder.store.files(user.id, project.id).files;
    assert.equal((await (await post(base + "/check", { files: source })).json()).ok, true);
    dom = new JSDOM(await (await request("/build")).text(), { url: url + "/build?project=" + project.id, runScripts: "outside-only" });
    const w = dom.window, $ = id => w.document.getElementById(id);
    w.fetch = request; w.confirm = () => true;
    w.KaiI18n = { setText: (n, v) => { n.textContent = typeof v === "string" ? v : v.text; }, message: (parts, ...values) => ({ text: parts.reduce((s, p, i) => s + p + (values[i] ?? ""), ""), values }), t: value => value };
    w.KaiBuildBridge = { create: () => ({ reset() {} }) }; w.mdToHtml = require("../public/docs/md").mdToHtml;
    for (const dialog of w.document.querySelectorAll("dialog")) { dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; }; }
    const until = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail("UI did not settle: " + $("notice").textContent); };
    w.eval(fs.readFileSync(path.join(__dirname, "../views/build/ide.js"), "utf8")); w.eval(fs.readFileSync(path.join(__dirname, "../views/build/build.js"), "utf8"));
    await until(() => $("file-tree").children.length > 0);
    assert.equal($("publish").hidden, true); assert.equal($("source-export").hidden, false);
    assert.equal($("preview").getAttribute("src"), null); assert.equal($("pane-code").hidden, false);
    $("tab-reference").click(); await until(() => $("reference-content").textContent.includes("Core API boundaries"));
    assert.match($("reference-source").href, /plugin-builder/);
    $("reference-topic").value = "api"; $("reference-topic").dispatchEvent(new w.Event("change"));
    await until(() => $("reference-content").querySelector("pre"));
    assert.match($("reference-content").textContent, /FoundationApi/);
    w.document.querySelector("[data-plugin-prompt]").click(); assert.match($("prompt").value, /read_plugin_docs/);
    $("project-settings").click(); await until(() => $("settings-dialog").open && !$("code-editor").readOnly);
    assert.equal($("ownership-section").hidden, true); $("settings-dialog").close();
    const edit = await post(base + "/messages", { prompt: "Add help and document the counter", review: false }); assert.equal(edit.status, 202);
    await builder.tick(); const proposed = builder.store.detail(user.id, project.id);
    assert.equal(proposed.project.revision, 1); assert.ok(proposed.proposal, proposed.jobs[0].error);
    $("project-list").querySelector(".active").click(); await until(() => !$("review-pending").hidden);
    $("apply-proposal").click(); await until(() => builder.store.owned(user.id, project.id).revision === 2 && $("review-pending").hidden);
    assert.match(builder.store.files(user.id, project.id).files["contract/assembly/Counter.ts"], /paired-project/);
    $("add-file").click(); $("source-file-path").value = "plugin/panel.css"; $("source-file-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
    $("code-editor").value = "main { max-width: 900px; }"; $("code-editor").dispatchEvent(new w.Event("input"));
    $("save-files").click(); await until(() => builder.store.owned(user.id, project.id).revision === 3 && !$("check-files").disabled);
    $("check-files").click(); await until(() => $("source-diagnostics").textContent.includes("Source checks passed"));
    assert.match($("source-diagnostics").textContent, /have not run/);
    const archive = Buffer.from(await (await request(base + "/export.zip")).arrayBuffer());
    assert.ok(archive.includes(Buffer.from("source/plugin/manifest.json"))); assert.ok(archive.includes(Buffer.from("source/contract/assembly/Counter.ts")));
    const entries = [];
    for (let offset = 0; archive.readUInt32LE(offset) === 0x04034b50;) {
      const length = archive.readUInt16LE(offset + 26), extra = archive.readUInt16LE(offset + 28), size = archive.readUInt32LE(offset + 18);
      entries.push(archive.subarray(offset + 30, offset + 30 + length).toString()); offset += 30 + length + extra + size;
    }
    assert.ok(!entries.includes("site/app.html")); assert.ok(!entries.some(name => /\.(wasm|kaiplugin)$/.test(name)));
    const exported = await (await request(base + "/export")).json();
    assert.equal(exported.workspace.plugin, true); assert.equal(exported.workspace.publishAvailable, false);
    exported.project.contractId = "untrusted-import";
    const imported = await (await post("/build/api/projects/import", exported)).json();
    assert.notEqual(imported.project.id, project.id); assert.equal(imported.project.contract_id, null);
    builder.store.enqueue(user.id, project.id, "publish", { revision: 3 }); await builder.tick();
    assert.equal(builder.store.detail(user.id, project.id).jobs[0].status, "failed"); assert.equal(signerCalls, 0);
  } finally { dom?.window.close(); await new Promise(resolve => server.close(resolve)); builder.close(); accounts.service.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
