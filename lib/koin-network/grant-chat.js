"use strict";

// Existing account authentication and signed spend grants are reused for an
// explicitly selected rehearsal. Their USD limits NEVER become KOIN funding
// authority. A separate operator-created synthetic session bounds every job.
const P = require("./job-protocol");
const fault = (message, status = 400) => Object.assign(Error(message), { status });
const identity = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw fault("Invalid account or grant identity");
  return value;
};

function createGrantBindings({ accounts, bindings, meter }) {
  if (!Array.isArray(bindings) || bindings.length > 32 || !accounts) throw Error("Explicit shadow grant bindings and accounts required");
  const map = new Map(), sessions = new Set();
  for (const value of bindings) {
    if (!value || Object.keys(value).sort().join() !== "accountId,grantId,maxOutput,model,session,version") throw Error("Invalid shadow grant binding");
    const b = Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    identity(b.accountId); identity(b.grantId); P.digest(b.session);
    const t = meter.entry(b.model, b.version).tariff;
    P.integer(b.maxOutput, 1, t.maxOutputTokens);
    const key = JSON.stringify([b.accountId, b.grantId]);
    if (map.has(key) || sessions.has(b.session)) throw Error("Duplicate shadow grant binding");
    sessions.add(b.session); map.set(key, Object.freeze({ ...b, hash: P.hash(JSON.stringify(b)) }));
  }
  function resolve(accountId, grantId) {
    const binding = map.get(JSON.stringify([identity(accountId), identity(grantId)]));
    if (!binding) throw fault("This grant is not enabled for the KOIN rehearsal", 403);
    const account = accounts.accountById(accountId);
    if (!account) throw fault("Account is unavailable", 401);
    const grant = accounts.spendableGrant(accountId, grantId);
    if (!accounts.accountView(account).wallets.some(w => w.address === grant.address)) throw fault("Wallet is no longer linked", 403);
    return { binding, owner: grant.address };
  }
  function authorize({ accountId, grantId, session, owner, quote }) {
    const current = resolve(accountId, grantId), b = current.binding;
    if (b.session !== session || current.owner !== owner || quote.policyHash !== meter.policyHash ||
        quote.tariff.model !== b.model || quote.tariff.version !== b.version || quote.maxOutput > b.maxOutput) throw fault("Request exceeds the bound shadow grant", 403);
    return { mode: "shadow", accountId, grantId, bindingHash: b.hash };
  }
  function authenticate(req, body) {
    // Match Scheduler's existing account path. No request body/header can
    // manufacture the trustedAccountId property used by in-process tasks.
    const account = typeof req.trustedAccountId === "string" ? accounts.accountById(req.trustedAccountId) :
      accounts.sessionAccount(typeof body.sessionToken === "string" ? body.sessionToken : "");
    if (!account) throw fault("Sign in again before using the KOIN rehearsal", 401);
    return { accountId: account.id, grantId: identity(body.grantId), ...resolve(account.id, body.grantId) };
  }
  return { authorize, authenticate };
}

