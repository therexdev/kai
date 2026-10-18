"use strict";
const { uint } = require("./policy"), { policy } = require("./free-credits");
// Free admission requires fresh, pinned contract ceilings and a funded reward
// pool. Losing this observation pauses new free grants, never purchased usage
// or consumption of already allocated request holds.
class SponsorshipReadiness {
  constructor({ freePolicy, version, clock = Date.now }) { this.policy = policy(freePolicy); this.version = String(version); this.clock = clock; this.validUntil = 0; this.observedAt = 0; }
  ready() { const now = this.clock(); return !!this.policy && now >= this.observedAt && now < this.validUntil; }
  refresh(verified, pool, observedAt = this.clock()) {
    this.validUntil = 0;
    if (!Number.isSafeInteger(observedAt) || observedAt < 0 || this.clock() < observedAt || this.clock() >= observedAt + 30000) return false;
    const p = this.policy, c = verified?.credits;
    if (!p || !c || c.reward_basis !== 1 || String(c.version) !== this.version || verified.paused) return false;
    if (uint(c.sponsor_daily_limit || "0") < uint(p.networkDaily) || uint(c.sponsor_account_daily_limit || "0") < uint(p.accountDaily)) return false;
    const liquid = uint(pool?.liquid || "0"), liabilities = uint(pool?.liabilities || "0");
    // Positive work component of the existing 5% daily, 30% work policy.
    if (liquid <= liabilities || ((liquid - liabilities) * 500n / 10000n) * 3000n / 10000n === 0n) return false;
    this.observedAt = observedAt; this.validUntil = observedAt + 30000; return true;
  }
}
module.exports = { SponsorshipReadiness };
