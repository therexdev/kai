"use strict";

// Monetary calculations use KOIN atoms (8 decimals). No inferred prices,
// minted rewards, or conversion of historical test-KAI balances.
const MAX = (1n << 64n) - 1n,
  DAY = 86400000;
const DEFAULTS = Object.freeze({
  version: 1,
  dailyBps: 500,
  availabilityBps: 7000,
  revenueRewardBps: 6000,
  revenueMiningBps: 2500,
  revenueOperationsBps: 1500,
  workCapBps: 8000,
  noticeMs: 2 * DAY,
  reviewMs: DAY,
});
function uint(value) {
  if (
    typeof value !== "bigint" &&
    (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
  )
    throw Error("Expected unsigned atom string");
  const n = BigInt(value);
  if (n < 0n || n > MAX) throw Error("Amount outside uint64");
  return n;
}
function add(a, b) {
  return uint(uint(a) + uint(b));
}
function subtract(a, b) {
  return uint(uint(a) - uint(b));
}
function fraction(a, numerator, denominator = 10000) {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    numerator > denominator ||
    denominator <= 0
  )
    throw Error("Invalid fraction");
  return (uint(a) * BigInt(numerator)) / BigInt(denominator);
}
function settings(input = DEFAULTS) {
  const c = { ...input };
  for (const k of Object.keys(DEFAULTS))
    if (!Number.isSafeInteger(c[k]) || c[k] < 0)
      throw Error("Invalid setting: " + k);
  if (
    c.version < 1 ||
    c.dailyBps > 1000 ||
    c.availabilityBps > 10000 ||
    c.workCapBps > 9000 ||
    c.revenueRewardBps + c.revenueMiningBps + c.revenueOperationsBps !==
      10000 ||
    c.noticeMs < 2 * DAY ||
    c.reviewMs < DAY
  )
    throw Error("Invalid monetary policy");
  return Object.freeze(c);
}
function dailyBudget({
  balance,
  liabilities = "0",
  openedAt,
  config = DEFAULTS,
}) {
  const c = settings(config);
  if (!Number.isSafeInteger(openedAt) || openedAt < 0)
    throw Error("Invalid opening time");
  const free = subtract(balance, liabilities),
    remainder = DAY - (openedAt % DAY);
  const total = fraction(fraction(free, c.dailyBps), remainder, DAY),
    availability = fraction(total, c.availabilityBps);
  return {
    epoch: Math.floor(openedAt / DAY),
    version: c.version,
    openedAt,
    total: total.toString(),
    availability: availability.toString(),
    work: (total - availability).toString(),
  };
}
function revenueSplit(amount, config = DEFAULTS) {
  const c = settings(config),
    n = uint(amount),
    rewards = fraction(n, c.revenueRewardBps),
    mining = fraction(n, c.revenueMiningBps);
  // Exact conservation; the operations reserve receives the rounding residue.
  return {
    rewards: rewards.toString(),
    mining: mining.toString(),
    operations: (n - rewards - mining).toString(),
  };
}
function reliability(observations, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw Error("Invalid time");
  let success = 5,
    total = 10;
  for (const x of observations) {
    if (
      !Number.isSafeInteger(x.at) ||
      x.at > now ||
      typeof x.success !== "boolean"
    )
      throw Error("Invalid verification observation");
    const w = 2 ** (-(now - x.at) / (7 * DAY));
    total += w;
    if (x.success) success += w;
  }
  return Math.round((0.9 + (0.1 * success) / total) * 10000);
}
function modelWeight(parametersBillions) {
  if (
    !Number.isFinite(parametersBillions) ||
    parametersBillions <= 0 ||
    parametersBillions > 1000
  )
    throw Error("Unapproved model size");
  return Math.round(Math.sqrt(parametersBillions / 4) * 10000);
}
function coverage(target, supply, previousBps = null) {
  if (
    !Number.isFinite(target) ||
    target <= 0 ||
    !Number.isFinite(supply) ||
    supply < 0
  )
    throw Error("Invalid coverage target");
  let n = Math.max(
    7500,
    Math.min(
      15000,
      Math.round(Math.sqrt(target / Math.max(1, supply)) * 10000),
    ),
  );
  if (previousBps !== null) {
    if (
      !Number.isInteger(previousBps) ||
      previousBps < 7500 ||
      previousBps > 15000
    )
      throw Error("Invalid previous coverage");
    n = Math.max(
      Math.ceil(previousBps * 0.9),
      Math.min(Math.floor(previousBps * 1.1), n),
    );
  }
  return n;
}
function allocate({ budget, intervals, work, config = DEFAULTS }) {
  const c = settings(config),
    rows = new Map();
  const row = (address) => {
    if (typeof address !== "string" || !address || address.length > 80)
      throw Error("Invalid provider");
    if (!rows.has(address))
      rows.set(address, {
        address,
        availability: 0n,
        work: 0n,
        points: 0n,
        charged: 0n,
      });
    return rows.get(address);
  };
  const start = budget.openedAt,
    end = (budget.epoch + 1) * DAY;
  if (
    !Number.isSafeInteger(start) ||
    Math.floor(start / DAY) !== budget.epoch ||
    budget.version !== c.version ||
    add(budget.availability, budget.work) !== uint(budget.total)
  )
    throw Error("Invalid budget snapshot");
  let previousEnd = start;
  for (const interval of intervals) {
    if (
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < previousEnd ||
      interval.end <= interval.start ||
      interval.end > end
    )
      throw Error("Overlapping or invalid interval");
    previousEnd = interval.end;
    const byProvider = new Map(),
      slots = new Set();
    for (const slot of interval.slots) {
      // Verifier-issued capacity IDs: multiple wallets/aliases must not multiply a slot.
      if (!slot.verified || slot.eligible !== true) continue;
      if (
        typeof slot.capacityId !== "string" ||
        !slot.capacityId ||
        slots.has(slot.capacityId)
      )
        throw Error("Duplicate capacity slot");
      slots.add(slot.capacityId);
      if (
        !Number.isInteger(slot.coverageBps) ||
        slot.coverageBps < 7500 ||
        slot.coverageBps > 15000 ||
        !Number.isInteger(slot.reliabilityBps) ||
        slot.reliabilityBps < 9000 ||
        slot.reliabilityBps > 10000
      )
        throw Error("Invalid capacity adjustment");
      row(slot.address);
      const score =
        uint(slot.modelWeight) *
        BigInt(slot.coverageBps) *
        BigInt(slot.reliabilityBps);
      byProvider.set(
        slot.address,
        (byProvider.get(slot.address) || 0n) + score,
      );
    }
    const totalScore = [...byProvider.values()].reduce((a, b) => a + b, 0n);
    if (!totalScore) continue;
    const amount = fraction(
      budget.availability,
      interval.end - interval.start,
      end - start,
    );
    for (const [address, score] of byProvider)
      row(address).availability += (amount * score) / totalScore;
  }
  const jobs = new Set();
  for (const job of work) {
    if (!job.verified || !job.finalized || job.refunded || job.free) continue;
    if (job.epoch !== budget.epoch || !job.jobId || jobs.has(job.jobId))
      throw Error("Duplicate or wrong-period work");
    jobs.add(job.jobId);
    const r = row(job.address);
    r.points = add(r.points, job.points);
    r.charged = add(r.charged, job.charged);
  }
  const totalPoints = [...rows.values()].reduce((n, r) => n + r.points, 0n);
  if (totalPoints)
    for (const r of rows.values()) {
      const proportional = (uint(budget.work) * r.points) / totalPoints,
        cap = fraction(r.charged, c.workCapBps);
      r.work = proportional < cap ? proportional : cap;
    }
  const allocations = [...rows.values()]
    .sort((a, b) => a.address.localeCompare(b.address, "en"))
    .map((r) => ({
      address: r.address,
      availability: r.availability.toString(),
      work: r.work.toString(),
    }));
  const committed = allocations.reduce(
    (n, r) => add(n, add(r.availability, r.work)),
    0n,
  );
  return {
    allocations,
    committed: committed.toString(),
    unused: subtract(budget.total, committed).toString(),
  };
}
module.exports = {
  MAX,
  DAY,
  DEFAULTS,
  uint,
  add,
  subtract,
  fraction,
  settings,
  dailyBudget,
  revenueSplit,
  reliability,
  modelWeight,
  coverage,
  allocate,
};
