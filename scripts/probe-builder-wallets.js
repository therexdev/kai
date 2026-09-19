"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os"),
  vm = require("vm"),
  { Signer, Transaction, utils } = require("koilib");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { starter, validate, html } = require("../lib/builder/projects");
const { BuildChain, wasmHash } = require("../lib/builder/chain");
const { BuildSigner } = require("./build/signer");

test("compiled app and guard execute contract dispatch from _start", () => {
  for (const name of ["contract", "guard"]) {
    const calls = [],
      module = new WebAssembly.Module(
        fs.readFileSync(
          path.join(root, "contracts/build-app/build", name + ".wasm"),
        ),
      );
    const instance = new WebAssembly.Instance(module, {
      env: {
        invoke_system_call(id) {
          calls.push(id);
          throw Error("reached Koinos system call");
        },
      },
    });
    assert.throws(() => instance.exports._start(), /reached Koinos/);
    assert.equal(
      calls[0],
      603,
      name + " must read Koinos arguments, not return silently",
    );
  }
});

test("generated apps reject EVM wallets and retain the trusted Koinos bridge", () => {
  const files = starter("voting", "Vote");
  for (const code of [
    "window.ethereum.request({method:'eth_requestAccounts'})",
    "const wallet = 'MetaMask'",
    "new ethers.BrowserProvider(window.ethereum)",
  ])
    assert.throws(
      () => validate({ ...files, "app.js": code }),
      /Kondor and KOIN Vault/,
    );
  assert.equal(
    validate({
      ...files,
      "app.js": "kai.connect('koinvault').catch(console.error)",
    }).ok,
    true,
  );
  assert.match(html(files), /disconnect/);
});

test("preview ignores extension errors while preserving real app failures", () => {
  const listeners = {},
    messages = [],
    parent = { postMessage: (v) => messages.push(v) };
  const window = {
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
  };
  vm.runInNewContext(read("views/build/runtime.js"), {
    window,
    parent,
    setTimeout,
    clearTimeout,
    Map,
    Error,
  });
  listeners.unhandledrejection({
    reason: {
      message: "Failed to connect to MetaMask",
      stack: "chrome-extension://wallet/inpage.js",
    },
  });
  assert.equal(messages.length, 0);
  listeners.unhandledrejection({ reason: Error("The poll could not load") });
  assert.equal(messages[0].message, "The poll could not load");
  listeners.error({
    message: "broken app",
    filename: "https://koinosai.com/apps/test/content",
  });
  assert.equal(messages[1].message, "broken app");
  listeners.securitypolicyviolation({
    effectiveDirective: "form-action",
    blockedURI: "https://example.invalid/?private=data",
    lineNumber: 12,
    columnNumber: 3,
  });
  assert.equal(messages[2].kind, "policy");
  assert.match(messages[2].message, /preventDefault/);
  assert.doesNotMatch(JSON.stringify(messages[2]), /private=data/);
  assert.equal(messages[2].line, 12);
  listeners.securitypolicyviolation({
    effectiveDirective: "script-src-elem",
    blockedURI: "inline",
    sourceFile: "chrome-extension://wallet/content-script.js",
  });
  assert.equal(messages.length, 3);
});

function browser(fetchImpl) {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.textContent = "";
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    prepend(node) {
      this.children.unshift(node);
    }
    insertBefore(node, target) {
      this.children.splice(this.children.indexOf(target), 0, node);
    }
    setAttribute() {}
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this.onclose?.();
    }
    remove() {
      this.removed = true;
    }
  }
  const document = {
    createElement: (tag) => new Element(tag),
    body: new Element("body"),
  };
  const window = {};
  Object.defineProperty(window, "ethereum", {
    get() {
      throw Error("EVM provider must never be accessed");
    },
  });
  const context = {
    window,
    document,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    AbortSignal,
    location: { origin: "https://koinosai.com" },
    setTimeout,
    clearTimeout,
    structuredClone,
    qrcode: () => ({
      addData() {},
      make() {},
      createDataURL: () => "data:image/gif;base64,AA==",
    }),
  };
  vm.runInNewContext(read("views/build/wallets.js"), context);
  return { window, document, wallet: window.KaiBuildWallets.create() };
}
const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const account = Signer.fromSeed("wallet integration probe").getAddress();
const json = (data) => ({
  ok: true,
  json: async () => ({ ok: true, ...data }),
});

test("Kondor connection and signing never touch injected EVM providers", async () => {
  const b = browser(() => {
    throw Error("no HTTP expected");
  });
  b.window.kondor = {
    getAccounts: async () => [{ address: account }],
    getSigner: (address) => ({
      signTransaction: async (tx) => {
        assert.equal(address, account);
        return { transaction: { ...tx, signatures: ["kondor"] } };
      },
    }),
  };
  assert.equal((await b.wallet.connect({}, "kondor")).address, account);
  const signed = await b.wallet.sign({
    signerAddress: account,
    transaction: { id: "tx" },
    contractId: "app",
    abi: {},
  });
  assert.equal(signed.signatures[0], "kondor");
  await assert.rejects(
    () => b.wallet.connect({}, "metamask"),
    /Kondor or KOIN Vault/,
  );
  b.wallet.destroy();
});

