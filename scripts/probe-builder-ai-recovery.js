"use strict";
const test = require("node:test"), assert = require("node:assert/strict"),
  fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { aiRequest, jobFailure } = require("../lib/builder/ai-request"),
  { BuildAgent } = require("../lib/builder/agent"),
  { Builder } = require("../lib/builder/service"),
  { starter } = require("../lib/builder/projects");
const response = (status, data, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: name => headers[name] || null }, json: async () => data,
});
const complete = output => ({ status: "completed", output });
const message = text => ({ type: "message", content: [{ type: "output_text", text }] });
const request = options => aiRequest({ key: "sk-private-fixture", body: { model: "fixture", input: "private prompt" }, pause: async () => {}, ...options });

test("transport retries preserve the request and keep tools outside the retry", async () => {
  const payloads = [], stages = [], pauses = [];
  const result = await request({
    onStage: stage => stages.push(stage), pause: async ms => pauses.push(ms),
    fetchImpl: async (_url, options) => {
      payloads.push(options.body);
      if (payloads.length === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      if (payloads.length === 2) return response(503, { error: { code: "server_error" } });
      return response(200, complete([message("Ready")]));
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(new Set(payloads).size, 1);
  assert.deepEqual(pauses, [1000, 2000]);
  assert.equal(stages.length, 2);

  let requests = 0, inspections = 0;
  const agent = new BuildAgent({ key: "fixture", pause: async () => {}, fetchImpl: async (_url, options) => {
    requests++;
    if (requests === 1) return response(200, complete([{ type: "function_call", name: "inspect_app", call_id: "c1", arguments: "{}" }]));
    if (requests === 2) throw new TypeError("connection lost after the tool ran");
    const input = JSON.parse(options.body).input;
    assert.equal(input.filter(x => x.type === "function_call_output" && x.call_id === "c1").length, 1);
    return response(200, complete([message("Inspected the live app.")]));
  } });
  await agent.run({ files: starter("board", "Fixture"), messages: [], prompt: "Inspect", inspectApp: async () => { inspections++; return { ok: true }; } });
  assert.equal(inspections, 1);
  assert.equal(requests, 3);
});

test("timeouts during fetch or body reading are classified and bounded", async () => {
  for (const bodyTimeout of [false, true]) {
    let calls = 0;
    await assert.rejects(() => request({ fetchImpl: async () => {
      calls++;
      const timeout = () => { throw new DOMException("expired", "TimeoutError"); };
      if (!bodyTimeout) timeout();
      return { ...response(200, {}), json: timeout };
    } }), e => e.code === "AI_TIMEOUT" && e.details.attempt === 3);
    assert.equal(calls, 3);
  }
  // The timeout is applied even when a caller supplies a non-aborted signal.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(() => request({ timeoutMs: 5, signal: new AbortController().signal,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    }), e => e.code === "AI_TIMEOUT");
  } finally { clearInterval(keepAlive); }
});

test("access, billing and invalid requests are not retried; rate limiting respects Retry-After", async () => {
  for (const [status, code, expected] of [
    [401, "invalid_api_key", "AI_ACCESS"], [403, "permission_denied", "AI_ACCESS"],
    [429, "insufficient_quota", "AI_BILLING"], [400, "unsupported_parameter", "AI_REQUEST"],
  ]) {
    let calls = 0;
    await assert.rejects(() => request({ fetchImpl: async () => {
      calls++; return response(status, { error: { code, param: "model", message: "private body" } }, { "x-request-id": "req_fixture" });
    } }), e => e.code === expected && e.details.requestId === "req_fixture" && !e.message.includes("private body"));
    assert.equal(calls, 1);
  }
  await assert.rejects(() => request({ fetchImpl: async () => response(400, { error: { code: "context_length_exceeded" } }) }), e => e.code === "AI_CONTEXT_LIMIT" && !e.retryable);
  let calls = 0;
  const delays = [];
  await request({ pause: async ms => delays.push(ms), fetchImpl: async () => ++calls === 1
    ? response(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "4" })
    : response(200, complete([])) });
  assert.deepEqual(delays, [4000]);
  calls = 0;
  await assert.rejects(() => request({ fetchImpl: async () => {
    calls++; return response(429, { error: { code: "rate_limit_exceeded" } }, { "retry-after": "90" });
  } }), e => e.code === "AI_RATE_LIMIT");
  assert.equal(calls, 1);
});

test("bounded edits retain valid partial source as a review proposal, never apply it automatically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-partial-"));
  const agent = new BuildAgent({ key: "fixture", maxTurns: 1, fetchImpl: async () => response(200, complete([
    { type: "function_call", name: "write_files", call_id: "partial", arguments: JSON.stringify({ files: [{ path: "README.md", content: "A completed source stage" }] }) },
  ])) });
  const builder = new Builder({ stateDir: dir, autoStart: false, agent });
  try {
    const p = builder.store.create("owner", "Partial", "blank", starter("blank", "Partial"));
    builder.store.enqueue("owner", p.id, "edit", { prompt: "Implement many features", revision: 1, review: false });
    await builder.tick(); const d = builder.store.detail("owner", p.id);
    assert.equal(d.project.revision, 1); assert.equal(d.jobs[0].status, "completed");
    assert.equal(d.proposal.files["README.md"], "A completed source stage");
    assert.match(d.proposal.summary, /partial proposal/); assert.match(d.proposal.summary, /unfinished/);
    assert.notEqual(d.files["README.md"], d.proposal.files["README.md"]);
  } finally { builder.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("limits preserve the last valid checkpoint and never consume incomplete tool output", async () => {
  const files = starter("contract", "Counter"); let step = 0;
  const call = (name, args) => ({ type: "function_call", name, call_id: "limit-" + step++, arguments: JSON.stringify(args) });
  const outputs = [
    [call("write_files", { files: [{ path: "notes/stage.md", content: "Stage one" }] })],
    [call("validate_project", {})],
    [call("write_files", { files: [{ path: "broken.json", content: "{" }] })],
  ];
  const agent = new BuildAgent({ key: "fixture", maxTurns: 3, fetchImpl: async () => response(200, complete(outputs.shift())) });
  const result = await agent.run({ files, template: "contract", prompt: "Stage work", messages: [] });
  assert.equal(result.partial, true); assert.equal(result.files["notes/stage.md"], "Stage one"); assert.equal(result.files["broken.json"], undefined);
  const incomplete = new BuildAgent({ key: "fixture", fetchImpl: async () => response(200, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [call("write_files", { files: [{ path: "README.md", content: "Never consume this" }] })] }) });
  await assert.rejects(() => incomplete.run({ files, template: "contract", prompt: "Big change", messages: [] }), e => e.code === "AI_OUTPUT_LIMIT" && !e.retryable);
});

test("new and historic work-limit failures expose a smaller-request action and reject blind retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-work-limit-"));
  const builder = new Builder({ stateDir: dir, autoStart: false, agent: new BuildAgent({ key: "fixture", maxWorkChars: 1, fetchImpl: async () => { assert.fail("Should not spend another request"); } }) });
  const saved = console.error; console.error = () => {};
  try {
    const p = builder.store.create("owner", "Budget", "blank", starter("blank", "Budget"));
    const job = builder.store.enqueue("owner", p.id, "edit", { prompt: "Big request", revision: 1 }); await builder.tick();
    const failed = builder.store.detail("owner", p.id).jobs[0];
    assert.equal(failed.retryable, false); assert.match(failed.error, /AI_WORK_LIMIT/); assert.doesNotMatch(failed.error, /Use Retry/);
    assert.throws(() => builder.retry("owner", p.id, job.id), /smaller new request/);
    builder.store.db.prepare("UPDATE jobs SET error=?,error_detail=NULL WHERE id=?").run("This edit reached the context limit. Try one smaller change at a time. Your saved version is unchanged. Use Retry saved edit to resume.", job.id);
    assert.equal(builder.store.detail("owner", p.id).jobs[0].retryable, false);
    assert.throws(() => builder.retry("owner", p.id, job.id), /smaller new request/);
  } finally { console.error = saved; builder.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("truncated and invalid responses retain the request ID and transport cause", async () => {
  let calls = 0;
  await assert.rejects(() => request({ fetchImpl: async () => {
    calls++;
    return { ...response(200, {}, { "x-request-id": "req_truncated" }), json: async () => { throw Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } }); } };
  } }), e => e.code === "AI_RESPONSE" && e.details.requestId === "req_truncated" && e.details.causeCode === "UND_ERR_SOCKET");
  assert.equal(calls, 3);
  await assert.rejects(() => request({ fetchImpl: async () => response(200, null) }), e => e.code === "AI_RESPONSE");
});

