"use strict";
// Run as a DIFFERENT OS user from server.js. This process never sees prompts,
// HTML, model tool calls, or arbitrary bytecode. It only signs the bundled ABI.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  express = require("express");
const { Signer, Transaction, utils } = require("koilib"),
  {
    BuildChain,
    bytes,
    settings,
    validAddress,
    guardOperation,
  } = require("../../lib/builder/chain");
const { fail } = require("../../lib/builder/store");
class BuildSigner {
  constructor({
    stateDir,
    wif,
    encryptionKey,
    config = {
      ...settings(),
      rcLimit: process.env.KAI_BUILD_DEPLOY_RC_LIMIT || "2000000000",
    },
    dailyMana = "20000000000",
  }) {
    if (!wif || !encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey))
      throw Error(
        "Set KAI_BUILD_DEPLOYER_WIF and a 32-byte hexadecimal KAI_BUILD_KEY_ENCRYPTION_KEY in the signer service.",
      );
    this.chain = new BuildChain(config);
    this.signer = Signer.fromWif(wif);
    this.signer.provider = this.chain.provider;
    this.key = Buffer.from(encryptionKey, "hex");
    this.dailyMana = BigInt(dailyMana);
    if (
      (config.network === "mainnet" ||
        config.chainId ===
          "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==") &&
      process.env.KAI_BUILD_MAINNET_ENABLED !== "true"
    )
      throw Error(
        "Mainnet publishing requires KAI_BUILD_MAINNET_ENABLED=true after testnet validation.",
      );
    if (
      !/^\d+$/.test(config.rcLimit) ||
      BigInt(config.rcLimit) < 1n ||
      BigInt(config.rcLimit) > this.dailyMana
    )
      throw Error("Invalid builder mana limits.");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(path.join(stateDir, "keys.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,address TEXT UNIQUE NOT NULL,encrypted_key TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,transaction_json TEXT NOT NULL,created_at INTEGER NOT NULL,rc_limit TEXT NOT NULL);",
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(apps)")
        .all()
        .some((c) => c.name === "chain_id")
    )
      this.db.exec("ALTER TABLE apps ADD COLUMN chain_id TEXT");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS guards(id TEXT PRIMARY KEY,address TEXT NOT NULL,encrypted_key TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS retired_deployments(operation_id TEXT PRIMARY KEY,app_json TEXT NOT NULL,operation_json TEXT NOT NULL,retired_at INTEGER NOT NULL)",
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(operations)")
        .all()
        .some((c) => c.name === "confirmed")
    )
      this.db.exec(
        "ALTER TABLE operations ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0",
      );
    this.wasm = fs.readFileSync(
      path.join(__dirname, "../../contracts/build-app/build/contract.wasm"),
    );
    this.wasmHash =
      "0x1220" + crypto.createHash("sha256").update(this.wasm).digest("hex");
    this.guardWasm = fs.readFileSync(
      path.join(__dirname, "../../contracts/build-app/build/guard.wasm"),
    );
    this.guardHash =
      "0x1220" +
      crypto.createHash("sha256").update(this.guardWasm).digest("hex");
  }
  encrypt(s) {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv("aes-256-gcm", this.key, iv),
      data = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
  }
  decrypt(s) {
    const b = Buffer.from(s, "base64"),
      c = crypto.createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(
      "utf8",
    );
  }
  app(p) {
    if (
      !/^app_[a-f0-9]{24}$/.test(p.projectId) ||
      !/^acc_[A-Za-z0-9_-]+$/.test(p.accountId)
    )
      throw fail("Invalid project identity.");
    const row = this.db
      .prepare("SELECT * FROM apps WHERE id=?")
      .get(p.projectId);
    if (
      row &&
      (row.account_id !== p.accountId ||
        row.chain_id !== this.chain.config.chainId)
    )
      throw fail("Project identity or network mismatch.", 403);
    return row;
  }
  create(p) {
    let row = this.app(p);
    if (row) return row;
    const key = new Signer({ privateKey: crypto.randomBytes(32) });
    this.db
      .prepare(
        "INSERT INTO apps(id,account_id,address,encrypted_key,chain_id) VALUES(?,?,?,?,?)",
      )
      .run(
        p.projectId,
        p.accountId,
        key.getAddress(),
        this.encrypt(key.getPrivateKey("wif")),
        this.chain.config.chainId,
      );
    return this.app(p);
  }
  guard() {
    const id = this.chain.config.chainId + ":" + this.guardHash;
    let row = this.db.prepare("SELECT * FROM guards WHERE id=?").get(id);
    if (!row) {
      const key = new Signer({ privateKey: crypto.randomBytes(32) });
      this.db
        .prepare("INSERT INTO guards VALUES(?,?,?)")
        .run(id, key.getAddress(), this.encrypt(key.getPrivateKey("wif")));
      row = this.db.prepare("SELECT * FROM guards WHERE id=?").get(id);
    }
    return row;
  }
  limit() {
    const rows = this.db
        .prepare(
          "SELECT rc_limit FROM operations WHERE created_at>? UNION ALL SELECT json_extract(operation_json,'$.rc_limit') rc_limit FROM retired_deployments WHERE json_extract(operation_json,'$.created_at')>?",
        )
        .all(Date.now() - 86400000, Date.now() - 86400000),
      used = rows.reduce((sum, r) => sum + BigInt(r.rc_limit), 0n);
    if (used + BigInt(this.chain.config.rcLimit) > this.dailyMana)
      throw fail(
        "The platform's daily deployment mana allowance has been reached.",
        429,
      );
  }
  async status() {
    await this.chain.assertChain();
    await this.chain.provider.invokeGetContractMetadata(
      this.signer.getAddress(),
    );
    return {
      ready: true,
      owner: this.signer.getAddress(),
      network: this.chain.config.network,
      chainId: this.chain.config.chainId,
      contractHash: this.wasmHash,
      guardHash: this.guardHash,
    };
  }
  async run(kind, p) {
    if (
      !["release", "propose"].includes(kind) ||
      !/^job_[a-f0-9]{24}$/.test(p.operationId)
    )
      throw fail("Unknown signing action.");
    if (
      kind === "release" &&
      (!/^[a-f0-9]{64}$/.test(p.hash) ||
        typeof p.title !== "string" ||
        !p.title.length ||
        p.title.length > 120)
    )
      throw fail("Invalid release.");
    if (kind === "propose") validAddress(p.target);
    const row = kind === "release" ? this.create(p) : this.app(p);
    if (!row) throw fail("Publish the app first.", 409);
    const request = JSON.stringify({
      projectId: p.projectId,
      accountId: p.accountId,
      hash: p.hash || null,
      title: p.title || null,
      target: p.target || null,
    });
    await this.chain.assertChain();
    const previous = this.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(p.operationId);
    let tx;
    if (previous) {
      if (previous.payload !== request || previous.kind !== kind)
        throw fail("Signing request has changed.", 409);
      tx = JSON.parse(previous.transaction_json);
      // The first beta's _start did not invoke main. These exact bytes cannot
      // initialize an app or grant upload authority. Retire only a confirmed
      // testnet deployment of that known artifact, preserving its audit/key
      // records, then retry the same saved release with a fresh app address.
      const legacyHash =
        "0x122056495da7bf263f95a0a57c5e468ad91bed8cc60b04c89edd7df9d30741b2657a";
      const upload = tx.operations?.find(
        (o) => o.upload_contract?.contract_id === row.address,
      )?.upload_contract;
      if (
        kind === "release" &&
        this.chain.config.chainId ===
          "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==" &&
        upload &&
        "0x1220" +
          crypto
            .createHash("sha256")
            .update(Buffer.from(upload.bytecode, "base64url"))
            .digest("hex") ===
          legacyHash
      ) {
        await this.chain.confirmed(tx.id);
        const meta = await this.chain.provider.invokeGetContractMetadata(
          row.address,
        );
        if (meta?.value?.hash === legacyHash) {
          this.db.exec("BEGIN IMMEDIATE");
          try {
            this.db
              .prepare("INSERT INTO retired_deployments VALUES(?,?,?,?)")
              .run(
                p.operationId,
                JSON.stringify(row),
                JSON.stringify(previous),
                Date.now(),
              );
            this.db
              .prepare("DELETE FROM operations WHERE id=?")
              .run(p.operationId);
            this.db.prepare("DELETE FROM apps WHERE id=?").run(row.id);
            this.db.exec("COMMIT");
          } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
          }
          return this.run(kind, p);
        }
        throw fail(
          "The earlier deployment's code changed. Automatic recovery has stopped.",
          409,
        );
      }
    } else {
      const pending = this.db
        .prepare(
          "SELECT id,transaction_json FROM operations WHERE confirmed=0 ORDER BY created_at LIMIT 1",
        )
        .get();
      if (pending) {
        try {
          await this.chain.confirmed(JSON.parse(pending.transaction_json).id);
          this.db
            .prepare("UPDATE operations SET confirmed=1 WHERE id=?")
            .run(pending.id);
        } catch (e) {
          if (e.status === 422)
            this.db
              .prepare("UPDATE operations SET confirmed=1 WHERE id=?")
              .run(pending.id);
          else
            throw fail(
              "A previous platform transaction is still pending. Retry its saved publishing request before starting another.",
              409,
            );
        }
      }
      this.limit();
      if (
        BigInt(
          await this.chain.provider.getAccountRc(this.signer.getAddress()),
        ) < BigInt(this.chain.config.rcLimit)
      )
        throw fail(
          "The dedicated builder wallet needs more available mana before it can publish.",
          409,
        );
      let cfg = null;
      // Only an explicit missing-contract response is treated as undeployed.
      const meta = await this.chain.provider.invokeGetContractMetadata(
        row.address,
      );
      if (meta?.value?.hash) {
        if (
          meta.value.hash.toLowerCase() !== this.wasmHash ||
          meta.value.system ||
          !meta.value.authorizes_call_contract ||
          !meta.value.authorizes_transaction_application ||
          !meta.value.authorizes_upload_contract
        )
          throw fail(
            "The app contract was changed. The platform will not sign calls to replacement code.",
            409,
          );
        const result = await this.chain.read(row.address, "get_config", {});
        cfg = result.config;
        if (cfg?.owner !== this.signer.getAddress())
          throw fail(
            "This app belongs to a wallet. Publish updates with the owner's signature.",
            409,
          );
      }
      const operations = [];
      let bootstrap = null,
        guardBootstrap = null;
      const guard = this.guard(),
        guardMeta = await this.chain.provider.invokeGetContractMetadata(
          guard.address,
        );
      if (guardMeta?.value?.hash) {
        if (
          guardMeta.value.hash.toLowerCase() !== this.guardHash ||
          guardMeta.value.system ||
          !guardMeta.value.authorizes_upload_contract
        )
          throw fail("The immutable deployment guard did not match.", 409);
      } else {
        guardBootstrap = Signer.fromWif(this.decrypt(guard.encrypted_key));
        operations.push({
          upload_contract: {
            contract_id: guard.address,
            bytecode: utils.encodeBase64url(this.guardWasm),
            authorizes_upload_contract: true,
          },
        });
      }
      if (!cfg) {
        if (kind !== "release") throw fail("App is not deployed.", 409);
        bootstrap = Signer.fromWif(this.decrypt(row.encrypted_key));
        operations.push({
          upload_contract: {
            contract_id: row.address,
            bytecode: utils.encodeBase64url(this.wasm),
            abi: JSON.stringify(require("../../lib/builder/chain").abi),
            authorizes_call_contract: true,
            authorizes_transaction_application: true,
            authorizes_upload_contract: true,
          },
        });
      }
      // The immutable guard checks the target's bytecode and authority flags
      // DURING this transaction, before any call into user-controlled state.
      // An off-chain metadata check alone has a transfer/upgrade race.
      operations.push(
        guardOperation(
          row.address,
          guard.address,
          cfg ? this.signer.getAddress() : null,
        ),
      );
      if (kind === "release")
        operations.push(
          await this.chain.operation(
            row.address,
            cfg ? "set_release" : "initialize",
            {
              account: bytes(this.signer.getAddress()),
              title: p.title,
              release_hash: utils.encodeBase64url(Buffer.from(p.hash, "hex")),
            },
          ),
        );
      else
        operations.push(
          await this.chain.operation(row.address, "propose_owner", {
            account: bytes(p.target),
          }),
        );
      tx = await Transaction.prepareTransaction(
        {
          header: {
            payer: this.signer.getAddress(),
            chain_id: this.chain.config.chainId,
            rc_limit: this.chain.config.rcLimit,
          },
          operations,
        },
        this.chain.provider,
        this.signer.getAddress(),
      );
      if (guardBootstrap) await guardBootstrap.signTransaction(tx);
      if (bootstrap) await bootstrap.signTransaction(tx);
      await this.signer.signTransaction(tx);
      this.db
        .prepare(
          "INSERT INTO operations(id,project_id,kind,payload,transaction_json,created_at,rc_limit) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          p.operationId,
          p.projectId,
          kind,
          request,
          JSON.stringify(tx),
          Date.now(),
          this.chain.config.rcLimit,
        );
    }
    // Persist before broadcast. A lost HTTP response retries this exact signed
    // transaction; it never generates another key, nonce, or deployment.
    let submitError = null;
    try {
      await this.chain.provider.sendTransaction(tx);
    } catch (e) {
      submitError = e;
    }
    try {
      await this.chain.confirmed(tx.id);
    } catch (e) {
      if (e.status === 422) {
        this.db
          .prepare("UPDATE operations SET confirmed=1 WHERE id=?")
          .run(p.operationId);
        throw e;
      }
      if (e.status === 409) return { pending: true, txId: tx.id };
      if (submitError)
        throw fail(
          "Deployment could not be confirmed. Retry this release; its transaction is saved.",
          409,
        );
      throw e;
    }
    this.db
      .prepare("UPDATE operations SET confirmed=1 WHERE id=?")
      .run(p.operationId);
    const { config } = await this.chain.read(row.address, "get_config", {});
    if (!config)
      throw fail(
        "The deployment transaction is confirmed, but the app did not initialize. Update the builder signing service before retrying this saved request.",
        409,
      );
    if (kind === "release" && config.release_hash !== p.hash)
      throw fail("The confirmed release does not match this build.", 409);
    if (kind === "propose" && config.pending_owner !== p.target)
      throw fail("Ownership proposal is not confirmed yet.", 409);
    return {
      contractId: row.address,
      guardId: this.guard().address,
      chainId: this.chain.config.chainId,
      network: this.chain.config.network,
      owner: config.owner,
      txId: tx.id,
      pendingOwner: config.pending_owner,
    };
  }
}
function main() {
  const token = process.env.KAI_BUILD_SIGNER_TOKEN;
  if (!token || token.length < 32)
    throw Error("KAI_BUILD_SIGNER_TOKEN must have at least 32 characters.");
  const service = new BuildSigner({
    stateDir:
      process.env.KAI_BUILD_SIGNER_STATE_DIR || "/var/lib/kai-build-signer",
    wif: process.env.KAI_BUILD_DEPLOYER_WIF,
    encryptionKey: process.env.KAI_BUILD_KEY_ENCRYPTION_KEY,
    dailyMana: process.env.KAI_BUILD_DAILY_MANA || "20000000000",
  });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  app.use((req, res, next) => {
    const a = Buffer.from(String(req.headers.authorization || "")),
      b = Buffer.from("Bearer " + token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: "Unauthorized" });
    res.set("Cache-Control", "no-store");
    next();
  });
  let queue = Promise.resolve();
  for (const action of ["status", "release", "propose"])
    app.post("/" + action, (req, res) => {
      queue = queue
        .then(async () => {
          try {
            res.json(
              action === "status"
                ? await service.status()
                : await service.run(action, req.body),
            );
          } catch (e) {
            console.error("[build signer]", action, e.status || 500);
            res.status(e.status || 502).json({
              error: e.status
                ? e.message
                : "The signing service could not verify the chain. Retry shortly.",
            });
          }
        })
        .catch(() => {});
    });
  app.listen(
    Number(process.env.KAI_BUILD_SIGNER_PORT || 3091),
    "127.0.0.1",
    () => console.log("KAI Build signer listening on loopback."),
  );
}
if (require.main === module) main();
module.exports = { BuildSigner };
