"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { Signer } = require("koilib");
const { BuildSigner } = require("./build/signer");
const { BuildChain, chainErrorDetail } = require("../lib/builder/chain");
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