function createGrantChat({ ledger, meter, bindings, payloads, sweep, clock = Date.now, waitMs = 180000 }) {
  P.integer(waitMs, 1, 300000);
  const answers = new Map(), waiting = new Set();
  let closed = false;
  const prune = () => { for (const [id, item] of answers) if (clock() >= item.expires) answers.delete(id); };
  function remember(job, output) {
    if (!job.delegatedAuthorization) return;
    prune();
    if (answers.size >= 32 && !answers.has(job.id)) answers.delete(answers.keys().next().value);
    answers.set(job.id, { output, expires: clock() + 300000 });
  }
  function authorizeJob(job) {
    if (!job.delegatedAuthorization) return true;
    const { accountId, grantId } = job.delegatedAuthorization;
    try {
      const auth = bindings.authorize({ accountId, grantId, session: job.session,
        owner: ledger.get("grants", job.session).owner, quote: job.quote });
      return JSON.stringify(auth) === JSON.stringify(job.delegatedAuthorization);
    } catch { return false; }
  }
  function owned(job, who) {
    const auth = job.delegatedAuthorization;
    if (job.session !== who.binding.session || !auth || auth.accountId !== who.accountId || auth.grantId !== who.grantId ||
        auth.bindingHash !== who.binding.hash || ledger.get("grants", job.session).owner !== who.owner) throw fault("Request is not owned by this grant", 403);
  }
  function completion(job) {
    prune();
    const answer = answers.get(job.id);
    if (!answer) throw fault("This request was already accepted, but its answer is no longer retained. It will not be run again automatically.", 409);
    return { id: job.id, object: "chat.completion", model: "koinos-network", servedModel: job.quote.tariff.model,
      choices: [{ index: 0, message: { role: "assistant", content: answer.output }, finish_reason: "stop" }],
      usage: { prompt_tokens: job.receipt.usage.inputTokens, completion_tokens: job.receipt.usage.outputTokens,
        total_tokens: job.receipt.usage.inputTokens + job.receipt.usage.outputTokens },
      costUsd: 0, koin: { mode: "shadow", paymentsEnabled: false, state: job.state, quote: job.quote,
        receipt: job.receipt, receiptHash: job.receiptHash } };
  }
  const json = (res, code, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value));
  };
  async function handle(req, res, body) {
    let id, listening = false, disconnected = false, finished = false;
    const disconnect = () => { disconnected = true; };
    try {
      if (closed) throw fault("KOIN rehearsal is stopping", 503);
      if (body.billing !== "koin-shadow" || body.signature || body.address || body.selfHost ||
          Object.keys(body).some(key => !["billing", "messages", "model", "max_tokens", "stream", "sessionToken", "grantId", "requestId"].includes(key))) throw fault("Unsupported KOIN rehearsal request");
      id = P.digest(body.requestId);
      const who = bindings.authenticate(req, body), b = who.binding;
      const messages = P.messages(body.messages), requestHash = P.hash(JSON.stringify(messages));
      if (body.model && body.model !== "auto" && body.model !== b.model) throw fault("Selected model is outside this rehearsal grant");
      const maxOutput = body.max_tokens === undefined ? b.maxOutput : P.integer(body.max_tokens, 1, b.maxOutput);
      if (body.stream !== undefined && typeof body.stream !== "boolean") throw fault("Invalid stream flag");
      sweep();
      // Do not catch a corrupt database as if it were a missing request.
      const row = ledger.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
      let job = row ? JSON.parse(row.data) : null;
      if (job) {
        owned(job, who);
        if (job.quote.requestHash !== requestHash || job.quote.tariff.model !== b.model || job.quote.maxOutput !== maxOutput) throw fault("Request ID was already used with different terms", 409);
      }
      if (waiting.has(id)) throw fault("This request is already running; keep its request ID", 409);
      if (waiting.size >= 32 || (!payloads.has(id) && payloads.size >= 32)) throw fault("KOIN rehearsal queue is full", 429);
      if (!job) {
        // A declined request must not accumulate orphan quotes after a grant
        // is exhausted. These synchronous steps cannot interleave with another
        // HTTP request; preserve a quote if it already existed.
        const q = P.validateQuote(meter.quote(ledger.domain, b.model, b.version, messages, maxOutput, ledger.now()));
        const inserted = ledger.db.prepare("INSERT OR IGNORE INTO quotes VALUES (?, ?)").run(q.hash, JSON.stringify(q)).changes;
        try {
          job = ledger.reserveDelegated({ id, session: b.session, quoteHash: q.hash, accountId: who.accountId, grantId: who.grantId });
        } catch (e) {
          if (inserted) ledger.db.prepare("DELETE FROM quotes WHERE hash=?").run(q.hash);
          throw e;
        }
      }
      waiting.add(id); listening = true;
      res.on("close", disconnect);
      if (job.state === "cancelled") throw fault("This request was cancelled; it will not be restarted automatically", 409);
      if (["reserved", "dispatched"].includes(job.state)) {
        const prompt = meter.entry(b.model, b.version).render(messages);
        if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 131072 || P.hash(prompt) !== job.quote.promptHash) throw fault("Prompt commitment mismatch");
        payloads.set(id, { prompt, messages });
      }
      const until = clock() + waitMs;
      while (["reserved", "dispatched"].includes(job.state)) {
        if (closed || disconnected || res.destroyed) throw fault("Request stopped", 499);
        bindings.authenticate(req, body); // sign-out/revocation also stops an open request
        if (!authorizeJob(job)) throw fault("The spending grant changed or was revoked", 403);
        if (clock() >= until) throw fault("KOIN rehearsal timed out", 504);
        await new Promise(resolve => setTimeout(resolve, 50));
        if (closed) throw fault("KOIN rehearsal is stopping", 503);
        sweep(); job = ledger.get("jobs", id);
      }
      if (job.state === "cancelled") throw fault("KOIN rehearsal expired or was cancelled", 409);
      bindings.authenticate(req, body); owned(job, who);
      const result = completion(job);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`data: ${JSON.stringify({ model: result.servedModel, delta: result.choices[0].message.content })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, usage: result.usage, costUsd: 0, koin: result.koin, requestId: id })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else json(res, 200, result);
      finished = true;
    } catch (e) {
      json(res, e.status || 400, { error: { message: String(e.message).slice(0, 220), type: "koin_shadow_error" },
        requestId: id || null, mode: "shadow", paymentsEnabled: false });
    } finally {
      if (listening) {
        res.removeListener("close", disconnect); waiting.delete(id);
        if (!finished && !closed) {
          const job = ledger.get("jobs", id);
          if (["reserved", "dispatched"].includes(job.state)) { ledger.cancel(id); payloads.delete(id); }
          // Accepted/uncertain jobs retain their hold even if delivery failed.
        }
      }
    }
  }
  return { handle, remember, authorizeJob, close() { closed = true; answers.clear(); } };
}
module.exports = { createGrantBindings, createGrantChat };
