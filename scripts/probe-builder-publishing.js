"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { Signer, Transaction } = require("koilib");
const { BuildSigner } = require("./build/signer");
const {
  BuildChain,
  chainErrorDetail,
  wasmHash,
} = require("../lib/builder/chain");
const { Builder } = require("../lib/builder/service");
const { starter } = require("../lib/builder/projects");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-publish-"));
  const wallet = Signer.fromSeed("public publishing regression fixture");
  const s = new BuildSigner({
    stateDir: dir,
    wif: wallet.getPrivateKey("wif"),
    encryptionKey: "ab".repeat(32),
  });
  const p = {
    projectId: "app_" + "a".repeat(24),
    accountId: "acc_probe",
    operationId: "job_" + "b".repeat(24),
    title: "Publish",
    hash: "c".repeat(64),
  };
  const c = s.chain;
  c.assertChain = async () => {};
  c.provider.invokeGetContractMetadata = async () => ({});
  c.provider.getAccountRc = async () => "9999999999";
  c.provider.getNextNonce = async () => "KAE=";
  c.confirmed = async () => {
    throw Object.assign(Error("not included"), {
      status: 409,
      confirmationPhase: "not_seen",
    });
  };
  c.read = async () => ({
    config: { owner: wallet.getAddress(), release_hash: p.hash },
  });
  t.after(() => {
    s.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { s, p, c };
}

test("a frontend release reuses the deployed app and guard without uploading either contract", async (t) => {
  const { s, p, c } = fixture(t),
    sent = [];
  c.confirmed = async () => true;
  c.provider.sendTransaction = async (tx) => {
    sent.push(structuredClone(tx));
    return {};
  };
  const deployed = await s.run("release", p);
  assert.equal(sent[0].operations.filter((o) => o.upload_contract).length, 2);
  const originalApp = s.app(p),
    originalGuard = s.guard();
  c.provider.invokeGetContractMetadata = async (address) => ({
    value: {
      hash: wasmHash(address === deployed.guardId ? "guard" : "contract"),
      authorizes_upload_contract: true,
      authorizes_call_contract: true,
      authorizes_transaction_application: true,
    },
  });
  c.provider.getNextNonce = async () => "KAI=";
  p.hash = "d".repeat(64);
  p.operationId = "job_" + "e".repeat(24);
  const updated = await s.run("release", p),
    tx = sent[1];
  assert.equal(updated.contractId, deployed.contractId);
  assert.equal(updated.guardId, deployed.guardId);
  assert.deepEqual(s.app(p), originalApp);
  assert.deepEqual(s.guard(), originalGuard);
  assert.equal(tx.operations.length, 2);
  assert.ok(tx.operations.every((o) => !o.upload_contract));
  assert.equal(tx.operations[0].call_contract.contract_id, deployed.guardId);
  assert.deepEqual(
    tx.operations[1],
    await c.operation(deployed.contractId, "set_release", {
      account: require("../lib/builder/chain").bytes(s.signer.getAddress()),
      title: p.title,
      release_hash: Buffer.from(p.hash, "hex").toString("base64url"),
    }),
  );
  assert.equal(tx.signatures.length, 1);
});

test("resuming an already live version never calls the signing service", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-live-release-"));
  let calls = 0;
  const b = new Builder({
    stateDir: dir,
    autoStart: false,
    signer: {
      configured: true,
      call: async () => {
        calls++;
        throw Error("unexpected signing request");
      },
    },
  });
  t.after(() => {
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const p = b.store.create(
    "acc_probe",
    "Live app",
    "voting",
    starter("voting", "Live app"),
  );
  const chain = {
    contractId: "existing",
    guardId: "guard",
    chainId: b.chain.config.chainId,
    network: "testnet",
    owner: "owner",
    txId: "original-tx",
  };
  b.store.publish("acc_probe", p.id, 1, chain, "original-release");
  b.store.enqueue("acc_probe", p.id, "publish", { revision: 1 });
  await b.tick();
  assert.equal(calls, 0);
  assert.equal(b.store.detail("acc_probe", p.id).jobs[0].status, "completed");
  assert.equal(
    b.store.db.prepare("SELECT count(*) n FROM releases").get().n,
    1,
  );
  assert.equal(b.store.owned("acc_probe", p.id).contract_id, "existing");
});

test("RPC diagnostics retain bounded contract logs without exposing the RPC payload", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        error: {
          message: "reversion failure",
          data: JSON.stringify({
            message: "contract reverted",
            logs: ["Cannot verify app code"],
            transaction: "do not expose",
          }),
        },
      }),
  }));
  await assert.rejects(
    () => new BuildChain().provider.call("chain.submit_transaction", {}),
    (e) => {
      assert.match(e.message, /Cannot verify app code/);
      assert.doesNotMatch(e.message, /do not expose/);
      assert.equal(e.rpcError, true);
      assert.equal(e.rpcTransient, false);
      return true;
    },
  );
  assert.ok(
    chainErrorDetail("a".repeat(10000), { logs: ["b".repeat(10000)] }).length <=
      800,
  );
});

