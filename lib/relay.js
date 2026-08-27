/*
 * Device relay — the "works from anywhere" half of the app's local API.
 *
 * The desktop app serves an OpenAI-compatible API on the user's own
 * machine, which is exactly where nothing on the internet can reach it.
 * The classic fixes (port forwards, third-party tunnels) are the opposite
 * of one-click. This relay closes the gap with plain outbound HTTP:
 *
 *   device  --->  GET  /relay/poll        (long-poll, held ~25s)
 *   public  --->  ANY  /r/<id>/v1/...     (queued as a job)
 *   device  <---  job  {reqId, method, path, headers, body}
 *   device  --->  POST /relay/respond/<reqId>   (streams the answer back)
 *   public  <---  status + headers + streamed body (SSE included)
 *
 * The device only ever connects OUT, so it works behind any NAT or
 * firewall with zero configuration. No WebSockets on purpose: long-poll +
 * a streamed respond POST is the whole protocol, debuggable with curl.
 *
 * Identity is stateless by construction: the device holds a random secret
 * token and its public tunnel id IS sha256(token) — the relay derives it
 * on every request, so there is nothing to persist, nothing to register,
 * and no way to hijack an id short of a preimage. Losing the token means
 * a new id, which the app surfaces as "your URL changed".
 *
 * Trust, stated honestly: TLS terminates here, so this box could read
 * relayed traffic — the same box already runs the scheduler that serves
 * network inference, so remote use of NETWORK models transits it either
 * way; remote use of LOCAL models is new visibility the app's privacy
 * copy must own. End-to-end AUTH stays on the device: the relay forwards
 * the caller's Authorization header untouched and the device's gateway
 * enforces its own API keys — a relay operator cannot mint access.
 *
 * Only /v1/* is forwarded. The gateway also serves /core/* (tools, search,
 * files) and its UI; none of that belongs on the public internet.
 */
"use strict";

const crypto = require("node:crypto");

const POLL_HOLD_MS = 25_000; // under Caddy/proxy idle timeouts
const PICKUP_TIMEOUT_MS = 6_000; // no poller showed up -> device offline
const RESPOND_TIMEOUT_MS = 240_000; // answers can stream for minutes
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_JOBS_PER_TUNNEL = 8;
const TUNNEL_IDLE_PRUNE_MS = 10 * 60_000;
// Request headers worth carrying to the device; everything else is
// transport detail of THIS hop. Authorization rides through so the
// device's own API keys keep being the authority.
const FWD_REQ_HEADERS = ["authorization", "content-type", "accept", "user-agent"];

const tunnelIdOf = (token) => crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 32);

class Relay {
  constructor({ publicBase = "", onEvent = () => {} } = {}) {
    this.publicBase = publicBase.replace(/\/+$/, "");
    this.onEvent = onEvent;
    /** tunnelId -> { pollers: [{res,timer}], queue: [job], jobs: Map(reqId -> job), lastSeen } */
    this.tunnels = new Map();
    this._prune = setInterval(() => this._pruneIdle(), 60_000);
    this._prune.unref?.();
  }

  stop() {
    clearInterval(this._prune);
    for (const t of this.tunnels.values()) {
      for (const p of t.pollers) this._finishPoller(p, 204);
      for (const job of t.jobs.values()) this._failJob(job, 502, "relay shutting down");
    }
    this.tunnels.clear();
  }

  status() {
    let jobs = 0, pollers = 0;
    for (const t of this.tunnels.values()) { jobs += t.jobs.size; pollers += t.pollers.length; }
    return { tunnels: this.tunnels.size, pollers, jobs };
  }

  /* ---------------- device side (mounted at /relay) ---------------- */

  async handleDevice(req, res) {
    const token = this._bearer(req);
    if (!token || token.length < 32) {
      return this._json(res, 401, { ok: false, error: "missing or short device token" });
    }
    const id = tunnelIdOf(token);
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "POST" && path === "/hello") {
      req.resume();
      const t = this._tunnel(id);
      t.lastSeen = Date.now();
      return this._json(res, 200, { ok: true, tunnelId: id, base: `${this.publicBase}/r/${id}/v1` });
    }

    if (req.method === "GET" && path === "/poll") {
      const t = this._tunnel(id);
      t.lastSeen = Date.now();
      const job = t.queue.shift();
      if (job) return this._deliver(res, job);
      const poller = { res, timer: null };
      poller.timer = setTimeout(() => this._finishPoller(poller, 204, t), POLL_HOLD_MS);
      res.on("close", () => this._finishPoller(poller, null, t));
      t.pollers.push(poller);
      return;
    }

    const m = /^\/respond\/([0-9a-f-]{16,64})$/.exec(path);
    if (req.method === "POST" && m) {
      const t = this.tunnels.get(id);
      const job = t?.jobs.get(m[1]);
      if (!job) {
        req.resume();
        return this._json(res, 410, { ok: false, error: "job is gone (answered, timed out, or caller left)" });
      }
      t.lastSeen = Date.now();
      return this._pipeRespond(req, res, t, job);
    }

