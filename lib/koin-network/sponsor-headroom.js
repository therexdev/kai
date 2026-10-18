"use strict";
const { uint, DAY } = require("./policy");
// Read-only, immediately before preparing a sponsored settlement. Already
// admitted obligations wait intact for capacity; they are never re-priced,
// expired, retried with new IDs, or deliberately sent into a daily-cap revert.
async function sponsorHeadroom({ client, ledger, job, clock = Date.now }) {
  const free = uint(job.funding?.freeUsed || "0"); if (!free) return true;
  const generation = client.provider.readGeneration, before = await client.provider.getHeadInfo();
  if (!/^0x1220[a-f0-9]{64}$/.test(before.head_topology?.id || "") ||
      typeof before.head_topology?.height !== "string" || !/^[1-9][0-9]*$/.test(before.head_topology.height) ||
      typeof before.head_block_time !== "string" || !/^[0-9]+$/.test(before.head_block_time)) return false;
  const time = Number(before.head_block_time);
  if (!Number.isSafeInteger(time) || Math.abs(clock() - time) > 60000) return false;
  const day = Math.floor(time / DAY), verified = await client.verify(), cfg = verified?.credits;
  if (!cfg || verified.paused || !uint(cfg.sponsor_daily_limit || "0") || !uint(cfg.sponsor_account_daily_limit || "0")) return false;
  const rows = ledger.settledJobs(); let total = 0n, sponsored = 0n, account = 0n;
  for (const row of rows) {
    if (!row.finality?.blockTime || !/^[0-9]+$/.test(row.finality.blockTime)) return false; // old evidence needs a fresh observation
    const epoch = Number(BigInt(row.finality.blockTime) / BigInt(DAY)); if (epoch !== day) continue;
    total += uint(row.receipt.usage.amount); const amount = uint(row.funding?.freeUsed || "0"); sponsored += amount;
    if (row.funding?.accountId === job.funding.accountId) account += amount;
  }
  const onChain = await client.read("credits", "get_spend", { epoch: String(day) }), after = await client.provider.getHeadInfo();
  if (before.head_topology?.id !== after.head_topology?.id || before.head_topology?.height !== after.head_topology?.height || before.head_block_time !== after.head_block_time || client.provider.readGeneration !== generation) return false;
  // Unknown or not-yet-finalized work cannot be treated as spare capacity.
  if (uint(onChain.amount || "0") !== total) return false;
  return sponsored + free <= uint(cfg.sponsor_daily_limit) && account + free <= uint(cfg.sponsor_account_daily_limit);
}
module.exports = { sponsorHeadroom };