test("a refused submission fails promptly, retains the exact transaction, and can resume", async (t) => {
  const { s, p, c } = fixture(t),
    sent = [];
  c.provider.sendTransaction = async (tx) => {
    sent.push(structuredClone(tx));
    throw Object.assign(Error("Koinos: insufficient rc"), {
      status: 502,
      rpcError: true,
    });
  };
  await assert.rejects(
    () => s.run("release", p),
    /refused.*insufficient rc.*Transaction: 0x1220/,
  );
  const saved = s.db
    .prepare("SELECT * FROM operations WHERE id=?")
    .get(p.operationId);
  const app = s.app(p);
  assert.equal(saved.confirmed, 0);
  c.provider.sendTransaction = async (tx) => {
    sent.push(structuredClone(tx));
    return {};
  };
  const retry = await s.run("release", p);
  assert.equal(retry.pending, true);
  assert.equal(retry.phase, "not_seen");
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(s.app(p).address, app.address);
  c.confirmed = async () => true;
  c.provider.sendTransaction = async () => {
    throw Error("must not rebroadcast a confirmed transaction");
  };
  assert.equal((await s.run("release", p)).txId, sent[0].id);
});

test("a reverted submission receipt exposes its contract log instead of entering a wait loop", async (t) => {
  const { s, p, c } = fixture(t);
  c.provider.sendTransaction = async () => ({
    receipt: {
      reverted: true,
      logs: ["Initialization requires the deployment key"],
    },
  });
  await assert.rejects(
    () => s.run("release", p),
    /Initialization requires the deployment key/,
  );
  assert.equal(s.db.prepare("SELECT count(*) n FROM operations").get().n, 1);
});

test("transport uncertainty is not described as chain acceptance or permanent rejection", async (t) => {
  const { s, p, c } = fixture(t);
  c.provider.sendTransaction = async () => {
    throw new DOMException("timed out", "TimeoutError");
  };
  await assert.rejects(
    () => s.run("release", p),
    (e) => {
      assert.match(
        e.message,
        /could not be verified.*request is saved.*Transaction:/,
      );
      assert.doesNotMatch(e.message, /refused|submitted|finality/);
      return true;
    },
  );
});

test("an included saved transaction waits for finality without another broadcast", async (t) => {
  const { s, p, c } = fixture(t);
  let sent = 0;
  c.provider.sendTransaction = async () => {
    sent++;
    return {};
  };
  await s.run("release", p);
  c.confirmed = async () => {
    throw Object.assign(Error("waiting for finality"), {
      status: 409,
      confirmationPhase: "finality",
    });
  };
  const next = await s.run("release", p);
  assert.equal(next.phase, "finality");
  assert.equal(sent, 1);
});

test("canonical confirmation wins over a duplicate submission error", async (t) => {
  const { s, p, c } = fixture(t);
  c.provider.sendTransaction = async () => {
    throw Object.assign(Error("Koinos: invalid nonce"), {
      status: 502,
      rpcError: true,
    });
  };
  c.confirmed = async () => true;
  const result = await s.run("release", p);
  assert.equal(result.contractId, s.app(p).address);
  assert.equal(result.pending, undefined);
});

