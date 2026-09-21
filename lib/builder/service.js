"use strict";
const { BuildStore, fail } = require("./store"),
  { BuildAgent } = require("./agent"),
  {
    BuildChain,
    SignerClient,
    wasmHash,
    PUBLISHING_PROTOCOL,
  } = require("./chain"),
  { validate } = require("./projects");
const { jobFailure } = require("./ai-request");
class Builder {
  constructor({ stateDir, agent, chain, signer, autoStart = true }) {
    this.publicOrigin = new URL(
      process.env.KAI_SITE_ORIGIN || "https://koinosai.com",
    ).origin;
    this.store = new BuildStore(stateDir);
    this.agent = agent || new BuildAgent();
    this.chain = chain || new BuildChain();
    this.signer = signer || new SignerClient();
    this.running = false;
    this.stopped = false;
    if (autoStart) {
      this.timer = setInterval(() => this.tick().catch(() => {}), 1500);
      this.timer.unref();
    }
  }
  config() {
    return {
      aiReady: this.agent.configured,
      publishingReady: this.signer.configured,
      model: this.agent.model,
      network: this.chain.config.network,
      chainId: this.chain.config.chainId,
      publicOrigin: this.publicOrigin,
      templates: [
        {
          id: "voting",
          title: "Community voting",
          description: "Polls and one vote per wallet.",
        },
        {
          id: "board",
          title: "Community board",
          description: "Posts and updates stored on Koinos.",
        },
        {
          id: "blank",
          title: "Start from scratch",
          description: "Your interface, using the app data contract.",
        },
      ],
      contractVersion: "Koinos App v1",
    };
  }
  publishedMessage(revision, slug, frontendUpdate = false) {
    const url = new URL("/apps/" + encodeURIComponent(slug), this.publicOrigin)
      .href;
    return (
      "Version " +
      revision +
      " is published. Your live app is at [" +
      url +
      "](" +
      url +
      ")." +
      (frontendUpdate
        ? " Your frontend was updated using the existing contract. Its code, address, and stored data are preserved."
        : "")
    );
  }
  async tick() {
    if (this.running || this.stopped) return;
    const job = this.store.claim();
    if (!job) return;
    this.running = true;
    let stage = "Starting",
      heartbeat = setInterval(() => this.store.stage(job, stage), 25000);
    heartbeat.unref();
    const progress = (s) => {
      stage = s;
      this.store.stage(job, s);
    };
    const signedAction = async (action, payload) => {
      let last,
        confirmationTxId = job.payload.confirmationTxId || null;
      for (let i = 0; i < 40; i++) {
        let result;
        if (confirmationTxId) {
          // A nonce rejection can be a duplicate of an accepted transaction
          // whose block has not reached the RPC index yet. Poll read-only until
          // finality; do not ask the signer to broadcast or choose a new nonce.
          try {
            await this.chain.confirmed(confirmationTxId);
          } catch (e) {
            if (e.status !== 409)
              throw fail(
                e.status
                  ? e.message + " Transaction: " + confirmationTxId
                  : "The saved transaction could not be checked. Retry confirmation shortly. Transaction: " +
                      confirmationTxId,
                e.status || 502,
              );
            result = {
              pending: true,
              txId: confirmationTxId,
              phase: e.confirmationPhase || "not_seen",
            };
          }
        }
        if (!result) {
          try {
            // Once final, let the signer verify the saved release/owner state
            // and return its original contract IDs before publishing files.
            result = await this.signer.call(action, payload);
          } catch (e) {
            const txId =
              e.status === 502 &&
              /\binvalid (?:account )?nonce\b/i.test(e.message)
                ? e.message.match(/Transaction: (0x1220[a-f0-9]{64})\s*$/i)?.[1]
                : null;
            if (!txId || (confirmationTxId && confirmationTxId !== txId))
              throw e;
            confirmationTxId = txId;
            job.payload.confirmationTxId = txId;
            this.store.db
              .prepare("UPDATE jobs SET payload=? WHERE id=? AND account_id=?")
              .run(JSON.stringify(job.payload), job.id, job.account_id);
            result = { pending: true, txId, phase: "not_seen" };
          }
        }
        if (!result.pending) return result;
        last = result;
        progress(
          result.phase === "finality"
            ? "Transaction included · waiting for Koinos finality"
            : result.phase === "receipt"
              ? "Waiting for the node's transaction receipt"
              : confirmationTxId
                ? "Checking the saved transaction after a node nonce conflict"
                : "Waiting for the transaction to enter a block",
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw fail(
        (last?.phase === "finality"
          ? "The transaction is included in a block but has not reached finality. "
          : last?.phase === "receipt"
            ? "The node has not returned the transaction receipt. "
            : confirmationTxId
              ? "The node reported a nonce conflict, and the saved transaction is not yet confirmed. No replacement transaction has been created. "
              : "The node has not confirmed this transaction in a block. ") +
          "Use Retry saved publishing request to check the same transaction. Transaction: " +
          last?.txId,
        409,
      );
    };
    try {
      const project = this.store.owned(job.account_id, job.project_id);
      if (
        job.kind !== "edit" &&
        project.chain_id &&
        project.chain_id !== this.chain.config.chainId
      )
        throw fail(
          "This app belongs to a different network. Its source remains available for editing and export.",
          409,
        );
      if (job.kind === "edit") {
        const version = this.store.files(
          job.account_id,
          job.project_id,
          job.payload.revision,
        );
        if (project.revision !== job.payload.revision)
          throw fail(
            "The project changed while this edit was queued. Please send the request again.",
            409,
          );
        const result = await this.agent.run({
          files: version.files,
          messages: this.store.detail(job.account_id, job.project_id).messages,
          prompt: job.payload.prompt,
          diagnostics: job.payload.diagnostics || [],
          liveDiagnostics: this.store.liveDiagnostics(job.account_id, project.id),
          deployment: {
            revision: project.revision, liveRevision: project.live_revision,
            contractId: project.contract_id, network: project.network, chainId: project.chain_id,
          },
          readLiveSource: async () => project.live_revision
            ? this.store.files(job.account_id, project.id, project.live_revision)
            : { published: false },
          readContract: async (method, args) => {
            if (!project.contract_id) throw fail("Publish this app before reading live contract data.", 409);
            return this.chain.read(project.contract_id, method, {
              ...(args.id !== null ? { id: args.id } : {}),
              ...(args.offset !== null ? { offset: args.offset } : {}),
            });
          },
          inspectApp: async () => {
            const report = {
              draftRevision: project.revision, liveRevision: project.live_revision,
              network: project.network, chainId: project.chain_id,
              contractId: project.contract_id, guardId: project.guard_id,
              walletNotes: [
                "Kondor signing must use this exact chain ID. The testnet label alone does not establish network compatibility.",
                "KOIN Vault currently supports mainnet only.",
                "A sign-stage payer error may originate in wallet simulation or mana estimation; it does not prove that the draft is missing a payer. The platform prepares the payer from the connected account.",
              ],
              checks: [],
            };
            if (!project.contract_id) return { ...report, published: false };
            for (const [name, check] of [
              ["RPC chain identity", () => this.chain.assertChain()],
              ["App and guard code", () => this.chain.verifiedGuard(project.contract_id, project.guard_id)],
              ["Contract configuration", () => this.chain.read(project.contract_id, "get_config", {})],
            ]) {
              try {
                const value = await check();
                report.checks.push({ name, ok: true, ...(name === "Contract configuration" ? { result: value } : {}) });
              } catch (e) { report.checks.push({ name, ok: false, error: String(e.message).slice(0, 800) }); }
            }
            return report;
          },
          onStage: progress,
          onUsage: (n) => this.store.usage(job, n),
        });
        this.store.transaction(() => {
          if (result.changed)
            this.store.saveRevision(
              job.account_id,
              job.project_id,
              result.files,
              result.summary,
            );
          this.store.message(job.project_id, "assistant", result.summary);
          this.store.finish(job);
        });
      } else if (job.kind === "publish") {
        const version = this.store.files(
          job.account_id,
          job.project_id,
          job.payload.revision,
        );
        // Resuming an already completed publication must not sign another tx.
        if (project.live_revision === version.revision) {
          this.store.finish(job);
          return;
        }
        validate(version.files);
        const signing = await this.signer.call("status");
        if (
          signing.contractHash !== wasmHash("contract") ||
          signing.guardHash !== wasmHash("guard") ||
          signing.publishingProtocol !== PUBLISHING_PROTOCOL
        )
          throw fail(
            "The publishing service needs an update before this app can deploy. Ask the site administrator to update the builder signer, then retry this saved publishing request.",
            503,
          );
        progress(
          project.contract_id
            ? "Recording frontend update on the existing contract"
            : "Deploying the app contract for its first publish",
        );
        const chain = await signedAction("release", {
          projectId: project.id,
          accountId: job.account_id,
          operationId: job.id,
          hash: version.hash,
          title: project.title,
        });
        if (chain.chainId !== this.chain.config.chainId)
          throw fail("The signing service uses a different network.", 409);
        this.store.publish(
          job.account_id,
          job.project_id,
          version.revision,
          chain,
          job.id,
        );
        this.store.message(
          job.project_id,
          "assistant",
          this.publishedMessage(
            version.revision,
            project.slug,
            !!project.contract_id,
          ),
        );
        this.store.finish(job);
      } else if (job.kind === "propose") {
        progress("Preparing the ownership handoff");
        const result = await signedAction("propose", {
          projectId: project.id,
          accountId: job.account_id,
          operationId: job.id,
          target: job.payload.target,
        });
        this.store.message(
          job.project_id,
          "assistant",
          "Ownership has been offered to " +
            result.pendingOwner +
            ". Complete the handoff by signing Accept ownership with that wallet.",
        );
        this.store.finish(job);
      } else throw fail("Unknown build job.");
    } catch (e) {
      const failure = jobFailure(e, job, stage);
      // Keep publishing error wording and transaction references unchanged.
      this.store.finish(job, job.kind === "edit" ? failure.message : e.status ? e.message : failure.message, failure.details);
      console.error("[builder]", JSON.stringify(failure.details));
    } finally {
      clearInterval(heartbeat);
      this.running = false;
    }
  }
  retry(account, id, jobId) {
    const p = this.store.owned(account, id),
      job = this.store.db
        .prepare(
          "SELECT * FROM jobs WHERE id=? AND account_id=? AND project_id=?",
        )
        .get(jobId, account, id);
    if (
      !job ||
      job.status !== "failed" ||
      !["edit", "publish", "propose"].includes(job.kind)
    )
      throw fail("This job cannot be resumed.", 409);
    if (job.kind === "edit") {
      if (JSON.parse(job.payload).revision !== p.revision)
        throw fail("This edit was requested for an older version. Send a new request for the current version.", 409);
      const latestEdit = this.store.db.prepare("SELECT id FROM jobs WHERE project_id=? AND kind='edit' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);
      if (latestEdit?.id !== job.id)
        throw fail("A newer edit request exists. Retry the latest edit or send a new request.", 409);
    }
    if (
      this.store.db
        .prepare(
          "SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running')",
        )
        .get(p.id)
    )
      throw fail("A job is already running.", 409);
    this.store.db
      .prepare(
        "UPDATE jobs SET status='queued',error=NULL,error_detail=NULL,stage=?,attempts=0,updated_at=? WHERE id=?",
      )
      .run(job.kind === "edit" ? "Retrying saved edit" : "Retrying saved transaction", Date.now(), job.id);
    return { id: job.id, status: "queued" };
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    if (!this.running) this.store.close();
  }
}
module.exports = { Builder };
