"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), express = require("express");
const { Builder } = require("../lib/builder/service"), { createBuilderRouter } = require("../lib/builder/router"),
  { createAccounts } = require("../lib/accounts"), { starter } = require("../lib/builder/projects"), { BuildAgent } = require("../lib/builder/agent");

test("conversation continues from pending source without applying it; failures and stale tabs preserve the review", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-proposal-chat-")), app = express(), origin = "http://127.0.0.1";
  const accounts = createAccounts({ stateDir: dir, siteOrigin: origin });
  let failNext = false, calls = 0;
  const agent = { configured: true, model: "fixture", async run({ files, prompt, pendingProposal, review }) {
    calls++; assert.equal(pendingProposal, true); assert.equal(review, true);
    assert.match(files["README.md"], /First proposed change/);
    if (failNext) { failNext = false; throw Object.assign(Error("Fixture interrupted"), { status: 502 }); }
    if (prompt === "Explain") return { files, changed: false, summary: "These are still proposed changes." };
    return { files: { ...files, "README.md": files["README.md"] + "\nFollow-up refinement" }, changed: true, summary: "Refined the pending proposal." };
  } };
  const builder = new Builder({ stateDir: dir, autoStart: false, agent });
  app.use(express.json(), accounts.router, createBuilderRouter({ accounts, stateDir: dir, builder }).router);
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }), url = origin + ":" + server.address().port;
  const user = accounts.service._newAccount({ email: "chat@example.test" }), other = accounts.service._newAccount({ email: "other@example.test" });
  const token = accounts.service._issueSession(user.id, "probe"), otherToken = accounts.service._issueSession(other.id, "probe");
  const post = (route, body, session = token) => fetch(url + route, { method: "POST", headers: { origin, cookie: "kai_session=" + session, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const files = starter("blank", "Chat app"), p = builder.store.create(user.id, "Chat app", "blank", files), base = "/build/api/projects/" + p.id;
    const initial = builder.store.propose(user.id, p.id, 1, { ...files, "README.md": "First proposed change" }, "Initial proposal");
    assert.equal((await post(base + "/messages", { prompt: "Explain", proposalId: initial }, otherToken)).status, 404);
    assert.equal((await post(base + "/messages", { prompt: "Explain" })).status, 409);
    assert.equal((await post(base + "/messages", { prompt: "Explain", proposalId: "stale" })).status, 409);
    assert.equal((await post(base + "/messages", { prompt: "Explain", proposalId: initial, review: false })).status, 202);
    assert.equal((await post(base + "/proposals/" + initial, { action: "apply", revision: 1 })).status, 409);
    await builder.tick();
    assert.equal(builder.store.proposal(user.id, p.id).id, initial);
    assert.equal(builder.store.owned(user.id, p.id).revision, 1);
    assert.equal((await post(base + "/messages", { prompt: "Refine", proposalId: initial })).status, 202);
    failNext = true; await builder.tick();
    const failed = builder.store.detail(user.id, p.id).jobs[0];
    assert.equal(failed.status, "failed"); assert.equal(builder.store.proposal(user.id, p.id).id, initial);
    builder.retry(user.id, p.id, failed.id); await builder.tick();
    const replacement = builder.store.proposal(user.id, p.id);
    assert.notEqual(replacement.id, initial); assert.match(replacement.files["README.md"], /First proposed change\nFollow-up refinement/);
    assert.deepEqual(builder.store.files(user.id, p.id).files, files);
    assert.equal((await post(base + "/proposals/" + initial, { action: "apply", revision: 1 })).status, 404);
    assert.equal((await post(base + "/messages", { prompt: "Refine", proposalId: initial })).status, 409);
    // Failed validation must not remove the current proposal.
    assert.throws(() => builder.store.propose(user.id, p.id, 1, { "bad-path": "" }, "Invalid", replacement.id));
    assert.equal(builder.store.proposal(user.id, p.id).id, replacement.id);
    assert.equal((await post(base + "/proposals/" + replacement.id, { action: "apply", revision: 1 })).status, 200);
    assert.equal(builder.store.owned(user.id, p.id).revision, 2);
    assert.match(builder.store.files(user.id, p.id).files["README.md"], /Follow-up refinement/);
    assert.equal((await post(base + "/messages", { prompt: "Refine", proposalId: replacement.id })).status, 409);
    // A queued job must not switch to different source if its review disappears.
    const next = builder.store.propose(user.id, p.id, 2, { ...replacement.files, "README.md": "First proposed change again" }, "New proposal");
    const job = builder.store.enqueue(user.id, p.id, "edit", { prompt: "Refine", revision: 2, proposalId: next });
    builder.store.db.prepare("DELETE FROM source_proposals WHERE id=?").run(next);
    const before = calls; await builder.tick(); assert.equal(calls, before);
    assert.equal(builder.store.detail(user.id, p.id).jobs.find(j => j.id === job.id).status, "failed");
    assert.throws(() => builder.retry(user.id, p.id, job.id), /older proposal/);
  } finally { await new Promise(resolve => server.close(resolve)); builder.close(); accounts.service.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("AI receives explicit pending-source context and answers without inventing an apply action", async () => {
  const files = starter("blank", "Pending");
  const agent = new BuildAgent({ key: "fixture", fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.match(request.instructions, /already contain the pending, unapplied proposal/);
    assert.match(request.instructions, /Conversational agreement does not authorize/);
    assert.ok(!request.tools.some(t => /apply|publish|deploy/.test(t.name)));
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "You can refine this proposal before applying it." }] }] }));
  } });
  const result = await agent.run({ files, review: true, pendingProposal: true, messages: [], prompt: "Explain" });
  assert.equal(result.changed, false); assert.deepEqual(result.files, files);
});
