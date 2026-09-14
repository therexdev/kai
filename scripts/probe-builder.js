"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os"),
  crypto = require("crypto"),
  express = require("express");
const { BuildStore, digest } = require("../lib/builder/store"),
  { starter, validate, html } = require("../lib/builder/projects"),
  { BuildAgent } = require("../lib/builder/agent"),
  { Builder } = require("../lib/builder/service"),
  { createBuilderRouter } = require("../lib/builder/router"),
  { createAccounts } = require("../lib/accounts"),
  { BuildChain } = require("../lib/builder/chain"),
  { Signer, Transaction } = require("koilib");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-build-test-"));
test("projects, source and chats remain account scoped and survive restart", () => {
  const dir = tmp();
  let s = new BuildStore(dir);
  const p = s.create("acc_one", "One", "voting", starter("voting", "One"));
  assert.throws(() => s.files("acc_two", p.id), /not found/);
  assert.throws(() => s.detail("acc_two", p.id), /not found/);
  assert.throws(
    () => s.saveRevision("acc_two", p.id, {}, "attack"),
    /not found/,
  );
  assert.deepEqual(s.list("acc_two"), []);
  s.close();
  s = new BuildStore(dir);
  assert.equal(s.detail("acc_one", p.id).messages.length, 1);
  assert.ok(s.files("acc_one", p.id).files["index.html"].includes("One"));
  s.close();
});
test("jobs recover after interruption without allowing concurrent project writes", () => {
  const s = new BuildStore(tmp()),
    p = s.create("acc_one", "One", "board", starter("board", "One"));
  const job = s.enqueue("acc_one", p.id, "edit", {
    prompt: "change",
    revision: 1,
  });
  assert.throws(() => s.enqueue("acc_one", p.id, "edit", {}), /already/);
  assert.equal(s.claim().id, job.id);
  assert.equal(s.claim(), null);
  s.db.prepare("UPDATE jobs SET lease_until=0 WHERE id=?").run(job.id);
  assert.equal(s.claim().id, job.id);
  s.db
    .prepare("UPDATE jobs SET lease_until=0,attempts=3 WHERE id=?")
    .run(job.id);
  assert.equal(s.claim(), null);
  assert.equal(s.detail("acc_one", p.id).jobs[0].status, "failed");
  s.close();
});
test("publication pins its saved revision and is idempotent", () => {
  const s = new BuildStore(tmp()),
    p = s.create("acc_one", "One", "voting", starter("voting", "One")),
    chain = {
      contractId: "contract",
      chainId: "test",
      network: "testnet",
      owner: "platform",
      txId: "tx",
    };
  s.publish("acc_one", p.id, 1, chain, "job_release");
  s.publish("acc_one", p.id, 1, chain, "job_release");
  s.saveRevision("acc_one", p.id, starter("voting", "Draft edit"), "draft");
  const pub = s.publicProject(p.slug);
  assert.equal(pub.live_revision, 1);
  assert.ok(!s.publicFiles(pub)["index.html"].includes("Draft edit"));
  assert.equal(s.detail("acc_one", p.id).releases.length, 1);
  assert.equal(s.owned("acc_one", p.id).platform_owner, "platform");
  s.close();
});
test("draft validation rejects traversal, server files, oversized source and malformed JS", () => {
  const files = starter("blank", "Hello");
  assert.equal(validate(files).ok, true);
  assert.throws(
    () => validate({ ...files, "../server.js": "x" }),
    /Unsupported/,
  );
  assert.throws(() => validate({ ...files, "app.js": "while(" }), /syntax/);
  assert.throws(
    () => validate({ ...files, "app.css": "x".repeat(301000) }),
    /300 KB/,
  );
  assert.ok(html(files).includes("kai-app-request"));
  assert.throws(
    () => html({ ...files, "index.html": "<html><body>bad</body></html>" }),
    /head element/,
  );
});
test("OpenAI tool loop applies an actual file change, validates it and returns a summary", async () => {
  const files = starter("blank", "Before"),
    changed = files["index.html"].replaceAll("Before", "After");
  let step = 0,
    usage = 0;
  const outputs = [
    [
      {
        type: "function_call",
        name: "read_project",
        call_id: "c1",
        arguments: "{}",
      },
    ],
    [
      {
        type: "function_call",
        name: "write_files",
        call_id: "c2",
        arguments: JSON.stringify({
          files: [{ path: "index.html", content: changed }],
        }),
      },
    ],
    [
      {
        type: "function_call",
        name: "validate_project",
        call_id: "c3",
        arguments: "{}",
      },
    ],
    [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Updated the heading." }],
      },
    ],
  ];
  const agent = new BuildAgent({
    key: "fixture-key",
    fetchImpl: async (url, opts) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(opts.body);
      assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.ok(!body.tools.some((t) => /sign|publish|shell/.test(t.name)));
      return {
        ok: true,
        json: async () => ({
          status: "completed",
          output: outputs[step++],
          usage: { total_tokens: 10 },
        }),
      };
    },
  });
  const out = await agent.run({
    files,
    messages: [],
    prompt: "Change Before to After",
    onUsage: (n) => (usage += n),
  });
  assert.equal(step, 4);
  assert.equal(usage, 40);
  assert.equal(out.changed, true);
  assert.ok(out.files["index.html"].includes("After"));
  assert.equal(out.summary, "Updated the heading.");
});
test("failed AI edits cannot overwrite the last saved version", async () => {
  const b = new Builder({
      stateDir: tmp(),
      autoStart: false,
      agent: {
        configured: true,
        run: async () => {
          throw Error("provider failure");
        },
      },
    }),
    p = b.store.create("acc_one", "Safe", "blank", starter("blank", "Safe"));
  b.store.enqueue("acc_one", p.id, "edit", { prompt: "edit", revision: 1 });
  await b.tick();
  assert.equal(b.store.owned("acc_one", p.id).revision, 1);
  assert.equal(b.store.detail("acc_one", p.id).jobs[0].status, "failed");
  b.close();
});
test("HTTP routes share real session auth and refuse cross-account / opaque-origin access", async () => {
  const dir = tmp(),
    app = express();
  app.use(express.json({ limit: "512kb" }));
  const origin = "http://127.0.0.1";
  const accounts = createAccounts({ stateDir: dir, siteOrigin: origin }),
    builder = new Builder({ stateDir: dir, autoStart: false });
  app.use(accounts.router);
  app.use(createBuilderRouter({ accounts, stateDir: dir, builder }).router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const a = accounts.service._newAccount({ email: "one@example.test" }),
      b = accounts.service._newAccount({ email: "two@example.test" }),
      token = accounts.service._issueSession(a.id, "probe"),
      other = accounts.service._issueSession(b.id, "probe");
    const request = async (
      route,
      { method = "GET", body, session = token, originHeader = origin } = {},
    ) => {
      const headers = {};
      if (session) headers.cookie = "kai_session=" + session;
      if (body) {
        headers["content-type"] = "application/json";
        headers.origin = originHeader;
      }
      const r = await fetch(base + route, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return { status: r.status, headers: r.headers, text, data };
    };
    assert.equal((await request("/build", { session: null })).status, 302);
    assert.equal(
      (await request("/build/api/projects", { session: null })).status,
      401,
    );
    assert.equal((await request("/build")).status, 200);
    const created = await request("/build/api/projects", {
      method: "POST",
      body: { title: "My app", template: "voting" },
    });
    assert.equal(created.status, 201);
    const p = created.data.project;
    assert.equal(
      (await request("/build/api/projects/" + p.id, { session: other })).status,
      404,
    );
    assert.equal(
      (
        await request("/build/api/projects/" + p.id + "/preview", {
          session: other,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request("/build/api/projects", {
          method: "POST",
          body: { title: "attack" },
          originHeader: "null",
        })
      ).status,
      403,
    );
    const preview = await request("/build/api/projects/" + p.id + "/preview");
    assert.equal(preview.status, 200);
    assert.match(
      preview.headers.get("content-security-policy"),
      /sandbox allow-scripts/,
    );
    assert.ok(
      !preview.headers
        .get("content-security-policy")
        .includes("allow-same-origin"),
    );
    assert.match(
      preview.headers.get("content-security-policy"),
      /connect-src 'none'/,
    );
    assert.ok(preview.text.includes("kai-app-request"));
    const files = builder.store.files(a.id, p.id).files;
    assert.equal(
      (
        await request("/build/api/projects/" + p.id + "/files", {
          method: "PUT",
          body: { revision: 0, files },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/build/api/projects/" + p.id + "/files", {
          method: "PUT",
          body: { revision: 1, files },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/build/api/projects/" + p.id + "/publish", {
          method: "POST",
          body: { revision: 2 },
        })
      ).status,
      503,
    );
    const exported = await request("/build/api/projects/" + p.id + "/export");
    assert.equal(exported.data.format, "kai-build-project-v1");
    assert.ok(!exported.text.includes("encrypted_key"));
    const imported = await request("/build/api/projects/import", {
      method: "POST",
      body: exported.data,
    });
    assert.equal(imported.status, 201);
    assert.notEqual(imported.data.project.id, p.id);
    assert.equal(imported.data.project.contract_id, null);
  } finally {
    await new Promise((r) => server.close(r));
    builder.close();
    accounts.service.db.close();
  }
});
test("transaction validation rejects wallet changes and unrelated signatures", async () => {
  const signer = new Signer({ privateKey: crypto.randomBytes(32) }),
    other = new Signer({ privateKey: crypto.randomBytes(32) }),
    c = new BuildChain({
      rpc: "https://unused.invalid",
      chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==",
      network: "testnet",
      rcLimit: "100",
    });
  const expected = await Transaction.prepareTransaction(
    {
      header: {
        payer: signer.getAddress(),
        chain_id: c.config.chainId,
        rc_limit: "100",
        nonce: "KAE=",
      },
      operations: [
        {
          call_contract: {
            contract_id: signer.getAddress(),
            entry_point: 1,
            args: "",
          },
        },
      ],
    },
    undefined,
    signer.getAddress(),
  );
  let submitted = 0;
  c.assertChain = async () => {};
  c.provider.sendTransaction = async () => {
    submitted++;
    return {};
  };
  const valid = structuredClone(expected);
  await signer.signTransaction(valid);
  assert.equal(
    await c.submitExact(expected, valid, signer.getAddress()),
    expected.id,
  );
  assert.equal(submitted, 1);
  const changed = structuredClone(valid);
  changed.header.rc_limit = "999";
  await assert.rejects(
    () => c.submitExact(expected, changed, signer.getAddress()),
    /changed/,
  );
  const wrong = structuredClone(expected);
  await other.signTransaction(wrong);
  await assert.rejects(
    () => c.submitExact(expected, wrong, signer.getAddress()),
    /wallet shown/,
  );
  assert.equal(submitted, 1);
});

test("finality lookup recovers historical transactions and rejects noncanonical blocks", async () => {
  const c = new BuildChain();
  c.provider.getTransactionsById = async () => ({
    transactions: [
      { transaction: { id: "tx-old" }, containing_blocks: ["old-block"] },
    ],
  });
  c.provider.getBlocksById = async () => ({
    block_items: [
      {
        block_id: "old-block",
        block_height: "25",
        receipt: { transaction_receipts: [{ id: "tx-old", reverted: false }] },
      },
    ],
  });
  c.provider.getHeadInfo = async () => ({
    head_topology: { id: "head-now", height: "800" },
    last_irreversible_block: "790",
  });
  c.provider.getBlocks = async (height, count, head) => {
    assert.equal(height, 25);
    assert.equal(head, "head-now");
    return [{ block_id: "old-block" }];
  };
  assert.equal(await c.confirmed("tx-old"), true);
  c.provider.getBlocksById = async () => ({
    block_items: [
      {
        block_id: "old-block",
        block_height: "25",
        receipt: { transaction_receipts: [{ id: "tx-old", reverted: true }] },
      },
    ],
  });
  await assert.rejects(() => c.confirmed("tx-old"), /reverted/);
  c.provider.getBlocks = async () => [{ block_id: "other-fork" }];
  await assert.rejects(() => c.confirmed("tx-old"), /confirmed chain/);
});
test("wallet requests put a verified immutable guard before the app call", async () => {
  const { wasmHash, guardOperation } = require("../lib/builder/chain");
  const c = new BuildChain(),
    payer = Signer.fromSeed("public probe wallet").getAddress(),
    id = Signer.fromSeed("public probe app").getAddress(),
    guard = Signer.fromSeed("public probe guard").getAddress();
  c.assertChain = async () => {};
  c.provider.getNextNonce = async () => "KAE=";
  c.provider.invokeGetContractMetadata = async (address) => ({
    value: {
      hash: wasmHash(address === guard ? "guard" : "contract"),
      authorizes_call_contract: true,
      authorizes_transaction_application: true,
      authorizes_upload_contract: true,
    },
  });
  const tx = await c.preparePublic(
    id,
    "create_record",
    { title: "Poll", options: ["Yes", "No"] },
    payer,
    guard,
  );
  assert.deepEqual(tx.operations[0], guardOperation(id, guard));
  assert.equal(tx.operations[1].call_contract.contract_id, id);
  const release = await c.prepare(
    id,
    "set_release",
    { title: "App", release_hash: "AA" },
    payer,
    guard,
  );
  assert.deepEqual(release.operations[0], guardOperation(id, guard, payer));
  const accept = await c.prepare(id, "accept_owner", {}, payer, guard);
  assert.deepEqual(
    accept.operations[0],
    guardOperation(id, guard, null, payer),
  );
  c.provider.invokeGetContractMetadata = async () => ({
    value: { hash: "0x1220bad" },
  });
  await assert.rejects(
    () => c.preparePublic(id, "vote", { id: 1 }, payer, guard),
    /replaced/,
  );
});
test("isolated signer journals one transaction, encrypts keys, and refuses changed or transferred apps", async () => {
  const { BuildSigner } = require("./build/signer"),
    { wasmHash } = require("../lib/builder/chain");
  const wallet = Signer.fromSeed("public deterministic builder signing test"),
    service = new BuildSigner({
      stateDir: tmp(),
      wif: wallet.getPrivateKey("wif"),
      encryptionKey: "ab".repeat(32),
    }),
    p = {
      projectId: "app_" + "1".repeat(24),
      accountId: "acc_signer_probe",
      operationId: "job_" + "2".repeat(24),
      title: "My app",
      hash: "a".repeat(64),
    };
  let sent = [],
    included = false,
    owner = wallet.getAddress();
  const c = service.chain;
  c.assertChain = async () => {};
  c.provider.getAccountRc = async () => "9999999999";
  c.provider.getNextNonce = async () => "KAE=";
  c.provider.invokeGetContractMetadata = async () => ({});
  c.provider.sendTransaction = async (tx) => {
    sent.push(structuredClone(tx));
    return {};
  };
  c.confirmed = async () => {
    if (!included) throw Object.assign(Error("pending"), { status: 409 });
    return true;
  };
  c.read = async () => ({ config: { owner, release_hash: p.hash } });
  try {
    const first = await service.run("release", p);
    assert.equal(first.pending, true);
    assert.equal(sent.length, 1);
    const tx = sent[0];
    assert.equal(tx.operations.length, 4);
    assert.ok(tx.operations[0].upload_contract.authorizes_upload_contract);
    assert.equal(tx.operations[2].call_contract.entry_point, 1);
    assert.equal(tx.signatures.length, 3);
    assert.ok((await Signer.recoverAddresses(tx)).includes(owner));
    const dbrow = service.app(p);
    assert.ok(!dbrow.encrypted_key.includes(wallet.getPrivateKey("wif")));
    assert.equal(
      Signer.fromWif(service.decrypt(dbrow.encrypted_key)).getAddress(),
      dbrow.address,
    );
    await assert.rejects(
      () =>
        service.run("release", { ...p, operationId: "job_" + "3".repeat(24) }),
      /previous platform transaction/,
    );
    const retry = await service.run("release", p);
    assert.equal(retry.txId, first.txId);
    assert.deepEqual(sent[1], sent[0]);
    included = true;
    const result = await service.run("release", p);
    assert.equal(result.contractId, dbrow.address);
    assert.equal(result.guardId, service.guard().address);
    await assert.rejects(
      () => service.run("release", { ...p, hash: "b".repeat(64) }),
      /changed/,
    );
    c.provider.invokeGetContractMetadata = async (id) => ({
      value: {
        hash: wasmHash(id === service.guard().address ? "guard" : "contract"),
        authorizes_upload_contract: true,
        authorizes_call_contract: true,
        authorizes_transaction_application: true,
      },
    });
    owner = Signer.fromSeed("new creator wallet").getAddress();
    await assert.rejects(
      () =>
        service.run("release", { ...p, operationId: "job_" + "4".repeat(24) }),
      /belongs to a wallet/,
    );
    c.provider.invokeGetContractMetadata = async () => ({
      value: { hash: "0x1220bad" },
    });
    await assert.rejects(
      () =>
        service.run("release", { ...p, operationId: "job_" + "5".repeat(24) }),
      /contract was changed/,
    );
  } finally {
    service.db.close();
  }
});
