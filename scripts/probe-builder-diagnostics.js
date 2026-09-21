"use strict";
const test = require("node:test"), assert = require("node:assert/strict"),
  fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");
const { BuildChain } = require("../lib/builder/chain"),
  { BuildStore } = require("../lib/builder/store"),
  { BuildAgent } = require("../lib/builder/agent"),
  { starter } = require("../lib/builder/projects"),
  { Signer, Transaction } = require("koilib");
const chainId = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";

test("Kondor mana optimization changes the ID but preserves the reviewed action and signer", async () => {
  const signer = Signer.fromSeed("builder mana fixture"), address = signer.getAddress();
  const expected = await Transaction.prepareTransaction({
    header: { payer: address, chain_id: chainId, nonce: "KAE=", rc_limit: "200000000" },
    operations: [{ call_contract: { contract_id: address, entry_point: 1, args: "AA==" } }],
  }, undefined, address);
  const signed = structuredClone(expected);
  signed.header.rc_limit = "17500000";
  signed.header.payee = address;
  signed.id = Transaction.computeTransactionId(signed.header);
  await signer.signTransaction(signed);
  const chain = new BuildChain();
  chain.assertChain = async () => {};
  const sent = [];
  chain.provider.sendTransaction = async (tx) => sent.push(tx);
  let savedId;
  assert.equal(await chain.submitExact(expected, signed, address, id => savedId = id), signed.id);
  assert.notEqual(savedId, expected.id);
  assert.equal(sent[0].header.rc_limit, "17500000");
  for (const mutate of [
    t => t.operations[0].call_contract.args = "AQ==",
    t => t.operations.push(t.operations[0]),
    t => t.header.payer = Signer.fromSeed("other").getAddress(),
    t => t.header.payee = Signer.fromSeed("other").getAddress(),
    t => t.header.chain_id = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==",
    t => t.header.nonce = "KAI=",
    t => t.header.rc_limit = "0",
  ]) {
    const changed = structuredClone(signed);
    mutate(changed);
    changed.id = Transaction.computeTransactionId(changed.header);
    changed.signatures = [];
    await signer.signTransaction(changed);
    await assert.rejects(() => chain.submitExact(expected, changed, address), /changed/);
  }
  assert.equal(sent.length, 1);
  chain.provider.sendTransaction = async () => { throw Error("invalid account nonce"); };
  chain.confirmed = async () => true;
  assert.equal(await chain.submitExact(expected, signed, address), signed.id);
  chain.provider.sendTransaction = async () => ({ receipt: { reverted: true, logs: ["Poll is closed"] } });
  await assert.rejects(() => chain.submitExact(expected, signed, address), /Poll is closed/);
});

function bridgeHarness({ sign, submit }) {
  const reports = [], responses = [], prepared = [];
  let listener, sequence = 0;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; }
    append(...nodes) { this.children.push(...nodes); }
    remove() {}
    close() { this.onclose?.(); }
    showModal() { this.children[3].children[0].onclick(); }
  }
  const document = { createElement: tag => new Element(tag), body: new Element("body") };
  const wallet = {
    connect: async () => ({ address: "reviewed-account", wallet: "kondor" }),
    sign, disconnect: async () => {}, destroy() {},
  };
  const window = { addEventListener: (_type, fn) => listener = fn, removeEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../views/build/bridge.js"), "utf8"), {
    window, document, KaiBuildWallets: { create: () => wallet },
  });
  const frame = { contentWindow: { postMessage: value => responses.push(value) } };
  window.KaiBuildBridge.create(frame, {
    mode: "live", getProject: () => ({ title: "Fixture", network: "testnet" }),
    onDiagnostic: value => reports.push(value),
    api: async (action, args) => {
      if (action === "prepare") {
        const draft = { id: String(prepared.length + 1), transaction: { id: "tx" }, ...args };
        prepared.push(draft); return { draft };
      }
      return submit(args);
    },
  });
  return {
    prepared, reports, responses,
    async request(method, args = {}) {
      await listener({ source: frame.contentWindow, origin: "null", data: { type: "kai-app-request", id: String(++sequence), method, args } });
      return responses.at(-1);
    },
  };
}

