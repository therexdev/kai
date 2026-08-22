"use strict";

/*
 * Probe: Chat, Docs, Tasks and Memory in the web app — task #79.
 *
 * Boots the REAL server and drives a whole conversation through it, with a
 * FAKE WORKER on the other side actually answering. The point is the seam:
 * a browser holds only an HttpOnly cookie, so it cannot present the session
 * token the scheduler's grant lane requires. The server bridges that hop in
 * process. This probe proves the bridge carries a real answer, bills a real
 * grant, and stores what was said — and that it refuses everything it
 * should.
 *
 * What it asserts, in rough order of how badly it would hurt to get wrong:
 *
 *   1. one account cannot read, write to, rename or delete another's chat,
 *      even knowing its id exactly
 *   2. no live grant -> 402 before anything runs, and nothing is stored
 *   3. a real streamed answer arrives, is persisted, and charges the grant
 *   4. the question is stored BEFORE the answer is asked, so a network
 *      failure never eats what someone typed
 *   5. the browser is never handed its own session token
 *
 * Old code (no /app/api, no lib/appdata.js): every section fails.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { Signer } = require("koilib");
// Hoisted: sections 7 and 8 both open the store directly to assert things
// that only exist in-process — a claim race and a recall ranking. Requiring
// it inside one of them put the other in its temporal dead zone.
const { AppData } = require(path.join(__dirname, "..", "lib", "appdata"));

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

const ROOT = path.join(__dirname, "..");
const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });

/* ------------------------------------------------------- a fake provider */
/*
 * A worker that registers, polls for a job, streams two chunks, and posts a
 * SIGNED result — the signature over sha256(`jobId|output`) that the
 * scheduler recovers an address from. Anything less and the answer is
 * rejected, so this exercises the real dispatch path, not a stub of it.
 */
class FakeWorker {
  constructor(base, model) {
    this.base = base;
    this.model = model;
    this.signer = Signer.fromSeed("probe app chat worker");
    this.address = this.signer.getAddress();
    this.stop = false;
    this.served = 0;
  }
  /*
   * Worker auth is a ?token= query parameter, NOT a bearer header — the
   * scheduler reads it off the URL (see _auth). Getting this wrong does not
   * error; next-job simply answers 401 forever and the job sits in the queue
   * until the consumer's 180s timeout. Ask how I know.
   */
  _url(p) {
    return `${this.base}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token || "")}`;
  }
  async _post(p, body, authed) {
    const r = await fetch(authed ? this._url(p) : this.base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json().catch(() => ({}));
  }
  async start() {
    const reg = await this._post("/scheduler/worker/register", {
      address: this.address,
      models: [this.model],
      capabilities: { ramGb: 32 },
    });
    this.token = reg.token;
    this.loop = this._run();
    return reg;
  }
  async _run() {
    while (!this.stop) {
      let job = null;
      try {
        const r = await fetch(this._url("/scheduler/worker/next-job"));
        const j = await r.json().catch(() => ({}));
        job = j.job || null;
      } catch { /* server going away — the loop ends below */ }
      if (!job) { await new Promise((r) => setTimeout(r, 60)); continue; }
      const output = "The Koinos Network answered this.";
      for (const piece of ["The Koinos Network ", "answered this."]) {
        await this._post("/scheduler/worker/chunk", { jobId: job.id, delta: piece }, true);
      }
      const hash = crypto.createHash("sha256").update(`${job.id}|${output}`).digest();
      const signature = await this.signer.signHash(hash);
      await this._post("/scheduler/worker/result", {
        jobId: job.id,
        output,
        signature: Buffer.from(signature).toString("base64"),
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }, true);
      this.served += 1;
    }
  }
}

/* ------------------------------------------------------------- http bits */
const jsonReq = (port, method, p, { cookie, body } = {}) =>
  new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port, path: p, method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, body: raw, json: parsed });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });

