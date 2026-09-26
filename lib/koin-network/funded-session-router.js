"use strict";
// Explicitly configured, authenticated accounting rehearsal only. No worker
// dispatch, settlement signer, token transfer or broadcast capability.
const path = require("path");
const P = require("./job-protocol"), D = require("./session-delegation");
const { FundedReservations } = require("./funded-reservations");
function createFundedSessionRouter({ dataDir, accounts, observer, target, meter, accept = null, clock = Date.now }) {
  if (!accounts) throw Error("Funded session rehearsal requires accounts");
  const ledger = new FundedReservations(path.join(dataDir, "koin-funded-sessions"), { accounts, observer, target, meter, accept, clock });
  const respond = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ mode: "funded-rehearsal", paymentsEnabled: false, ...value }));
  };
  function authenticate(body) {
    const account = accounts.sessionAccount(typeof body.sessionToken === "string" ? body.sessionToken : "");
    if (!account) throw Object.assign(Error("Sign in again"), { status: 401 });
    return account;
  }
  async function handle(req, res) {
    const url = new URL(req.url, "http://scheduler"), prefix = "/koin/funded/rehearsal/";
    if (!url.pathname.startsWith(prefix)) return false;
    try {
      if (req.method !== "POST") throw Error("POST required");
      const chunks = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > 16384) throw Error("Request too large"); chunks.push(part); }
      const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const action = url.pathname.slice(prefix.length);
      const fields = { observe: ["grantId", "session"], review: ["grantId", "observationId", "proposal"],
        authorize: ["grantId", "observationId", "terms", "signature"], status: ["id"], revoke: ["id"] }[action];
      if (!fields || !b || Object.keys(b).some(k => !["sessionToken", ...fields].includes(k))) throw Error("Unsupported session request");
      const account = authenticate(b);
      let result;
      if (["observe", "review", "authorize"].includes(action)) {
        const grant = accounts.spendableGrant(account.id, D.identity(b.grantId));
        if (!accounts.accountView(account).wallets.some(w => w.address === grant.address)) throw Error("Linked wallet required");
        if (action === "observe") result = await observer.observe({ id: P.digest(b.session), owner: grant.address });
        if (action === "review") {
          const keys = "amount,expires,maxJobs,maxOutput,model,perJob,version";
          if (!b.proposal || Object.keys(b.proposal).sort().join() !== keys) throw Error("Exact session limits required");
          const evidence = await observer.verify(P.digest(b.observationId));
          if (evidence.state !== "verified") result = { state: evidence.state, observationId: b.observationId };
          else result = await ledger.reviewDelegation({ ...b.proposal, observationId: b.observationId, accountId: account.id, grantId: b.grantId });
        }
        if (action === "authorize") result = await ledger.authorizeDelegation({ observationId: b.observationId,
          terms: b.terms, signature: b.signature, accountId: account.id, grantId: b.grantId });
      } else if (action === "status") result = ledger.delegationStatus({ id: b.id, accountId: account.id });
      else result = ledger.revokeDelegation({ id: b.id, accountId: account.id });
      if (authenticate(b).id !== account.id) throw Error("Account changed during verification");
      respond(res, 200, { ok: true, ...result });
    } catch (e) { respond(res, e.status || 400, { ok: false, error: String(e.message).slice(0, 220) }); }
    return true;
  }
  return { handle, ledger, close: () => ledger.close() };
}
module.exports = { createFundedSessionRouter };
