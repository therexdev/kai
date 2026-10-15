"use strict";
// Owner-reviewed recovery of ONE already signed lifecycle transaction. No keys,
// new signatures, nonce replacement, retry-counter reset, or journal rewrites.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual: equal } = require("node:util"), { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const TX = "0x12204e2f644ddd52dca6cc2f3a68d6c901e0d12e3cd1854f39f2fa13a9edfedc4b1b";
const RECORD = "ae612a3ace873f43fe52ea2ab20b9ad70f58b615c26f7c14035cfc8195bbfbe3";
const OWNER = "17f9wpFZgJLkYgZuS3KZCMjuKPLf4nhxjU", EPOCH = "20739", DAY = 86400000;
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const RELEASES = ["79ba574083d716810fa2f0a0cbbabe4d85a9174d", "07629b24e91f32af8abafc2ebdf0bdca8771e936"];
const STATE = "/var/lib/kai-koin-mainnet-pilot", UNIT = "kai-koin-mainnet-pilot.service";
const UNTIL = Date.parse("2026-10-16T00:00:00Z"), SINCE = Date.parse("2026-10-15T21:36:00Z");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const safe = value => String(value).replace(/https?:\/\/[^\s"']+/g, "[RPC]").replace(/[A-Za-z0-9_+/=-]{80,}/g, "[redacted]").slice(0, 500);
function readDb(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function record(row) {
  if (!row || hash(row.data) !== row.hash) throw Error("Payment journal integrity check failed");
  const r = JSON.parse(row.data);
  if (r.id !== row.id || r.state !== row.state || ("owner" in row && r.owner !== row.owner) ||
      ("tx_id" in row && (r.outbox?.transaction.id ?? null) !== row.tx_id)) throw Error("Payment journal binding changed");
  return r;
}
function simulation(receipt) {
  if (receipt?.id !== TX || receipt.payer !== OWNER || ![undefined, false].includes(receipt.reverted) ||
      !/^\d+$/.test(receipt.rc_used || "") || BigInt(receipt.rc_used) <= 0n || BigInt(receipt.rc_used) > 100000000n)
    throw Error("The exact saved transaction did not pass its reviewed Mana limit");
}
// Exclusive creation + file/directory fsync BEFORE network submission. A crash,
// timeout, partial file, or repeat invocation can never authorize another send.
function attemptStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error("Private recovery directory required");
  const file = path.join(directory, "attempt.json");
  return {
    exists: () => fs.existsSync(file),
    claim(transaction, now) {
      let fd;
      try { fd = fs.openSync(file, "wx", 0o600); }
      catch (e) { if (e.code === "EEXIST") return false; throw e; }
      try {
        fs.writeFileSync(fd, JSON.stringify({ schema: 1, txId: TX, envelopeHash: hash(JSON.stringify(transaction)),
          approvedAt: now, maxAdditionalAttempts: 1, state: "attempt_committed_before_send" }) + "\n");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const parent = fs.openSync(directory, "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return true;
    },
  };
}
async function recover({ approval, load, observe, preflight, beforeSend = () => {}, submit, store, waitReady, now = Date.now, log = console.log }) {
  if (approval !== TX) throw Error("Approve only the exact reviewed transaction ID");
  const transaction = await load();
  const check = states => {
    if (!Array.isArray(states) || states.length !== 2 || states.some(s => !["unknown", "pending", "reversible", "finalized", "reverted"].includes(s.state)))
      throw Error("Both reviewed RPC finality results are required");
    if (states.some(s => s.state === "reverted")) throw Error("The saved transaction reverted; no retry or update was performed");
    return states.every(s => s.state === "unknown");
  };
  let unknown = check(await observe(transaction));
  if (unknown && !store.exists()) {
    if (now() < SINCE || now() >= UNTIL) throw Error("The October 15 one-time retry review has expired; no transaction sent");
    await preflight(transaction);
    unknown = check(await observe(transaction));
    if (unknown) {
      if (!equal(transaction, await load())) throw Error("Saved transaction changed during review");
      if (now() >= UNTIL) throw Error("Retry review expired before submission");
      beforeSend(transaction);
      if (store.claim(transaction, now())) {
        log("Retrying the exact saved rewards transaction once: " + TX);
        try { await submit(transaction); log("RPC response received; waiting for irreversible confirmation."); }
        catch (e) { log("Submission response uncertain: " + safe(e.message) + ". Monitoring the same transaction; no additional retry."); }
      }
    }
  }
  await waitReady(transaction);
  log("REWARDS RECOVERED: irreversible confirmation and service reconciliation verified. Provider update may proceed.");
}
function environment() {
  const show = name => execFileSync("systemctl", ["show", UNIT, "--value", "--property=" + name], { encoding: "utf8" }).trim();
  const base = show("WorkingDirectory");
  if (!RELEASES.some(sha => base === "/opt/kai-koin-mainnet-pilot/releases/" + sha) || show("ActiveState") !== "active")
    throw Error("Expected active pilot service required");
  const { KoinChain } = require(base + "/lib/koin-network/chain"), { inspectFinality } = require(base + "/lib/koin-network/finality");
  const { Transaction, Signer } = require(base + "/node_modules/koilib"), { nonce } = require(base + "/lib/koin-network/settlement-outbox");
  const config = JSON.parse(fs.readFileSync("/etc/kai-koin-mainnet-pilot/runtime.json", "utf8")), d = config.deployment;
  if (config.mode !== "mainnet-pilot" || d.chainId !== CHAIN || config.roles.lifecycle !== OWNER || config.maxRcPerTransaction !== "100000000" ||
      d.rewards !== "1E1Stp1xMGt5ZmSTzEknLVyi79j9hDK9iT" || d.credits !== "13xiS64Z7mQXBNXniKPYRbFDCaNfvKbrPT" ||
      d.rpc.length !== 2 || d.rpc.map(u => new URL(u).hostname).sort().join() !== "api.koinos.io,api.koinosblocks.com")
    throw Error("Reviewed pilot deployment does not match");
  const read = () => {
    const r = readDb(path.join(STATE, "signing/test-signing.sqlite"), db => record(db.prepare("SELECT * FROM signatures WHERE id=?").get(RECORD)));
    const step = readDb(path.join(STATE, "cycle/reward-cycle.sqlite"), db => record(db.prepare("SELECT * FROM steps WHERE epoch=? AND method='finalize_root'").get(EPOCH)));
    if (r.owner !== OWNER || r.transaction?.id !== TX || step.epoch !== EPOCH || step.method !== "finalize_root" ||
        !equal(r.transaction, step.outbox?.transaction) || step.outbox.hash !== hash(JSON.stringify(r.transaction))) throw Error("Exact saved lifecycle envelope required");
    return { r, step };
  };
  const load = async () => {
    const { r, step } = read(), tx = r.transaction, op = tx.operations?.[0]?.call_contract;
    if (!((r.state === "signed" && step.state === "needs_review" && step.reason === "attempt_limit" && step.outbox.attempts === 3) ||
      (r.state === "finalized" && ["needs_review", "complete"].includes(step.state)))) throw Error("Saved lifecycle state changed; review before proceeding");
    if (tx.header.chain_id !== CHAIN || tx.header.payer !== OWNER || tx.header.payee || nonce(tx.header.nonce) !== "15" ||
        tx.header.rc_limit !== "100000000" || tx.operations.length !== 1 || op?.contract_id !== d.rewards || op.entry_point !== 2340412777 ||
        (await Transaction.prepareTransaction(structuredClone(tx))).id !== TX || !equal(await Signer.recoverAddresses(tx), [OWNER]))
      throw Error("Saved bytes exceed the reviewed transaction scope");
    return structuredClone(tx);
  };
  let rpcId = 0;
  const request = async (url, method, params) => {
    const id = ++rpcId;
    const response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error("RPC HTTP " + response.status);
    const value = await response.json();
    if (value.id !== id || value.jsonrpc !== "2.0") throw Error("RPC response identity mismatch");
    if (value.error) throw Error(String(value.error.message || "RPC rejected the request"));
    if (!value.result || typeof value.result !== "object") throw Error("Missing RPC result");
    return value.result;
  };
  const peers = d.rpc.map(url => {
    const client = new KoinChain({ ...d, rpc: [url] });
    client.provider.call = (method, params) => {
      if (method === "chain.submit_transaction" && params.broadcast !== false) throw Error("Read-only review cannot broadcast");
      return request(url, method, params);
    };
    return { url, client };
  });
  const observe = tx => Promise.all(peers.map(async ({ client }) => {
    await client.verify();
    return inspectFinality(client.provider, { chainId: CHAIN, txId: TX, expectedOperation: tx.operations[0].call_contract });
  }));
  const preflight = async tx => {
    const day = String(Math.floor(Date.now() / DAY)), { r, step } = read();
    if (r.state !== "signed" || step.state !== "needs_review" || !step.outbox.days.includes(day))
      throw Error("The existing daily Mana reservation is required; no limits or counters were changed");
    readDb(path.join(STATE, "cycle/reward-cycle.sqlite"), db => {
      if (db.prepare("SELECT amount FROM mana WHERE day=? AND id=?").get(day, step.id)?.amount !== tx.header.rc_limit ||
          db.prepare("SELECT amount FROM mana WHERE day=?").all(day).reduce((sum, v) => sum + BigInt(v.amount), 0n) > BigInt(config.maxRcPerDay))
        throw Error("Existing lifecycle Mana budget could not be verified");
    });
    await Promise.all(peers.map(async ({ client }) => {
      const p = client.provider, head = await p.getHeadInfo(), time = Number(head.head_block_time);
      if (!Number.isSafeInteger(time) || time > Date.now() + 60000 || Date.now() - time > 120000) throw Error("Fresh RPC head required");
      const [current, rc] = await Promise.all([p.getNonce(OWNER), p.getAccountRc(OWNER)]);
      if (current !== 14 || BigInt(rc) < 100000000n) throw Error("Nonce or available Mana changed; no retry sent");
      const receipt = (await p.call("chain.submit_transaction", { transaction: tx, broadcast: false })).receipt;
      simulation(receipt);
    }));
  };
  const waitReady = async tx => {
    const end = Date.now() + 240000; let last = "waiting", lastLog = 0;
    while (Date.now() < end) {
      const states = await observe(tx);
      if (states.some(s => s.state === "reverted")) throw Error("Transaction irreversibly reverted; records retained for review");
      const { r, step } = read();
      const unfinished = readDb(path.join(STATE, "signing/test-signing.sqlite"), db => db.prepare("SELECT count(*) AS n FROM signatures WHERE state NOT IN ('finalized','reverted')").get().n);
      const holds = readDb(path.join(STATE, "scheduler/koin-funded-sessions/funded-reservations.sqlite"), db => db.prepare("SELECT count(*) AS n FROM holds WHERE state NOT IN ('settled','cancelled')").get().n);
      const status = JSON.stringify({ network: states.map(s => s.state), signing: r.state, rewardStep: step.state, unfinishedSignatures: unfinished, unfinishedChats: holds });
      if (status !== last || Date.now() - lastLog >= 20000) { console.log(status); last = status; lastLog = Date.now(); }
      if (states.every(s => s.state === "finalized") && r.state === "finalized" && step.state === "complete" && !unfinished && !holds) {
        const response = await fetch("http://127.0.0.1:3108/health", { redirect: "error", signal: AbortSignal.timeout(5000) });
        const health = await response.json();
        if (response.ok && health.mode === "mainnet-pilot" && health.chainId === CHAIN && health.mainnetPaymentsEnabled === true &&
            Number.isSafeInteger(health.lastSuccess) && health.lastSuccess <= Date.now() && Date.now() - health.lastSuccess < 60000 && show("ActiveState") === "active") return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw Error("Confirmation/reconciliation is still pending. The original transaction and retry record are preserved; rerunning only checks status");
  };
  const beforeSend = tx => {
    const { r, step } = read();
    if (r.state !== "signed" || step.state !== "needs_review" || step.reason !== "attempt_limit" || step.outbox.attempts !== 3 ||
        !equal(r.transaction, tx) || !step.outbox.days.includes(String(Math.floor(Date.now() / DAY))))
      throw Error("Existing retry fence changed before submission; original records preserved");
  };
  return { load, observe, preflight, beforeSend, submit: tx => request(peers[0].url, "chain.submit_transaction", { transaction: tx, broadcast: true }),
    store: attemptStore(path.join(STATE, "reviewed-recovery-" + RECORD)), waitReady };
}
if (require.main === module) {
  if (process.getuid?.() !== 0 || process.argv.slice(2).join(" ") !== "--approve-retry=" + TX) {
    console.error("As root, approve one retry of the reviewed saved transaction with --approve-retry=" + TX); process.exitCode = 1;
  } else {
    process.umask(0o077);
    try { recover({ approval: TX, ...environment() }).catch(e => { console.error("Recovery stopped: " + safe(e.message)); process.exitCode = 1; }); }
    catch (e) { console.error("Recovery stopped: " + safe(e.message)); process.exitCode = 1; }
  }
}
module.exports = { recover, attemptStore, simulation, record, TX, SINCE, UNTIL };
