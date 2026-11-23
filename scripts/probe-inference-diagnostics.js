"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Signer } = require("koilib");
const D = require("../lib/koin-network/inference-diagnostics"), M = require("../lib/koin-network/managed-protocol"), P = require("../lib/koin-network/job-protocol");
const { ManagedProvider, ManagedMeter } = require("../lib/koin-network/managed-provider"), { Meter } = require("../lib/koin-network/metering");
const { fixture } = require("./helpers/koin-prepaid-fixture"), { service } = require("./helpers/credit-gateway-fixture");
const privateText = "PRIVATE-PROMPT-CREDENTIAL-REASONING-SENTINEL";
const good = () => ({ id: privateText, choices: [{ message: { content: "Answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
const identity = { accountId: P.hash("diagnostic-customer"), origin: P.hash("diagnostic-origin") };
async function setup(t, respond) {
  const signer = Signer.fromSeed("diagnostic-verifier"), verifier = signer.getAddress(), model = M.models[0];
  const freePolicy = { version: 1, accountDaily: "100000000", networkDaily: "300000000", originDaily: "200000000", accountConcurrent: 4, eligibleModels: M.models.map(m => m.model) };
  const f = fixture(t, { product: "prepaid-usd-v1", meter: new ManagedMeter(new Meter()), managedVerifier: verifier, freePolicy });
  const input = { ...f.request("diagnostic-request"), identity, model: model.model, messages: [{ role: "user", content: privateText }], maxOutput: 1024 };
  let calls = 0;
  const provider = new ManagedProvider({ key: privateText, signer, verifier, domain: f.target.domain, clock: f.options.clock, fetchImpl: async (url, init) => {
    if (url.endsWith("/models")) return Response.json({ data: M.models.map(m => ({ id: m.upstream, pricing: { input: Number(m.input) / 1e14, output: Number(m.output) / 1e14, input_cache_read: Number(m.cache) / 1e14 } })) });
    calls++; assert.deepEqual(JSON.parse(init.body), { model: model.upstream, messages: input.messages, max_completion_tokens: 1024, stream: false });
    return respond(init, { f, provider, input });
  } });
  t.after(() => provider.close()); await provider.refresh();
  return { f, input, provider, calls: () => calls };
}
async function failure(s, code) {
  const job = s.f.ledger.reserve(s.input);
  await assert.rejects(s.provider.execute(s.f.ledger, job.id, s.input.messages), e => {
    assert.equal(e.inferenceFailure.code, code); assert.match(e.message, /No credits were charged/); assert.doesNotMatch(JSON.stringify(e), new RegExp(privateText)); return true;
  });
  const failed = s.f.ledger.job(job.id);
  assert.equal(failed.state, "cancelled"); assert.equal(failed.hold, "0"); assert.equal(s.f.ledger.balance(s.f.owner).spent, "0");
  assert.equal(s.f.ledger.creditView(s.f.owner, identity, s.input.model).free.available, "100000000");
  const d = failed.inferenceFailure;
  assert.equal(d.requestId, job.id); assert.equal(d.messageCount, 1); assert.equal(d.requestedOutputTokens, 1024); assert.equal(d.allowedContextTokens, M.models[0].contextTokens);
  assert.ok(d.requestBytes > 0); assert.ok(d.reservedInputTokens >= 100); assert.ok(d.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(d), new RegExp(privateText));
  s.f.restart(); assert.deepEqual(s.f.ledger.job(job.id).inferenceFailure, d);
  s.f.ledger.cancel(job.id, s.f.owner, "generic-cleanup", { code: "internal_error", message: privateText });
  assert.deepEqual(s.f.ledger.job(job.id).inferenceFailure, d);
  await assert.rejects(s.provider.execute(s.f.ledger, job.id, s.input.messages)); assert.equal(s.calls(), 1);
  assert.throws(() => s.f.ledger.job(job.id, "other-owner"));
  return d;
}
test("HTTP rejections retain status, bounded classification and hashed correlation, never raw bodies", async t => {
  for (const status of [400, 401, 402, 429, 503]) {
    const s = await setup(t, async () => new Response(JSON.stringify({ error: { message: "context length exceeded " + privateText } }), { status, headers: { "x-request-id": privateText } }));
    const d = await failure(s, "upstream_http");
    assert.equal(d.upstreamStatus, status); assert.equal(d.upstreamCategory, "context_limit"); assert.equal(d.upstreamIdHash, D.upstreamId(privateText));
    assert.equal(s.provider.ready(s.input.model), status === 400, "preserve existing provider suspension behavior");
  }
});
test("response and usage failures remain distinct without changing validation or availability", async t => {
  const cases = [
    ["invalid_json", () => new Response("{" + privateText)],
    ["invalid_response", () => Response.json({ choices: [{ message: { content: null } }] })],
    ["empty_output", () => { const v = good(); v.choices[0] = { message: { content: "", reasoning_content: privateText }, finish_reason: "length" }; v.usage.completion_tokens_details = { reasoning_tokens: 40 }; return Response.json(v); }],
    ["unsupported_finish", () => { const v = good(); v.choices[0].finish_reason = "content_filter"; return Response.json(v); }],
    ["unexpected_tool_calls", () => { const v = good(); v.choices[0].message.tool_calls = [{ arguments: privateText }]; return Response.json(v); }],
    ["missing_usage", () => { const v = good(); delete v.usage; return Response.json(v); }],
    ["input_usage_out_of_range", () => { const v = good(); v.usage.prompt_tokens = 999999; return Response.json(v); }],
    ["output_usage_out_of_range", () => { const v = good(); v.usage.completion_tokens = 1025; return Response.json(v); }],
    ["inconsistent_usage", () => { const v = good(); v.usage.total_tokens = 1; return Response.json(v); }],
    ["cached_usage_out_of_range", () => { const v = good(); v.usage.prompt_tokens_details = { cached_tokens: 101 }; return Response.json(v); }],
    ["response_too_large", () => new Response("x".repeat(2000001))]
  ];
  for (const [code, response] of cases) {
    const s = await setup(t, async () => response()), d = await failure(s, code);
    assert.equal(d.upstreamStatus, 200); assert.equal(s.provider.ready(s.input.model), true);
    if (code === "empty_output") { assert.equal(d.finishReason, "length"); assert.equal(d.contentChars, 0); assert.equal(d.reasoningChars, privateText.length); assert.equal(d.reasoningTokens, 40); }
  }
});
test("transport, timeout and explicit cancellation preserve the failing stage", async t => {
  for (const code of ["transport_error", "timeout", "cancelled"]) {
    const s = await setup(t, async (init, { provider, input }) => {
      if (code === "transport_error") throw Object.assign(Error(privateText), { cause: { code: "ECONNRESET" } });
      provider.inflight.get(input.id).abort(new DOMException(privateText, code === "timeout" ? "TimeoutError" : "AbortError"));
      init.signal.throwIfAborted();
    });
    const d = await failure(s, code); assert.equal(d.stage, "request");
    if (code === "transport_error") assert.equal(d.transportCode, "ECONNRESET");
  }
});
test("receipt failures are distinguishable, and diagnostics cannot modify a charged job", async t => {
  for (const code of ["receipt_signing_failed", "receipt_validation_failed"]) {
    const s = await setup(t, async () => Response.json(good()));
    if (code === "receipt_signing_failed") s.provider.signer = { signHash: async () => { throw Error(privateText); } };
    else s.f.ledger.completeManaged = () => { throw Error(privateText); };
    const d = await failure(s, code); assert.equal(d.stage, code === "receipt_signing_failed" ? "receipt_signing" : "receipt_validation");
  }
  const s = await setup(t, async () => Response.json(good())), job = s.f.ledger.reserve(s.input);
  await s.provider.execute(s.f.ledger, job.id, s.input.messages);
  const ready = s.f.ledger.job(job.id), charged = s.f.ledger.acknowledge(job.id, s.f.owner, ready.receiptHash);
  s.f.ledger.cancel(job.id, s.f.owner, "late-error", { code: "internal_error" });
  assert.deepEqual(s.f.ledger.job(job.id), charged); assert.equal(charged.inferenceFailure, undefined);
});
test("sanitizer rejects arbitrary fields and HTTP classification has size and time bounds", async () => {
  const clean = D.clean({ code: "empty_output", raw: privateText, message: privateText, requestId: privateText, upstreamIdHash: privateText, finishReason: privateText, transportCode: privateText, inputTokens: privateText, outputTokens: -1, elapsedMs: Infinity });
  assert.deepEqual(clean, { schema: 1, provider: "akashml", code: "empty_output" }); assert.equal(D.clean({ code: privateText }), null);
  assert.equal(await D.httpCategory(new Response("invalid api key " + "x".repeat(9000))), "unknown");
  let cancelled = false; const started = Date.now();
  assert.equal(await D.httpCategory(new Response(new ReadableStream({ cancel() { cancelled = true; } }))), "unknown");
  assert.ok(Date.now() - started < 1500); assert.equal(cancelled, true);
});
test("authenticated HTTP and SSE deliver persistent diagnostics and preserve account isolation and billing", async t => {
  let posts = 0;
  const s = await service(t, { managedFetch: async () => { posts++; const v = good(); v.choices[0].message.content = ""; return Response.json(v); } });
  const alice = await s.signup("diagnostics@example.test"), bob = await s.signup("other-diagnostics@example.test");
  const one = (await s.createKey(alice, { dailyLimitAtoms: "100000000" })).value, two = (await s.createKey(bob, { dailyLimitAtoms: "100000000" })).value;
  const input = { model: M.models[0].model, messages: [{ role: "user", content: privateText }], max_tokens: 1024 };
  const requestIds = [];
  for (const stream of [false, true]) {
    const headers = { authorization: "Bearer " + one.secret, "idempotency-key": "diagnostic-http-" + stream };
    let id;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await s.raw("/v1/chat/completions", { ...input, stream }, headers), text = await r.text();
      assert.equal(r.status, stream ? 200 : 502); assert.doesNotMatch(text, new RegExp(privateText));
      const data = stream ? text.split("\n\n").filter(x => x.startsWith("data: ")).map(x => JSON.parse(x.slice(6)))[0] : JSON.parse(text);
      assert.equal(data.error.code, "managed_empty_output"); assert.equal(data.error.type, "server_error"); assert.equal(data.error.status, 502);
      assert.equal(data.error.diagnostics.stage, "response_validation"); assert.equal(data.error.diagnostics.upstreamStatus, 200);
      assert.equal(data.error.request_id, r.headers.get("x-request-id"));
      id ??= data.error.request_id; assert.equal(data.error.request_id, id);
      assert.equal(s.prepaid.ledger.job(id).inferenceFailure.code, "empty_output");
    }
    assert.equal(posts, stream ? 2 : 1, "same request never repeats upstream POST");
    requestIds.push(id);
    assert.throws(() => s.prepaid.ledger.job(id, "account-" + P.hash("verified-account:" + bob.account.id)));
  }
  const other = await s.raw("/v1/chat/completions", input, { authorization: "Bearer " + two.secret, "idempotency-key": "diagnostic-http-false" });
  assert.equal((await other.json()).error.code, "managed_empty_output");
  assert.ok(!requestIds.includes(other.headers.get("x-request-id"))); assert.equal(posts, 3);
  const start = (await s.call("/auth/device/start", {})).value;
  assert.equal((await s.call("/auth/device/approve", { userCode: start.userCode }, { cookie: alice.cookie })).status, 200);
  const session = (await s.call("/auth/device/poll", start)).value;
  const native = await s.raw("/platform/api/chat", { ...input, stream: true, creditWallet: null, freeOnly: true }, { authorization: "Bearer " + session.token });
  assert.equal(native.status, 200); assert.match(await native.text(), /managed_empty_output/); assert.equal(posts, 4);
  const credits = await s.call("/v1/credits", undefined, { authorization: "Bearer " + one.secret });
  assert.equal(credits.value.credits.free.available, "100000000"); assert.equal(credits.value.credits.purchased.spent, "0");
  assert.equal((await s.call("/health")).value.inferenceDiagnosticsVersion, 1);
});
