"use strict";
const crypto = require("crypto"), path = require("path");
const { ShadowJobs } = require("./job-ledger");
const P = require("./job-protocol");

// Operator-only experiment control. Workers use their existing authenticated
// poll and this separate result route. Never touches legacy billing/reputation.
function createWorkRouter({ dataDir, operatorSecret, domain, meter, qualify, accept, fundingObserver = null, clock = Date.now }) {
  if (!operatorSecret || typeof qualify !== "function" || typeof accept !== "function") throw Error("Shadow work needs operator, qualification and challenge policy");
  const ledger = new ShadowJobs(path.join(dataDir, "koin-shadow-work"), { domain: P.domain(domain), meter, clock });
  const payloads = new Map();
  const auth = (req) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(req.headers["x-operator-secret"] || "")).digest(),
    crypto.createHash("sha256").update(operatorSecret).digest());
  const send = (res, code, value) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ mode: "shadow", paymentsEnabled: false, ...value })); };
  async function body(req) {
    if (req.body) { if (Buffer.byteLength(JSON.stringify(req.body)) > 1500000) throw Error("Body too large"); return req.body; }
    const chunks = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > 1500000) throw Error("Body too large"); chunks.push(part); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function sweep() {
    const active = new Set(ledger.recover().map((j) => j.id));
    for (const id of payloads.keys()) if (!active.has(id)) payloads.delete(id);
  }
  function next(worker) {
    if (worker?.proof !== "signed" || worker.capabilities?.koinShadowJobs !== 1) return null;
    sweep();
    const active = ledger.recover();
    if (active.some((j) => j.state === "dispatched" && j.provider === worker.address)) return null;
    for (const j of active) {
      if (j.state !== "reserved" || !payloads.has(j.id) || !worker.models?.includes(j.quote.tariff.model) ||
          qualify(worker.address, j.quote.tariff.model, j.quote.tariff.modelHash, clock()) !== true) continue;
      if (ledger.get("grants", j.session).owner === worker.address) continue;
      const d = ledger.dispatch(j.id, worker.address);
      return { id: d.id, type: "koin-shadow-chat", model: d.quote.tariff.model,
        prompt: payloads.get(d.id).prompt, quote: d.quote, attempt: d.attempt,
        dispatchedAt: d.dispatchedAt, deadline: d.deadline };
    }
    return null;
  }
  async function handle(req, res, workerAuth) {
    const url = new URL(req.url, "http://scheduler");
    if (!url.pathname.startsWith("/koin/shadow/jobs/")) return false;
    try {
      if (url.pathname === "/koin/shadow/jobs/result" && req.method === "POST") {
        const worker = workerAuth(req);
        if (worker?.proof !== "signed" || worker.capabilities?.koinShadowJobs !== 1) { send(res, 401, { error: "Opted-in signed worker required" }); return true; }
        const b = await body(req), j = ledger.get("jobs", P.digest(b.jobId));
        if (j.provider !== worker.address) throw Error("Different assigned provider");
        // Signature and SLA checks happen again in complete. Exact successful
        // retries get their original acknowledgment after a lost response.
        P.signatureMatches(P.resultHash(domain, j.id, j.attempt, j.quote.hash, b.output), b.signature, worker.address);
        if (["verified", "prepared", "submitted", "settled"].includes(j.state)) {
          if (j.receipt.outputHash !== P.hash(b.output) || j.receipt.signature !== b.signature) throw Error("Conflicting result replay");
          send(res, 200, { ok: true, accepted: true, receiptHash: j.receiptHash }); return true;
        }
        if (!payloads.has(j.id) || qualify(worker.address, j.quote.tariff.model, j.quote.tariff.modelHash, clock()) !== true) throw Error("Qualification or challenge context unavailable");
        const accepted = accept({ job: structuredClone(j), messages: payloads.get(j.id).messages, output: b.output }) === true;
        const done = ledger.complete(j.id, { output: b.output, signature: b.signature }, { accepted });
        payloads.delete(j.id);
        send(res, 200, { ok: true, accepted: true, receiptHash: done.receiptHash }); return true;
      }
      if (!auth(req)) { send(res, 403, { error: "Operator authentication required" }); return true; }
      if (req.method !== "POST") throw Error("POST required");
      const b = await body(req); sweep();
      if (url.pathname === "/koin/shadow/jobs/grant") {
        send(res, 200, { ok: true, grant: ledger.importSimulationGrant(b) });
      } else if (url.pathname === "/koin/shadow/jobs/funding-observe") {
        if (!fundingObserver) throw Error("Funded session observation is not configured");
        send(res, 200, { ok: true, evidence: await fundingObserver.observe({ id: P.digest(b.id), owner: b.owner }) });
      } else if (url.pathname === "/koin/shadow/jobs/funding-verify") {
        if (!fundingObserver) throw Error("Funded session observation is not configured");
        send(res, 200, { ok: true, evidence: await fundingObserver.verify(P.digest(b.observationId)) });
      } else if (url.pathname === "/koin/shadow/jobs/session") {
        send(res, 200, { ok: true, session: ledger.status(P.digest(b.id)) });
      } else if (url.pathname === "/koin/shadow/jobs/revoke") {
        ledger.revoke(P.digest(b.id)); sweep();
        send(res, 200, { ok: true, session: ledger.status(b.id) });
      } else if (url.pathname === "/koin/shadow/jobs/quote") {
        if (payloads.size >= 32) throw Error("Shadow queue full");
        const quote = ledger.quote(b.model, b.version, P.messages(b.messages), b.maxOutput);
        P.validateQuote(quote); send(res, 200, { ok: true, quote });
      } else if (url.pathname === "/koin/shadow/jobs/reserve") {
        if (!payloads.has(b.id) && payloads.size >= 32) throw Error("Shadow queue full");
        const q = P.validateQuote(ledger.get("quotes", P.digest(b.quoteHash))), m = P.messages(b.messages);
        if (P.hash(JSON.stringify(m)) !== q.requestHash) throw Error("Request differs from quote");
        const entry = meter.entry(q.tariff.model, q.tariff.version);
        if (!entry.render) throw Error("Pinned prompt renderer required");
        const prompt = entry.render(m);
        if (Buffer.byteLength(prompt) > 131072 || P.hash(prompt) !== q.promptHash) throw Error("Rendered prompt differs from quote");
        const j = ledger.reserve({ id: b.id, session: b.session, quoteHash: b.quoteHash, signature: b.signature });
        if (["reserved", "dispatched"].includes(j.state)) payloads.set(j.id, { prompt, messages: m });
        send(res, 200, { ok: true, id: j.id, state: j.state });
      } else if (url.pathname === "/koin/shadow/jobs/status") {
        const j = ledger.get("jobs", P.digest(b.id));
        send(res, 200, { ok: true, id: j.id, state: j.state, receiptHash: j.receiptHash ?? null, usage: j.receipt?.usage ?? null });
      } else if (url.pathname === "/koin/shadow/jobs/cancel") {
        const j = ledger.cancel(P.digest(b.id)); payloads.delete(j.id); send(res, 200, { ok: true, state: j.state });
      } else send(res, 404, { error: "Unknown shadow job route" });
    } catch (e) { send(res, 400, { ok: false, error: String(e.message).slice(0, 180) }); }
    return true;
  }
  return { handle, next, ledger,
    busy: (address) => ledger.recover().some((j) => j.state === "dispatched" && j.provider === address),
    close: () => { payloads.clear(); ledger.close(); } };
}
module.exports = { createWorkRouter };
