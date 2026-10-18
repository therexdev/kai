"use strict";
const path = require("path"), { PrepaidLedger } = require("./prepaid-ledger"), { PrepaidPurchases } = require("./prepaid-purchases");
const P = require("./job-protocol"), { protocol } = require("./payment-network");
function createPrepaidRouter({ dataDir, accounts, client, target, meter, encryptionKey, qualify, accept, clock = Date.now, waitMs = 180000, purchaseQuote, freePolicy, publicAccounts = false, networkOverview }) {
  if (publicAccounts && !require("./product").isUsd(client.d)) throw Error("Public accounts require USD credits");
  const ledger = new PrepaidLedger(path.join(dataDir, "prepaid"), { target, meter, encryptionKey, clock, waitMs, product: client.d.product, freePolicy, ownershipWallets: o => accounts.accountView({ id: o.accountId }).wallets.map(w => w.address) });
  const purchases = new PrepaidPurchases(client, ledger, { clock }), wire = protocol(target), payloads = new Map(), waiting = new Set(), consumers = new Map();
  let closed = false;
  const json = (res, code, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ product: client.d.product, mode: wire.mode, paymentsEnabled: wire.paymentsEnabled, ...value })); } };
  const account = (b, req) => {
    const a = accounts.sessionAccount(b?.sessionToken), wallets = a && accounts.accountView(a).wallets;
    if (!a || typeof a.id !== "string" || !a.id || !Array.isArray(wallets) || wallets.length > 64 || (!freePolicy && !publicAccounts && wallets.length !== 1))
      throw Object.assign(Error("Sign in to use your credits"), { status: 401 });
    const wallet = require("./credit-wallet").select(wallets, b, { walletless: !!freePolicy || publicAccounts });
    const accountId = P.hash("verified-account:" + a.id), owner = wallet || "account-" + accountId;
    // Do not trust X-Forwarded-For supplied by a client. Deployments behind a
    // proxy share a conservative origin cap until a trusted origin adapter is
    // configured. The origin is a risk budget, not an account identity.
    return { owner, wallet, accountId, ownership: { accountId: a.id, wallets: wallets.map(w => w.address) }, identity: freePolicy || publicAccounts ? { accountId, origin: P.hash("origin:" + (req?.socket?.remoteAddress || "unknown")) } : undefined };
  };
  const requestOwner = (id, a) => { const j = ledger.job(id); return j?.funding?.accountId === a.identity?.accountId && a.identity ? j.owner : a.owner; };
  const sweep = () => { ledger.sweep(); for (const id of payloads.keys()) if (!["queued", "running"].includes(ledger.job(id)?.state)) payloads.delete(id); };
  const timer = setInterval(() => { sweep(); ledger.pruneAnswers(); }, 1000); timer.unref();
  function completion(j) {
    if (!j.answer) throw Error("This answer is saved on the computer that requested it");
    const output = ledger.decrypt(j.id, j.answer);
    // Commit the one debit before exposing plaintext. A client cannot read an
    // answer, withhold its acknowledgement, cancel, and repeat for free.
    // The durable encrypted answer makes a lost HTTP response recoverable with
    // this same request ID and no second debit.
    if (!j.delivered) j = ledger.acknowledge(j.id, j.owner, j.receiptHash);
    return { id: j.id, object: "chat.completion", model: "koinos-network", servedModel: j.quote.tariff.model,
      choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: j.state === "running" ? null : "stop" }],
      usage: { prompt_tokens: j.receipt.usage.inputTokens, completion_tokens: j.receipt.usage.outputTokens, total_tokens: j.receipt.usage.inputTokens + j.receipt.usage.outputTokens }, costUsd: require("./product").isUsd(client.d) ? Number(j.receipt.usage.amount) / 1e8 : 0,
      koin: { product: client.d.product, mode: wire.mode, paymentsEnabled: wire.paymentsEnabled, state: j.state === "running" ? "streaming" : j.state, target, quote: j.quote,
        session: j.session, receipt: j.receipt, receiptHash: j.receiptHash, credits: j.receipt.usage.amount } };
  }
  async function chat(req, res, b) {
    let id, owner, ownsWait = false, answered = false, streaming = false, sentHash;
    const emit = j => {
      if (res.destroyed || res.writableEnded || !streaming) throw Error("Stream disconnected");
      if (res.writableLength > 2000000) throw Error("Stream consumer is too slow; saved reply can be recovered");
      if (j.answer && (j.receiptHash !== sentHash || j.state === "charged")) {
        const value = completion(j); sentHash = j.receiptHash;
        res.write("data: " + JSON.stringify({ ok: true, product: client.d.product, mode: wire.mode, paymentsEnabled: wire.paymentsEnabled, completion: value }) + "\n\n");
      }
    };
    const stop = () => { if (!closed && !answered && ownsWait && ledger.job(id)?.owner === owner) { ledger.cancel(id, owner); payloads.delete(id); } };
    res.on("close", stop);
    try {
      if (closed) throw Error("The network is restarting. Please try again.");
      if (!b || b.billing !== "koin-" + client.d.product || Object.keys(b).some(k => !["billing", "sessionToken", "creditWallet", "requestId", "model", "messages", "max_tokens", "freeOnly", "stream", "maxPaid", "runId"].includes(k))) throw Error("Invalid credit chat request");
      if (b.stream !== undefined && typeof b.stream !== "boolean") throw Error("Invalid stream preference");
      const a = account(b, req); id = P.digest(b.requestId); owner = requestOwner(id, a);
      if (waiting.has(id)) throw Error("This message is already being answered");
      waiting.add(id); ownsWait = true;
      const messages = P.messages(b.messages), tariff = meter.tariffs().find(t => t.model === b.model);
      if (!tariff) throw Error("Choose an available network model");
      let j = ledger.reserve({ id, owner, identity: a.identity, ownership: a.ownership, freeOnly: b.freeOnly ?? false, stream: b.stream === true, maxPaid: b.maxPaid, runId: b.runId, model: tariff.model, version: tariff.version, messages, maxOutput: P.integer(b.max_tokens, 1, tariff.maxOutputTokens) });
      if (b.stream) {
        streaming = true;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.flushHeaders?.();
        consumers.set(id, { live: () => !res.destroyed && !res.writableEnded, emit });
        if (j.answer) emit(j);
      }
      if (j.state === "queued") {
        const prompt = meter.entry(tariff.model, tariff.version).render(messages);
        if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 131072 || P.hash(prompt) !== j.quote.promptHash) throw Error("Model prompt mismatch");
        payloads.set(id, { prompt, messages });
      }
      while (["queued", "running"].includes(j.state)) {
        if (closed || res.destroyed || requestOwner(id, account(b, req)) !== owner) throw Error(j.delivered ? "Chat stopped. Only verified delivered usage was charged; your saved reply can be recovered." : "Chat stopped without a charge");
        await new Promise(resolve => setTimeout(resolve, 25)); if (closed) throw Error("The network is restarting. Please try again."); sweep(); j = ledger.job(id, owner);
      }
      if (!["ready", "charged"].includes(j.state)) throw Error("No answer was delivered. Your credits are available; please try again.");
      if (res.destroyed || requestOwner(id, account(b, req)) !== owner) throw Error("Chat disconnected");
      answered = true;
      if (streaming) { emit(j); res.end("data: [DONE]\n\n"); }
      else json(res, 200, { ok: true, completion: completion(j) });
    } catch (e) {
      stop(); const error = { ok: false, error: String(e.message).slice(0, 220), requestId: id };
      if (streaming) { if (!res.destroyed && !res.writableEnded) res.end("data: " + JSON.stringify(error) + "\n\n"); }
      else json(res, e.status || 400, error);
    }
    finally { res.removeListener("close", stop); if (ownsWait) { waiting.delete(id); consumers.delete(id); } }
  }
  async function next(worker, available = () => true) {
    sweep();
    if (closed || worker?.proof !== "signed" || worker.capabilities?.[wire.capability] !== 1 || ledger.busy(worker.address) || !available()) return null;
    for (const [id, p] of payloads) {
      const j = ledger.job(id);
      if (j?.state !== "queued" || !ledger.rewardEligible(j, worker.address) || !worker.models?.includes(j.quote.tariff.model) || qualify(worker.address, j.quote.tariff.model, j.quote.tariff.modelHash, clock()) !== true) continue;
      if (j.stream && worker.capabilities?.koinMeteredStreaming !== 1) continue;
      const d = ledger.dispatch(id, worker.address);
      return { id, type: wire.jobType, paymentsEnabled: wire.paymentsEnabled, target, session: d.session, model: d.quote.tariff.model,
        prompt: p.prompt, quote: d.quote, attempt: d.attempt, dispatchedAt: d.dispatchedAt, deadline: d.deadline, ...(j.stream ? { stream: true } : {}) };
    }
    return null;
  }
  async function handle(req, res, workerAuth) {
    const route = new URL(req.url, "http://scheduler").pathname;
    if (!route.startsWith("/koin/prepaid/") && ![wire.prefix + "result", wire.prefix + "chunk"].includes(route)) return false;
    try {
      if (closed || req.method !== "POST") throw Error("POST required");
      let size = 0; const chunks = [];
      for await (const part of req) { size += part.length; if (size > (/\/(result|chunk)$/.test(route) ? 1500000 : route.endsWith("/estimate") ? 32768 : 4096)) throw Error("Request too large"); chunks.push(part); }
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (route === wire.prefix + "result" || route === wire.prefix + "chunk") {
        const w = workerAuth(req), j = ledger.job(P.digest(b.jobId));
        if (w?.proof !== "signed" || w.capabilities?.[wire.capability] !== 1 || j?.provider !== w.address) throw Error("Assigned signed provider required");
        const p = payloads.get(j.id);
        const accepted = !!p && qualify(w.address, j.quote.tariff.model, j.quote.tariff.modelHash, clock()) === true && accept({ job: j, messages: p.messages, output: b.output }) === true;
        if (route === wire.prefix + "chunk") {
          const consumer = consumers.get(j.id);
          if (!consumer?.live()) throw Error("Consumer disconnected; no additional usage accepted");
          const done = ledger.streamChunk(j.id, b, accepted); consumer.emit(done);
          json(res, 200, { ok: true, accepted: true, sequence: done.delivered.sequence, receiptHash: done.receiptHash }); return true;
        }
        let done;
        if (j.stream && !consumers.get(j.id)?.live()) { ledger.cancel(j.id, j.owner, "disconnected"); throw Error("Consumer disconnected; no additional usage accepted"); }
        try { done = ledger.complete(j.id, b, accepted); }
        catch (e) { ledger.cancel(j.id, j.owner, "provider_result_rejected"); payloads.delete(j.id); throw e; }
        payloads.delete(j.id);
        json(res, 200, { ok: true, accepted: true, receiptHash: done.receiptHash }); return true;
      }
      const action = route.slice("/koin/prepaid/".length), fields = { capabilities: [], "run-open": ["runId", "model", "mode", "maxTotal", "freeOnly"], "run-status": ["runId"], "run-stop": ["runId"], network: [], quote: ["amount"], "quote-usd": ["dollars"], estimate: ["model", "messages", "max_tokens", "freeOnly", "runId"], status: [], purchase: ["txId"], acknowledge: ["requestId", "receiptHash"], cancel: ["requestId"], result: ["requestId"] }[action];
      if (!fields || Object.keys(b).some(k => !["sessionToken", "creditWallet", ...fields].includes(k))) throw Error("Invalid credit request");
      const a = account(b, req), owner = b.requestId ? requestOwner(P.digest(b.requestId), a) : a.owner; let result;
      if (action === "capabilities") result = { capabilities: { advancedRuns: require("./product").isUsd(client.d) && (!!freePolicy || publicAccounts), models: meter.tariffs().map(t => ({ model: t.model, version: t.version, maxOutput: t.maxOutputTokens })) } };
      if (action === "run-open") result = { run: ledger.runs.open({ id: b.runId, owner, identity: a.identity, model: b.model, mode: b.mode, maxTotal: b.maxTotal, freeOnly: b.freeOnly }) };
      if (action === "run-status") result = { run: ledger.runs.status(b.runId, a.identity) };
      if (action === "run-stop") { result = { run: ledger.runs.stop(b.runId, a.identity) }; sweep(); }
      if (action === "network") { if (!networkOverview) throw Error("Network status unavailable"); result = { network: networkOverview() }; }
      if (["quote", "quote-usd", "purchase"].includes(action) && !a.wallet) throw Error("Connect a payment wallet to buy credits. Free credits do not require a wallet.");
      if (["quote", "quote-usd"].includes(action)) { if (typeof purchaseQuote !== "function") throw Error("USD purchasing is unavailable"); result = { args: await purchaseQuote(owner, action === "quote-usd" ? b.dollars : b.amount, action === "quote-usd" ? "USD" : "KOIN") }; }
      if (action === "estimate") {
        if (b.freeOnly !== undefined && typeof b.freeOnly !== "boolean") throw Error("Invalid Free only preference");
        const tariff = meter.tariffs().find(t => t.model === b.model); if (!tariff) throw Error("Choose an available network model");
        const quote = meter.quote(target.domain, tariff.model, tariff.version, P.messages(b.messages), P.integer(b.max_tokens, 1, tariff.maxOutputTokens), clock());
        if (b.runId) ledger.runs.admit(b.runId, { owner, identity: a.identity, model: b.model, freeOnly: b.freeOnly === true, maximum: quote.maxCharge });
        const credits = ledger.creditView(owner, a.identity, b.model), max = BigInt(quote.maxCharge), free = BigInt(credits.free.available);
        const maxFree = free < max ? free : max, maxPaid = max - maxFree;
        result = { estimate: { model: b.model, unit: credits.unit, maxCharge: String(max), maxFree: String(maxFree), maxPaid: String(maxPaid),
          freeOnly: b.freeOnly === true, allowed: maxPaid <= BigInt(credits.purchased.available) && (!b.freeOnly || maxPaid === 0n), expiresAt: quote.expires }, credits };
      }
      if (action === "status") result = { balance: ledger.balance(owner), credits: ledger.creditView(owner, a.identity), purchases: ledger.purchases(owner).slice(0, 50),
        usage: ledger.usage(owner).map(j => ({ id: j.id, at: j.chargedAt, credits: j.receipt.usage.amount, free: j.funding?.freeUsed || "0", purchased: j.funding?.paidUsed ?? j.receipt.usage.amount, model: j.quote.tariff.model })) };
      if (action === "purchase") result = { purchase: ledger.queuePurchase(b.txId, owner, a.accountId) };
      if (action === "acknowledge") result = { state: ledger.acknowledge(b.requestId, owner, b.receiptHash).state, balance: ledger.balance(owner) };
      if (action === "cancel") { const j = ledger.cancel(b.requestId, owner); payloads.delete(b.requestId); result = { state: j?.state || "unknown", balance: ledger.balance(owner) }; }
      if (action === "result") { const j = ledger.job(b.requestId, owner); result = ["ready", "charged"].includes(j?.state) || j?.delivered ? { state: j.state, completion: completion(j) } : { state: j?.state || "unknown" }; }
      json(res, 200, { ok: true, owner, ...result });
    } catch (e) { json(res, e.status || 400, { ok: false, error: String(e.message).slice(0, 220) }); }
    return true;
  }
  const work = { chat, next, busy: owner => ledger.busy(owner) };
  return { handle, ledger, work, purchases, requiresUnifiedBilling: publicAccounts, close() { closed = true; clearInterval(timer); for (const id of payloads.keys()) ledger.cancel(id, ledger.job(id).owner, "service_stopped"); payloads.clear(); ledger.close(); } };
}
module.exports = { createPrepaidRouter };
