"use strict";

/*
 * Probe: Chat in the web app — task #79.
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
    console.log("\n6) out of capacity is a refusal, not an overdraft");
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
    m = await sse(port, `/app/api/chats/${orphan}/message`, mine.cookie, { content: "and again?", model: "koinos-fast" });
    check(m.status === 402, `refused with 402 when the wallet has nothing to draw on (got ${m.status})`);
    check(worker.served === 1, "and no worker was ever asked to do the work");
    r = await jsonReq(port, "GET", `/app/api/chats/${orphan}`, { cookie: mine.cookie });
    check(r.json.messages.length === 1 && r.json.messages[0].role === "user",
      "the question survives this refusal too");

    /* ------------------------------------------------------------------ */
    console.log("\n7) the browser is never handed its own session token");
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
