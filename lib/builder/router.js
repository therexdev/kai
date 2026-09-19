"use strict";
const path = require("path"),
  express = require("express"),
  { Builder } = require("./service"),
  { starter, validate, html, ALLOWED } = require("./projects"),
  { fail, uid } = require("./store"),
  { bytes, validAddress, abi, guardAbi, cleanArgs } = require("./chain");
const { utils } = require("koilib");
const { FRAME_CSP } = require("./frame-policy");
const { previewDiagnostics } = require("./diagnostics");
const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://koinvault.app; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function createBuilderRouter({ accounts, stateDir, builder }) {
  const service = builder || new Builder({ stateDir }),
    store = service.store,
    router = express.Router(),
    views = path.join(__dirname, "../../views/build"),
    limits = new Map();
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch((e) => {
        if (!res.headersSent)
          res.status(e.status || 502).json({
            ok: false,
            error: e.status
              ? e.message
              : "This request could not finish. Please retry shortly.",
          });
      });
  const limit = (key, max = 80) => {
    const t = Date.now();
    let row = limits.get(key);
    if (!row || row.until < t) {
      row = { n: 0, until: t + 60000 };
      limits.set(key, row);
    }
    if (++row.n > max)
      throw fail("Too many requests. Wait a moment and retry.", 429);
    if (limits.size > 5000)
      for (const [k, v] of limits) if (v.until < t) limits.delete(k);
  };
  const security = (res, frame = false) => {
    res.set({
      "Content-Security-Policy": frame ? FRAME_CSP : SHELL_CSP,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=()",
    });
    if (!frame) res.set("X-Frame-Options", "DENY");
  };
  const shell = (req, res) => {
    security(res);
    res.sendFile(path.join(views, "index.html"));
  };
  const busy = (id) => {
    if (
      store.db
        .prepare(
          "SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running')",
        )
        .get(id)
    )
      throw fail("Wait for the current job to finish.", 409);
  };
  const project = (req) => store.owned(req.account.id, req.params.id);
  const network = (p) => {
    if (p.chain_id && p.chain_id !== service.chain.config.chainId)
      throw fail(
        "This app belongs to a different blockchain. Editing and export remain available.",
        409,
      );
    return p;
  };
  const chainProject = (req) => network(project(req));
  router.get(
    ["/build", "/build/"],
    wrap((req, res) => {
      if (!accounts?.accountOf(req))
        return res.redirect("/account?next=/build");
      shell(req, res);
    }),
  );
  for (const name of [
    "build.js",
    "build.css",
    "host.js",
    "bridge.js",
    "wallets.js",
    "qrcode.js",
    "markdown.js",
  ])
    router.get("/build/assets/" + name, (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(
        name === "markdown.js"
          ? path.join(__dirname, "../../public/docs/md.js")
          : path.join(views, name === "qrcode.js" ? "vendor/qrcode.js" : name),
      );
    });
  router.use(
    "/build/api",
    wrap((req, res, next) => {
      security(res);
      req.account = accounts?.requireAccount(req, res);
      if (req.account) {
        limit(req.account.id, 180);
        next();
      } else if (!accounts)
        res.status(503).json({ ok: false, error: "Accounts are unavailable." });
    }),
  );
  router.get(
    "/build/api/config",
    wrap((req, res) =>
      res.json({
        ok: true,
        ...service.config(),
        account: { id: req.account.id, email: req.account.email },
      }),
    ),
  );
  router.get(
    "/build/api/projects",
    wrap((req, res) =>
      res.json({ ok: true, projects: store.list(req.account.id) }),
    ),
  );
  router.post(
    "/build/api/projects",
    wrap((req, res) => {
      const title = String(req.body.title || "My Koinos app")
          .trim()
          .slice(0, 100),
        template = String(req.body.template || "blank");
      if (!["voting", "board", "blank"].includes(template))
        throw fail("Choose a starting point.");
      res.status(201).json({
        ok: true,
        project: store.create(
          req.account.id,
          title || "My Koinos app",
          template,
          starter(template, title || "My Koinos app"),
        ),
      });
    }),
  );
  router.get(
    "/build/api/projects/:id",
    wrap((req, res) =>
      res.json({ ok: true, ...store.detail(req.account.id, req.params.id) }),
    ),
  );
  router.get(
    "/build/api/projects/:id/preview",
    wrap((req, res) => {
      const v = store.files(req.account.id, req.params.id, req.query.revision);
      security(res, true);
      res.removeHeader("X-Frame-Options");
      res.type("html").send(html(v.files));
    }),
  );
  router.post(
    "/build/api/projects/:id/messages",
    wrap((req, res) => {
      const p = project(req);
      if (!service.agent.configured)
        throw fail(
          "AI editing needs the server's OpenAI API key. Your starter and manual file editor are available now.",
          503,
        );
      const prompt = String(req.body.prompt || "").trim();
      if (!prompt || prompt.length > 6000)
        throw fail("Write a request of up to 6,000 characters.");
      if (
        /\b(?:5[HJK][1-9A-HJ-NP-Za-km-z]{49}|[KL][1-9A-HJ-NP-Za-km-z]{51}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b/.test(
          prompt,
        )
      )
        throw fail(
          "Remove private keys from your message. Configure keys through the server's environment.",
        );
      res.status(202).json({
        ok: true,
        job: store.enqueue(
          req.account.id,
          p.id,
          "edit",
          {
            prompt,
            revision: p.revision,
            diagnostics: previewDiagnostics(req.body.diagnostics, p.revision),
          },
          {
            perAccount: Number(process.env.KAI_BUILD_DAILY_JOBS) || 10,
            global: Number(process.env.KAI_BUILD_GLOBAL_DAILY_JOBS) || 100,
          },
        ),
      });
    }),
  );
  router.put(
    "/build/api/projects/:id/files",
    wrap((req, res) => {
      const p = project(req);
      busy(p.id);
      if (req.body.revision !== p.revision)
        throw fail(
          "Another edit was saved. Reload before saving your changes.",
          409,
        );
      validate(req.body.files);
      html(req.body.files);
      const version = store.transaction(() =>
        store.saveRevision(
          req.account.id,
          p.id,
          req.body.files,
          "Saved in the file editor",
        ),
      );
      res.json({ ok: true, ...version });
    }),
  );
  router.post(
    "/build/api/projects/:id/restore",
    wrap((req, res) => {
      const p = project(req);
      busy(p.id);
      if (req.body.currentRevision !== p.revision)
        throw fail("The project changed. Reload before restoring.", 409);
      const old = store.files(req.account.id, p.id, req.body.revision),
        version = store.transaction(() =>
          store.saveRevision(
            req.account.id,
            p.id,
            old.files,
            "Restored version " + old.revision,
          ),
        );
      res.json({ ok: true, ...version });
    }),
  );
  router.get(
    "/build/api/projects/:id/export",
    wrap((req, res) => {
      const p = project(req),
        v = store.files(req.account.id, p.id);
      res.set("Content-Disposition", `attachment; filename="${p.slug}.json"`);
      res.json({
        format: "kai-build-project-v1",
        project: {
          title: p.title,
          template: p.template,
          contractId: p.contract_id,
          chainId: p.chain_id,
          network: p.network,
        },
        revision: v.revision,
        hash: v.hash,
        files: v.files,
        abi,
        contractSource: require("fs").readFileSync(
          path.join(__dirname, "../../contracts/build-app/assembly/App.ts"),
          "utf8",
        ),
      });
    }),
  );
  router.get(
    "/build/api/projects/:id/export.zip",
    wrap((req, res) => {
      const p = project(req),
        v = store.files(req.account.id, p.id);
      limit("export:" + req.account.id, 5);
      res.set("Content-Disposition", `attachment; filename="${p.slug}.zip"`);
      res.type("application/zip").send(require("./export").bundle(p, v));
    }),
  );
  router.post(
    "/build/api/projects/import",
    wrap((req, res) => {
      const data = req.body;
      if (
        data.format !== "kai-build-project-v1" ||
        !["voting", "board", "blank"].includes(data.project?.template)
      )
        throw fail("Choose a KAI Build project export.");
      validate(data.files);
      html(data.files);
      const title = String(data.project.title || "Imported app").slice(0, 100);
      res.status(201).json({
        ok: true,
        project: store.create(
          req.account.id,
          title,
          data.project.template,
          data.files,
        ),
      });
    }),
  );
  router.get(
    "/build/api/projects/:id/chain",
    wrap(async (req, res) => {
      const p = chainProject(req);
      if (!p.contract_id)
        return res.json({ ok: true, config: null, managed: true });
      const result = await service.chain.read(p.contract_id, "get_config", {});
      res.json({
        ok: true,
        ...result,
        managed: result.config?.owner === p.platform_owner,
      });
    }),
  );
  router.post(
    "/build/api/projects/:id/publish",
    wrap((req, res) => {
      const p = project(req);
      if (req.body.revision !== p.revision)
        throw fail("Preview the latest version before publishing.", 409);
      if (p.live_revision === p.revision)
        throw fail(
          "This version is already live. Make a change before publishing another update.",
          409,
        );
      if (!service.signer.configured)
        throw fail(
          "Publishing needs the server's builder signing service. Your project and preview are saved.",
          503,
        );
      res.status(202).json({
        ok: true,
        job: store.enqueue(req.account.id, p.id, "publish", {
          revision: p.revision,
        }),
      });
    }),
  );
  router.post(
    "/build/api/projects/:id/ownership/propose",
    wrap((req, res) => {
      const p = project(req);
      if (!p.contract_id)
        throw fail("Publish the app before transferring it.", 409);
      res.status(202).json({
        ok: true,
        job: store.enqueue(req.account.id, p.id, "propose", {
          target: validAddress(req.body.target),
        }),
      });
    }),
  );
  router.post(
    "/build/api/projects/:id/jobs/:jobId/retry",
    wrap((req, res) =>
      res.json({
        ok: true,
        job: service.retry(req.account.id, req.params.id, req.params.jobId),
      }),
    ),
  );
  // Prepared wallet requests are persisted, account bound, and single use.
  function draft(account, p, kind, data) {
    const id = uid("draft"),
      expires = Date.now() + 30 * 60000;
    store.db
      .prepare("DELETE FROM wallet_drafts WHERE expires_at<?")
      .run(Date.now() - 86400000);
    if (
      store.db
        .prepare(
          "SELECT count(*) n FROM wallet_drafts WHERE account_id=? AND expires_at>? AND completed=0 AND json_extract(data,'$.signerAddress')=?",
        )
        .get(account, Date.now(), data.signerAddress).n >= 20
    )
      throw fail(
        "Too many pending wallet requests. Wait before preparing another.",
        429,
      );
    store.db
      .prepare(
        "INSERT INTO wallet_drafts(id,project_id,account_id,kind,data,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, p.id, account, kind, JSON.stringify(data), expires);
    return { id, expiresAt: expires, ...data };
  }
  function ownedDraft(account, id) {
    const r = store.db
      .prepare("SELECT * FROM wallet_drafts WHERE id=? AND account_id=?")
      .get(id, account);
    if (!r || r.expires_at < Date.now())
      throw fail("This wallet request expired. Prepare a fresh one.", 409);
    return { ...r, data: JSON.parse(r.data) };
  }
  async function submitDraft(d, transaction) {
    if (d.data.vaultTxId) {
      if (
        transaction?.wallet !== "koinvault" ||
        transaction.txId !== d.data.vaultTxId
      )
        throw fail(
          "This request already has a KOIN Vault transaction. Confirm that transaction first.",
          409,
        );
      return d.data.vaultTxId;
    }
    if (transaction?.wallet === "koinvault") {
      const txId = await service.chain.vaultReceipt(
        d.data.transaction,
        transaction.txId,
      );
      d.data.vaultTxId = txId;
      store.db
        .prepare("UPDATE wallet_drafts SET data=? WHERE id=?")
        .run(JSON.stringify(d.data), d.id);
      return txId;
    }
    return service.chain.submitExact(
      d.data.transaction,
      transaction,
      d.data.signerAddress,
    );
  }
  router.post(
    "/build/api/projects/:id/wallet/prepare",
    wrap(async (req, res) => {
      const p = chainProject(req);
      busy(p.id);
      if (!p.contract_id) throw fail("Publish the app first.", 409);
      if (req.body.action === "publish" && p.live_revision === p.revision)
        throw fail(
          "This version is already live. Make a change before publishing another update.",
          409,
        );
      const { config } = await service.chain.read(
        p.contract_id,
        "get_config",
        {},
      );
      let method,
        args,
        payer,
        revision = null;
      if (req.body.action === "accept") {
        method = "accept_owner";
        payer = config.pending_owner;
        args = {};
        if (!payer) throw fail("There is no pending ownership transfer.", 409);
      } else if (req.body.action === "propose") {
        method = "propose_owner";
        payer = config.owner;
        args = { account: bytes(validAddress(req.body.target)) };
      } else if (req.body.action === "publish") {
        if (req.body.revision !== p.revision)
          throw fail("Preview the latest version first.", 409);
        revision = p.revision;
        const v = store.files(req.account.id, p.id);
        method = "set_release";
        payer = config.owner;
        args = {
          title: p.title,
          release_hash: utils.encodeBase64url(Buffer.from(v.hash, "hex")),
        };
      } else throw fail("Unknown wallet action.");
      const transaction = await service.chain.prepare(
        p.contract_id,
        method,
        args,
        validAddress(payer),
        p.guard_id,
      );
      res.json({
        ok: true,
        draft: draft(req.account.id, p, req.body.action, {
          transaction,
          signerAddress: payer,
          contractId: p.contract_id,
          chainId: p.chain_id,
          network: p.network,
          method,
          args:
            method === "propose_owner"
              ? { newOwner: req.body.target }
              : method === "set_release"
                ? {
                    title: p.title,
                    releaseHash: store.files(req.account.id, p.id, revision)
                      .hash,
                  }
                : args,
          revision,
          abi,
          guardId: p.guard_id,
          guardAbi,
        }),
      });
    }),
  );
  router.post(
    "/build/api/projects/:id/wallet/:draftId/submit",
    wrap(async (req, res) => {
      const p = chainProject(req),
        d = ownedDraft(req.account.id, req.params.draftId);
      if (d.project_id !== p.id) throw fail("Wallet request not found.", 404);
      if (d.completed)
        return res.json({
          ok: true,
          txId: d.data.vaultTxId || d.data.transaction.id,
        });
      const txId = await submitDraft(d, req.body.transaction);
      res.json({ ok: true, txId, pending: true });
    }),
  );
  router.post(
    "/build/api/projects/:id/wallet/:draftId/confirm",
    wrap(async (req, res) => {
      const p = chainProject(req),
        d = ownedDraft(req.account.id, req.params.draftId);
      if (d.project_id !== p.id) throw fail("Wallet request not found.", 404);
      if (d.completed) return res.json({ ok: true });
      await service.chain.confirmed(d.data.vaultTxId || d.data.transaction.id);
      const { config } = await service.chain.read(
        p.contract_id,
        "get_config",
        {},
      );
      if (d.kind === "publish") {
        const v = store.files(req.account.id, p.id, d.data.revision);
        if (config.release_hash !== v.hash)
          throw fail("The chain has not confirmed this release.", 409);
        store.publish(
          req.account.id,
          p.id,
          d.data.revision,
          {
            contractId: p.contract_id,
            chainId: p.chain_id,
            network: p.network,
            owner: config.owner,
            txId: d.data.vaultTxId || d.data.transaction.id,
          },
          d.id,
        );
        store.message(
          p.id,
          "assistant",
          service.publishedMessage(d.data.revision, p.slug, true),
        );
      }
      if (d.kind === "accept" && config.owner !== d.data.signerAddress)
        throw fail("The ownership transfer is not confirmed.", 409);
      store.db
        .prepare(
          "UPDATE projects SET owner_address=? WHERE id=? AND account_id=?",
        )
        .run(config.owner, p.id, req.account.id);
      store.db
        .prepare("UPDATE wallet_drafts SET completed=1 WHERE id=?")
        .run(d.id);
      res.json({ ok: true, config });
    }),
  );
  // Public hosted apps use a trusted shell around an opaque, sandboxed frame.
  router.get(
    "/apps/:slug",
    wrap((req, res) => {
      if (!store.publicProject(req.params.slug))
        throw fail("App not found.", 404);
      security(res);
      res.sendFile(path.join(views, "host.html"));
    }),
  );
  router.get(
    "/apps/:slug/content",
    wrap((req, res) => {
      const p = store.publicProject(req.params.slug);
      if (!p) throw fail("App not found.", 404);
      security(res, true);
      res.type("html").send(html(store.publicFiles(p)));
    }),
  );
  const publicProject = (req) => {
    limit("public:" + req.ip);
    const p = store.publicProject(req.params.slug);
    if (!p) throw fail("App not found.", 404);
    return network(p);
  };
  router.use(
    "/build/public",
    wrap((req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (req.method !== "GET") {
        const expected = process.env.KAI_SITE_ORIGIN || "https://koinosai.com";
        if (req.headers.origin !== expected)
          throw fail("Open the published app to use its wallet.", 403);
      }
      next();
    }),
  );
  router.get(
    "/build/public/:slug",
    wrap((req, res) => {
      const p = publicProject(req);
      res.json({ ok: true, project: p });
    }),
  );
  router.get(
    "/build/public/:slug/read/:method",
    wrap(async (req, res) => {
      const p = publicProject(req);
      let args = {};
      try {
        args = JSON.parse(req.query.args || "{}");
      } catch {
        throw fail("Invalid arguments.");
      }
      res.json({
        ok: true,
        result: await service.chain.read(
          p.contract_id,
          req.params.method,
          args,
        ),
      });
    }),
  );
  router.post(
    "/build/public/:slug/prepare",
    wrap(async (req, res) => {
      const p = publicProject(req);
      limit("wallet:" + req.ip, 15);
      const payer = validAddress(req.body.address),
        transaction = await service.chain.preparePublic(
          p.contract_id,
          req.body.method,
          req.body.args,
          payer,
          p.guard_id,
        );
      res.json({
        ok: true,
        draft: draft("public:" + p.slug, p, "app", {
          transaction,
          signerAddress: payer,
          contractId: p.contract_id,
          method: req.body.method,
          args: {
            ...cleanArgs(req.body.method, req.body.args),
            account: payer,
          },
          abi,
          guardId: p.guard_id,
          guardAbi,
          network: p.network,
          chainId: p.chain_id,
        }),
      });
    }),
  );
  router.post(
    "/build/public/:slug/submit/:draftId",
    wrap(async (req, res) => {
      const p = publicProject(req),
        d = ownedDraft("public:" + p.slug, req.params.draftId);
      if (d.completed)
        return res.json({
          ok: true,
          txId: d.data.vaultTxId || d.data.transaction.id,
        });
      const txId = await submitDraft(d, req.body.transaction);
      if (d.data.vaultTxId) {
        try {
          await service.chain.confirmed(txId);
        } catch (e) {
          if (e.status === 409)
            return res.json({ ok: true, txId, pending: true });
          throw e;
        }
      }
      store.db
        .prepare("UPDATE wallet_drafts SET completed=1 WHERE id=?")
        .run(d.id);
      res.json({ ok: true, txId });
    }),
  );
  router.use("/build/api", (_req, res) =>
    res.status(404).json({ ok: false, error: "Builder endpoint not found." }),
  );
  return { router, service };
}
module.exports = { createBuilderRouter, FRAME_CSP, SHELL_CSP };