    req.resume();
    return this._json(res, 404, { ok: false, error: "unknown relay endpoint" });
  }

  /* ---------------- public side (mounted at /r) ---------------- */

  async handlePublic(req, res) {
    const parts = /^\/([0-9a-f]{32})(\/.*)$/.exec(new URL(req.url, "http://x").pathname);
    const fwdPath = parts && parts[2];
    if (!parts || !/^\/v1\/[A-Za-z0-9_/.-]*$/.test(fwdPath)) {
      req.resume();
      return this._json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      req.resume();
      return this._json(res, 405, { error: { message: "Only GET and POST cross the relay", type: "invalid_request_error" } });
    }
    const id = parts[1];
    const t = this._tunnel(id);
    if (t.jobs.size + t.queue.length >= MAX_JOBS_PER_TUNNEL) {
      req.resume();
      return this._json(res, 429, { error: { message: "This device is answering as much as it can — try again in a moment", type: "rate_limit_error" } });
    }

    let body;
    try {
      body = await this._readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      return this._json(res, 413, { error: { message: String(e.message), type: "invalid_request_error" } });
    }

    const headers = {};
    for (const h of FWD_REQ_HEADERS) if (req.headers[h]) headers[h] = String(req.headers[h]);

    const job = {
      reqId: crypto.randomUUID(),
      method: req.method,
      path: fwdPath,
      headers,
      body: body.toString("base64"),
      publicRes: res,
      answered: false,
      pickupTimer: null,
      respondTimer: null,
    };
    t.jobs.set(job.reqId, job);
    res.on("close", () => {
      // Caller left: keep the job entry so the device's respond gets an
      // honest 410 instead of piping into a dead socket.
      if (!job.answered) job.publicRes = null;
    });

    job.pickupTimer = setTimeout(() => {
      if (!job.pickedUp) this._failJob(job, 503, "device offline — the computer this API lives on is not connected right now", t);
    }, PICKUP_TIMEOUT_MS);
    job.respondTimer = setTimeout(() => this._failJob(job, 504, "the device did not finish answering in time", t), RESPOND_TIMEOUT_MS);

    const poller = t.pollers.shift();
    if (poller) this._deliver(poller.res, job, poller);
    else t.queue.push(job);
    this.onEvent({ type: "relay:job", tunnel: id, path: fwdPath });
  }

  /* ---------------- internals ---------------- */

  _tunnel(id) {
    let t = this.tunnels.get(id);
    if (!t) {
      t = { pollers: [], queue: [], jobs: new Map(), lastSeen: Date.now() };
      this.tunnels.set(id, t);
    }
    return t;
  }

  _deliver(res, job, poller) {
    if (poller?.timer) clearTimeout(poller.timer);
    job.pickedUp = true;
    clearTimeout(job.pickupTimer);
    const { reqId, method, path, headers, body } = job;
    this._json(res, 200, { ok: true, job: { reqId, method, path, headers, body } });
  }

  _pipeRespond(req, res, t, job) {
    clearTimeout(job.respondTimer);
    t.jobs.delete(job.reqId);
    const out = job.publicRes;
    if (!out || job.answered) {
      req.resume();
      return this._json(res, 410, { ok: false, error: "caller already gone" });
    }
    job.answered = true;
    let status = parseInt(String(req.headers["x-kai-status"] || "200"), 10) || 200;
    let outHeaders = {};
    try {
      outHeaders = JSON.parse(Buffer.from(String(req.headers["x-kai-headers"] || ""), "base64").toString("utf8") || "{}");
    } catch { /* headers are a courtesy; the body still flows */ }
    const safe = {};
    for (const [k, v] of Object.entries(outHeaders)) {
      const key = k.toLowerCase();
      if (key === "content-type" || key === "cache-control") safe[key] = String(v);
    }
    out.writeHead(status, safe);
    req.pipe(out);
    req.on("end", () => { try { out.end(); } catch { /* gone */ } this._json(res, 200, { ok: true }); });
    req.on("error", () => { try { out.destroy(); } catch { /* gone */ } });
    out.on("close", () => { if (!res.writableEnded) req.destroy(); });
  }

  _failJob(job, status, message, t) {
    clearTimeout(job.pickupTimer);
    clearTimeout(job.respondTimer);
    t?.jobs.delete(job.reqId);
    if (t) { const i = t.queue.indexOf(job); if (i !== -1) t.queue.splice(i, 1); }
    if (job.publicRes && !job.answered) {
      job.answered = true;
      this._json(job.publicRes, status, { error: { message, type: "relay_error" } });
    }
  }

  _finishPoller(poller, status, t) {
    if (poller.timer) clearTimeout(poller.timer);
    if (t) { const i = t.pollers.indexOf(poller); if (i !== -1) t.pollers.splice(i, 1); }
    if (status && !poller.res.writableEnded) { try { poller.res.writeHead(status); poller.res.end(); } catch { /* gone */ } }
  }

  _pruneIdle() {
    const now = Date.now();
    for (const [id, t] of this.tunnels) {
      if (now - t.lastSeen > TUNNEL_IDLE_PRUNE_MS && t.pollers.length === 0 && t.jobs.size === 0 && t.queue.length === 0) {
        this.tunnels.delete(id);
      }
    }
  }

  _bearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
    return m ? m[1].trim() : null;
  }

  async _readBody(req, cap) {
    const chunks = [];
    let bytes = 0;
    for await (const c of req) {
      bytes += c.length;
      if (bytes > cap) throw new Error(`request body over ${cap} bytes`);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  _json(res, status, obj) {
    if (res.writableEnded || res.headersSent) return;
    try {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    } catch { /* gone */ }
  }
}

module.exports = { Relay, tunnelIdOf };
