"use strict";

// In-process shadow harness only. The injected transport is operator-owned;
// never distribute its credentials or expose this signer through HTTP/tools.
const crypto = require("crypto");
const P = require("./job-protocol");
const { address } = require("./metering");
const { uint } = require("./policy");
const copy = (v) => structuredClone(v);
const displayKoin = (v) => {
  const n = uint(v);
  return `${n / 100000000n}.${String(n % 100000000n).padStart(8, "0")}`;
};

class ShadowConsumerReview {
  #reviews = new Map(); #transport; #sign; #clock; #owner; #domain; #policy;
  constructor({ owner, domain, policyHash, transport, sign, clock = Date.now }) {
    this.#owner = address(owner); this.#domain = P.domain(domain); this.#policy = P.digest(policyHash);
    if (typeof transport !== "function" || typeof sign !== "function" || typeof clock !== "function") throw Error("Trusted transport and signer required");
    this.#transport = transport; this.#sign = sign; this.#clock = clock;
  }
  async #call(route, body) {
    const r = await this.#transport(route, copy(body));
    if (!r || r.ok !== true || r.mode !== "shadow" || r.paymentsEnabled !== false) throw Error("Invalid shadow response");
    return copy(r);
  }
  async #session(id, charge = "0", active = true) {
    const { session: s } = await this.#call("session", { id: P.digest(id) });
    const now = P.integer(this.#clock());
    if (!s || s.mode !== "shadow" || s.paymentsEnabled !== false || s.id !== id || s.owner !== this.#owner ||
        s.policyHash !== this.#policy) throw Error("Session identity or policy changed");
    P.integer(s.openedAt); P.integer(s.expires, s.openedAt + 1);
    P.integer(s.maxJobs, 1, 10000); P.integer(s.remainingJobs, 0, s.maxJobs);
    if (active && (now < s.openedAt || now >= s.expires || s.remainingJobs < 1 || s.revokedAt !== null)) throw Error("Session expired, revoked or exhausted");
    if (uint(s.spent) + uint(s.held) + uint(s.available) !== uint(s.amount) ||
        uint(s.perJob) > uint(s.amount) || uint(charge) > uint(s.perJob) || uint(charge) > uint(s.available)) throw Error("Session spending limit");
    return s;
  }
  #fresh(q) {
    const now = P.integer(this.#clock());
    if (now < q.at || now >= q.expires) throw Error("Quote expired or not yet valid");
  }
  async review({ session, model, version, messages, maxOutput }) {
    // Bound private prompt retention. No unapproved request is signed.
    for (const [id, r] of this.#reviews) if (r.state === "review" && this.#clock() >= r.quote.expires) this.#reviews.delete(id);
    if (this.#reviews.size >= 32) throw Error("Review queue full");
    const m = P.messages(messages);
    await this.#session(session);
    const q = P.validateQuote((await this.#call("quote", { model, version, messages: m, maxOutput })).quote);
    if (q.domain !== this.#domain || q.policyHash !== this.#policy || q.tariff.model !== model ||
        q.tariff.version !== version || q.maxOutput !== maxOutput || q.requestHash !== P.hash(JSON.stringify(m))) throw Error("Quote differs from requested terms");
    this.#fresh(q);
    const s = await this.#session(session, q.maxCharge);
    // Recheck after awaits so concurrent reviews cannot bypass retention limits.
    if (this.#reviews.size >= 32) throw Error("Review queue full");
    const id = crypto.randomBytes(32).toString("hex");
    this.#reviews.set(id, { state: "review", quote: q, messages: m, session });
    return { reviewId: id, mode: "shadow", paymentsEnabled: false, owner: this.#owner, session,
      quoteHash: q.hash, model: q.tariff.model, tariffVersion: q.tariff.version, inputTokens: q.inputTokens,
      maxOutputTokens: q.maxOutput, maximumChargeAtoms: q.maxCharge, maximumChargeKoin: displayKoin(q.maxCharge),
      sessionAvailableKoin: displayKoin(s.available), perJobLimitKoin: displayKoin(s.perJob),
      expires: Math.min(q.expires, s.expires), notice: "Simulation only. No KOIN will be spent." };
  }
  reject(id) {
    const r = this.#reviews.get(P.digest(id));
    if (!r || r.state !== "review") throw Error("Review is not pending");
    this.#reviews.delete(id);
  }
  async approve(id, quoteHash) {
    const r = this.#reviews.get(P.digest(id));
    if (!r || r.state !== "review" || r.quote.hash !== P.digest(quoteHash)) throw Error("Review changed or already approved");
    // Lock before awaiting: double clicks cannot create additional signatures.
    r.state = "approving";
    try {
      this.#fresh(r.quote); await this.#session(r.session, r.quote.maxCharge); this.#fresh(r.quote);
      const bytes = P.authorizeHash(this.#domain, r.session, id, r.quote.hash);
      const signature = await this.#sign(bytes);
      P.signatureMatches(bytes, signature, this.#owner);
      this.#fresh(r.quote);
      r.request = { id, session: r.session, quoteHash: r.quote.hash, messages: r.messages, signature };
    } catch (e) { this.#reviews.delete(id); throw e; }
    r.state = "uncertain";
    return this.retry(id);
  }
  async retry(id) {
    const r = this.#reviews.get(P.digest(id));
    if (!r || r.state !== "uncertain") throw Error("No uncertain reservation");
    r.state = "sending";
    try {
      const result = await this.#call("reserve", r.request);
      if (result.id !== id || !["reserved", "dispatched", "verified", "prepared", "submitted", "settled", "cancelled"].includes(result.state)) throw Error("Reservation acknowledgment mismatch");
      this.#reviews.delete(id);
      return { id, state: result.state, mode: "shadow", paymentsEnabled: false };
    } catch (e) { r.state = "uncertain"; throw e; }
  }
  async revoke(session) {
    // Existing accepted work stays reserved on the server. No local balance refund.
    await this.#session(session, "0", false);
    const r = await this.#call("revoke", { id: session });
    if (r.session?.id !== session || r.session?.owner !== this.#owner || r.session?.revokedAt == null) throw Error("Revocation acknowledgment mismatch");
    for (const [id, review] of this.#reviews) if (review.session === session && review.state === "review") this.#reviews.delete(id);
    return r.session;
  }
}
module.exports = { ShadowConsumerReview, displayKoin };