test("a failed Kondor signature releases the unsigned draft and records its actual phase", async () => {
  let attempts = 0, submissions = 0;
  const b = bridgeHarness({
    sign: async () => { if (++attempts === 1) throw Error("Approval cancelled"); return { id: "signed", signatures: ["fixture"] }; },
    submit: async () => { submissions++; return { txId: "signed" }; },
  });
  await b.request("connect");
  const action = { method: "create_record", args: { title: "Feature" } };
  const failed = await b.request("call", action);
  assert.equal(failed.failure.phase, "sign");
  assert.equal(b.reports[0].wallet, "kondor");
  assert.equal(submissions, 0);
  assert.equal((await b.request("call", action)).result.txId, "signed");
  assert.equal(b.prepared.length, 2);
  assert.equal(submissions, 1);
});

test("an uncertain submission retains its signed request and never signs a replacement", async () => {
  let signatures = 0, submissions = 0;
  const requests = [];
  const b = bridgeHarness({
    sign: async () => { signatures++; return { id: "saved" }; },
    submit: async args => { requests.push(args); if (++submissions === 1) throw Error("Server response lost"); return { txId: "saved" }; },
  });
  await b.request("connect");
  const action = { method: "create_record", args: { title: "Feature" } };
  assert.equal((await b.request("call", action)).failure.phase, "submit");
  assert.match((await b.request("call", { method: "vote", args: { id: 1 } })).error, /previous wallet request/);
  assert.equal((await b.request("call", action)).result.txId, "saved");
  assert.equal(signatures, 1);
  assert.equal(b.prepared.length, 1);
  assert.equal(requests[0], requests[1]);
});

test("published diagnostics are owner-only, versioned, bounded and survive restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-diagnostics-"));
  let s = new BuildStore(dir);
  const p = s.create("owner", "Live", "board", starter("board", "Live"));
  s.publish("owner", p.id, 1, { contractId: "app", chainId, network: "testnet", owner: "owner", txId: "tx" }, "release");
  assert.throws(() => s.recordDiagnostics("other", p.id, { revision: 1, errors: [] }), /not found/);
  assert.equal(s.recordDiagnostics("owner", p.id, { revision: 2, errors: [{ message: "stale" }] }), 0);
  for (let i = 0; i < 30; i++) s.recordDiagnostics("owner", p.id, {
    revision: 1, errors: [{ kind: "bridge", phase: "sign", wallet: "kondor", message: "Original error " + i, form: "private form", code: "SIGN_FAILED" }],
  });
  assert.equal(s.db.prepare("SELECT count(*) n FROM app_diagnostics").get().n, 24);
  s.close(); s = new BuildStore(dir);
  const reports = s.liveDiagnostics("owner", p.id);
  assert.equal(reports.length, 12);
  assert.equal(reports[0].message, "Original error 29");
  assert.equal(reports[0].phase, "sign");
  assert.equal(reports[0].form, undefined);
  assert.equal(reports[0].source, "published app");
  s.close();
});

test("the AI can inspect live evidence and source and read only supported contract methods", async () => {
  const calls = [
    { name: "inspect_app", arguments: "{}" },
    { name: "read_live_source", arguments: "{}" },
    { name: "read_app_contract", arguments: JSON.stringify({ method: "get_config", id: null, offset: null }) },
    { name: "read_app_contract", arguments: JSON.stringify({ method: "create_record", id: null, offset: null }) },
  ];
  let step = 0, reads = 0;
  const agent = new BuildAgent({ key: "fixture", fetchImpl: async (_url, options) => {
    const input = JSON.parse(options.body);
    assert.match(input.instructions, /Never blame Kondor/);
    assert.match(input.input.at(-1).content || input.input[0].content, /./);
    if (step === calls.length) {
      const outputs = input.input.filter(x => x.type === "function_call_output").map(x => JSON.parse(x.output));
      assert.equal(outputs[0].liveErrors[0].phase, "prepare");
      assert.equal(outputs[1].revision, 7);
      assert.equal(outputs[2].config.count, 2);
      assert.match(outputs[3].error, /unavailable/);
      return { ok: true, json: async () => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "The live error happened during preparation." }] }] }) };
    }
    const call = calls[step++];
    return { ok: true, json: async () => ({ status: "completed", output: [{ type: "function_call", call_id: "c" + step, ...call }] }) };
  } });
  await agent.run({
    files: starter("board", "Draft"), messages: [], prompt: "Fix the live app",
    liveDiagnostics: [{ phase: "prepare", message: "Original failure" }],
    inspectApp: async () => ({ liveRevision: 7 }),
    readLiveSource: async () => ({ revision: 7, files: { "app.js": "// live" } }),
    readContract: async () => { reads++; return { config: { count: 2 } }; },
  });
  assert.equal(reads, 1);
});