test("mainnet-only Vault refuses testnet before creating a connection", async () => {
  let requests = 0;
  const b = browser(() => {
    requests++;
  });
  await assert.rejects(
    () =>
      b.wallet.connect(
        { network: "testnet", chain_id: "testnet" },
        "koinvault",
      ),
    /currently on mainnet/,
  );
  assert.equal(requests, 0);
  b.wallet.destroy();
});

test("KOIN Vault pairs with a local QR, approves once, and detects wallet-side disconnect", async () => {
  let connected = true,
    posts = 0;
  const b = browser(async (url, options) => {
    assert.equal(url.origin, "https://koinvault.app");
    assert.equal(options.credentials, "omit");
    if (url.pathname.endsWith("/create"))
      return json({
        sessionId: "test",
        secret: "local",
        expiresAt: Date.now() + 600000,
        uri: "https://koinvault.app/?connect=test&secret=local",
      });
    if (url.pathname.endsWith("/status"))
      return json({
        connected,
        address: account,
        origin: "https://koinosai.com",
      });
    if (url.pathname.endsWith("/request-status"))
      return json({ status: "approved", txid: "0x1220" + "a".repeat(64) });
    if (url.pathname.endsWith("/request")) {
      posts++;
      assert.equal(JSON.parse(options.body).mana, "wallet");
      return json({ requestId: "request", expiresAt: Date.now() + 600000 });
    }
    throw Error("Unexpected endpoint");
  });
  assert.equal(
    (await b.wallet.connect({ chainId: MAINNET }, "koinvault")).address,
    account,
  );
  assert.ok(
    b.document.body.children.some((d) =>
      d.children.some((n) => n.tag === "img" && n.src.startsWith("data:")),
    ),
  );
  const result = await b.wallet.sign({
    id: "draft",
    chainId: MAINNET,
    signerAddress: account,
    transaction: { operations: [] },
  });
  assert.equal(result.wallet, "koinvault");
  assert.equal(posts, 1);
  connected = false;
  await assert.rejects(
    () => b.wallet.connect({ chainId: MAINNET }),
    /disconnected/,
  );
  b.wallet.destroy();
});

test("an uncertain KOIN Vault request is not automatically posted again", async () => {
  let posts = 0;
  const b = browser(async (url) => {
    if (url.pathname.endsWith("/create"))
      return json({
        sessionId: "test",
        secret: "local",
        expiresAt: Date.now() + 600000,
        uri: "https://koinvault.app/?connect=test&secret=local",
      });
    if (url.pathname.endsWith("/status"))
      return json({
        connected: true,
        address: account,
        origin: "https://koinosai.com",
      });
    if (url.pathname.endsWith("/request")) {
      posts++;
      throw Error("response lost");
    }
    throw Error("unexpected");
  });
  await b.wallet.connect({ chainId: MAINNET }, "koinvault");
  const draft = {
    id: "draft",
    chainId: MAINNET,
    signerAddress: account,
    transaction: { operations: [] },
  };
  await assert.rejects(() => b.wallet.sign(draft), /unreachable/);
  await assert.rejects(() => b.wallet.sign(draft), /outcome is unknown/);
  assert.equal(posts, 1);
  b.wallet.destroy();
});

