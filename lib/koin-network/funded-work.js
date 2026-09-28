"use strict";
const P = require("./job-protocol"), D = require("./session-delegation");
const fault = (message, status = 400) => Object.assign(Error(message), { status });

// Prompts and answers exist only in this process. The durable ledger controls
// admission/dispatch; a lost dispatched request is never automatically rerun.
function createFundedWork({ ledger, accounts, meter, target, qualify, accept, clock = Date.now, waitMs = 180000 }) {
  if (typeof qualify !== "function" || typeof accept !== "function") throw Error("Funded work requires qualification and acceptance policies");
  P.integer(waitMs, 1, 300000); target = D.target(target);
  const payloads = new Map(), answers = new Map(), waiting = new Set(), polling = new Set();
  let closed = false;
  const auth = body => {
    const account = accounts.sessionAccount(typeof body.sessionToken === "string" ? body.sessionToken : "");
    if (!account) throw fault("Sign in again", 401);
    return account.id;
  };
  const json = (res, code, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value));
  };
  function sweep() {
    for (const [id, p] of payloads) {
      const h = ledger.job(id);
      if (h?.state === "reserved") {
        try {
          ledger.delegation(p.who);
          if (clock() >= h.quote.expires) throw Error("Expired");
        } catch { ledger.releaseQueued({ ...p.who, delegationId: p.who.id, id }); }
      }
      const current = ledger.job(id);
      if (!current || !["reserved", "dispatched"].includes(current.state) ||
          (current.state === "dispatched" && clock() > current.deadline)) payloads.delete(id);
    }
    for (const [id, a] of answers) if (clock() >= a.expires) answers.delete(id);
  }
  const timer = setInterval(() => { if (!closed) sweep(); }, 1000); timer.unref();
  function remember(h, output) {
    if (answers.size >= 32 && !answers.has(h.id)) answers.delete(answers.keys().next().value);
    answers.set(h.id, { output, expires: clock() + 300000 });
  }
  function completion(h) {
    sweep(); const answer = answers.get(h.id);
    if (!answer) throw fault("The answer is no longer retained. This request will not be run again automatically.", 409);
    return { id: h.id, object: "chat.completion", model: "koinos-network", servedModel: h.quote.tariff.model,
      choices: [{ index: 0, message: { role: "assistant", content: answer.output }, finish_reason: "stop" }],
      usage: { prompt_tokens: h.receipt.usage.inputTokens, completion_tokens: h.receipt.usage.outputTokens,
        total_tokens: h.receipt.usage.inputTokens + h.receipt.usage.outputTokens }, costUsd: 0,
      koin: { mode: "funded-rehearsal", paymentsEnabled: false, state: h.state, delegationId: h.delegationId,
        target, quote: h.quote, tariffs: meter.tariffs(), receipt: h.receipt, receiptHash: h.receiptHash,
        settlement: h.intent ? { state: "prepared", intent: h.intent, hash: h.intentHash } : { state: "waiting" } } };
  }
  async function chat(req, res, body) {
    let id, who, ownsWait = false, admitted = false, disconnected = false, success = false;
    const disconnect = () => { disconnected = true; };
    res.on("close", disconnect);
    try {
      if (closed) throw fault("Funded rehearsal is stopping", 503);
      if (!body || body.billing !== "koin-funded-rehearsal" ||
          Object.keys(body).some(k => !["billing", "messages", "model", "max_tokens", "stream", "sessionToken", "grantId", "delegationId", "observationId", "requestId"].includes(k))) throw fault("Unsupported funded rehearsal request");
      id = P.digest(body.requestId);
      who = { id: P.digest(body.delegationId), accountId: auth(body), grantId: D.identity(body.grantId) };
      const old = ledger.ownedJob({ id, delegationId: who.id, accountId: who.accountId, grantId: who.grantId });
      const scope = old ? ledger.delegationStatus({ id: who.id, accountId: who.accountId }) : ledger.delegation(who);
      const messages = P.messages(body.messages), requestHash = P.hash(JSON.stringify(messages));
      if (body.model && body.model !== "auto" && body.model !== scope.model) throw fault("Selected model exceeds session approval");
      const maxOutput = body.max_tokens === undefined ? scope.maxOutput : P.integer(body.max_tokens, 1, scope.maxOutput);
      if (body.stream !== undefined && typeof body.stream !== "boolean") throw fault("Invalid stream flag");
      if (old && (old.quote.requestHash !== requestHash || old.quote.maxOutput !== maxOutput)) throw fault("Request ID already used with different terms", 409);
      if (waiting.has(id)) throw fault("This request is already running; keep its request ID", 409);
      sweep();
      if (waiting.size >= 32 || (!old && payloads.size >= 32)) throw fault("Funded rehearsal queue is full", 429);
      waiting.add(id); ownsWait = true;
      let h = old;
      if (!h || h.state === "reserved") {
        const quote = h?.quote || ledger.quote(scope.model, scope.version, messages, maxOutput);
        h = await ledger.reserveDelegated({ id, observationId: body.observationId, quote,
          delegationId: who.id, accountId: who.accountId, grantId: who.grantId });
        admitted = true;
      }
      if (closed || disconnected || res.destroyed || auth(body) !== who.accountId) throw fault("Request stopped", 499);
      if (h.state === "reserved") {
        ledger.delegation(who);
        const prompt = meter.entry(scope.model, scope.version).render(messages);
        if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 131072 || P.hash(prompt) !== h.quote.promptHash) throw fault("Prompt commitment mismatch");
        if (!payloads.has(id) && payloads.size >= 32) throw fault("Funded rehearsal queue is full", 429);
        payloads.set(id, { prompt, messages, who, observationId: P.digest(body.observationId) });
      } else if (h.state === "dispatched" && !payloads.has(id)) {
        throw fault("Dispatched work remains held and cannot be restarted automatically", 409);
      }
      const until = Date.now() + waitMs;
      while (["reserved", "dispatched"].includes(h.state)) {
        if (closed || disconnected || res.destroyed) throw fault("Request stopped", 499);
        if (auth(body) !== who.accountId) throw fault("Account changed", 401);
        if (Date.now() >= until || (h.deadline && clock() > h.deadline)) throw fault("Request timed out; dispatched work remains held", 504);
        await new Promise(resolve => setTimeout(resolve, 25));
        if (closed) throw fault("Funded rehearsal is stopping", 503);
        sweep(); h = ledger.job(id);
      }
      if (h.state === "cancelled") throw fault("Request cancelled; it will not be restarted automatically", 409);
      if (auth(body) !== who.accountId) throw fault("Account changed", 401);
      const result = completion(h);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`data: ${JSON.stringify({ model: result.servedModel, delta: result.choices[0].message.content })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, usage: result.usage, costUsd: 0, koin: result.koin, requestId: id })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else json(res, 200, result);
      success = true;
    } catch (e) {
      json(res, e.status || 400, { error: { message: String(e.message).slice(0, 220), type: "koin_funded_rehearsal_error" },
        requestId: id || null, mode: "funded-rehearsal", paymentsEnabled: false });
    } finally {
      res.removeListener("close", disconnect);
      if (ownsWait) {
        waiting.delete(id);
        if (!success && !closed && admitted) {
          const h = ledger.releaseQueued({ id, delegationId: who.id, accountId: who.accountId });
          if (h?.state !== "dispatched") payloads.delete(id);
        }
      }
    }
  }
  async function next(worker, stillAvailable = () => true) {
    if (closed || worker?.proof !== "signed" || worker.capabilities?.koinFundedRehearsalJobs !== 1 || polling.has(worker.address)) return null;
    polling.add(worker.address);
    try {
      sweep(); if (ledger.busy(worker.address)) return null;
      for (const [id, p] of payloads) {
        const h = ledger.job(id);
        if (h?.state !== "reserved" || h.owner === worker.address || !worker.models?.includes(h.quote.tariff.model) ||
            qualify(worker.address, h.quote.tariff.model, h.quote.tariff.modelHash, clock()) !== true) continue;
        // Fresh RPC verification is asynchronous; the ledger checks the account,
        // session, budget and state again in the dispatch transaction.
        const d = await ledger.markDispatched({ id, observationId: p.observationId, provider: worker.address,
          available: () => !closed && stillAvailable() && qualify(worker.address, h.quote.tariff.model, h.quote.tariff.modelHash, clock()) === true });
        return { id, type: "koin-funded-rehearsal-chat", paymentsEnabled: false, target, session: d.session,
          model: d.quote.tariff.model, prompt: p.prompt, quote: d.quote, attempt: d.attempt,
          dispatchedAt: d.dispatchedAt, deadline: d.deadline };
      }
      return null;
    } finally { polling.delete(worker.address); }
  }
  function acceptResult({ job, output }) {
    const p = payloads.get(job.id);
    return !closed && !!p && qualify(job.provider, job.quote.tariff.model, job.quote.tariff.modelHash, clock()) === true &&
      accept({ job, messages: structuredClone(p.messages), output }) === true;
  }
  async function handle(req, res, workerAuth) {
    if (new URL(req.url, "http://scheduler").pathname !== "/koin/funded/rehearsal/result") return false;
    try {
      if (closed || req.method !== "POST") throw Error("Funded worker result unavailable");
      const worker = workerAuth(req);
      if (worker?.proof !== "signed" || worker.capabilities?.koinFundedRehearsalJobs !== 1) throw fault("Opted-in signed worker required", 401);
      let size = 0; const chunks = [];
      for await (const part of req) { size += part.length; if (size > 1500000) throw Error("Result too large"); chunks.push(part); }
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8")), h = ledger.job(P.digest(b.jobId));
      if (!h?.delegationId || h.provider !== worker.address) throw Error("Different assigned provider");
      ledger.complete({ id: h.id, output: b.output, signature: b.signature });
      remember(h, b.output); payloads.delete(h.id);
      // Verified results retain their charge while an earlier nonce is pending.
      // Preparation never has access to a signer, keeper or broadcast provider.
      try { ledger.prepare(h.id); } catch (e) {
        if (!/Previous settlement unresolved|Session needs reconciliation or expired settlement window/.test(e.message)) throw e;
      }
      const done = ledger.job(h.id);
      json(res, 200, { ok: true, mode: "funded-rehearsal", paymentsEnabled: false, accepted: true, receiptHash: done.receiptHash });
    } catch (e) { json(res, e.status || 400, { ok: false, mode: "funded-rehearsal", paymentsEnabled: false, error: String(e.message).slice(0, 220) }); }
    return true;
  }
  return { chat, next, handle, accept: acceptResult, busy: provider => ledger.busy(provider),
    close() {
      closed = true; clearInterval(timer);
      for (const [id, p] of payloads) ledger.releaseQueued({ id, delegationId: p.who.id, accountId: p.who.accountId });
      payloads.clear(); answers.clear();
    } };
}
module.exports = { createFundedWork };
