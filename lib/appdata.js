"use strict";

/*
 * Storage for the web app: chats, their messages, and (later) docs and
 * tasks. Its own sqlite DB, beside accounts.sqlite rather than inside it,
 * because these are different things with different lifetimes — an account
 * is an identity you keep, a chat is content you delete. Mixing them would
 * mean every schema change to one risks the other.
 *
 * ONE RULE RUNS THROUGH EVERY QUERY HERE: an id is never enough. Every
 * read, write and delete is scoped by account_id in the WHERE clause, so a
 * guessed or leaked chat id opens nothing. That is deliberately repetitive
 * — the repetition is the property. There is no method on this class that
 * takes an id without also taking the account it must belong to.
 *
 * If sqlite is unavailable the constructor throws rather than falling back
 * to memory. A chat store that silently forgets everything on restart is
 * worse than one that refuses to start, because the first kind is
 * discovered by a user and the second by an operator.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const now = () => Date.now();
const id = (p) => `${p}_${crypto.randomBytes(9).toString("base64url")}`;

// Bounds, so one client cannot fill the disk. Generous enough that nobody
// writing in good faith will ever meet them.
const MAX_TITLE = 200;
const MAX_CONTENT = 100_000;
const MAX_CHATS_PER_ACCOUNT = 500;
const MAX_MESSAGES_PER_CHAT = 2000;
const MAX_DOCS_PER_ACCOUNT = 200;
const MAX_DOC_CHARS = 200_000;
const MAX_TASKS_PER_ACCOUNT = 20;
const MAX_TASK_PROMPT = 8_000;
const MIN_TASK_MINUTES = 60;
const MAX_MEMORIES = 100;
const MAX_MEMORY_CHARS = 500;
const MAX_TASK_MINUTES = 60 * 24 * 30;

class AppData {
  constructor({ stateDir }) {
    const dir = path.join(stateDir, "webapp");
    fs.mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(path.join(dir, "webapp.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_account ON chats(account_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        served_model TEXT,
        cost_micro INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        title TEXT,
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_docs_account ON docs(account_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        title TEXT,
        prompt TEXT NOT NULL,
        model TEXT,
        grant_id TEXT,
        every_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_ok INTEGER,
        last_output TEXT,
        last_error TEXT,
        runs INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        uses INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_account ON memories(account_id, created_at DESC);
    `);
  }

  /* ---------------------------------------------------------------- chats */

  chats(accountId) {
    return this.db
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messages
         FROM chats c WHERE c.account_id = ? ORDER BY c.updated_at DESC LIMIT 200`
      )
      .all(String(accountId))
      .map((r) => ({
        id: r.id,
        title: r.title || "New chat",
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        messages: Number(r.messages),
      }));
  }

  createChat(accountId, title) {
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE account_id = ?").get(String(accountId)).n;
    if (n >= MAX_CHATS_PER_ACCOUNT) {
      throw Object.assign(new Error("that is a lot of chats — delete some before starting another"), { status: 409 });
    }
    const cid = id("chat");
    const t = now();
    this.db.prepare("INSERT INTO chats (id, account_id, title, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(cid, String(accountId), String(title || "").slice(0, MAX_TITLE) || null, t, t);
    return { id: cid, title: title || "New chat", createdAt: t, updatedAt: t, messages: 0 };
  }

  /** Throws unless this chat exists AND belongs to this account. */
  ownedChat(accountId, chatId) {
    const c = this.db.prepare("SELECT * FROM chats WHERE id = ? AND account_id = ?")
      .get(String(chatId || ""), String(accountId));
    if (!c) throw Object.assign(new Error("no such chat"), { status: 404 });
    return c;
  }

  renameChat(accountId, chatId, title) {
    this.ownedChat(accountId, chatId);
    this.db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND account_id = ?")
      .run(String(title || "").slice(0, MAX_TITLE) || null, now(), String(chatId), String(accountId));
  }

  deleteChat(accountId, chatId) {
    this.ownedChat(accountId, chatId);
    // Explicit, rather than trusting ON DELETE CASCADE to be switched on:
    // the PRAGMA is per-connection, and a future connection that forgets it
    // would leave orphan messages nobody can reach or delete.
    this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(String(chatId));
    this.db.prepare("DELETE FROM chats WHERE id = ? AND account_id = ?").run(String(chatId), String(accountId));
  }

  /* ------------------------------------------------------------- messages */

  messages(accountId, chatId) {
    this.ownedChat(accountId, chatId);
    return this.db
      .prepare("SELECT id, role, content, created_at, served_model, cost_micro FROM messages WHERE chat_id = ? ORDER BY created_at, rowid")
      .all(String(chatId))
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: Number(m.created_at),
        servedModel: m.served_model || null,
        costUsd: m.cost_micro == null ? null : Number(m.cost_micro) / 1e6,
      }));
  }

  addMessage(accountId, chatId, { role, content, servedModel, costMicro }) {
    this.ownedChat(accountId, chatId);
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(String(chatId)).n;
    if (n >= MAX_MESSAGES_PER_CHAT) {
      throw Object.assign(new Error("this chat is full — start a new one"), { status: 409 });
    }
    const mid = id("msg");
    const t = now();
    this.db.prepare("INSERT INTO messages (id, chat_id, role, content, created_at, served_model, cost_micro) VALUES (?,?,?,?,?,?,?)")
      .run(mid, String(chatId), String(role), String(content ?? "").slice(0, MAX_CONTENT), t,
        servedModel ? String(servedModel) : null, costMicro == null ? null : Math.round(Number(costMicro)));
    this.db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(t, String(chatId));
    return { id: mid, createdAt: t };
  }

  /**
   * Name a chat from its first user message, once. Titles are for finding a
   * conversation again in a list, so the first thing you said is a better
   * title than anything a model would invent — and it costs nothing.
   */
  autoTitle(accountId, chatId, firstMessage) {
    const c = this.ownedChat(accountId, chatId);
    if (c.title) return;
    const line = String(firstMessage || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!line) return;
    this.db.prepare("UPDATE chats SET title = ? WHERE id = ? AND account_id = ?")
      .run(line, String(chatId), String(accountId));
  }

  /* ----------------------------------------------------------------- docs */
  /*
   * A doc is one body of text you keep editing, which makes it a different
   * shape from a chat: no turns, no roles, and the thing that matters is
   * that a save never loses what was on screen. So the body is written whole
   * on every save rather than patched — a diff that lands out of order would
   * corrupt a document, and there is no version of that failure worth the
   * bytes it saves.
   */

  docs(accountId) {
    return this.db
      .prepare("SELECT id, title, created_at, updated_at, length(body) AS chars FROM docs WHERE account_id = ? ORDER BY updated_at DESC LIMIT 200")
      .all(String(accountId))
      .map((d) => ({
        id: d.id,
        title: d.title || "Untitled",
        createdAt: Number(d.created_at),
        updatedAt: Number(d.updated_at),
        chars: Number(d.chars),
      }));
  }

  createDoc(accountId, { title, body } = {}) {
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE account_id = ?").get(String(accountId)).n;
    if (n >= MAX_DOCS_PER_ACCOUNT) {
      throw Object.assign(new Error("that is a lot of documents — delete some before starting another"), { status: 409 });
    }
    const did = id("doc");
    const t = now();
    this.db.prepare("INSERT INTO docs (id, account_id, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(did, String(accountId), String(title || "").slice(0, MAX_TITLE) || null, String(body || "").slice(0, MAX_DOC_CHARS), t, t);
    return this.doc(accountId, did);
  }

  /** Throws unless this doc exists AND belongs to this account. */
  doc(accountId, docId) {
    const d = this.db.prepare("SELECT * FROM docs WHERE id = ? AND account_id = ?")
      .get(String(docId || ""), String(accountId));
    if (!d) throw Object.assign(new Error("no such document"), { status: 404 });
    return {
      id: d.id,
      title: d.title || "Untitled",
      body: d.body || "",
      createdAt: Number(d.created_at),
      updatedAt: Number(d.updated_at),
    };
  }

  saveDoc(accountId, docId, { title, body }) {
    this.doc(accountId, docId);
    if (body != null && String(body).length > MAX_DOC_CHARS) {
      throw Object.assign(new Error(`that document is too long (max ${MAX_DOC_CHARS.toLocaleString()} characters)`), { status: 413 });
    }
    const t = now();
    // Two nullable fields, one statement: COALESCE leaves a field alone when
    // the caller did not send it, so a title-only rename cannot blank a body
    // and an autosave cannot revert a rename that raced it.
    this.db.prepare("UPDATE docs SET title = COALESCE(?, title), body = COALESCE(?, body), updated_at = ? WHERE id = ? AND account_id = ?")
      .run(title == null ? null : String(title).slice(0, MAX_TITLE), body == null ? null : String(body), t, String(docId), String(accountId));
    return this.doc(accountId, docId);
  }

  deleteDoc(accountId, docId) {
    this.doc(accountId, docId);
    this.db.prepare("DELETE FROM docs WHERE id = ? AND account_id = ?").run(String(docId), String(accountId));
  }

  /* ---------------------------------------------------------------- tasks */
  /*
   * A task spends money while nobody is watching. That single fact shapes
   * everything below.
   *
   *   - Every task names the GRANT it draws on. Not "whichever grant is
   *     live" — the one the person chose when they created it. A task that
   *     silently migrates to a different wallet's grant because the first
   *     expired is a task that spends money nobody authorised for it.
   *   - When that grant stops being live, the task PAUSES. It does not error
   *     every hour forever, and it does not quietly find another way to pay.
   *   - The minimum interval is an hour. Not for the server's sake — for the
   *     wallet's. A five-minute task is a spend loop with a friendly name.
   *   - next_run_at is stored, not derived. A restart must not reset every
   *     task's clock and fire the lot at once.
   */

  taskView(t) {
    if (!t) return null;
    return {
      id: t.id,
      title: t.title || "Untitled task",
      prompt: t.prompt,
      model: t.model || "auto",
      grantId: t.grant_id || null,
      everyMinutes: Number(t.every_minutes),
      enabled: Number(t.enabled) === 1,
      createdAt: Number(t.created_at),
      nextRunAt: Number(t.next_run_at),
      lastRunAt: t.last_run_at == null ? null : Number(t.last_run_at),
      lastOk: t.last_ok == null ? null : Number(t.last_ok) === 1,
      lastOutput: t.last_output || null,
      lastError: t.last_error || null,
      runs: Number(t.runs),
    };
  }

  tasks(accountId) {
    return this.db.prepare("SELECT * FROM tasks WHERE account_id = ? ORDER BY created_at DESC LIMIT 100")
      .all(String(accountId)).map((t) => this.taskView(t));
  }

  task(accountId, taskId) {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND account_id = ?")
      .get(String(taskId || ""), String(accountId));
    if (!t) throw Object.assign(new Error("no such task"), { status: 404 });
    return this.taskView(t);
  }

  createTask(accountId, { title, prompt, model, grantId, everyMinutes }) {
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ?").get(String(accountId)).n;
    if (n >= MAX_TASKS_PER_ACCOUNT) {
      throw Object.assign(new Error(`you can have ${MAX_TASKS_PER_ACCOUNT} scheduled tasks — delete one first`), { status: 409 });
    }
    const p = String(prompt || "").trim();
    if (!p) throw Object.assign(new Error("a task needs a prompt"), { status: 400 });
    if (p.length > MAX_TASK_PROMPT) throw Object.assign(new Error("that prompt is too long for a task"), { status: 413 });
    const every = Math.round(Number(everyMinutes));
    if (!Number.isFinite(every) || every < MIN_TASK_MINUTES) {
      throw Object.assign(new Error(`a task can run at most once every ${MIN_TASK_MINUTES} minutes`), { status: 400 });
    }
    if (every > MAX_TASK_MINUTES) throw Object.assign(new Error("that interval is too long to be a schedule"), { status: 400 });
    if (!grantId) throw Object.assign(new Error("a task must name the spending grant it draws on"), { status: 400 });
    const tid = id("task");
    const t = now();
    this.db.prepare(
      `INSERT INTO tasks (id, account_id, title, prompt, model, grant_id, every_minutes, enabled, created_at, next_run_at, runs)
       VALUES (?,?,?,?,?,?,?,1,?,?,0)`
    ).run(tid, String(accountId), String(title || "").slice(0, MAX_TITLE) || null, p,
      model ? String(model) : null, String(grantId), every, t, t + every * 60000);
    return this.task(accountId, tid);
  }

  updateTask(accountId, taskId, { title, prompt, model, everyMinutes, enabled }) {
    const cur = this.task(accountId, taskId);
    const every = everyMinutes == null ? cur.everyMinutes : Math.round(Number(everyMinutes));
    if (!Number.isFinite(every) || every < MIN_TASK_MINUTES || every > MAX_TASK_MINUTES) {
      throw Object.assign(new Error(`a task can run at most once every ${MIN_TASK_MINUTES} minutes`), { status: 400 });
    }
    const p = prompt == null ? cur.prompt : String(prompt).trim();
    if (!p) throw Object.assign(new Error("a task needs a prompt"), { status: 400 });
    if (p.length > MAX_TASK_PROMPT) throw Object.assign(new Error("that prompt is too long for a task"), { status: 413 });
    /*
     * Re-enabling schedules the NEXT run one full interval out, rather than
     * firing immediately. Someone switching a paused task back on is saying
     * "resume", not "run right now" — and a task that fires the instant it
     * is enabled makes toggling it an expensive way to change your mind.
     */
    const on = enabled == null ? cur.enabled : Boolean(enabled);
    const nextRun = !cur.enabled && on ? now() + every * 60000 : cur.nextRunAt;
    this.db.prepare(
      `UPDATE tasks SET title = ?, prompt = ?, model = ?, every_minutes = ?, enabled = ?, next_run_at = ?
       WHERE id = ? AND account_id = ?`
    ).run(title == null ? (cur.title === "Untitled task" ? null : cur.title) : String(title).slice(0, MAX_TITLE) || null,
      p, model == null ? (cur.model === "auto" ? null : cur.model) : String(model), every, on ? 1 : 0, nextRun,
      String(taskId), String(accountId));
    return this.task(accountId, taskId);
  }

  deleteTask(accountId, taskId) {
    this.task(accountId, taskId);
    this.db.prepare("DELETE FROM tasks WHERE id = ? AND account_id = ?").run(String(taskId), String(accountId));
  }

  /** Enabled tasks whose time has come. Account-wide by design — this is the
   *  runner's query, and the runner serves everyone. */
  dueTasks(at = now(), limit = 20) {
    return this.db.prepare("SELECT * FROM tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?")
      .all(at, limit).map((t) => ({ ...this.taskView(t), accountId: t.account_id }));
  }

  /**
   * Record what happened and move the clock forward.
   *
   * The clock advances on FAILURE too. A task whose next_run_at only moved on
   * success would stay permanently due after one bad run and be retried on
   * every tick — the tightest possible spend loop, reached by a bug rather
   * than a decision.
   */
  recordRun(taskId, { ok, output, error, pause }) {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(taskId));
    if (!t) return null;
    const every = Number(t.every_minutes);
    this.db.prepare(
      `UPDATE tasks SET last_run_at = ?, last_ok = ?, last_output = ?, last_error = ?, runs = runs + 1,
              next_run_at = ?, enabled = ? WHERE id = ?`
    ).run(now(), ok ? 1 : 0, ok ? String(output || "").slice(0, MAX_CONTENT) : null,
      ok ? null : String(error || "failed"), now() + every * 60000, pause ? 0 : Number(t.enabled), String(taskId));
    return this.taskView(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(taskId)));
  }

  /* ------------------------------------------------------------- memory */
  /*
   * Things worth remembering between conversations: what you are working on,
   * how you like answers written, your timezone. Short facts, written by the
   * person, kept until they delete them.
   *
   * Explicit, not inferred. An assistant that decides on its own what to
   * remember about you is one you cannot correct, because you never find out
   * what it wrote down — and here it would also mean an extra model call, and
   * therefore an extra charge, on every message you send. Neither is a good
   * trade for a feature whose whole value is that you trust what is in it.
   *
   * Recall is keyword overlap, not embeddings. That is a real limitation and
   * it buys a real property: you can look at a memory and predict when it
   * will be used. A vector store would recall better and explain nothing, and
   * "why did it bring that up" has no answer you could give someone.
   */

  memories(accountId) {
    return this.db.prepare("SELECT id, text, created_at, used_at, uses FROM memories WHERE account_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(String(accountId), MAX_MEMORIES)
      .map((m) => ({
        id: m.id,
        text: m.text,
        createdAt: Number(m.created_at),
        usedAt: m.used_at == null ? null : Number(m.used_at),
        uses: Number(m.uses),
      }));
  }

  addMemory(accountId, text) {
    const body = String(text || "").replace(/\s+/g, " ").trim();
    if (!body) throw Object.assign(new Error("write something to remember"), { status: 400 });
    if (body.length > MAX_MEMORY_CHARS) {
      throw Object.assign(new Error(`a memory should be short — under ${MAX_MEMORY_CHARS} characters`), { status: 413 });
    }
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE account_id = ?").get(String(accountId)).n;
    if (n >= MAX_MEMORIES) {
      throw Object.assign(new Error(`you can keep ${MAX_MEMORIES} memories — delete one first`), { status: 409 });
    }
    // Exact duplicates are a no-op rather than an error: saving the same
    // thing twice is a normal human action, not a mistake worth a red box.
    const dupe = this.db.prepare("SELECT id FROM memories WHERE account_id = ? AND text = ?").get(String(accountId), body);
    if (dupe) return this.memories(accountId);
    this.db.prepare("INSERT INTO memories (id, account_id, text, created_at, uses) VALUES (?,?,?,?,0)")
      .run(id("mem"), String(accountId), body, now());
    return this.memories(accountId);
  }

  deleteMemory(accountId, memoryId) {
    const r = this.db.prepare("DELETE FROM memories WHERE id = ? AND account_id = ?")
      .run(String(memoryId || ""), String(accountId));
    if (!r.changes) throw Object.assign(new Error("no such memory"), { status: 404 });
    return this.memories(accountId);
  }

  /**
   * Which memories are relevant to this message.
   *
   * Score = how many of the memory's distinctive words appear in the text.
   * Words shorter than four characters are ignored, which is a crude stand-in
   * for a stopword list and behaves the same way on the words that matter.
   * Ties break toward the newest, because a fact you wrote today is more
   * likely to be the current one.
   */
  recall(accountId, text, limit = 4) {
    const hay = String(text || "").toLowerCase();
    if (!hay) return [];
    const scored = [];
    for (const m of this.memories(accountId)) {
      const words = [...new Set(m.text.toLowerCase().match(/[a-z0-9]{4,}/g) || [])];
      if (!words.length) continue;
      const hits = words.filter((w) => hay.includes(w)).length;
      if (hits > 0) scored.push({ ...m, score: hits / words.length });
    }
    scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    return scored.slice(0, limit);
  }

  /** Mark memories as used, so the list can show what is actually earning
   *  its place and what has never once been recalled. */
  touchMemories(ids) {
    for (const mid of ids || []) {
      this.db.prepare("UPDATE memories SET used_at = ?, uses = uses + 1 WHERE id = ?").run(now(), String(mid));
    }
  }

  /** Everything this account holds, for a delete-my-data request. */
  purgeAccount(accountId) {
    const chats = this.db.prepare("SELECT id FROM chats WHERE account_id = ?").all(String(accountId));
    for (const c of chats) this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(c.id);
    const r = this.db.prepare("DELETE FROM chats WHERE account_id = ?").run(String(accountId));
    const d = this.db.prepare("DELETE FROM docs WHERE account_id = ?").run(String(accountId));
    const k = this.db.prepare("DELETE FROM tasks WHERE account_id = ?").run(String(accountId));
    const m = this.db.prepare("DELETE FROM memories WHERE account_id = ?").run(String(accountId));
    return { chats: r.changes, docs: d.changes, tasks: k.changes, memories: m.changes };
  }
}

module.exports = {
  AppData,
  MAX_CONTENT,
  MAX_CHATS_PER_ACCOUNT,
  MAX_MESSAGES_PER_CHAT,
  MAX_DOCS_PER_ACCOUNT,
  MAX_DOC_CHARS,
  MAX_TASKS_PER_ACCOUNT,
  MIN_TASK_MINUTES,
  MAX_MEMORIES,
  MAX_MEMORY_CHARS,
};
