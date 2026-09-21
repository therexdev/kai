"use strict";
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const uid = (prefix) => prefix + "_" + crypto.randomBytes(12).toString("hex");
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const digest = (files) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(files)
          .sort()
          .map((k) => [k, files[k]]),
      ),
    )
    .digest("hex");
class BuildStore {
  constructor(stateDir) {
    const dir = path.join(stateDir, "builder");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(path.join(dir, "projects.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL, template TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL DEFAULT 0, live_revision INTEGER, contract_id TEXT, chain_id TEXT, network TEXT, owner_address TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS projects_account ON projects(account_id,updated_at);
      CREATE TABLE IF NOT EXISTS revisions(project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, files TEXT NOT NULL, hash TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project_id,revision));
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), account_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, usage INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(project_id) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, hash TEXT NOT NULL, contract_id TEXT, chain_id TEXT, network TEXT, tx_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_drafts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), account_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS app_diagnostics(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, report TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS app_diagnostics_project ON app_diagnostics(project_id,created_at);
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(projects)")
        .all()
        .some((c) => c.name === "platform_owner")
    )
      this.db.exec("ALTER TABLE projects ADD COLUMN platform_owner TEXT");
    if (
      !this.db
        .prepare("PRAGMA table_info(projects)")
        .all()
        .some((c) => c.name === "guard_id")
    )
      this.db.exec("ALTER TABLE projects ADD COLUMN guard_id TEXT");
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  owned(account, id) {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id=? AND account_id=?")
      .get(id, account);
    if (!row) throw fail("Project not found.", 404);
    return row;
  }
  list(account) {
    return this.db
      .prepare(
        "SELECT * FROM projects WHERE account_id=? ORDER BY updated_at DESC LIMIT 30",
      )
      .all(account);
  }
  create(account, title, template, files) {
    return this.transaction(() => {
      if (this.list(account).length >= 20)
        throw fail("The account limit is 20 projects.", 409);
      const id = uid("app"),
        slug =
          String(title)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40)
            .replace(/^-|-$/g, "") || "my-app",
        t = Date.now();
      this.db
        .prepare(
          "INSERT INTO projects(id,account_id,title,template,slug,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, account, title, template, slug + "-" + id.slice(-8), t, t);
      this.saveRevision(account, id, files, "Project created");
      this.message(
        id,
        "assistant",
        "Your starting app is ready. Tell me what you want to change, or try it in the preview.",
      );
      return this.owned(account, id);
    });
  }
  files(account, id, revision) {
    const p = this.owned(account, id);
    const row = this.db
      .prepare("SELECT * FROM revisions WHERE project_id=? AND revision=?")
      .get(id, revision == null ? p.revision : Number(revision));
    if (!row) throw fail("Version not found.", 404);
    return { ...row, files: JSON.parse(row.files) };
  }
  saveRevision(account, id, files, summary) {
    const p = this.owned(account, id);
    if (p.revision >= 200)
      throw fail(
        "This project has reached its 200-version limit. Export it before continuing.",
        409,
      );
    const used = this.db
      .prepare(
        "SELECT COALESCE(SUM(length(CAST(r.files AS BLOB))),0) bytes FROM revisions r JOIN projects p ON p.id=r.project_id WHERE p.account_id=?",
      )
      .get(account).bytes;
    if (used + Buffer.byteLength(JSON.stringify(files)) > 15000000)
      throw fail(
        "This account has reached its 15 MB source-history allowance.",
        409,
      );
    const revision = p.revision + 1,
      t = Date.now(),
      hash = digest(files);
    this.db
      .prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?)")
      .run(
        id,
        revision,
        JSON.stringify(files),
        hash,
        summary.slice(0, 2000),
        t,
      );
    this.db
      .prepare(
        "UPDATE projects SET revision=?,updated_at=? WHERE id=? AND account_id=?",
      )
      .run(revision, t, id, account);
    return { revision, hash };
  }
  message(id, role, content) {
    this.db
      .prepare(
        "INSERT INTO messages(project_id,role,content,created_at) VALUES(?,?,?,?)",
      )
      .run(id, role, String(content).slice(0, 8000), Date.now());
    this.db
      .prepare(
        "DELETE FROM messages WHERE project_id=? AND id NOT IN (SELECT id FROM messages WHERE project_id=? ORDER BY id DESC LIMIT 160)",
      )
      .run(id, id);
  }
  detail(account, id) {
    const project = this.owned(account, id);
    return {
      project,
      ...this.files(account, id),
      messages: this.db
        .prepare(
          "SELECT role,content,created_at FROM messages WHERE project_id=? ORDER BY id",
        )
        .all(id),
      versions: this.db
        .prepare(
          "SELECT revision,hash,summary,created_at FROM revisions WHERE project_id=? ORDER BY revision DESC LIMIT 200",
        )
        .all(id),
      releases: this.db
        .prepare(
          "SELECT * FROM releases WHERE project_id=? ORDER BY created_at DESC LIMIT 30",
        )
        .all(id),
      jobs: this.db
        .prepare(
          "SELECT id,kind,status,stage,error,created_at,updated_at,usage FROM jobs WHERE project_id=? AND account_id=? ORDER BY created_at DESC LIMIT 8",
        )
        .all(id, account),
    };
  }
  enqueue(account, id, kind, payload) {
    return this.transaction(() => {
      this.owned(account, id);
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running')",
          )
          .get(id)
      )
        throw fail("This project already has a job running.", 409);
      const jid = uid("job"),
        t = Date.now();
      this.db
        .prepare(
          "INSERT INTO jobs(id,project_id,account_id,kind,payload,status,stage,created_at,updated_at) VALUES(?,?,?,?,?,'queued','Waiting to start',?,?)",
        )
        .run(jid, id, account, kind, JSON.stringify(payload), t, t);
      if (kind === "edit") this.message(id, "user", payload.prompt);
      return { id: jid, status: "queued" };
    });
  }
  claim() {
    return this.transaction(() => {
      const t = Date.now();
      this.db
        .prepare(
          "UPDATE jobs SET status='failed',stage='Interrupted',error='The job could not finish after a server restart. Your saved version is unchanged.' WHERE status='running' AND lease_until<? AND attempts>=3",
        )
        .run(t);
      this.db
        .prepare(
          "UPDATE jobs SET status='queued',stage='Resuming after interruption' WHERE status='running' AND lease_until<? AND attempts<3",
        )
        .run(t);
      // One worker at a time across processes: this also serializes releases.
      if (this.db.prepare("SELECT id FROM jobs WHERE status='running'").get())
        return null;
      const job = this.db
        .prepare(
          "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1",
        )
        .get();
      if (!job) return null;
      this.db
        .prepare(
          "UPDATE jobs SET status='running',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?",
        )
        .run(t + 120000, t, job.id);
      return { ...job, payload: JSON.parse(job.payload) };
    });
  }
  stage(job, stage) {
    this.db
      .prepare(
        "UPDATE jobs SET stage=?,lease_until=?,updated_at=? WHERE id=? AND status='running'",
      )
      .run(stage, Date.now() + 120000, Date.now(), job.id);
  }
  usage(job, tokens) {
    this.db
      .prepare("UPDATE jobs SET usage=usage+? WHERE id=?")
      .run(tokens, job.id);
  }
  finish(job, error) {
    this.db
      .prepare(
        "UPDATE jobs SET status=?,stage=?,error=?,updated_at=?,lease_until=0 WHERE id=?",
      )
      .run(
        error ? "failed" : "completed",
        error ? "Needs attention" : "Ready",
        error || null,
        Date.now(),
        job.id,
      );
    if (error) this.message(job.project_id, "assistant", error);
  }
  publish(account, id, revision, chain, jobId) {
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM releases WHERE id=?")
        .get(jobId);
      if (old) return old;
      const version = this.files(account, id, revision),
        t = Date.now();
      this.db
        .prepare("INSERT INTO releases VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          jobId,
          id,
          revision,
          version.hash,
          chain.contractId,
          chain.chainId,
          chain.network,
          chain.txId || null,
          t,
        );
      this.db
        .prepare(
          "UPDATE projects SET live_revision=?,contract_id=?,chain_id=?,network=?,owner_address=?,updated_at=? WHERE id=? AND account_id=?",
        )
        .run(
          revision,
          chain.contractId,
          chain.chainId,
          chain.network,
          chain.owner,
          t,
          id,
          account,
        );
      this.db
        .prepare(
          "UPDATE projects SET platform_owner=COALESCE(platform_owner,?) WHERE id=? AND account_id=?",
        )
        .run(chain.owner, id, account);
      this.db
        .prepare(
          "UPDATE projects SET guard_id=COALESCE(?,guard_id) WHERE id=? AND account_id=?",
        )
        .run(chain.guardId || null, id, account);
      return this.db.prepare("SELECT * FROM releases WHERE id=?").get(jobId);
    });
  }
  publicProject(slug) {
    return this.db
      .prepare(
        "SELECT id,title,template,slug,live_revision,contract_id,chain_id,network,guard_id FROM projects WHERE slug=? AND live_revision IS NOT NULL",
      )
      .get(slug);
  }
  recordDiagnostics(account, id, value) {
    const p = this.owned(account, id);
    const errors = require("./diagnostics").previewDiagnostics(value, p.live_revision);
    return this.transaction(() => {
      this.db.prepare("DELETE FROM app_diagnostics WHERE created_at<?").run(Date.now() - 86400000);
      for (const error of errors) {
        const report = JSON.stringify(error);
        if (!this.db.prepare("SELECT id FROM app_diagnostics WHERE project_id=? AND revision=? AND report=? AND created_at>?")
          .get(id, p.live_revision, report, Date.now() - 60000))
          this.db.prepare("INSERT INTO app_diagnostics(project_id,revision,report,created_at) VALUES(?,?,?,?)")
            .run(id, p.live_revision, report, Date.now());
      }
      this.db.prepare("DELETE FROM app_diagnostics WHERE project_id=? AND id NOT IN (SELECT id FROM app_diagnostics WHERE project_id=? ORDER BY id DESC LIMIT 24)").run(id, id);
      return errors.length;
    });
  }
  liveDiagnostics(account, id) {
    const p = this.owned(account, id);
    return this.db.prepare("SELECT revision,report,created_at FROM app_diagnostics WHERE project_id=? AND revision=? AND created_at>? ORDER BY id DESC LIMIT 12")
      .all(id, p.live_revision, Date.now() - 86400000)
      .map((r) => ({ ...JSON.parse(r.report), revision: r.revision, observedAt: r.created_at, source: "published app" }));
  }
  publicFiles(project) {
    const row = this.db
      .prepare("SELECT files FROM revisions WHERE project_id=? AND revision=?")
      .get(project.id, project.live_revision);
    return JSON.parse(row.files);
  }
  close() {
    this.db.close();
  }
}
module.exports = { BuildStore, fail, uid, digest };