function frontendJob(t) {
  const f = fixture(t),
    { s, p, c } = f;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-nonce-job-"));
  const calls = [],
    submissions = [];
  const makeBuilder = () =>
    new Builder({
      stateDir: dir,
      autoStart: false,
      chain: c,
      signer: {
        configured: true,
        call: (action, payload) => {
          if (action === "status") return s.status();
          calls.push(structuredClone(payload));
          return s.run(action, payload);
        },
      },
    });
  let builder = makeBuilder();
  t.after(() => {
    builder.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const project = builder.store.create(
    p.accountId,
    "Publish",
    "voting",
    starter("voting", "Publish"),
  );
  p.projectId = project.id;
  const app = s.create(p),
    guard = s.guard();
  builder.store.publish(
    p.accountId,
    project.id,
    1,
    {
      contractId: app.address,
      guardId: guard.address,
      chainId: c.config.chainId,
      network: c.config.network,
      owner: s.signer.getAddress(),
      txId: "original",
    },
    "first-release",
  );
  const files = builder.store.files(p.accountId, project.id).files;
  const version = builder.store.saveRevision(
    p.accountId,
    project.id,
    { ...files, "app.css": files["app.css"] + "\n/* Frontend update */" },
    "Frontend update",
  );
  p.hash = version.hash;
  c.provider.invokeGetContractMetadata = async (id) => ({
    value: {
      hash: wasmHash(id === guard.address ? "guard" : "contract"),
      authorizes_upload_contract: true,
      authorizes_call_contract: true,
      authorizes_transaction_application: true,
    },
  });
  c.provider.sendTransaction = async (tx) => {
    submissions.push(structuredClone(tx));
    throw Object.assign(Error("Koinos: invalid account nonce"), {
      status: 502,
      rpcError: true,
    });
  };
  const job = builder.store.enqueue(p.accountId, project.id, "publish", {
    revision: version.revision,
  });
  // Exercise the normal 40-poll loop without waiting two wall-clock minutes.
  const timeout = global.setTimeout;
  t.mock.method(global, "setTimeout", (fn, ms, ...args) =>
    timeout(fn, ms === 3000 ? 0 : ms, ...args),
  );
  return {
    ...f,
    get b() {
      return builder;
    },
    job,
    app,
    calls,
    submissions,
    restart() {
      builder.close();
      builder = makeBuilder();
    },
  };
}

test("a nonce conflict polls the same frontend transaction through index lag and finality without rebroadcast", async (t) => {
  const f = frontendJob(t);
  let checks = 0;
  f.c.confirmed = async (id) => {
    assert.equal(id, f.submissions[0].id);
    if (++checks < 4)
      throw Object.assign(Error("not final"), {
        status: 409,
        confirmationPhase: checks < 3 ? "not_seen" : "finality",
      });
    return true;
  };
  await f.b.tick();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.submissions[0].operations.length, 2);
  assert.ok(f.submissions[0].operations.every((o) => !o.upload_contract));
  assert.equal(
    f.b.store.detail(f.p.accountId, f.p.projectId).jobs[0].status,
    "completed",
  );
  assert.equal(f.b.store.owned(f.p.accountId, f.p.projectId).live_revision, 2);
  assert.equal(
    f.b.store.owned(f.p.accountId, f.p.projectId).contract_id,
    f.app.address,
  );
  assert.equal(
    f.b.store.db.prepare("SELECT tx_id FROM releases WHERE id=?").get(f.job.id)
      .tx_id,
    f.submissions[0].id,
  );
});

test("an unresolved nonce conflict stays bounded and resumes read-only confirmation after restart", async (t) => {
  const f = frontendJob(t);
  await f.b.tick();
  const failed = f.b.store.detail(f.p.accountId, f.p.projectId).jobs[0];
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /nonce conflict.*No replacement transaction/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.b.store.owned(f.p.accountId, f.p.projectId).live_revision, 1);
  const saved = JSON.parse(
    f.b.store.db.prepare("SELECT payload FROM jobs WHERE id=?").get(f.job.id)
      .payload,
  );
  assert.equal(saved.confirmationTxId, f.submissions[0].id);
  f.restart();
  f.c.confirmed = async (id) => {
    assert.equal(id, saved.confirmationTxId);
    return true;
  };
  f.b.retry(f.p.accountId, f.p.projectId, f.job.id);
  await f.b.tick();
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(
    f.b.store.detail(f.p.accountId, f.p.projectId).jobs[0].status,
    "completed",
  );
});

