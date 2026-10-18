"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), { Signer } = require("koilib");
const { Meter } = require("../../lib/koin-network/metering"), P = require("../../lib/koin-network/job-protocol");
const { PrepaidLedger } = require("../../lib/koin-network/prepaid-ledger"), { fundedResultHash } = require("../../lib/koin-network/funded-protocol");
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-prepaid-")), buyer = Signer.fromSeed("prepaid-buyer"), worker = Signer.fromSeed("prepaid-provider");
  const owner = buyer.getAddress(), provider = worker.getAddress(), address = n => Signer.fromSeed("prepaid-" + n).getAddress();
  let now = Date.now(), ledger;
  const tariff = { model: "fixture", version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokenizer"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 };
  const encode = s => [...Buffer.from(s)], meter = new Meter([{ tariff, adapter: { ...tariff, render: JSON.stringify, encode,
    input: m => encode(JSON.stringify(m)).length, output: s => encode(s).length } }]);
  const target = { chainId: require("../../lib/koin-network/payment-network").MAINNET_CHAIN, credits: address("contract"),
    creditsHash: "0x1220" + P.hash("prepaid-wasm"), policyHash: meter.policyHash, domain: "shadow:mainnet-pilot-" + P.hash("prepaid-service") };
  const options = { target, meter, encryptionKey: Buffer.alloc(32, 42), clock: () => now, waitMs: 3000, ...overrides };
  const open = () => ledger = new PrepaidLedger(dir, options); open();
  t.after(() => { ledger?.close(); fs.rmSync(dir, { recursive: true, force: true }); for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dir + ".recovery-anchor.sqlite" + suffix, { force: true }); });
  const purchase = (name = "first", amount = "1000") => {
    const id = "0x1220" + P.hash(name); ledger.queuePurchase(id, owner);
    ledger.confirmPurchase(id, { state: "finalized", txId: id, owner, amount, height: "3", blockId: "0x1220" + P.hash("block") }); return id;
  };
  const request = name => ({ id: P.hash(name), owner, model: "fixture", version: 1, messages: [{ role: "user", content: "Private question" }], maxOutput: 16 });
  const complete = async (id, output = "Private answer") => { const job = ledger.dispatch(id, provider); return ledger.complete(id, {
    output, signature: Buffer.from(await worker.signHash(fundedResultHash(target, job, output))).toString("base64") }, true); };
  return { dir, options, target, owner, provider, buyer, worker, meter, tariff, request, purchase, complete,
    get ledger() { return ledger; }, time: ms => { now += ms; }, restart() { ledger.close(); open(); } };
}
module.exports = { fixture };
