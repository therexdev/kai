"use strict";
const P = require("./job-protocol"), { uint, DAY } = require("./policy");
// Shares the credit ledger transaction and recovery anchor. A run is a spending
// ceiling, not another balance or a customer-controlled custody reservation.
class CreditRuns {
  constructor(ledger) {
    this.ledger = ledger;
    ledger.db.exec("CREATE TABLE IF NOT EXISTS credit_runs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,data TEXT NOT NULL)");
  }
  get(id, identity) {
    P.digest(id); P.digest(identity?.accountId);
    const row = this.ledger.db.prepare("SELECT account_id,data FROM credit_runs WHERE id=?").get(id);
    if (!row || row.account_id !== identity.accountId) throw Error("Run is unavailable for this account");
    return JSON.parse(row.data);
  }
  jobs(id) { return this.ledger.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.runId')=? ORDER BY rowid").all(id).map(r => JSON.parse(r.data)); }
  totals(run) {
    const jobs = this.jobs(run.id); let spent = 0n, pending = 0n;
    for (const j of jobs) {
      if (j.delivered || j.state === "charged") spent += uint(j.receipt.usage.amount);
      if (["queued", "running", "ready"].includes(j.state)) pending += uint(j.hold);
    }
    const remaining = uint(run.maxTotal) - spent - pending;
    if (remaining < 0n) throw Error("Run budget accounting invariant failed");
    return { spent: String(spent), pending: String(pending), remaining: String(remaining), modelCalls: jobs.length };
  }
  open({ id, owner, identity, model, mode, maxTotal, freeOnly, paidFirst = false }) {
    P.digest(id); P.digest(identity?.accountId);
    require("./credit-funding").preferences(freeOnly, paidFirst);
    if (this.ledger.product !== "prepaid-usd-v1" || !["research", "agent", "team", "agents"].includes(mode) || typeof freeOnly !== "boolean" || !uint(maxTotal) ||
        !this.ledger.meter.tariffs().some(t => t.model === model)) throw Error("Explicit supported model and total credit run budget required");
    const terms = { id, owner, accountId: identity.accountId, model, mode, maxTotal, freeOnly, ...(paidFirst ? { paidFirst: true } : {}) };
    return this.ledger.write(() => {
      const old = this.ledger.db.prepare("SELECT data FROM credit_runs WHERE id=?").get(id);
      if (old) {
        const run = this.get(id, identity);
        if ((run.paidFirst === true) !== paidFirst || Object.keys(terms).some(k => run[k] !== terms[k])) throw Error("An existing run's approved terms cannot change");
        return { ...run, ...this.totals(run) };
      }
      const count = this.ledger.db.prepare("SELECT COUNT(*) AS n FROM credit_runs WHERE account_id=? AND json_extract(data,'$.state')='open' AND json_extract(data,'$.expires')>?").get(identity.accountId, this.ledger.clock()).n;
      if (count >= 4) throw Error("Finish or stop an earlier run first");
      const run = { ...terms, state: "open", createdAt: this.ledger.clock(), expires: this.ledger.clock() + DAY };
      this.ledger.db.prepare("INSERT INTO credit_runs VALUES(?,?,?)").run(id, identity.accountId, JSON.stringify(run));
      return { ...run, ...this.totals(run) };
    });
  }
  admit(id, { owner, identity, model, freeOnly, paidFirst = false, maximum }) {
    require("./credit-funding").preferences(freeOnly, paidFirst);
    const run = this.get(id, identity), totals = this.totals(run);
    if (run.state !== "open" || this.ledger.clock() >= run.expires) throw Error("Run stopped or expired; saved results remain recoverable");
    if (run.owner !== owner || run.model !== model || run.freeOnly !== freeOnly || (run.paidFirst === true) !== paidFirst) throw Error("Run account, model or paid-continuation preference changed");
    if (totals.modelCalls >= 128 || uint(maximum) > uint(totals.remaining)) throw Error("Total run budget reached. Saved results remain available; no new model call was started.");
  }
  status(id, identity) {
    this.ledger.sweep(); const run = this.get(id, identity); return { ...run, ...this.totals(run),
      steps: this.jobs(id).map(j => ({ id: j.id, state: j.state, delivered: !!j.delivered || j.state === "charged", credits: j.delivered || j.state === "charged" ? j.receipt.usage.amount : "0" })) };
  }
  stop(id, identity) {
    return this.ledger.write(() => {
      const run = this.get(id, identity);
      for (const job of this.jobs(id)) if (["queued", "running", "ready"].includes(job.state)) this.ledger.finishInTransaction(job, "run_stopped");
      run.state = "stopped";
      this.ledger.db.prepare("UPDATE credit_runs SET data=? WHERE id=?").run(JSON.stringify(run), id);
      return { ...run, ...this.totals(run) };
    });
  }
}
module.exports = { CreditRuns };