test("nonce recovery never publishes a reverted transaction or skips the signer's release check", async (t) => {
  for (const outcome of ["reverted", "unavailable", "wrong-release"])
    await t.test(outcome, async (t) => {
      const f = frontendJob(t);
      let checks = 0;
      f.c.confirmed = async () => {
        if (!checks++)
          throw Object.assign(Error("not indexed"), {
            status: 409,
            confirmationPhase: "not_seen",
          });
        if (outcome === "reverted")
          throw Object.assign(Error("Koinos reverted this transaction"), {
            status: 422,
          });
        if (outcome === "unavailable") throw Error("offline");
        return true;
      };
      if (outcome === "wrong-release")
        f.c.read = async () => ({
          config: {
            owner: f.s.signer.getAddress(),
            release_hash: "0".repeat(64),
          },
        });
      await f.b.tick();
      const job = f.b.store.detail(f.p.accountId, f.p.projectId).jobs[0];
      assert.equal(job.status, "failed");
      assert.match(
        job.error,
        outcome === "reverted"
          ? /reverted/
          : outcome === "unavailable"
            ? /could not be checked/
            : /does not match this build/,
      );
      assert.equal(f.submissions.length, 1);
      assert.equal(
        f.b.store.owned(f.p.accountId, f.p.projectId).live_revision,
        1,
      );
    });
});

