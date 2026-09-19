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
class Builder {
  constructor({ stateDir, agent, chain, signer, autoStart = true }) {
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
      let last;
      for (let i = 0; i < 40; i++) {
        const result = await this.signer.call(action, payload);
        if (!result.pending) return result;
        last = result;
        progress(
          result.phase === "finality"
            ? "Transaction included · waiting for Koinos finality"
            : result.phase === "receipt"
              ? "Waiting for the node's transaction receipt"
              : "Waiting for the transaction to enter a block",
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw fail(
        (last?.phase === "finality"
          ? "The transaction is included in a block but has not reached finality. "
          : last?.phase === "receipt"
            ? "The node has not returned the transaction receipt. "
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
        progress("Publishing to Koinos and waiting for confirmation");
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
          "Version " +
            version.revision +
            " is published. Your live app is at /apps/" +
            project.slug +
            ".",
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
      const error = e.status
        ? e.message
        : "The job could not finish. Your saved project is safe. Please retry.";
      this.store.finish(job, error);
      console.error("[builder]", job.kind, job.id, e.status || 500);
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
      !["publish", "propose"].includes(job.kind)
    )
      throw fail("This job cannot be resumed.", 409);
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
        "UPDATE jobs SET status='queued',error=NULL,stage='Retrying saved transaction',attempts=0,updated_at=? WHERE id=?",
      )
      .run(Date.now(), job.id);
    return { id: job.id, status: "queued" };
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    if (!this.running) this.store.close();
  }
}
module.exports = { Builder };
