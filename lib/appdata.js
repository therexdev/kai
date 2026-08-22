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

  /** Everything this account holds, for a delete-my-data request. */
  purgeAccount(accountId) {
    const chats = this.db.prepare("SELECT id FROM chats WHERE account_id = ?").all(String(accountId));
    for (const c of chats) this.db.prepare("DELETE FROM messages WHERE chat_id = ?").run(c.id);
    const r = this.db.prepare("DELETE FROM chats WHERE account_id = ?").run(String(accountId));
    const d = this.db.prepare("DELETE FROM docs WHERE account_id = ?").run(String(accountId));
    return { chats: r.changes, docs: d.changes };
  }
}

module.exports = { AppData, MAX_CONTENT, MAX_CHATS_PER_ACCOUNT, MAX_MESSAGES_PER_CHAT, MAX_DOCS_PER_ACCOUNT, MAX_DOC_CHARS };
