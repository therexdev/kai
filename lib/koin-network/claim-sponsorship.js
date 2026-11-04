"use strict";
const fs = require("node:fs");
const P = require("./job-protocol"), { uint } = require("./policy");
const FILE = "claim-sponsorship.json";

// An explicit operator-owned allowance, bound to the exact existing ledger.
// It changes only claim daily reservations; signed envelopes and their original
// identity, per-transaction limit, nonce and retry fences remain immutable.
function allowance(value, identity, base) {
  if (value === null) return base;
  if (!value || Object.keys(value).sort().join() !== "ledgerIdentityHash,maxRcPerDay,schema" ||
      value.schema !== 1 || value.ledgerIdentityHash !== P.hash(identity) ||
      typeof value.maxRcPerDay !== "string" || uint(value.maxRcPerDay) < uint(base))
    throw Error("Invalid claim sponsorship authorization");
  return String(uint(value.maxRcPerDay));
}
function reader(file) {
  return () => {
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (error.code === "ENOENT") return null; throw Error("Claim sponsorship authorization unavailable"); }
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.size > 2048 || s.uid !== 0 || (s.mode & 0o022)) throw Error("Protected operator-owned claim sponsorship authorization required");
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  };
}
function plan(providers, maxRcPerTransaction) {
  P.integer(providers, 1, 1000);
  const limit = uint(maxRcPerTransaction); if (!limit) throw Error("Positive claim transaction ceiling required");
  const reservations = Math.ceil(providers * 1.25), daily = BigInt(reservations) * limit;
  uint(String(daily * 5n));
  return { providersPerDay: providers, dailyReservations: reservations,
    maxRcPerDay: String(daily), sponsorBalanceTargetAtoms: String(daily * 5n),
    assumptions: "One payout per provider per day; full transaction ceiling; 25% reservation headroom; 20% daily Mana regeneration. Funding capacity, not a throughput guarantee." };
}
module.exports = { FILE, allowance, reader, plan };
