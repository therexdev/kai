"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { utils } = require("koilib");
const P = require("./policy");
const blank = () => ({
  schema: 1,
  mode: "shadow",
  qualifications: {},
  presence: {},
  observations: {},
  budgets: {},
  days: {},
});
// A separate durable, read-only-money ledger. Never derives a KOIN balance
// from legacy receipts, device fingerprints, advertisements or test-token USD.
class KoinShadow {
  constructor(dir, { clock = Date.now } = {}) {
    this.file = path.join(dir, "koin-shadow.json");
    this.clock = clock;
    this.state = blank();
    try {
      const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (s.schema !== 1 || s.mode !== "shadow")
        throw Error("Invalid KOIN shadow ledger");
      this.state = s;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  qualify(q) {
    if (q && ["__proto__", "constructor", "prototype"].includes(q.capacityId)) throw Error("Invalid capacity ID");
    if (q && !Object.hasOwn(this.state.qualifications, q.capacityId) && Object.keys(this.state.qualifications).length >= 10000) throw Error("Qualification capacity reached");
    if (
      !q ||
      !utils.isChecksumAddress(q.address) ||
      typeof q.capacityId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(q.capacityId) ||
      typeof q.model !== "string" ||
      q.model.length > 100 ||
      !q.model ||
      !/^([a-f0-9]{64})$/.test(q.modelHash) ||
      !/^([a-f0-9]{64})$/.test(q.benchmarkHash)
    )
      throw Error("Verified benchmark identity required");
    if (
      !Number.isSafeInteger(q.expires) ||
      q.expires <= this.clock() ||
      q.expires > this.clock() + P.DAY ||
      P.uint(q.modelWeight) === 0n
    )
      throw Error("Qualification must expire within a day");
    if (
      !Number.isInteger(q.coverageBps) ||
      q.coverageBps < 7500 ||
      q.coverageBps > 15000
    )
      throw Error("Invalid coverage");
    // One effective service slot per verified capacity ID across addresses.
    this.state.qualifications[q.capacityId] = {
      address: q.address,
      capacityId: q.capacityId,
      model: q.model,
      modelHash: q.modelHash,
      modelWeight: q.modelWeight,
      coverageBps: q.coverageBps,
      benchmarkHash: q.benchmarkHash,
      expires: q.expires,
      approvedAt: this.clock(),
    };
    this.save();
  }
  observe(address, report) {
    if (
      !utils.isChecksumAddress(address) ||
      !report ||
      report.schema !== 1 ||
      !Number.isSafeInteger(report.at) ||
      Math.abs(report.at - this.clock()) > 60000 ||
      !Number.isSafeInteger(report.sequence) ||
      report.sequence < 0 ||
      typeof report.session !== "string" ||
      !/^[a-f0-9]{32}$/.test(report.session)
    )
      throw Error("Invalid presence report");
    if (
      typeof report.model !== "string" ||
      report.model.length > 100 ||
      !(report.modelHash === "" || /^[a-f0-9]{64}$/.test(report.modelHash)) ||
      typeof report.ready !== "boolean"
    )
      throw Error("Invalid model report");
    if (
      !Object.values(this.state.qualifications).some(
        (q) => q.address === address && q.expires > this.clock(),
      )
    )
      throw Error("Capacity qualification required before shadow collection");
    const old = this.state.presence[address];
    if (old?.session === report.session && report.sequence <= old.sequence)
      throw Error("Replayed presence");
    if (old && report.at <= old.signedAt) throw Error("Stale presence");
    if (old && this.clock() - old.at < 10000)
      throw Error("Presence rate exceeded");
    if (!old && Object.keys(this.state.presence).length >= 10000)
      throw Error("Presence capacity reached");
    const sample = {
      session: report.session,
      sequence: report.sequence,
      model: report.model,
      modelHash: report.modelHash,
      ready: report.ready,
      at: this.clock(),
      signedAt: report.at,
    };
    // Keep enough evidence to cover both minute boundaries, not just a late
    // snapshot that could award a full minute to a newly loaded model.
    sample.samples = [
      ...(old?.samples || []).filter((p) => p.at >= this.clock() - 180000),
      { ...sample },
    ].slice(-40);
    this.state.presence[address] = sample;
    this.save();
  }
  open(balance, { liabilities = "0" } = {}) {
    const openedAt = this.clock();
    const budget = P.dailyBudget({ balance, liabilities, openedAt });
    if (this.state.budgets[budget.epoch])
      throw Error("Shadow budget already opened");
    this.state.budgets[budget.epoch] = budget;
    this.state.days[budget.epoch] = { intervals: [], work: [] };
    this.save();
    return budget;
  }
  tick() {
    const now = this.clock(),
      end = Math.floor(now / 60000) * 60000,
      start = end - 60000;
    const epoch = Math.floor(start / P.DAY),
      budget = this.state.budgets[epoch],
      day = this.state.days[epoch];
    if (!budget || !day) return;
    if (
      start < budget.openedAt ||
      Math.floor(start / P.DAY) !== epoch ||
      day.intervals.at(-1)?.end >= end
    )
      return;
    const slots = [];
    for (const q of Object.values(this.state.qualifications)) {
      const samples = this.state.presence[q.address]?.samples || [];
      const first = samples.findLastIndex((p) => p.at <= start),
        last = samples.findIndex((p) => p.at >= end);
      if (q.approvedAt > start || q.expires < end || first < 0 || last < first)
        continue;
      const window = samples.slice(first, last + 1);
      if (
        window.some(
          (p, i) =>
            !p.ready ||
            p.model !== q.model ||
            p.modelHash !== q.modelHash ||
            (i > 0 &&
              (p.at - window[i - 1].at > 45000 ||
                p.session !== window[i - 1].session)),
        )
      )
        continue;
      slots.push({
        ...q,
        verified: true,
        eligible: true,
        reliabilityBps: P.reliability(
          this.state.observations[q.address] || [],
          now,
        ),
      });
    }
    day.intervals.push({ start, end, slots });
    this.save();
  }
  status(address) {
    const now = this.clock(),
      epoch = Math.floor(now / P.DAY),
      b = this.state.budgets[epoch],
      d = this.state.days[epoch],
      p = this.state.presence[address];
    const q = Object.values(this.state.qualifications).find(
      (x) =>
        x.address === address &&
        x.expires > now &&
        p?.ready &&
        p.at > now - 90000 &&
        p.model === x.model &&
        p.modelHash === x.modelHash,
    );
    const result =
      b && d
        ? P.allocate({ budget: b, intervals: d.intervals, work: d.work })
        : null;
    const row = result?.allocations.find((x) => x.address === address);
    return {
      schema: 1,
      mode: "shadow",
      asset: "KOIN",
      paymentsEnabled: false,
      claimable: null,
      usageCredit: null,
      estimate: row
        ? { availability: row.availability, work: row.work, simulated: true }
        : null,
      qualification: q
        ? "qualified-shadow"
        : p
          ? "awaiting-verification"
          : "unreported",
      model: p?.model || null,
      budget: b || null,
      policy: P.DEFAULTS,
      asOf: now,
    };
  }
  manifest(epoch) {
    const b = this.state.budgets[epoch],
      d = this.state.days[epoch];
    if (!b || !d || epoch >= Math.floor(this.clock() / P.DAY))
      throw Error("Closed shadow day required");
    const result = P.allocate({
      budget: b,
      intervals: d.intervals,
      work: d.work,
    });
    const data = { schema: 1, mode: "shadow", epoch, budget: b, ...result };
    return {
      ...data,
      hash: crypto
        .createHash("sha256")
        .update(JSON.stringify(data))
        .digest("hex"),
    };
  }
}
module.exports = { KoinShadow };
