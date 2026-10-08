"use strict";
// Read-only accounting export. This is deliberately not a payout signer.
const crypto = require("node:crypto");
const { utils } = require("koilib");
const { complete } = require("./payouts");
const hash = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
function atoms(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw Error("Exact nonnegative atom strings required");
  return BigInt(value);
}
function map(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`Missing ${label}`);
  for (const [address, n] of Object.entries(value)) {
    if (!utils.isChecksumAddress(address)) throw Error(`Invalid address in ${label}`);
    atoms(n);
  }
  return value;
}
function rootFor(epoch, totals) {
  let nodes = Object.entries(totals).filter(([, n]) => atoms(n) > 0n)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([a, n]) => Buffer.from(hash(`${epoch}|${a}|${n}`), "hex"));
  if (!nodes.length) return hash("empty");
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) next.push(crypto.createHash("sha256").update(Buffer.concat([nodes[i], nodes[i + 1] || nodes[i]])).digest());
    nodes = next;
  }
  return nodes[0].toString("hex");
}
function decimal(n) {
  n = atoms(String(n)); return `${n / 100000000n}.${String(n % 100000000n).padStart(8, "0")}`;
}
function snapshot(records, { firstEpoch, finalEpoch, cutoff = null, chainBalances = null } = {}) {
  if (!Number.isSafeInteger(firstEpoch) || firstEpoch < 0 || !Number.isSafeInteger(finalEpoch) || finalEpoch < firstEpoch) throw Error("Explicit first/final epoch coverage required");
  if (!Array.isArray(records) || !records.length) throw Error("No epoch records; cannot certify an empty history");
  const epochs = [...records].sort((a, b) => a.epoch - b.epoch), seen = new Set(), wallets = new Map(), evidence = [], blockers = [];
  if (epochs[0].epoch !== firstEpoch || epochs.at(-1).epoch !== finalEpoch) throw Error("Supplied history does not match the declared epoch coverage");
  if (cutoff !== null && (!cutoff || cutoff.schema !== 1 || cutoff.mode !== "legacy-kai-cutoff" || cutoff.finalEpoch !== finalEpoch ||
      cutoff.finalRoot !== epochs.at(-1).summary?.root || !Number.isFinite(Date.parse(cutoff.effectiveAt)))) throw Error("Cutoff marker does not match the snapshot");
  const wallet = address => {
    if (!wallets.has(address)) wallets.set(address, { earned: 0n, net: 0n, spent: 0n, debt: 0n });
    return wallets.get(address);
  };
  for (const record of epochs) {
    const e = record.epoch, s = record.summary;
    if (!Number.isSafeInteger(e) || e < firstEpoch || e > finalEpoch || seen.has(e)) throw Error("Duplicate or invalid epoch");
    seen.add(e);
    if (!s || s.epoch !== e || s.persisted === false) throw Error(`Epoch ${e} is open or was not durably closed`);
    if (!Array.isArray(record.receipts) || s.receipts !== record.receipts.length) throw Error(`Epoch ${e} receipt count mismatch`);
    const totals = map(s.totals, "net totals"), spent = map(record.spentSat, "exact spend history"), debts = map(s.debts, "debts");
    if (rootFor(e, totals) !== s.root) throw Error(`Epoch ${e} root mismatch`);
    const claims = s.claims;
    if (!claims || Object.keys(claims).sort().join() !== Object.keys(totals).filter(a => atoms(totals[a]) > 0n).sort().join() ||
        Object.entries(claims).some(([a, c]) => c?.amount !== totals[a])) throw Error(`Epoch ${e} claims mismatch`);
    const addresses = new Set([...Object.keys(totals), ...Object.keys(spent), ...Object.keys(debts)]);
    if (s.earnedAtoms) for (const a of Object.keys(map(s.earnedAtoms, "earned atoms"))) addresses.add(a);
    // Historical earnedKai/spentKai used floating point. Reconstruct instead:
    // net = max(earned - spent, 0); debt = max(spent - earned, 0).
    for (const a of addresses) {
      const net = atoms(totals[a] || "0"), used = atoms(spent[a] || "0"), debt = atoms(debts[a] || "0"), earned = net + used - debt;
      if (earned < 0n || (net > 0n && debt > 0n) || (s.earnedAtoms && atoms(s.earnedAtoms[a] || "0") !== earned)) throw Error(`Epoch ${e} accounting mismatch`);
      const row = wallet(a); row.earned += earned; row.net += net; row.spent += used; row.debt += debt;
    }
    if (s.receipts && !complete(s)) blockers.push({ epoch: e, reason: "legacy_settlement_unresolved" });
    evidence.push({ epoch: e, root: s.root, recordSha256: hash(record), receipts: s.receipts });
  }
  if (chainBalances !== null) {
    if (!chainBalances || typeof chainBalances !== "object" || Array.isArray(chainBalances)) throw Error("Pinned chain balance snapshot required");
    const b = chainBalances;
    if (!b.chainId || !utils.isChecksumAddress(b.contract || "") || !/^0x1220[a-f0-9]{64}$/.test(b.blockId || "") || !/^[1-9]\d*$/.test(b.blockHeight || "")) throw Error("Chain balance anchor required");
    map(b.balances, "chain balances");
    for (const a of Object.keys(b.balances)) wallet(a);
  }
  const rows = [...wallets].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([address, r]) => ({
    address, earnedKaiAtoms: String(r.earned), netAwardedKaiAtoms: String(r.net), spentKaiAtoms: String(r.spent), debtKaiAtoms: String(r.debt),
    currentKaiBalanceAtoms: chainBalances?.balances[address] ?? null,
    proposedKoinAtoms: String(r.earned / 10n), conversionRemainderKaiAtoms: String(r.earned % 10n),
  }));
  const total = key => String(rows.reduce((n, r) => n + atoms(r[key]), 0n));
  return { schema: 1, mode: "kai-earned-snapshot-draft", payoutEnabled: false,
    basis: "gross-earned-before-consumer-spend", ratio: { kai: 10, mainnetKoin: 1 }, decimals: 8,
    coverage: { firstEpoch, finalEpoch, epochs: epochs.length, completeHistoryVerified: false }, cutoff,
    chainBalanceAnchor: chainBalances ? { chainId: chainBalances.chainId, contract: chainBalances.contract, blockId: chainBalances.blockId,
      blockHeight: chainBalances.blockHeight, sourceSha256: hash(chainBalances) } : null,
    reviewRequired: ["Confirm complete historical epoch coverage against independent backups", "Confirm eligible earning categories and destination wallets",
      "Reconcile the final testnet chain snapshot and all outstanding legacy settlements", "Approve the exact hashed allocation and fund it before distribution"],
    blockers: [...(!cutoff ? [{ reason: "alpha_cutoff_not_recorded" }] : []), ...(!chainBalances ? [{ reason: "chain_balances_not_reconciled" }] : []), ...blockers],
    totals: { earnedKaiAtoms: total("earnedKaiAtoms"), proposedKoinAtoms: total("proposedKoinAtoms"),
      proposedKoin: decimal(total("proposedKoinAtoms")), conversionRemainderKaiAtoms: total("conversionRemainderKaiAtoms") }, evidence, rows };
}
module.exports = { atoms, decimal, hash, rootFor, snapshot };
