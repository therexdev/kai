"use strict";
const path = require("path"), { PrepaidLedger } = require("./prepaid-ledger"), { PrepaidPurchases } = require("./prepaid-purchases");
const P = require("./job-protocol"), { protocol } = require("./payment-network");
function createPrepaidRouter({ dataDir, accounts, client, target, meter, encryptionKey, qualify, accept, clock = Date.now, waitMs = 180000 }) {
  const ledger = new PrepaidLedger(path.join(dataDir, "prepaid"), { target, meter, encryptionKey, clock, waitMs });
  const purchases = new PrepaidPurchases(client, ledger, { clock }), wire = protocol(target), payloads = new Map(), waiting = new Set();
  let closed = false;
  const json = (res, code, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ product: "prepaid-v1", mode: wire.mode, paymentsEnabled: wire.paymentsEnabled, ...value })); } };
  const auth = b => {
    const a = accounts.sessionAccount(b?.sessionToken), wallets = a && accounts.accountView(a).wallets;
    if (!a || wallets?.length !== 1) throw Object.assign(Error("Sign in to use your credits"), { status: 401 });
    return wallets[0].address;
  };
  const sweep = () => { ledger.sweep(); for (const id of payloads.keys()) if (!["queued", "running"].includes(ledger.job(id)?.state)) payloads.delete(id); };
  const timer = setInterval(() => { sweep(); ledger.pruneAnswers(); }, 1000); timer.unref();
  function completion(j) {
    if (!j.answer) throw Error("This answer is saved on the computer that requested it");
    const output = ledger.decrypt(j.id, j.answer);
    // Commit the one debit before exposing plaintext. A client cannot read an
    // answer, withhold its acknowledgement, cancel, and repeat for free.
    // The durable encrypted answer makes a lost HTTP response recoverable with
    // this same request ID and no second debit.
    j = ledger.acknowledge(j.id, j.owner, j.receiptHash);
    return { id: j.id, object: "chat.completion", model: "koinos-network", servedModel: j.quote.tariff.model,
      choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }],
      usage: { prompt_tokens: j.receipt.usage.inputTokens, completion_tokens: j.receipt.usage.outputTokens, total_tokens: j.receipt.usage.inputTokens + j.receipt.usage.outputTokens }, costUsd: 0,
      koin: { product: "prepaid-v1", mode: wire.mode, paymentsEnabled: wire.paymentsEnabled, state: j.state, target, quote: j.quote,
        session: j.session, receipt: j.receipt, receiptHash: j.receiptHash, credits: j.receipt.usage.amount } };
  }
  async function chat(req, res, b) {
    let id, owner, ownsWait = false, answered = false;
    const stop = () => { if (!closed && !answered && ownsWait) { ledger.cancel(id, owner); payloads.delete(id); } };
    res.on("close", stop);
    try {
      if (closed) throw Error("The network is restarting. Please try again.");
      if (!b || b.billing !== "koin-prepaid-v1" || Object.keys(b).some(k => !["billing", "sessionToken", "requestId", "model", "messages", "max_tokens"].includes(k))) throw Error("Invalid credit chat request");
      owner = auth(b); id = P.digest(b.requestId);
      if (waiting.has(id)) throw Error("This message is already being answered");
      waiting.add(id); ownsWait = true;
      const messages = P.messages(b.messages), tariff = meter.tariffs().find(t => t.model === b.model);
      if (!tariff) throw Error("Choose an available network model");
      let j = ledger.reserve({ id, owner, model: tariff.model, version: tariff.version, messages, maxOutput: P.integer(b.max_tokens, 1, tariff.maxOutputTokens) });
      if (j.state === "queued") {
        const prompt = meter.entry(tariff.model, tariff.version).render(messages);
        if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 131072 || P.hash(prompt) !== j.quote.promptHash) throw Error("Model prompt mismatch");
        payloads.set(id, { prompt, messages });
      }
      while (["queued", "running"].includes(j.state)) {
        if (closed || res.destroyed || auth(b) !== owner) throw Error("Chat stopped without a charge");
        await new Promise(resolve => setTimeout(resolve, 25)); if (closed) throw Error("The network is restarting. Please try again."); sweep(); j = ledger.job(id, owner);
      }
      if (!["ready", "charged"].includes(j.state)) throw Error("No answer was delivered. Your credits are available; please try again.");
      if (res.destroyed || auth(b) !== owner) throw Error("Chat disconnected");
      answered = true; json(res, 200, { ok: true, completion: completion(j) });
    } catch (e) { stop(); json(res, e.status || 400, { ok: false, error: String(e.message).slice(0, 220), requestId: id }); }
    finally { res.removeListener("close", stop); if (ownsWait) waiting.delete(id); }
  }
  async function next(worker, available = () => true) {
    sweep();
    if (closed || worker?.proof !== "signed" || worker.capabilities?.[wire.capability] !== 1 || ledger.busy(worker.address) || !available()) return null;
    for (const [id, p] of payloads) {
      const j = ledger.job(id);
      if (j?.state !== "queued" || j.owner === worker.address || !worker.models?.includes(j.quote.tariff.model) || qualify(worker.address, j.quote.tariff.model, j.quote.tariff.modelHash, clock()) !== true) continue;
      const d = ledger.dispatch(id, worker.address);
      return { id, type: wire.jobType, paymentsEnabled: wire.paymentsEnabled, target, session: d.session, model: d.quote.tariff.model,
        prompt: p.prompt, quote: d.quote, attempt: d.attempt, dispatchedAt: d.dispatchedAt, deadline: d.deadline };
    }
    return null;
  }
  async function handle(req, res, workerAuth) {
    const route = new URL(req.url, "http://scheduler").pathname;
    if (!route.startsWith("/koin/prepaid/") && route !== wire.prefix + "result") return false;
    try {
      if (closed || req.method !== "POST") throw Error("POST required");
      let size = 0; const chunks = [];
      for await (const part of req) { size += part.length; if (size > (route.endsWith("result") ? 1500000 : 4096)) throw Error("Request too large"); chunks.push(part); }
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (route === wire.prefix + "result") {
        const w = workerAuth(req), j = ledger.job(P.digest(b.jobId));
        if (w?.proof !== "signed" || w.capabilities?.[wire.capability] !== 1 || j?.provider !== w.address) throw Error("Assigned signed provider required");
        const p = payloads.get(j.id);
        const accepted = !!p && qualify(w.address, j.quote.tariff.model, j.quote.tariff.modelHash, clock()) === true && accept({ job: j, messages: p.messages, output: b.output }) === true;
        let done;
        try { done = ledger.complete(j.id, b, accepted); }
        catch (e) { ledger.cancel(j.id, j.owner, "provider_result_rejected"); payloads.delete(j.id); throw e; }
        payloads.delete(j.id);
        json(res, 200, { ok: true, accepted: true, receiptHash: done.receiptHash }); return true;
      }
      const action = route.slice("/koin/prepaid/".length), fields = { status: [], purchase: ["txId"], acknowledge: ["requestId", "receiptHash"], cancel: ["requestId"], result: ["requestId"] }[action];
      if (!fields || Object.keys(b).some(k => !["sessionToken", ...fields].includes(k))) throw Error("Invalid credit request");
      const owner = auth(b); let result;
      if (action === "status") result = { balance: ledger.balance(owner), purchases: ledger.purchases(owner).slice(0, 50),
        usage: ledger.usage(owner).map(j => ({ id: j.id, at: j.chargedAt, credits: j.receipt.usage.amount, model: j.quote.tariff.model })) };
      if (action === "purchase") result = { purchase: ledger.queuePurchase(b.txId, owner) };
      if (action === "acknowledge") result = { state: ledger.acknowledge(b.requestId, owner, b.receiptHash).state, balance: ledger.balance(owner) };
      if (action === "cancel") { const j = ledger.cancel(b.requestId, owner); payloads.delete(b.requestId); result = { state: j?.state || "unknown", balance: ledger.balance(owner) }; }
      if (action === "result") { const j = ledger.job(b.requestId, owner); result = ["ready", "charged"].includes(j?.state) ? { state: "charged", completion: completion(j) } : { state: j?.state || "unknown" }; }
      json(res, 200, { ok: true, owner, ...result });
    } catch (e) { json(res, e.status || 400, { ok: false, error: String(e.message).slice(0, 220) }); }
    return true;
  }
  const work = { chat, next, busy: owner => ledger.busy(owner) };
  return { handle, ledger, work, purchases, close() { closed = true; clearInterval(timer); for (const id of payloads.keys()) ledger.cancel(id, ledger.job(id).owner, "service_stopped"); payloads.clear(); ledger.close(); } };
}
module.exports = { createPrepaidRouter };
