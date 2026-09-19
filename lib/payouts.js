"use strict";

// Payout-only policy. Never applies to worker/client-signed transactions.
const MAX_RC = 600000000n; // retain the existing per-transaction spending ceiling
const RETRY_MS = 60000;
const PENDING_MS = 10 * 60000;
const message = (e) => String(e?.message || e).slice(0, 200);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function complete(summary) {
  const s = summary?.settlement;
  if (!s || s.error || !s.rootTx) return false;
  if (s.status) return s.status === "complete";
  // Legacy records have no status. A partial result is NOT success.
  return Object.keys(summary.claims || {}).every((w) => s.claims?.[w]?.tx && !s.claims[w].error);
}

// koilib's default transport can retry forever; recovery must release its lock.
function boundedRpc(url) {
  let id = 0;
  return async (method, params) => {
    const requestId = ++id;
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Payout RPC HTTP ${res.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Payout RPC response too large");
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data.id !== requestId || data.jsonrpc !== "2.0") throw new Error("Invalid payout RPC response");
    if (data.error) throw new Error(JSON.stringify(data.error));
    if (!data.result || typeof data.result !== "object") throw new Error("Missing payout RPC result");
    return data.result;
  };
}

/** Simulate without broadcasting, then sign a fresh header with measured RC.
 * Checkpoint the FINAL tx id before broadcasting; a crash/timeout stays pending.
 * There is no high-RC fallback if estimation fails. */
async function budgetedCall(kai, method, args, prepared) {
  const { Transaction } = require("koilib");
  const { provider, signer } = kai.chain;
  const available = BigInt(await provider.getAccountRc(signer.getAddress()));
  const ceiling = available < MAX_RC ? available : MAX_RC;
  if (ceiling <= 0n) throw new Error("Insufficient payout MANA; waiting for resources");
  const simulation = await kai.contract.functions[method](args, {
    rcLimit: ceiling.toString(), broadcast: false, chainId: kai.chain.expectedChainId,
  });
  const receipt = simulation.receipt;
  if (!receipt || receipt.rpc_error || receipt.reverted || !/^\d+$/.test(String(receipt.rc_used))) {
    throw new Error("Payout simulation failed or returned no resource estimate");
  }
  const used = BigInt(receipt.rc_used);
  if (used <= 0n) throw new Error("Invalid payout resource estimate");
  const limit = (used * 125n + 99n) / 100n + 10000n;
  if (limit > ceiling) throw new Error("Insufficient payout MANA for estimated cost and safety margin");
  const tx = new Transaction({ signer, provider, transaction: simulation.transaction });
  tx.adjustRcLimit(limit.toString()); // drops simulation signatures when header changes
  await tx.sign();
  await prepared({ tx: tx.transaction.id, rcLimit: limit.toString(), estimatedRc: used.toString() });
  // Use the actual RPC result, not koilib's synthetic success on RPC timeout.
  const submitted = await provider.call("chain.submit_transaction", { transaction: tx.transaction, broadcast: true });
  if (!submitted.receipt || submitted.receipt.rpc_error || submitted.receipt.reverted) {
    throw new Error("Payout broadcast unconfirmed or reverted; will reconcile on chain");
  }
  return tx.transaction.id;
}

async function settlePayouts({ kai, summary, checkpoint, now = Date.now, sleep = pause, send = budgetedCall }) {
  const previous = summary.settlement || {};
  const out = {
    ...previous, status: "pending", error: null, nextRetryAt: null,
    attempts: (previous.attempts || 0) + 1,
    claims: { ...(previous.claims || {}) }, settledAt: new Date(now()).toISOString(),
  };
  const save = async () => checkpoint(out);
  const started = now();
  let sent = 0;
  const verified = new Set();
  const recent = (item) => item?.status === "submitted" && now() - Date.parse(item.submittedAt) < PENDING_MS;
  const confirm = async (check) => {
    const deadline = now() + 20000;
    do {
      if (await check()) return true;
      if (now() >= deadline) return false;
      await sleep(2000);
    } while (true);
  };
  const rootMatches = async () => {
    const root = await kai.getRoot(summary.epoch);
    if (root && root !== summary.root) {
      const err = new Error(`epoch ${summary.epoch} already has a different root on-chain`);
      err.blocked = true;
      throw err;
    }
    return root === summary.root;
  };
  try {
    await save(); // strict durability before any transaction
    if (!await rootMatches()) {
      if (recent(out.rootPending)) throw new Error("Root transaction awaiting confirmation");
      await send(kai, "submit_root", {
        epoch: String(summary.epoch), root: Buffer.from(summary.root, "hex").toString("base64url"),
      }, async (tx) => {
        out.rootTx = tx.tx;
        out.rootPending = { ...tx, status: "submitted", submittedAt: new Date(now()).toISOString() };
        await save();
      });
      sent++;
      if (!await confirm(rootMatches)) throw new Error("Root transaction awaiting confirmation");
    }
    out.rootTx ||= "already-on-chain";
    delete out.rootPending;
    await save();
    for (const [worker, packet] of Object.entries(summary.claims || {})) {
      // The claim bit, not a previous submission response, is authoritative.
      if (await kai.isClaimed(summary.epoch, worker)) {
        verified.add(worker);
        out.claims[worker] = { ...out.claims[worker], status: "confirmed", error: null, confirmedAt: new Date(now()).toISOString() };
        await save();
        continue;
      }
      if (recent(out.claims[worker])) continue;
      if (sent >= 12 || now() - started >= 90000) break;
      const args = {
        epoch: String(summary.epoch), worker, index: String(packet.index),
        proof: packet.proof.map((h) => Buffer.from(h, "hex").toString("base64url")),
        ...(packet.amount != null ? { amount: String(packet.amount) } : { count: String(packet.count) }),
      };
      try {
        await send(kai, packet.amount != null ? "claim_value" : "claim", args, async (tx) => {
          out.claims[worker] = { ...tx, status: "submitted", submittedAt: new Date(now()).toISOString() };
          await save();
        });
        sent++;
        if (!await confirm(() => kai.isClaimed(summary.epoch, worker))) {
          throw new Error("Claim transaction awaiting confirmation");
        }
        verified.add(worker);
        out.claims[worker] = { ...out.claims[worker], status: "confirmed", error: null, confirmedAt: new Date(now()).toISOString() };
        await save();
      } catch (e) {
        // Keep tx/time on ambiguous failures. A fresh chain read precedes retry.
        // Explicit resource rejections were not admitted and can retry next pass.
        const rejected = /insufficient.*(resources|mana)|account.*nonce/i.test(message(e));
        out.claims[worker] = { ...out.claims[worker], error: message(e),
          status: rejected ? "failed" : (out.claims[worker]?.status || "failed") };
        throw e; // stop this burst; don't repeatedly hammer an exhausted payer
      }
    }
    out.status = Object.keys(summary.claims || {}).every((w) => verified.has(w)) ? "complete" : "pending";
  } catch (e) {
    if (out.rootPending && /insufficient.*(resources|mana)|account.*nonce/i.test(message(e))) {
      out.rootPending.status = "failed";
    }
    out.status = e.blocked ? "blocked" : "pending";
    out.error = message(e);
  }
  if (out.status === "pending") {
    out.nextRetryAt = new Date(now() + Math.min(15 * RETRY_MS, RETRY_MS * 2 ** Math.min(out.attempts - 1, 4))).toISOString();
  }
  await save();
  return out;
}

module.exports = { boundedRpc, budgetedCall, settlePayouts, complete, RETRY_MS };