test("Vault receipts pin payer, chain, nonce and exact operations without EOA signature recovery", async () => {
  const expected = await Transaction.prepareTransaction(
    {
      header: {
        payer: account,
        nonce: "KAE=",
        chain_id: MAINNET,
        rc_limit: "200000000",
      },
      operations: [
        {
          call_contract: { contract_id: account, entry_point: 1, args: "AA==" },
        },
      ],
    },
    undefined,
    account,
  );
  const actual = structuredClone(expected);
  actual.header.rc_limit = "10000000000";
  actual.id = Transaction.computeTransactionId(actual.header);
  actual.signatures = ["passkey-format"];
  const chain = new BuildChain();
  chain.assertChain = async () => {};
  chain.provider.getTransactionsById = async () => ({
    transactions: [{ transaction: actual }],
  });
  assert.equal(await chain.vaultReceipt(expected, actual.id), actual.id);
  for (const mutate of [
    (t) => (t.header.payer = Signer.fromSeed("wrong").getAddress()),
    (t) =>
      (t.header.chain_id = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ=="),
    (t) => (t.header.nonce = "KAA="),
    (t) => t.operations.reverse().push(t.operations[0]),
    (t) => (t.operations[0].call_contract.args = "AQ=="),
  ]) {
    const wrong = structuredClone(actual);
    mutate(wrong);
    wrong.id = Transaction.computeTransactionId(wrong.header);
    chain.provider.getTransactionsById = async () => ({
      transactions: [{ transaction: wrong }],
    });
    await assert.rejects(
      () => chain.vaultReceipt(expected, wrong.id),
      /does not match/,
    );
  }
});

test("known confirmed no-op deployment is archived and retried under a new address", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-legacy-"));
  const signer = Signer.fromSeed("deployment recovery test");
  const s = new BuildSigner({
    stateDir: dir,
    wif: signer.getPrivateKey("wif"),
    encryptionKey: "ab".repeat(32),
  });
  const p = {
    projectId: "app_" + "a".repeat(24),
    accountId: "acc_probe",
    operationId: "job_" + "b".repeat(24),
    hash: "c".repeat(64),
    title: "Recovered app",
  };
  const old = s.create(p),
    payload = JSON.stringify({
      projectId: p.projectId,
      accountId: p.accountId,
      hash: p.hash,
      title: p.title,
      target: null,
    });
  const tx = {
    id: "legacy-tx",
    operations: [
      {
        upload_contract: {
          contract_id: old.address,
          bytecode: fs
            .readFileSync(
              path.join(__dirname, "fixtures/builder-legacy-noop.wasm"),
            )
            .toString("base64url"),
        },
      },
    ],
  };
  s.db
    .prepare(
      "INSERT INTO operations(id,project_id,kind,payload,transaction_json,created_at,rc_limit) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      p.operationId,
      p.projectId,
      "release",
      payload,
      JSON.stringify(tx),
      Date.now(),
      "2000000000",
    );
  s.chain.assertChain = async () => {};
  s.chain.confirmed = async () => {
    throw Object.assign(Error("still pending"), { status: 409 });
  };
  await assert.rejects(() => s.run("release", p), /still pending/);
  assert.equal(s.app(p).address, old.address);
  assert.equal(
    s.db.prepare("SELECT count(*) n FROM retired_deployments").get().n,
    0,
  );
  let confirmations = 0;
  s.chain.confirmed = async (id) => {
    assert.equal(id, "legacy-tx");
    confirmations++;
    return true;
  };
  s.chain.provider.invokeGetContractMetadata = async (id) => {
    assert.equal(id, old.address);
    return {
      value: {
        hash: "0x122056495da7bf263f95a0a57c5e468ad91bed8cc60b04c89edd7df9d30741b2657a",
      },
    };
  };
  // Stop immediately after recovery, before preparing/broadcasting the new tx.
  s.limit = () => {
    throw Object.assign(Error("recovered safely"), { status: 409 });
  };
  await assert.rejects(() => s.run("release", p), /recovered safely/);
  assert.equal(confirmations, 1);
  assert.notEqual(s.app(p).address, old.address);
  const archived = s.db.prepare("SELECT * FROM retired_deployments").get();
  assert.equal(JSON.parse(archived.app_json).encrypted_key, old.encrypted_key);
  assert.equal(s.db.prepare("SELECT count(*) n FROM operations").get().n, 0);
  s.dailyMana = 2000000000n;
  assert.throws(
    () => BuildSigner.prototype.limit.call(s),
    /daily deployment mana allowance/,
  );
  s.db.close();
  fs.rmSync(dir, { recursive: true });
});

test("old signer is stopped before release and the saved job resumes after its update", async () => {
  const { Builder } = require("../lib/builder/service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-preflight-"));
  let updated = false,
    releases = 0;
  const b = new Builder({
    stateDir: dir,
    autoStart: false,
    signer: {
      configured: true,
      call: async (action) => {
        if (action === "status")
          return updated
            ? {
                contractHash: wasmHash("contract"),
                guardHash: wasmHash("guard"),
                publishingProtocol: require("../lib/builder/chain")
                  .PUBLISHING_PROTOCOL,
              }
            : { ready: true };
        releases++;
        return {
          chainId: b.chain.config.chainId,
          network: "testnet",
          contractId: account,
          guardId: account,
          owner: account,
          txId: "verified-test-transaction",
        };
      },
    },
  });
  const p = b.store.create(
    "acc_probe",
    "Ready",
    "voting",
    starter("voting", "Ready"),
  );
  const job = b.store.enqueue("acc_probe", p.id, "publish", { revision: 1 });
  await b.tick();
  assert.equal(releases, 0);
  assert.match(
    b.store.detail("acc_probe", p.id).jobs[0].error,
    /publishing service needs an update/,
  );
  updated = true;
  b.retry("acc_probe", p.id, job.id);
  await b.tick();
  assert.equal(releases, 1);
  assert.equal(b.store.owned("acc_probe", p.id).live_revision, 1);
  b.store.close();
  fs.rmSync(dir, { recursive: true });
});