test("cancellation does not retry and diagnostics exclude raw errors and credentials", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => request({ signal: controller.signal, fetchImpl: async () => {
    calls++; controller.abort(); throw new DOMException("cancel", "AbortError");
  } }), e => e.code === "AI_CANCELLED");
  assert.equal(calls, 1);
  const failure = jobFailure(Object.assign(new TypeError("private prompt sk-secret"), {
    cause: { code: "sk-private-secret" }, details: { requestId: "req_safe", body: "private body" },
    stack: "TypeError: private prompt\n at run (/app/lib/builder/agent.js:140:10)",
  }), { id: "job_123", kind: "edit" }, "Inspecting project files");
  assert.match(failure.message, /TypeError during Inspecting project files/);
  assert.equal(failure.details.location, "lib/builder/agent.js:140:10");
  assert.doesNotMatch(JSON.stringify(failure), /private|secret/);
});

test("failed edits expose diagnostics to their owner and resume the same saved request", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-recovery-"));
  const calls = [], logs = [];
  let succeed = false;
  const builder = new Builder({ stateDir: dir, autoStart: false, agent: { run: async args => {
    calls.push(args);
    args.onStage("Reading your request");
    if (!succeed) return request({ fetchImpl: async () => { throw Object.assign(new TypeError("private message"), { cause: { code: "ECONNRESET" } }); } });
    return { changed: true, files: starter("board", "Repaired"), summary: "Updated." };
  } } });
  const savedError = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const p = builder.store.create("owner", "Live", "board", starter("board", "Live"));
    const payload = { prompt: "Fix the Kondor error", revision: 1, diagnostics: [{ message: "failure" }] };
    const job = builder.store.enqueue("owner", p.id, "edit", payload);
    await builder.tick();
    const detail = builder.store.detail("owner", p.id), failed = detail.jobs[0];
    assert.equal(detail.project.revision, 1);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /AI_CONNECTION.*ECONNRESET/);
    assert.equal(JSON.parse(failed.error_detail).stage, "Reading your request");
    assert.equal(JSON.parse(failed.error_detail).attempt, 3);
    assert.throws(() => builder.retry("other", p.id, job.id), /not found/);
    assert.throws(() => builder.store.detail("other", p.id), /not found/);
    const originalPayload = builder.store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(job.id).payload;
    succeed = true;
    assert.equal(builder.retry("owner", p.id, job.id).id, job.id);
    assert.equal(builder.store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(job.id).payload, originalPayload);
    await builder.tick();
    const recovered = builder.store.detail("owner", p.id);
    assert.equal(recovered.project.revision, 2);
    assert.equal(recovered.jobs[0].status, "completed");
    assert.equal(recovered.jobs[0].error_detail, null);
    assert.equal(recovered.messages.filter(m => m.role === "user").length, 1);
    assert.equal(calls[1].prompt, payload.prompt);
    assert.deepEqual(calls[1].diagnostics, payload.diagnostics);
    assert.match(logs.join("\n"), /ECONNRESET/);
    assert.doesNotMatch(logs.join("\n"), /private message/);

    const old = builder.store.enqueue("owner", p.id, "edit", { prompt: "old", revision: 2 });
    builder.store.finish({ ...old, project_id: p.id }, "old failed");
    const newer = builder.store.enqueue("owner", p.id, "edit", { prompt: "new", revision: 2 });
    builder.store.finish({ ...newer, project_id: p.id }, "new failed");
    assert.throws(() => builder.retry("owner", p.id, old.id), /newer edit/);
    builder.store.saveRevision("owner", p.id, starter("board", "Manual change"), "manual");
    assert.throws(() => builder.retry("owner", p.id, newer.id), /older version/);
  } finally { console.error = savedError; builder.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