/** POST a message and collect the SSE frames it streams back. */
const sse = (port, p, cookie, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port, path: p, method: "POST",
        headers: { cookie, "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const frames = [];
          for (const line of raw.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") { frames.push({ DONE: true }); continue; }
            try { frames.push(JSON.parse(payload)); } catch { /* partial */ }
          }
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* streamed, not json */ }
          resolve({ status: res.statusCode, headers: res.headers, frames, json: parsed, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });

async function main() {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-appchat-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      KAI_STATE_DIR: stateDir,
      KAI_SITE_ORIGIN: `http://127.0.0.1:${port}`,
      /*
       * One free token a day, not zero.
       *
       * The free allowance is charged BEFORE the grant, so with the normal
       * 25,000/day a short chat costs the grant exactly nothing and section 5
       * could never see a charge — it would pass by testing nothing. One
       * token still opens the pre-execution capacity gate (which needs SOME
       * capacity to exist) while leaving 27 of 28 tokens billable, so the
       * grant is genuinely charged and the number can be checked.
       */
      KAI_FREE_TOKENS_PER_DAY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const LOG = process.env.PROBE_VERBOSE === "1";
  child.stdout.on("data", (d) => { if (LOG) process.stderr.write("[srv] " + d); });
  child.stderr.on("data", (d) => { if (LOG) process.stderr.write("[srv!] " + d); });
  const base = `http://127.0.0.1:${port}`;
  let worker = null;

  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await jsonReq(port, "GET", "/api/health").then((r) => r.status === 200).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    check(up, "server boots");
    if (!up) return;

    /* -- two accounts, one of which will try to read the other's chats -- */
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(stateDir, "accounts", "accounts.sqlite"));
    const t = Date.now();
    const mkAccount = (tag) => {
      const id = `acc_${tag}_${crypto.randomBytes(3).toString("hex")}`;
      db.prepare("INSERT INTO accounts (id, email, created_at, last_seen_at) VALUES (?,?,?,?)")
        .run(id, `${tag}@example.test`, t, t);
      const token = "sk_" + crypto.randomBytes(32).toString("base64url");
      db.prepare("INSERT INTO sessions (token_hash, account_id, label, created_at, expires_at, last_used_at) VALUES (?,?,?,?,?,?)")
        .run(sha256hex(token), id, "probe", t, t + 3600e3, t);
      return { id, cookie: `kai_session=${encodeURIComponent(token)}` };
    };
    const mine = mkAccount("mine");
    const other = mkAccount("other");

    /* ------------------------------------------------------------------ */
    console.log("\n1) chats are per-account, and an id alone opens nothing");
    let r = await jsonReq(port, "POST", "/app/api/chats", { cookie: mine.cookie, body: {} });
    check(r.status === 200 && r.json?.chat?.id, "a signed-in caller can start a chat");
    const chatId = r.json.chat.id;

    check((await jsonReq(port, "GET", "/app/api/chats", {})).status === 401, "signed out: 401 on the chat list");
    r = await jsonReq(port, "GET", `/app/api/chats/${chatId}`, { cookie: other.cookie });
    check(r.status === 404, `another account reading it: 404 (got ${r.status})`);
    r = await jsonReq(port, "DELETE", `/app/api/chats/${chatId}`, { cookie: other.cookie });
    check(r.status === 404, `another account deleting it: 404 (got ${r.status})`);
    r = await jsonReq(port, "PATCH", `/app/api/chats/${chatId}`, { cookie: other.cookie, body: { title: "stolen" } });
    check(r.status === 404, `another account renaming it: 404 (got ${r.status})`);
    r = await jsonReq(port, "GET", "/app/api/chats", { cookie: other.cookie });
    check(r.status === 200 && r.json.chats.length === 0, "…and it does not appear in their list at all");

    /* ------------------------------------------------------------------ */
    console.log("\n2) no spending grant means nothing runs");
    let m = await sse(port, `/app/api/chats/${chatId}/message`, mine.cookie, { content: "hello?" });
    check(m.status === 402, `refused with 402 (got ${m.status})`);
    check(/grant/i.test(String(m.json?.error || "")), "and the refusal says what is missing");
    r = await jsonReq(port, "GET", `/app/api/chats/${chatId}`, { cookie: mine.cookie });
    check(r.json.messages.length === 0, "a refused send stores nothing");

    /* ------------------------------------------------------------------ */
    console.log("\n3) a real answer, from a real dispatch, billed to the grant");
    const consumerAddr = Signer.fromSeed("probe app chat consumer").getAddress();
    db.prepare("INSERT INTO wallets (address, account_id, linked_at) VALUES (?,?,?)").run(consumerAddr, mine.id, t);
    db.prepare("INSERT INTO spend_grants (id, account_id, address, max_micro, spent_micro, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run("gr_chat", mine.id, consumerAddr, 5 * 1e6, 0, t, t + 86400e3);

    worker = new FakeWorker(base, "koinos-fast");
    const reg = await worker.start();
    check(Boolean(reg.token), "a provider is online and serving koinos-fast");

    // Before spending anything: a class nobody serves is refused up front,
    // not queued to time out 180 seconds later. Done HERE, while capacity is
    // still available, so the refusal can only be about the missing provider.
    const noneChat = (await jsonReq(port, "POST", "/app/api/chats", { cookie: mine.cookie, body: {} })).json.chat.id;
    let none = await sse(port, `/app/api/chats/${noneChat}/message`, mine.cookie, { content: "anyone there?", model: "koinos-smart" });
    check(none.status === 503, `a class nobody serves is refused immediately with 503 (got ${none.status})`);
    check(/serving/i.test(String(none.json?.error?.message || none.json?.error || "")), "and says so in words");
    r = await jsonReq(port, "GET", `/app/api/chats/${noneChat}`, { cookie: mine.cookie });
    check(r.json.messages.length === 1 && r.json.messages[0].role === "user",
      "the question is still there — a refused send never eats what someone typed");

    m = await sse(port, `/app/api/chats/${chatId}/message`, mine.cookie, { content: "What is this?", model: "koinos-fast" });
    check(m.status === 200, `the send streams (got ${m.status}: ${String(m.raw).slice(0, 160)})`);
    check(/text\/event-stream/.test(String(m.headers["content-type"] || "")), "as server-sent events");
    check(m.frames.some((f) => typeof f.delta === "string" && f.delta), "chunks arrived as the answer was generated");
    const done = m.frames.find((f) => f.done);
    check(Boolean(done), "a final frame closed it");
    check(String(done?.output || "").includes("Koinos Network answered"), "carrying the whole answer");
    check(done?.servedModel === "koinos-fast", "and naming the class that served it");
    check(m.frames.some((f) => f.DONE), "the stream terminated properly");
    /*
     * The price of THIS answer, in the answer. Someone paying per token
     * should see what they just bought at the moment they buy it — a total
     * on another page is an invoice, not a price tag. Zero is a legitimate
     * value (the free allowance covered it), so the assertion is on the TYPE,
     * not on truthiness: a falsy check here would have let a missing field
     * pass as "free".
     */
    check(typeof done?.costUsd === "number", `the final frame carries a price (got ${typeof done?.costUsd})`);
    check(done.costUsd > 0 && done.costUsd < 0.01, `…and it is a sane one ($${done?.costUsd})`);
    check(typeof done?.paidWith === "string" && done.paidWith, "…and says which pocket it came from");

    // Availability and price in one public feed, so choosing a class is not
    // a cross-reference exercise against /pricing.
    const feed = await jsonReq(port, "GET", "/scheduler/network/models");
    const fast = (feed.json?.models || []).find((x) => x.model === "koinos-fast");
    check(Boolean(fast), "the public models feed lists what is being served");
    check(fast?.providers >= 1, "…with how many providers hold it");
    check(fast?.outUsdPerM === 0.4 && fast?.inUsdPerM === 0.1, `…and its price (in ${fast?.inUsdPerM}/M, out ${fast?.outUsdPerM}/M)`);

    /* ------------------------------------------------------------------ */
    console.log("\n4) what was said is what was stored");
    // The reply is written when the response closes, which is the same tick
    // the client sees [DONE] — give the event loop a beat to run it.
    await new Promise((r2) => setTimeout(r2, 250));
    r = await jsonReq(port, "GET", `/app/api/chats/${chatId}`, { cookie: mine.cookie });
    const msgs = r.json.messages;
    check(msgs.length === 2, `both turns stored (got ${msgs.length})`);
    check(msgs[0]?.role === "user" && msgs[0]?.content === "What is this?", "the question, exactly as typed");
    check(msgs[1]?.role === "assistant" && String(msgs[1]?.content).includes("Koinos Network answered"), "and the answer");
    check(msgs[1]?.servedModel === "koinos-fast", "with the class that produced it");
    check(typeof msgs[1]?.costUsd === "number" && msgs[1].costUsd > 0,
      `and what it cost, kept with the message ($${msgs[1]?.costUsd})`);

    r = await jsonReq(port, "GET", "/app/api/chats", { cookie: mine.cookie });
    check(r.json.chats[0].title === "What is this?", "the chat named itself from the first thing said");
    check(r.json.chats[0].messages === 2, "the list counts what is in it");

    /* ------------------------------------------------------------------ */
    console.log("\n5) the grant paid for it");
    const me = await jsonReq(port, "GET", "/account/api", { cookie: mine.cookie });
    const grant = me.json.account.grants.find((g) => g.id === "gr_chat");
    check(grant.spentUsd > 0, `the grant was charged (spent $${grant?.spentUsd})`);
    check(grant.spentUsd < 0.01, "…a sane amount for 28 tokens, not a runaway");
    check(grant.remainingUsd === grant.maxUsd - grant.spentUsd, "remaining is what is left, arithmetically");

    /* ------------------------------------------------------------------ */
    /* ------------------------------------------------------------------ */
    console.log("\n6) docs: the model reads the document and writes nothing");
    /*
     * A SECOND wallet, with its own grant. Not for variety — the free daily
     * allowance is counted per ADDRESS, and this probe runs with one token a
     * day so that section 5 can see a real charge. Reusing wallet A here
     * would be refused for lack of capacity before the docs path was
     * exercised at all. A second address also means the grant must be picked
     * BY ID, which is worth pinning on its own.
     */
    const docAddr = Signer.fromSeed("probe app docs consumer").getAddress();
    db.prepare("INSERT INTO wallets (address, account_id, linked_at) VALUES (?,?,?)").run(docAddr, mine.id, t);
    db.prepare("INSERT INTO spend_grants (id, account_id, address, max_micro, spent_micro, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run("gr_docs", mine.id, docAddr, 5 * 1e6, 0, t, t + 86400e3);

    r = await jsonReq(port, "POST", "/app/api/docs", { cookie: mine.cookie, body: {} });
    check(r.status === 200 && r.json?.doc?.id, "a signed-in caller can start a document");
    const docId = r.json.doc.id;

    check((await jsonReq(port, "GET", `/app/api/docs/${docId}`, { cookie: other.cookie })).status === 404,
      "another account cannot open it");
    check((await jsonReq(port, "PUT", `/app/api/docs/${docId}`, { cookie: other.cookie, body: { body: "theirs now" } })).status === 404,
      "…nor write to it");
    check((await jsonReq(port, "DELETE", `/app/api/docs/${docId}`, { cookie: other.cookie })).status === 404,
      "…nor delete it");

    const BODY = "The network routes a job to whichever machine can serve the class.";
    r = await jsonReq(port, "PUT", `/app/api/docs/${docId}`, { cookie: mine.cookie, body: { title: "Routing", body: BODY } });
    check(r.status === 200 && r.json.doc.body === BODY, "a save round-trips the whole body");
    check(r.json.doc.title === "Routing", "and the title");

    // A title-only save must not blank the body — the COALESCE in saveDoc is
    // the whole reason this cannot happen, so it gets an assertion.
    r = await jsonReq(port, "PUT", `/app/api/docs/${docId}`, { cookie: mine.cookie, body: { title: "Routing, revised" } });
    check(r.json.doc.body === BODY, "a rename leaves the body alone");
    check(r.json.doc.title === "Routing, revised", "…and does rename it");

    const ai = await sse(port, `/app/api/docs/${docId}/ai`, mine.cookie,
      { instruction: "Summarise this.", grantId: "gr_docs", model: "koinos-fast" });
    check(ai.status === 200, `the ask streams (got ${ai.status}: ${String(ai.raw).slice(0, 140)})`);
    const aiDone = ai.frames.find((f) => f.done);
    check(String(aiDone?.output || "").includes("Koinos Network answered"), "an answer came back");

    await new Promise((r2) => setTimeout(r2, 250));
    r = await jsonReq(port, "GET", `/app/api/docs/${docId}`, { cookie: mine.cookie });
    check(r.json.doc.body === BODY,
      "THE DOCUMENT IS UNCHANGED — the model proposes, the person decides");

    const meDocs = await jsonReq(port, "GET", "/account/api", { cookie: mine.cookie });
    const gDocs = meDocs.json.account.grants.find((g) => g.id === "gr_docs");
    check(gDocs.spentUsd > 0, `the named grant paid for it (spent $${gDocs?.spentUsd})`);
    const gChat = meDocs.json.account.grants.find((g) => g.id === "gr_chat");
    check(gChat.spentUsd < 0.00001, "…and the OTHER grant was not touched");

    /* ------------------------------------------------------------------ */
    /* ------------------------------------------------------------------ */
    console.log("\n7) tasks: spending while nobody is watching");
    /*
     * A third wallet, for the same reason as the second: the free allowance
     * is per address and this probe runs with one token a day.
     */
    const taskAddr = Signer.fromSeed("probe app tasks consumer").getAddress();
    db.prepare("INSERT INTO wallets (address, account_id, linked_at) VALUES (?,?,?)").run(taskAddr, mine.id, t);
    db.prepare("INSERT INTO spend_grants (id, account_id, address, max_micro, spent_micro, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run("gr_task", mine.id, taskAddr, 5 * 1e6, 0, t, t + 86400e3);

    // A schedule tighter than an hour is a spend loop with a friendly name.
    r = await jsonReq(port, "POST", "/app/api/tasks", {
      cookie: mine.cookie,
      body: { title: "Too often", prompt: "hi", everyMinutes: 5, grantId: "gr_task" },
    });
    check(r.status === 400, `a five-minute schedule is refused (got ${r.status})`);

    r = await jsonReq(port, "POST", "/app/api/tasks", {
      cookie: mine.cookie,
      body: { title: "Daily digest", prompt: "Summarise the network.", everyMinutes: 1440, grantId: "gr_task", model: "koinos-fast" },
    });
    check(r.status === 200 && r.json?.task?.id, `a task can be created (got ${r.status}: ${r.body.slice(0, 120)})`);
    const taskId = r.json.task.id;
    check(r.json.task.grantId === "gr_task", "it names the grant it draws on, not 'whichever is live'");
    check(r.json.task.enabled === true && r.json.task.nextRunAt > Date.now(), "scheduled forward, not due immediately");

    check((await jsonReq(port, "GET", "/app/api/tasks", { cookie: other.cookie })).json.tasks.length === 0,
      "another account cannot see it");
    check((await jsonReq(port, "POST", `/app/api/tasks/${taskId}/run`, { cookie: other.cookie, body: {} })).status === 404,
      "…nor run it");
    check((await jsonReq(port, "DELETE", `/app/api/tasks/${taskId}`, { cookie: other.cookie })).status === 404,
      "…nor delete it");

    // Run now takes the SAME path the schedule takes — no session involved,
    // the account asserted on the request object in-process.
    r = await jsonReq(port, "POST", `/app/api/tasks/${taskId}/run`, { cookie: mine.cookie, body: {} });
    check(r.status === 200, `run now succeeds with no session in the request (got ${r.status}: ${r.body.slice(0, 160)})`);
    check(String(r.json?.task?.lastOutput || "").includes("Koinos Network answered"), "and stores what came back");
    check(r.json?.task?.lastOk === true && r.json?.task?.runs === 1, "the run is recorded");
    check(worker.served === 3, "a worker really did the work");

    const meTask = await jsonReq(port, "GET", "/account/api", { cookie: mine.cookie });
    check(meTask.json.account.grants.find((g) => g.id === "gr_task").spentUsd > 0, "the task's own grant paid for it");

    /*
     * THE ONE THAT MATTERS MOST HERE. The task runner asserts its account on
     * the request OBJECT (req.trustedAccountId), which a request arriving
     * over a socket cannot carry — headers land on req.headers and the body
     * is parsed separately. Prove it: ask the scheduler directly, over real
     * HTTP, claiming the account every way a caller could.
     */
    const forge = (extra) =>
      jsonReq(port, "POST", "/scheduler/consume/chat/completions", {
        body: { messages: [{ role: "user", content: "hi" }], max_tokens: 32, grantId: "gr_task", ...extra },
      });
    for (const [label, extra] of [
      ["a body field", { trustedAccountId: mine.id }],
      ["an accountId field", { accountId: mine.id }],
      ["no session at all", {}],
      ["a made-up session", { sessionToken: "sk_not_a_real_token" }],
    ]) {
      const f = await forge(extra);
      check(f.status === 401, `${label} cannot spend someone's grant over HTTP (got ${f.status})`);
    }

    // A dead grant pauses the task rather than failing it hourly forever.
    db.prepare("UPDATE spend_grants SET revoked_at = ? WHERE id = ?").run(Date.now(), "gr_task");
    r = await jsonReq(port, "POST", `/app/api/tasks/${taskId}/run`, { cookie: mine.cookie, body: {} });
    check(r.status === 402, `a revoked grant refuses the run (got ${r.status})`);
    r = await jsonReq(port, "GET", "/app/api/tasks", { cookie: mine.cookie });
    const paused = r.json.tasks.find((x) => x.id === taskId);
    check(paused.enabled === false, "…and PAUSES the task rather than retrying forever");
    check(/paused/i.test(String(paused.lastError || "")), "with an error that says so");
    check(paused.nextRunAt > Date.now(), "the clock is still forward of now");

    /*
     * THE DOUBLE-SPEND RACE. A run can take three minutes (the consume path
     * waits that long for a provider) while the runner ticks every one, and
     * setInterval does not wait for an async callback. Without an atomic
     * claim, tick N+1 finds a task tick N is still executing, sees it as due,
     * and charges for it twice — by accident, on the one feature that spends
     * with nobody watching.
     *
     * Driven against the store directly, because that is where the guard
     * lives: the UPDATE's WHERE re-checks the due time inside sqlite, so of
     * two callers racing exactly one can win.
     */
    const store2 = new AppData({ stateDir });
    const raceId = (await jsonReq(port, "POST", "/app/api/tasks", {
      cookie: mine.cookie,
      body: { title: "Race", prompt: "hi", everyMinutes: 60, grantId: "gr_docs" },
    })).json.task.id;
    // Make it due, the way the passage of an hour would.
    store2.db.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?").run(Date.now() - 1000, raceId);
    check(store2.dueTasks(Date.now()).some((x) => x.id === raceId), "the task is due");
    const first = store2.claimTask(raceId);
    const second = store2.claimTask(raceId);
    check(first === true, "the first claim wins");
    check(second === false, "…and the second does NOT — no double run, no double charge");
    check(store2.task(mine.id, raceId).nextRunAt > Date.now(), "the claim moved the clock, before the work");
    check(!store2.dueTasks(Date.now()).some((x) => x.id === raceId), "…so it is no longer due");
    // A paused task cannot be claimed at all.
    store2.db.prepare("UPDATE tasks SET next_run_at = ?, enabled = 0 WHERE id = ?").run(Date.now() - 1000, raceId);
    check(store2.claimTask(raceId) === false, "a paused task cannot be claimed");
    store2.db.close();

    // A manual run leaves the SCHEDULE alone — running something by hand is
    // not a statement about when it should next run by itself.
    const beforeManual = (await jsonReq(port, "GET", "/app/api/tasks", { cookie: mine.cookie }))
      .json.tasks.find((x) => x.id === taskId).nextRunAt;
    await jsonReq(port, "POST", `/app/api/tasks/${taskId}/run`, { cookie: mine.cookie, body: {} });
    const afterManual = (await jsonReq(port, "GET", "/app/api/tasks", { cookie: mine.cookie }))
      .json.tasks.find((x) => x.id === taskId).nextRunAt;
    check(afterManual === beforeManual, "a manual run does not move the schedule");

    /* ------------------------------------------------------------------ */
    console.log("\n8) memory is recalled by relevance, never wholesale");
    r = await jsonReq(port, "POST", "/app/api/memory", { cookie: mine.cookie, body: { text: "I run a Koinos node on a Raspberry Pi 5." } });
    check(r.status === 200 && r.json.memories.length === 1, "a memory can be saved");
    await jsonReq(port, "POST", "/app/api/memory", { cookie: mine.cookie, body: { text: "My favourite colour is orange." } });
    r = await jsonReq(port, "POST", "/app/api/memory", { cookie: mine.cookie, body: { text: "I run a Koinos node on a Raspberry Pi 5." } });
    check(r.json.memories.length === 2, "saving the same thing twice is a no-op, not an error");
    check((await jsonReq(port, "GET", "/app/api/memory", { cookie: other.cookie })).json.memories.length === 0,
      "another account sees none of it");
    check((await jsonReq(port, "DELETE", `/app/api/memory/${r.json.memories[0].id}`, { cookie: other.cookie })).status === 404,
      "…and cannot delete one");

    /*
     * Recall runs in-process, so it can be asserted directly rather than
     * inferred from what a model happened to say. This is the property that
     * matters: a message about nodes must NOT drag in the colour memory.
     */
    const store = new AppData({ stateDir });
    const hits = store.recall(mine.id, "how do I check whether my node is earning?");
    check(hits.length === 1, `only the relevant memory is recalled (got ${hits.length})`);
    check(/Raspberry Pi/.test(hits[0]?.text || ""), "…and it is the right one");
    check(store.recall(mine.id, "what is the weather").length === 0, "an unrelated message recalls nothing");
    store.db.close();

    // …and it really reaches a completed answer. A fourth wallet, same
    // reason as the second and third: one free token per address per day.
    const memAddr = Signer.fromSeed("probe app memory consumer").getAddress();
    db.prepare("INSERT INTO wallets (address, account_id, linked_at) VALUES (?,?,?)").run(memAddr, mine.id, t);
    db.prepare("INSERT INTO spend_grants (id, account_id, address, max_micro, spent_micro, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run("gr_mem", mine.id, memAddr, 5 * 1e6, 0, t, t + 86400e3);

    const memChat = (await jsonReq(port, "POST", "/app/api/chats", { cookie: mine.cookie, body: {} })).json.chat.id;
    m = await sse(port, `/app/api/chats/${memChat}/message`, mine.cookie,
      { content: "Tell me about my node.", model: "koinos-fast", grantId: "gr_mem" });
    check(m.status === 200, `a chat that touches memory runs (got ${m.status})`);
    await new Promise((r2) => setTimeout(r2, 250));
    r = await jsonReq(port, "GET", "/app/api/memory", { cookie: mine.cookie });
    const used = r.json.memories.find((x) => /Raspberry Pi/.test(x.text));
    check(used.uses === 1, `the recalled memory is marked used (uses=${used?.uses})`);
    const unused = r.json.memories.find((x) => /orange/.test(x.text));
    check(unused.uses === 0, "…and the irrelevant one was never sent");

    // A use is counted when an ANSWER comes back, not when a memory is
    // recalled — otherwise a refused request inflates the tally and the
    // panel's "used 3×" stops meaning what it says.
    const deadChat = (await jsonReq(port, "POST", "/app/api/chats", { cookie: mine.cookie, body: {} })).json.chat.id;
    await sse(port, `/app/api/chats/${deadChat}/message`, mine.cookie,
      { content: "Anything else about my node?", model: "koinos-smart", grantId: "gr_mem" });
    r = await jsonReq(port, "GET", "/app/api/memory", { cookie: mine.cookie });
    check(r.json.memories.find((x) => /Raspberry Pi/.test(x.text)).uses === 1,
      "a refused request does not count as a use");

    /* ------------------------------------------------------------------ */
    console.log("\n9) out of capacity is a refusal, not an overdraft");
    /*
     * The grant says what the WEBSITE may spend. It does not conjure funds:
     * the wallet still has to have capacity in the scheduler's ledger — free
     * allowance, deposited KAI, or current-epoch earnings. This probe runs
     * with a one-token daily allowance and an address holding nothing, so the
     * next request has nothing to draw on and must be refused BEFORE a worker
     * is asked to do the work. Letting it run would spend the network's
     * compute against a debt that closeEpoch wipes — work nobody ever pays
     * for.
     */
    const r2 = await jsonReq(port, "POST", "/app/api/chats", { cookie: mine.cookie, body: {} });
    const orphan = r2.json.chat.id;
    m = await sse(port, `/app/api/chats/${orphan}/message`, mine.cookie,
      { content: "and again?", model: "koinos-fast", grantId: "gr_chat" });
    check(m.status === 402, `refused with 402 when the wallet has nothing to draw on (got ${m.status})`);
    // Three jobs by now — chat, the docs ask, and the task run. This refusal
    // must add none: the point is that nothing is dispatched.
    check(worker.served === 4, `and no worker was asked to do the work (served ${worker.served}, expected 4)`);
    r = await jsonReq(port, "GET", `/app/api/chats/${orphan}`, { cookie: mine.cookie });
    check(r.json.messages.length === 1 && r.json.messages[0].role === "user",
      "the question survives this refusal too");

    /* ------------------------------------------------------------------ */
    console.log("\n10) deleting your data deletes your data — and nothing else");
    r = await jsonReq(port, "GET", "/app/api/chats", { cookie: mine.cookie });
    const beforeChats = r.json.chats.length;
    check(beforeChats > 0, `there is something to delete (${beforeChats} chats)`);
    check((await jsonReq(port, "DELETE", "/app/api/data", {})).status === 401, "signed out: refused");

    r = await jsonReq(port, "DELETE", "/app/api/data", { cookie: mine.cookie });
    check(r.status === 200, `the purge runs (got ${r.status})`);
    check(r.json.deleted.chats === beforeChats, "…and reports what it removed");
    check((await jsonReq(port, "GET", "/app/api/chats", { cookie: mine.cookie })).json.chats.length === 0, "chats are gone");
    check((await jsonReq(port, "GET", "/app/api/docs", { cookie: mine.cookie })).json.docs.length === 0, "docs are gone");
    check((await jsonReq(port, "GET", "/app/api/tasks", { cookie: mine.cookie })).json.tasks.length === 0, "tasks are gone");
    check((await jsonReq(port, "GET", "/app/api/memory", { cookie: mine.cookie })).json.memories.length === 0, "memories are gone");
    /*
     * Identity and money are NOT content. Bundling them into the same button
     * is how somebody loses a wallet link they meant to keep, so the purge
     * must leave both standing — and be asserted to.
     */
    const after = await jsonReq(port, "GET", "/account/api", { cookie: mine.cookie });
    check(after.status === 200, "the account still exists");
    check(after.json.account.wallets.length === 4, `wallets untouched (${after.json.account.wallets.length})`);
    check(after.json.account.grants.length === 4, `grants untouched (${after.json.account.grants.length})`);

    /* ------------------------------------------------------------------ */
    console.log("\n11) the browser is never handed its own session token");
    const shell = await jsonReq(port, "GET", "/app", { cookie: mine.cookie });
    check(shell.status === 200 && !shell.body.includes("sk_"), "no token in the shell");
    const clientJs = fs.readFileSync(path.join(ROOT, "views", "app.js"), "utf8");
    check(!/sessionToken/.test(clientJs), "the client never even names one");
    const meBody = await jsonReq(port, "GET", "/account/api", { cookie: mine.cookie });
    check(!meBody.body.includes("sk_"), "and the account view does not leak one either");
    // The bridge is the ONLY thing that reads the cookie for this purpose.
    const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    check((srv.match(/sessionToken:/g) || []).length === 1, "exactly one place in the server passes it on");

    db.close();
  } finally {
    if (worker) worker.stop = true;
    child.kill("SIGTERM");
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