test("publishing job preserves the node reason and transaction ID for the retry UI", async (t) => {
  const { s, c } = fixture(t);
  c.provider.sendTransaction = async () => {
    throw Object.assign(Error("Koinos: compute bandwidth limit exceeded"), {
      status: 502,
      rpcError: true,
    });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-publish-ui-"));
  const b = new Builder({
    stateDir: dir,
    autoStart: false,
    signer: {
      configured: true,
      call: (action, p) =>
        action === "status" ? s.status() : s.run(action, p),
    },
  });
  t.after(() => {
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const p = b.store.create(
    "acc_probe",
    "Publish",
    "voting",
    starter("voting", "Publish"),
  );
  b.store.enqueue("acc_probe", p.id, "publish", { revision: 1 });
  await b.tick();
  const job = b.store.detail("acc_probe", p.id).jobs[0];
  assert.equal(job.status, "failed");
  assert.match(
    job.error,
    /compute bandwidth limit exceeded.*Transaction: 0x1220/,
  );
  assert.equal(b.store.owned("acc_probe", p.id).live_revision, null);
});

async function smallBufferJournal(t) {
  const f = fixture(t),
    { s, p, c } = f;
  c.provider.sendTransaction = async () => ({});
  await s.run("release", p);
  const row = s.app(p);
  const tx = JSON.parse(
    s.db
      .prepare("SELECT transaction_json FROM operations WHERE id=?")
      .get(p.operationId).transaction_json,
  );
  tx.operations.find(
    (o) => o.upload_contract?.contract_id === row.address,
  ).upload_contract.bytecode = fs
    .readFileSync(path.join(__dirname, "fixtures/builder-small-buffer.wasm"))
    .toString("base64url");
  await Transaction.prepareTransaction(tx);
  tx.signatures = [];
  for (const key of [
    s.decrypt(s.guard().encrypted_key),
    s.decrypt(row.encrypted_key),
    s.signer.getPrivateKey("wif"),
  ])
    await Signer.fromWif(key).signTransaction(tx);
  s.db
    .prepare("UPDATE operations SET transaction_json=? WHERE id=?")
    .run(JSON.stringify(tx), p.operationId);
  return { ...f, row, tx };
}

test("known buffer rejection is simulated without broadcast, archived, and rebuilt with the same app key", async (t) => {
  const { s, p, c, row, tx } = await smallBufferJournal(t);
  // This is the same saved job that already recovered from the first no-op
  // contract: a second archive must not collide with its existing audit entry.
  s.db
    .prepare("INSERT INTO retired_deployments VALUES(?,?,?,?)")
    .run(
      p.operationId,
      JSON.stringify(row),
      JSON.stringify({ created_at: Date.now(), rc_limit: "2000000000" }),
      Date.now(),
    );
  const sends = [];
  c.provider.sendTransaction = async (transaction, broadcast = true) => {
    sends.push({ transaction: structuredClone(transaction), broadcast });
    if (!broadcast)
      throw Object.assign(
        Error("Koinos: return buffer is not large enough for the return value"),
        { status: 502, rpcError: true },
      );
    return {};
  };
  const result = await s.run("release", p);
  assert.equal(result.pending, true);
  assert.equal(sends[0].broadcast, false);
  assert.equal(sends[0].transaction.id, tx.id);
  assert.equal(sends[1].broadcast, true);
  assert.notEqual(result.txId, tx.id);
  assert.deepEqual(s.app(p), row);
  const upload = sends[1].transaction.operations.find(
    (o) => o.upload_contract?.contract_id === row.address,
  ).upload_contract;
  assert.equal(
    "0x1220" +
      require("crypto")
        .createHash("sha256")
        .update(Buffer.from(upload.bytecode, "base64url"))
        .digest("hex"),
    wasmHash("contract"),
  );
  assert.equal(
    s.db.prepare("SELECT * FROM replaced_operations").get().transaction_id,
    tx.id,
  );
  assert.equal(
    s.db.prepare("SELECT count(*) n FROM retired_deployments").get().n,
    1,
  );
  await s.run("release", p);
  assert.equal(sends.length, 3);
  assert.equal(sends[2].transaction.id, result.txId);
  s.dailyMana = 6000000000n;
  assert.throws(() => s.limit(), /daily deployment mana allowance/);
});

test("buffer recovery refuses pending, successful, changed, and unverifiable deployments", async (t) => {
  for (const state of [
    "finality",
    "confirmed",
    "code-present",
    "timeout",
    "other-error",
    "accepted",
  ])
    await t.test(state, async (t) => {
      const { s, p, c, row, tx } = await smallBufferJournal(t);
      let broadcasts = 0;
      c.provider.sendTransaction = async (_tx, broadcast = true) => {
        if (broadcast) broadcasts++;
        if (state === "timeout")
          throw new DOMException("timed out", "TimeoutError");
        if (state === "other-error")
          throw Object.assign(Error("Koinos: invalid nonce"), {
            status: 502,
            rpcError: true,
          });
        return { receipt: { reverted: false } };
      };
      if (state === "confirmed") c.confirmed = async () => true;
      if (state === "finality")
        c.confirmed = async () => {
          throw Object.assign(Error("waiting for finality"), {
            status: 409,
            confirmationPhase: "finality",
          });
        };
      if (state === "code-present")
        c.provider.invokeGetContractMetadata = async () => ({
          value: { hash: "changed-code" },
        });
      await assert.rejects(() => s.run("release", p));
      assert.equal(broadcasts, 0);
      assert.deepEqual(s.app(p), row);
      assert.equal(
        s.db.prepare("SELECT count(*) n FROM replaced_operations").get().n,
        0,
      );
      assert.equal(
        JSON.parse(
          s.db
            .prepare("SELECT transaction_json FROM operations WHERE id=?")
            .get(p.operationId).transaction_json,
        ).id,
        tx.id,
      );
    });
});

test("a canonically reverted buffer deployment is recovered without resubmitting the failed transaction", async (t) => {
  const { s, p, c, tx } = await smallBufferJournal(t);
  c.confirmed = async (id) => {
    throw Object.assign(
      Error("reverted or pending"),
      id === tx.id
        ? { status: 422 }
        : { status: 409, confirmationPhase: "not_seen" },
    );
  };
  c.provider.sendTransaction = async (next, broadcast = true) => {
    assert.notEqual(next.id, tx.id);
    assert.equal(broadcast, true);
    return {};
  };
  const result = await s.run("release", p);
  assert.equal(result.pending, true);
  assert.notEqual(result.txId, tx.id);
});
