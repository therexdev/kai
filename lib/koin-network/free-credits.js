"use strict";
const P = require("./job-protocol"), { uint, DAY } = require("./policy");
const min = (...values) => values.reduce((a, b) => a < b ? a : b);
// No commercial defaults. Values are USD atoms, never historical AI tokens.
function policy(value) {
  if (value == null) return null;
  if (Object.keys(value).sort().join() !== "accountConcurrent,accountDaily,eligibleModels,networkDaily,originDaily,version") throw Error("Explicit free-credit policy required");
  P.integer(value.version, 1); P.integer(value.accountConcurrent, 1, 32);
  for (const key of ["accountDaily", "networkDaily", "originDaily"]) if (!uint(value[key])) throw Error("Positive free-credit budgets required");
  if (uint(value.accountDaily) > uint(value.networkDaily) || uint(value.originDaily) > uint(value.networkDaily)) throw Error("Free budgets exceed network sponsorship");
  if (!Array.isArray(value.eligibleModels) || !value.eligibleModels.length || value.eligibleModels.length > 64 ||
      value.eligibleModels.some(m => typeof m !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(m)) || new Set(value.eligibleModels).size !== value.eligibleModels.length)
    throw Error("Explicit eligible starter models required");
  return structuredClone(value);
}
// Shares the prepaid SQLite transaction: free and purchased portions cannot
// reserve or debit independently. Only authenticated in-process identity enters
// this class; a wallet, install id or HTTP-supplied account id is not a grant.
class FreeCredits {
  constructor(db, value, clock) {
    this.db = db; this.policy = policy(value); this.clock = clock;
    db.exec(`CREATE TABLE IF NOT EXISTS free_grants(account TEXT NOT NULL,day INTEGER NOT NULL,budget TEXT NOT NULL,spent TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(account,day));
      CREATE TABLE IF NOT EXISTS free_origins(origin TEXT NOT NULL,day INTEGER NOT NULL,spent TEXT NOT NULL,PRIMARY KEY(origin,day));`);
  }
  available(identity, model, jobs) {
    const now = this.clock(), day = Math.floor(now / DAY), resetAt = (day + 1) * DAY;
    if (!this.policy || !identity) return { state: "unavailable", available: "0", resetAt };
    const account = P.digest(identity.accountId), origin = P.digest(identity.origin), p = this.policy;
    this.db.prepare("INSERT OR IGNORE INTO free_grants VALUES(?,?,?,'0',?)").run(account, day, p.accountDaily, p.version);
    const grants = this.db.prepare("SELECT * FROM free_grants WHERE day=?").all(day), own = grants.find(g => g.account === account);
    const originSpent = this.db.prepare("SELECT spent FROM free_origins WHERE day=? AND origin=?").get(day, origin)?.spent || "0";
    const holds = jobs.filter(j => j.funding?.day === day && j.funding?.freeHold !== "0");
    const held = rows => rows.reduce((n, j) => n + uint(j.funding.freeHold), 0n);
    const left = (budget, spent, hold) => { const n = budget - spent - hold; return n > 0n ? n : 0n; };
    const accountLeft = left(min(uint(own.budget), uint(p.accountDaily)), uint(own.spent), held(holds.filter(j => j.funding.accountId === account)));
    const networkLeft = left(uint(p.networkDaily), grants.reduce((n,g) => n + uint(g.spent), 0n), held(holds));
    const originLeft = left(uint(p.originDaily), uint(originSpent), held(holds.filter(j => j.funding.origin === origin)));
    const eligible = model == null || p.eligibleModels.includes(model);
    return { state: eligible ? "available" : "ineligible", available: String(eligible ? min(accountLeft, networkLeft, originLeft) : 0n),
      accountRemaining: String(accountLeft), resetAt, day, accountId: account, origin, policyVersion: own.version };
  }
  consume(funding, amount) {
    const n = uint(amount); if (!n) return;
    if (!funding || n > uint(funding.freeHold)) throw Error("Free usage exceeds its allocation");
    const grant = this.db.prepare("SELECT * FROM free_grants WHERE account=? AND day=?").get(funding.accountId, funding.day);
    if (!grant || uint(grant.spent) + n > uint(grant.budget)) throw Error("Free-credit accounting invariant failed");
    this.db.prepare("UPDATE free_grants SET spent=? WHERE account=? AND day=?").run(String(uint(grant.spent) + n), funding.accountId, funding.day);
    const old = this.db.prepare("SELECT spent FROM free_origins WHERE origin=? AND day=?").get(funding.origin, funding.day)?.spent || "0";
    this.db.prepare("INSERT INTO free_origins VALUES(?,?,?) ON CONFLICT(origin,day) DO UPDATE SET spent=excluded.spent")
      .run(funding.origin, funding.day, String(uint(old) + n));
  }
}
module.exports = { FreeCredits, policy };
