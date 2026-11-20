"use strict";

/*
 * CONTEXT CAPACITY — network context protocol 1, scheduler side.
 *
 * The contract is KoinosAI docs/NETWORK_CONTEXT_PROTOCOL.md; this probe pins
 * the half that lives here. Fully offline: one in-process Scheduler per
 * scenario on a throwaway dataDir, HTTP on 127.0.0.1:0, real koilib
 * signatures, and fake workers that long-poll /worker/next-job and post
 * signed results. No engine, no model, nothing beyond loopback.
 *
 * What must hold:
 *   - legacy clients and workers keep legacy terms {512 output, 4096
 *     window}: an existing caller sending max_tokens 900 is served at 512,
 *     and a prompt that cannot fit 4096 is an immediate 400 on both legacy
 *     lanes (wallet and grant);
 *   - larger terms exist only behind a v1 signature that binds model and
 *     max_tokens, are honoured exactly or refused (never downgraded), and
 *     reach only workers whose sanitized capacity covers them;
 *   - every new refusal lands before any hold, charge or dispatch;
 *   - billing never exceeds the terms the consumer agreed to;
 *   - the free tokens a v1 worst-case gate counted are reserved until that
 *     request is billed or ends unbilled, and no other request — any lane,
 *     finishing in any order — can bill against them; grant and v1 requests
 *     for one address exclude each other (409); nothing is left reserved;
 *   - the mystery ring learns only from billed v1 results (at most 4 per
 *     consumer), and a quarter of v1-like mysteries audit the target's own
 *     advertised maximum whatever the ring holds;
 *   - v1 is text-only and carries no unsigned billing switch (selfHost is
 *     refused on it);
 *   - an own-machine job is never offered to another address, even after
 *     its lease expires, and a v1 stream whose consumer leaves turns into
 *     no result and no charge.
 *
 * Old code (no protocol): /pricing has no context object, v1 requests 401
 * against the legacy hash, and jobs carry no terms — most sections fail.
 *
 *   node scripts/probe-context-capacity.js
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Signer } = require("koilib");
const {
  Scheduler, seedMysteryOnce, MODEL_RATES,
  CONTEXT_TIERS, estimateTokensLegacy, estimateTokensV1, tierFor, sanitizeWorkerContext,
} = require("../lib/scheduler");
const { AccountService } = require("../lib/accounts");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

const OP = "probe-context-operator-secret";
const FAST = "koinos-fast";
const L = { contextTokens: 4096, maxOutputTokens: 512 };
// The visible payload of every consumer chat job (contract §9).
const VISIBLE = "contextTokens,createdAt,id,maxTokens,messages,model,modelClass,prompt,type";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-ctxcap-"));
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keysOf = (o) => Object.keys(o || {}).sort().join(",");
const user = (content) => [{ role: "user", content }];
// One ASCII user turn whose estimate (legacy and v1 alike) is exactly `est`.
const ofEst = (est) => user("a".repeat(4 * (est - 4)));
const ctxOf = (spec) => ({
  protocol: 1,
  models: Object.fromEntries(Object.entries(spec).map(([m, [c, o]]) => [m, { contextTokens: c, maxOutputTokens: o }])),
});
const msgOf = (r) => String(r.body?.error?.message || "");
const codeOf = (r) => r.body?.error?.code;

/* ------------------------------------------------------------ plumbing */
const booted = [];
async function boot(opts = {}) {
  const events = [];
  const s = new Scheduler({
    dataDir: tmp(),
    storeMode: "json",
    operatorSecret: OP,
    priceSources: [],
    // No dispatch head start: routing assertions below are about capacity,
    // not about which capable worker measured fastest.
    preferWindowMs: 0,
    // Generous free tier and no per-origin cap (every request here comes
    // from 127.0.0.1); the worst-case section sets its own.
    freeTokensPerDay: 1e7,
    freeTokensPerDayGlobal: 1e9,
    freeTokensPerIp: 0,
    onEvent: (e) => events.push(e),
    ...opts,
  });
  const port = await s.listen(0);
  booted.push(s);
  return { s, base: `http://127.0.0.1:${port}`, events };
}
/** Close a scenario's scheduler as soon as it is done (each holds a process
 *  exit listener until closed). */
async function retire(env) {
  const i = booted.indexOf(env.s);
  if (i >= 0) booted.splice(i, 1);
  await env.s.close().catch(() => {});
}

async function call(env, method, p, body, { signal, raw } = {}) {
  try {
    const r = await fetch(env.base + p, {
      method,
      headers: { "content-type": "application/json", "x-operator-secret": OP },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* empty or non-JSON */ }
    return { status: r.status, body: json };
  } catch (e) {
    return { status: 0, body: {}, error: e };
  }
}
const consume = (env, body, opts) => call(env, "POST", "/consume/chat/completions", body, opts);

function keyPair(seed) {
  const signer = new Signer({ privateKey: seed ? sha(seed).toString("hex") : crypto.randomBytes(32).toString("hex") });
  return { signer, address: signer.getAddress() };
}
const signB64 = async (signer, hash) => Buffer.from(await signer.signHash(hash)).toString("base64");

/** Register (or re-register) `w` — {signer, address, models, context?, ramGb?}. */
async function register(env, w) {
  const body = { address: w.address, models: w.models, capabilities: { ramGb: w.ramGb ?? 64 } };
  if (w.context !== undefined) body.context = w.context;
  const r = await call(env, "POST", "/worker/register", body);
  if (!r.body.token) throw new Error(`register failed: ${JSON.stringify(r.body).slice(0, 200)}`);
  w.token = r.body.token;
  return w;
}
async function addWorker(env, { models = [FAST], context, signer, name } = {}) {
  const kp = signer ? { signer, address: signer.getAddress() } : keyPair();
  return register(env, { ...kp, models, context, name });
}
const rowOf = (env, w) => [...env.s.workers.values()].find((x) => x.address === w.address);

/** Long-poll until a job arrives or `ms` runs out; the raw call result. A
 *  poll can wake with nothing for this worker (another job's wake-up, a
 *  lapsed preference timer) and answer 204 — a real worker just polls again. */
async function pollRaw(env, w, ms = 2500, ctl) {
  const deadline = Date.now() + ms;
  let r = { status: 0, body: {} };
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0 || ctl?.signal.aborted) return r;
    const signal = ctl ? AbortSignal.any([ctl.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
    r = await call(env, "GET", `/worker/next-job?token=${encodeURIComponent(w.token)}`, undefined, { signal });
    if (r.status !== 204) return r;
  }
}
/** One long-poll, bounded; null when nothing was handed over in time. */
async function poll(env, w, ms = 2500, ctl) {
  const r = await pollRaw(env, w, ms, ctl);
  return r.status === 200 ? r.body.job || null : null;
}
async function submit(env, w, job, { output = "ok", prompt = 10, completion = 5 } = {}) {
  const signature = await signB64(w.signer, sha(`${job.id}|${output}`));
  return call(env, "POST", `/worker/result?token=${encodeURIComponent(w.token)}`, {
    jobId: job.id, output, signature,
    usage: { prompt_tokens: prompt, completion_tokens: completion },
    perf: { ms: 100, tokPerSec: 20 },
  });
}

/** Send a consume request and let `w` (only) take and answer the job. */
async function served(env, body, w, submitOpts = {}) {
  const cctl = new AbortController();
  const pctl = new AbortController();
  let early = null;
  const pending = consume(env, body, { signal: cctl.signal }).then((r) => { early = r; pctl.abort(); return r; });
  const pr = await pollRaw(env, w, 3000, pctl);
  const job = pr.status === 200 ? pr.body.job || null : null;
  const why = (r) => (r.error ? `${r.error.name}:${r.error.cause?.code || r.error.cause?.message || r.error.message}` : String(r.status));
  if (!job) {
    if (!early) cctl.abort();
    const resp = await pending;
    await sleep(20); // let the server drop an abandoned job
    const diag = `poll=${why(pr)} consume=${why(resp)} early=${!!early}`;
    console.error(`    (no job reached the worker: ${diag})`);
    return { job: null, resp, diag };
  }
  await submit(env, w, job, submitOpts);
  return { job, resp: await pending };
}

/** Send a consume request, read the job it queued (if any), then abandon it. */
async function queuedBy(env, body) {
  const ctl = new AbortController();
  let done = null;
  const pending = consume(env, body, { signal: ctl.signal }).then((r) => (done = r));
  const end = Date.now() + 2000;
  let job = null;
  while (!job && !done && Date.now() < end) {
    job = env.s.queue.find((j) => j.type === "chat" && !j.challenge) || null;
    if (!job) await sleep(5);
  }
  if (!done) ctl.abort();
  const resp = await pending;
  await sleep(30); // the disconnect removes the abandoned job
  return { job, resp };
}

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  return !!cond();
};
/** Send a consume request and wait until it has queued its job (or been
 *  answered); the request stays in flight. `p` resolves with the response. */
async function inFlight(env, body) {
  const known = new Set([...env.s.queue.map((j) => j.id), ...env.s.pending.keys()]);
  const ctl = new AbortController();
  let done = null;
  const p = consume(env, body, { signal: ctl.signal }).then((r) => (done = r));
  const fresh = () => env.s.queue.find((j) => j.type === "chat" && !j.challenge && !known.has(j.id)) || null;
  await until(() => done || fresh());
  return { p, ctl, job: fresh(), early: done };
}

let lastTs = 0;
const freshTs = () => (lastTs = Math.max(Date.now(), lastTs + 1));
const v1Preimage = (address, ts, model, maxTokens, messages) =>
  "consume-v1|" + JSON.stringify([address, ts, model, maxTokens, messages]);
async function legacyReq(c, messages, extra = {}) {
  const ts = freshTs();
  const signature = await signB64(c.signer, sha(`consume|${c.address}|${ts}|${JSON.stringify(messages)}`));
  return { address: c.address, ts, messages, signature, ...extra };
}
async function v1Req(c, { model = FAST, max_tokens, messages }, extra = {}) {
  const ts = freshTs();
  const signature = await signB64(c.signer, sha(v1Preimage(c.address, ts, model, max_tokens, messages)));
  return { address: c.address, ts, model, max_tokens, messages, signatureVersion: 1, signature, ...extra };
}

/** Everything a refusal must leave untouched for an address. */
const ledger = (env, addr) =>
  JSON.stringify({
    consumed: env.s.consumed[addr] ?? null,
    usage: env.s.usage[addr] ?? null,
    spent: env.s.spentSat[addr] ?? null,
    balance: env.s.balances[addr]?.balanceMicro ?? null,
    free: env.s.freeUsedByDay[addr] ?? null,
    queued: env.s.queue.length,
    pending: env.s.pending.size,
    receipts: env.s.receipts.length,
  });
/** The money-only part of the ledger (no queue/pending), for requests that
 *  are still in flight while it is compared. */
const spendOf = (env, addr) =>
  JSON.stringify({
    consumed: env.s.consumed[addr] ?? null,
    usage: env.s.usage[addr] ?? null,
    spent: env.s.spentSat[addr] ?? null,
    balance: env.s.balances[addr]?.balanceMicro ?? null,
    free: env.s.freeUsedByDay[addr] ?? null,
    receipts: env.s.receipts.length,
  });

// The worst-case rule exactly as the contract states it (§8).
const costMicro = (pt, ct, m) => Math.ceil((pt * MODEL_RATES[m].inMicroPerM + ct * MODEL_RATES[m].outMicroPerM) / 1e6);
const uncoveredOf = (promptBound, mt, m, free) => {
  const worstTok = promptBound + mt;
  return free >= worstTok ? 0 : Math.ceil((costMicro(promptBound, mt, m) * (worstTok - free)) / worstTok);
};

async function main() {
  /* ================================================================== */
  console.log("\n1) /pricing advertises protocol 1 and each class's window");
  const S2 = await boot(); // the mixed-capacity network, used from section 7 on
  {
    const pr = await call(S2, "GET", "/pricing");
    check(
      same(pr.body.context, { protocol: 1, tiers: [4096, 16384, 32768], legacyCtxTokens: 4096, legacyMaxTokens: 512, maxOutputTokens: 4096 }),
      "top-level context object is exactly the contract's"
    );
    const pm = pr.body.models || {};
    const classes = Object.keys(MODEL_RATES);
    check(classes.every((m) => pm[m]?.ctxTokens === 4096), "ctxTokens stays 4096 for every class");
    check(
      classes.every((m) => pm[m]?.maxCtxTokens === (m === "phi-4" ? 16384 : 32768)),
      "maxCtxTokens is 32768 for every class, 16384 for phi-4"
    );
    check(classes.every((m) => MODEL_RATES[m].maxCtxTokens === pm[m]?.maxCtxTokens), "MODEL_RATES carries the same windows");
    check(same([...CONTEXT_TIERS], [4096, 16384, 32768]) && Object.isFrozen(CONTEXT_TIERS), "CONTEXT_TIERS export is [4096, 16384, 32768] and frozen");
  }

  /* ================================================================== */
  console.log("\n2) shared vectors: estimators, tierFor, signed strings");
  {
    const V = [
      [[], 0, 0], [null, 0, 0], ["hello", 0, 0],
      [user("abcd"), 5, 5], [user("abcde"), 6, 6], [user("héllo"), 6, 6],
      [user("你好世界"), 5, 8], [user("😀"), 5, 5], [user("\ud800"), 5, 5],
      [user(null), 4, 4], [user(12345), 6, 6], [user({}), 8, 8], [user([null]), 4, 4],
      [user([{ type: "text", text: "abcdefgh" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), 806, 806],
      [user([{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }]), 4, 4],
      [[{ content: "a" }, { content: "b" }], 9, 9],
      [[{ role: "system", content: "You are helpful." }, { role: "user", content: "Hi 👋 你好" }], 14, 16],
      [user("a".repeat(14320)), 3584, 3584], [user("a".repeat(14321)), 3585, 3585],
      [user("a".repeat(16368)), 4096, 4096], [user("a".repeat(16369)), 4097, 4097],
      [user("你".repeat(4000)), 1004, 4004], [user("a".repeat(23984)), 6000, 6000],
    ];
    const off = V.filter(([m, l, v]) => estimateTokensLegacy(m) !== l || estimateTokensV1(m) !== v);
    check(off.length === 0, `all ${V.length} estimator vectors match${off.length ? ` (off: ${off.map(([m]) => JSON.stringify(m).slice(0, 40)).join("; ")})` : ""}`);
    check(V.every(([m]) => estimateTokensV1(m) >= estimateTokensLegacy(m)), "v1 never estimates below legacy on the vectors");

    const T = [[1, 4096], [4096, 4096], [4097, 16384], [16384, 16384], [16385, 32768], [32768, 32768], [32769, null]];
    check(T.every(([r, t]) => tierFor(r) === t), "tierFor vectors");

    const PK = sha("koinos-context-test-vector-v1").toString("hex");
    check(PK === "1545f7f0b715b40669d106f723a7da16ae7d8e03d6ec59d22c483262cef297df", "pinned test key");
    const vs = new Signer({ privateKey: PK });
    const VADDR = "1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH";
    check(vs.getAddress() === VADDR, "pinned test address");
    const VMSGS = [{ role: "system", content: "You are helpful." }, { role: "user", content: "Hi 👋 你好" }];
    const pre = v1Preimage(VADDR, 1767225600000, FAST, 2048, VMSGS);
    check(
      pre === 'consume-v1|["1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH",1767225600000,"koinos-fast",2048,[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hi 👋 你好"}]]' &&
        Buffer.byteLength(pre, "utf8") === 174,
      "v1 preimage is the pinned 174-byte string"
    );
    const vh = sha(pre);
    check(vh.toString("hex") === "3144f8fc12e66306f1b7d6658272d712acf366b54237c1af8b2787e6180b2754", "v1 sha256");
    const VSIG = "IEZ75BHUy1ghVBRNROlGQ5uDcEkful/SWoCiu+sLZvXhZfVzZnO18cocBtJGfcDZ6bRO8DS/5Q1zPZYZPUPj7w4=";
    check(Signer.recoverAddress(vh, Buffer.from(VSIG, "base64")) === VADDR, "the pinned v1 signature recovers to the pinned address");
    check((await signB64(vs, vh)) === VSIG, "…and koilib signs it deterministically");
    check("m:" + vh.toString("hex") === "m:3144f8fc12e66306f1b7d6658272d712acf366b54237c1af8b2787e6180b2754", "replay key");
    const th = sha(v1Preimage(VADDR, 1767225600000, FAST, 4096, VMSGS));
    check(th.toString("hex") === "f02f26b1c8bb755272a086fb56fdfbc45ef8559674d0494c165f8d20e4e3eb57", "tampered tuple (max_tokens 4096) hash");
    let rec = null;
    try { rec = Signer.recoverAddress(th, Buffer.from(VSIG, "base64")); } catch { /* unrecoverable is fine too */ }
    check(rec !== VADDR, "the pinned signature does not recover to the address over the tampered tuple");
    check(Buffer.from(VSIG + " \n", "base64").equals(Buffer.from(VSIG, "base64")), "a whitespace-appended signature decodes to the same bytes");
    check(
      sha(v1Preimage(VADDR, 1767225600000, "auto", 512, user("hello"))).toString("hex") === "b205160c9892d3cbddd1b3c32bbe00b34bc302987aeac9708d9ca21c2d5c413b",
      "auto tuple hash"
    );
    const lh = sha(`consume|${VADDR}|1767225600000|${JSON.stringify(VMSGS)}`);
    check(lh.toString("hex") === "967f427649ca218bc2c90f759b8093c89ecdde0719a8e5da447c059d60d9243d", "legacy hash unchanged");
    const LSIG = "IMH11B8VVxXj1N4E3X3rpb7uYjwBNqgDHKPzxFRPugf3A78rsgAI5dW0E9UaTgXRuI8r4adAqP0+/J1s8S7yCls=";
    check(Signer.recoverAddress(lh, Buffer.from(LSIG, "base64")) === VADDR, "the pinned legacy signature recovers");
  }

  /* ================================================================== */
  console.log("\n3) worker capacity is sanitized, never inherited");
  {
    const SM = ["koinos-fast", "phi-4", "koinos-smart"];
    check(
      [undefined, { protocol: "1" }, { protocol: 2 }, [], null, "1", 1].every((r) => sanitizeWorkerContext(r, SM) === null),
      "anything but {protocol: 1} is a legacy worker (null)"
    );
    check(same(sanitizeWorkerContext({ protocol: 1 }, SM), { protocol: 1, models: { "koinos-fast": L, "phi-4": L, "koinos-smart": L } }), "{protocol: 1} alone -> every class legacy");
    const one = (cls, c, o) => sanitizeWorkerContext({ protocol: 1, models: { [cls]: { contextTokens: c, maxOutputTokens: o } } }, SM).models[cls];
    for (const [cls, c, o, ec, eo] of [
      [FAST, 16384, 2048, 16384, 2048], [FAST, 8192, 2048, 4096, 512], [FAST, 4096, 2048, 4096, 512],
      [FAST, 32768, 100, 32768, 512], [FAST, 32768, "2048", 32768, 512], [FAST, 16384, 1.5, 16384, 512],
      [FAST, 16384, 1e9, 16384, 4096], ["phi-4", 32768, 4096, 4096, 512], ["phi-4", 16384, 9999, 16384, 4096],
    ]) {
      check(same(one(cls, c, o), { contextTokens: ec, maxOutputTokens: eo }), `${cls} {${c}, ${JSON.stringify(o)}} -> {${ec}, ${eo}}`);
    }
    const tricky = JSON.parse(
      '{"protocol":1,"models":{"__proto__":{"contextTokens":32768,"maxOutputTokens":4096},' +
        '"constructor":{"contextTokens":32768,"maxOutputTokens":4096},' +
        '"qwen25-32b":{"contextTokens":32768,"maxOutputTokens":4096},' +
        '"koinos-fast":{"contextTokens":16384,"maxOutputTokens":2048}}}'
    );
    const st = sanitizeWorkerContext(tricky, [...SM, "__proto__", "constructor", "toString"]);
    check(keysOf(st.models) === "koinos-fast,koinos-smart,phi-4", "only own, server-filtered classes appear");
    check(
      !Object.hasOwn(st.models, "__proto__") && !Object.hasOwn(st.models, "constructor") && Object.getPrototypeOf(st.models) === Object.prototype,
      "__proto__/constructor never become keys or a prototype"
    );
    check(st.models["qwen25-32b"] === undefined, "an entry for an unadvertised class is dropped");
    check(same(st.models["koinos-smart"], L) && same(st.models[FAST], { contextTokens: 16384, maxOutputTokens: 2048 }), "a class with no entry is legacy; a valid one is kept");

    const SR = await boot();
    const R = keyPair();
    const raw =
      `{"address":"${R.address}","models":["koinos-fast","constructor","__proto__","toString","hasOwnProperty","qwen25-32b"],` +
      `"capabilities":{"ramGb":8},"context":{"protocol":1,"models":{"__proto__":{"contextTokens":32768,"maxOutputTokens":4096},` +
      `"constructor":{"contextTokens":32768,"maxOutputTokens":4096},"qwen25-32b":{"contextTokens":32768,"maxOutputTokens":4096},` +
      `"koinos-fast":{"contextTokens":32768,"maxOutputTokens":4096}}}}`;
    const rr = await call(SR, "POST", "/worker/register", undefined, { raw });
    const row = rowOf(SR, R);
    check(rr.status === 200 && same(row?.models, [FAST]), "register: constructor/__proto__/toString never reach w.models (RAM still filters qwen25-32b)");
    check(
      keysOf(row?.context?.models) === FAST && same(row.context.models[FAST], { contextTokens: 32768, maxOutputTokens: 4096 }),
      "register: context is sanitized against the filtered list"
    );
    const ev = SR.events.filter((e) => e.type === "scheduler:worker-registered").at(-1);
    check(same(ev?.context, row?.context?.models), "the registration event carries the sanitized summary");
    await register(SR, { ...R, models: [FAST] });
    check(rowOf(SR, R).context === null, "a re-register without context is legacy (capacity is never carried over)");
  }

  /* ================================================================== */
  console.log("\n4) a tampered roster is re-sanitized on load");
  {
    const dir = tmp();
    const SA = await boot({ dataDir: dir });
    const RW = await addWorker(SA, { models: [FAST, "phi-4"], context: ctxOf({ [FAST]: [32768, 4096], "phi-4": [16384, 2048] }) });
    const RW2 = await addWorker(SA, { models: [FAST], context: ctxOf({ [FAST]: [16384, 2048] }) });
    await SA.s.close();
    const file = path.join(dir, "workers.json");
    const roster = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const w of Object.values(roster)) {
      if (w.address === RW.address) {
        w.models.push("constructor", "__proto__");
        w.context.models[FAST] = { contextTokens: 65536, maxOutputTokens: 99999 };
        w.context.models["phi-4"] = { contextTokens: 32768, maxOutputTokens: 4096 };
        w.context.models["qwen25-32b"] = { contextTokens: 32768, maxOutputTokens: 4096 };
      } else if (w.address === RW2.address) {
        w.context.protocol = "1";
      }
    }
    fs.writeFileSync(file, JSON.stringify(roster));
    const SB = new Scheduler({ dataDir: dir, storeMode: "json", operatorSecret: OP, priceSources: [] });
    const r1 = [...SB.workers.values()].find((w) => w.address === RW.address);
    const r2 = [...SB.workers.values()].find((w) => w.address === RW2.address);
    check(same(r1?.models, [FAST, "phi-4"]), "reload drops constructor/__proto__ from w.models");
    check(same(r1?.context, { protocol: 1, models: { [FAST]: L, "phi-4": L } }), "reload: no 65536 tier, phi-4 held to its 16384 window, no unadvertised class");
    check(r2?.context === null, "reload: a row claiming protocol '1' (string) is legacy");
    await SB.close();
  }

  /* ================================================================== */
  console.log("\n5) legacy wallet lane: legacy terms, honest refusals");
  const acctSvc = new AccountService({ stateDir: tmp(), sendMail: async () => {}, siteOrigin: "http://127.0.0.1", onEvent: () => {} });
  const S1 = await boot({ accounts: acctSvc }); // only default workers: legacy A1, protocol-1-without-opt-in D1
  const A1 = await addWorker(S1, { models: [FAST] });
  const D1 = await addWorker(S1, { models: [FAST], context: { protocol: 1, models: {} } });
  check(same(rowOf(S1, D1).context, { protocol: 1, models: { [FAST]: L } }), "a protocol-1 worker without opt-in advertises {4096, 512}");
  {
    const c1 = keyPair();
    for (const [label, extra, want] of [
      ["no max_tokens, no model (old clients)", {}, 512],
      ["max_tokens 64", { model: FAST, max_tokens: 64 }, 64],
      ["max_tokens 900 (existing Core callers)", { model: FAST, max_tokens: 900 }, 512],
      ["max_tokens 2000", { max_tokens: 2000 }, 512],
      ["max_tokens null (absent)", { max_tokens: null }, 512],
      ["maxTokens 64 (alias)", { maxTokens: 64 }, 64],
    ]) {
      const { job, resp } = await served(S1, await legacyReq(c1, user("hello"), extra), A1);
      check(
        resp.status === 200 && job?.maxTokens === want && job?.contextTokens === 4096 && !("termsVersion" in (job || {})),
        `${label} -> served, job {${job?.maxTokens}, ${job?.contextTokens}} (status ${resp.status})`
      );
    }
    for (const bad of [0, -1, 1.5, "64", true, {}]) {
      const before = ledger(S1, c1.address);
      const r = await consume(S1, await legacyReq(c1, user("hello"), { max_tokens: bad }));
      check(
        r.status === 400 && codeOf(r) === "invalid_max_tokens" && ledger(S1, c1.address) === before && !S1.s._consumerAddresses.has(c1.address),
        `max_tokens ${JSON.stringify(bad)} -> 400 invalid_max_tokens, nothing queued or charged, lock released`
      );
    }
    const next = await served(S1, await legacyReq(c1, user("hello again")), A1);
    check(next.resp.status === 200, `the next fresh request is served, not 409 (got ${next.resp.status} ${next.diag || ""})`);

    const before = ledger(S1, c1.address);
    const tl = await consume(S1, await legacyReq(c1, user("a".repeat(16369))));
    check(
      tl.status === 400 && codeOf(tl) === "context_length_exceeded" && /4096-token context/.test(msgOf(tl)) && /shorten it or start a new chat/.test(msgOf(tl)),
      `legacy estimate 4097 -> immediate actionable 400 (${msgOf(tl).slice(0, 90)}…)`
    );
    check(ledger(S1, c1.address) === before && !S1.s._consumerAddresses.has(c1.address), "…nothing charged or queued, lock released");
    const fit = await served(S1, await legacyReq(c1, user("a".repeat(16368))), A1);
    check(fit.resp.status === 200 && fit.job?.contextTokens === 4096, "a prompt of exactly 4096 legacy tokens is still dispatched");
  }

  /* ================================================================== */
  console.log("\n6) grant lane: legacy terms, prompt refused before the hold");
  {
    const acct = acctSvc._newAccount({ email: "context@example.com" });
    const session = acctSvc._issueSession(acct.id, "probe");
    const gw = keyPair("probe-context-grant-wallet");
    const lts = Date.now();
    acctSvc.linkWallet(acct, { address: gw.address, ts: lts, signature: await signB64(gw.signer, sha(`link|${gw.address}|${acct.id}|${lts}`)) });
    const exp = Date.now() + 3600000;
    const gts = Date.now() + 1;
    const grant = acctSvc.grantSpend(acct, {
      address: gw.address, maxMicro: 1000000, expiresAt: exp, ts: gts,
      signature: await signB64(gw.signer, sha(`spend|${gw.address}|${acct.id}|1000000|${exp}|${gts}`)),
    });
    const remaining = () => acctSvc.spendableGrant(acct.id, grant.id).remainingMicro;
    const gReq = (extra) => ({ messages: user("hello"), sessionToken: session, grantId: grant.id, model: FAST, ...extra });
    const r0 = remaining();

    let r = await consume(S1, gReq({ messages: user("a".repeat(16369)), max_tokens: 64 }));
    check(r.status === 400 && codeOf(r) === "context_length_exceeded" && remaining() === r0, "an oversize web-app history -> 400 context_length_exceeded, nothing held or spent");
    r = await consume(S1, gReq({ messages: user("a".repeat(16369)) }));
    check(r.status === 400 && /max_tokens is required/.test(msgOf(r)) && codeOf(r) === undefined, "the existing max_tokens 400 still comes first, unchanged");
    r = await consume(S1, gReq({ max_tokens: 999999 }));
    check(r.status === 400 && /above 4096/.test(msgOf(r)) && codeOf(r) === undefined, "the existing ceiling 400 is unchanged");
    r = await consume(S1, gReq({ messages: user("a".repeat(16369)), max_tokens: 64, signatureVersion: 2 }));
    check(r.status === 400 && codeOf(r) === "context_length_exceeded", "the grant lane ignores signatureVersion");

    const small = await served(S1, gReq({ max_tokens: 32 }), A1);
    check(
      small.resp.status === 200 && small.job?.maxTokens === 32 && small.job?.contextTokens === 4096,
      `grant max_tokens 32 -> job {32, 4096} (status ${small.resp.status}${small.resp.status === 200 ? "" : ` ${msgOf(small.resp).slice(0, 120)} ${small.diag || ""}`})`
    );

    const ctl = new AbortController();
    const p = consume(S1, gReq({ max_tokens: 4000 }), { signal: ctl.signal });
    const job = await poll(S1, A1, 3000);
    const held = remaining();
    if (job) await submit(S1, A1, job); else ctl.abort();
    const res = await p;
    check(
      job?.maxTokens === 512 && job?.contextTokens === 4096 && !("termsVersion" in (job || {})),
      `grant max_tokens 4000 (web app) -> job {512, 4096} (status ${res.status}${res.status === 200 ? "" : ` ${msgOf(res).slice(0, 120)}`})`
    );
    check(held < r0, `the existing worst-case hold is taken while it runs (held ${r0 - held} µ$)`);
    check(res.status === 200 && remaining() === r0 - Math.round(Number(res.body.costUsd) * 1e6), "…and settles to the actual cost afterwards");
  }

  /* ================================================================== */
  console.log("\n7) mixed capacities: A legacy, B {16384, 2048}, C {32768, 4096}, D protocol 1 default");
  const A = await addWorker(S2, { models: [FAST], name: "A" });
  const B = await addWorker(S2, { models: [FAST], context: ctxOf({ [FAST]: [16384, 2048] }), name: "B" });
  const C = await addWorker(S2, { models: [FAST], context: ctxOf({ [FAST]: [32768, 4096] }), name: "C" });
  const D = await addWorker(S2, { models: [FAST], context: { protocol: 1, models: {} }, name: "D" });
  const c2 = keyPair();
  let legacyJob = null;
  let v1Job = null;
  {
    const who = (terms) => [A, B, C, D].filter((w) => S2.s._canServe(rowOf(S2, w), { model: FAST, ...terms })).map((w) => w.name).join("");
    for (const [terms, want] of [
      [{ maxTokens: 512, contextTokens: 4096 }, "ABCD"],
      [{ maxTokens: 512, contextTokens: 4096, termsVersion: 1 }, "BCD"],
      [{ maxTokens: 1024, contextTokens: 16384, termsVersion: 1 }, "BC"],
      [{ maxTokens: 512, contextTokens: 32768, termsVersion: 1 }, "C"],
      [{ maxTokens: 3000, contextTokens: 4096, termsVersion: 1 }, "C"],
      [{ maxTokens: 64, contextTokens: 4096 }, "ABCD"],
      [{}, "ABCD"],
    ]) {
      check(who(terms) === want, `_canServe ${JSON.stringify(terms)} -> ${want} (got ${who(terms)})`);
    }

    const lg = await served(S2, await legacyReq(c2, user("hi")), A);
    legacyJob = lg.job;
    check(lg.resp.status === 200 && !!lg.job, "a legacy request reaches the legacy worker A");

    const ctl = new AbortController();
    const p = consume(S2, await v1Req(c2, { max_tokens: 1024, messages: ofEst(4000) }), { signal: ctl.signal });
    const end = Date.now() + 2000;
    while (!S2.s.queue.some((j) => j.termsVersion === 1) && Date.now() < end) await sleep(5);
    check(!(await poll(S2, A, 400)) && !(await poll(S2, D, 400)), "the v1 {1024, 16384} job is never offered to A (legacy) or D (default capacity)");
    v1Job = await poll(S2, B, 2000);
    check(v1Job?.maxTokens === 1024 && v1Job?.contextTokens === 16384, "…and B takes it with its terms visible");
    if (v1Job) await submit(S2, B, v1Job); else ctl.abort();
    const vr = await p;
    check(vr.status === 200 && same(vr.body.terms, { maxTokens: 1024, contextTokens: 16384 }), "the v1 response reports the terms it ran under");

    const saved = {};
    for (const w of [A, B, C, D]) saved[w.address] = S2.s.perf[w.address];
    S2.s.perf[A.address] = { jobs: 1, srvTokPerSec: 100, sr: 1 };
    S2.s.perf[B.address] = { jobs: 1, srvTokPerSec: 10, sr: 1 };
    S2.s.perf[C.address] = { jobs: 1, srvTokPerSec: 50, sr: 1 };
    S2.s.perf[D.address] = { jobs: 1, srvTokPerSec: 5, sr: 1 };
    check(S2.s._preferredFor(FAST) === A.address, "_preferredFor(class string) still ranks every holder (legacy callers)");
    check(
      S2.s._preferredFor({ model: FAST, termsVersion: 1, contextTokens: 16384, maxTokens: 1024, forWorker: "1Nobody", preferWorker: "1Nobody", preferUntil: Date.now() + 1e6 }) === C.address,
      "_preferredFor(job) ranks only workers with the capacity, ignoring the job's own stamps"
    );
    check(S2.s._preferredFor({ model: FAST, termsVersion: 1, contextTokens: 32768, maxTokens: 512 }) === null, "one capable candidate -> no preference");
    for (const w of [A, B, C, D]) {
      if (saved[w.address]) S2.s.perf[w.address] = saved[w.address];
      else delete S2.s.perf[w.address];
    }
  }

  /* ================================================================== */
  console.log("\n8) signed terms: tampering and replay");
  {
    const c3 = keyPair();
    const base = { max_tokens: 1024, messages: user("tamper target") };
    for (const [label, mutate] of [
      ["model", (b) => { b.model = "auto"; }],
      ["max_tokens", (b) => { b.max_tokens = 2048; }],
      ["messages", (b) => { b.messages = user("tamper target!"); }],
      ["ts", (b) => { b.ts += 1; }],
      ["address", (b) => { b.address = keyPair().address; }],
    ]) {
      const b = await v1Req(c3, base);
      mutate(b);
      const r = await consume(S2, b);
      check(r.status === 401, `${label} changed after signing -> 401 (got ${r.status})`);
    }
    for (const sv of [2, "1", 0, true]) {
      const b = await v1Req(c3, base);
      b.signatureVersion = sv;
      const r = await consume(S2, b);
      check(r.status === 400 && codeOf(r) === "unsupported_signature_version", `signatureVersion ${JSON.stringify(sv)} -> 400 unsupported_signature_version`);
    }
    {
      const b = await v1Req(c3, base);
      delete b.signatureVersion;
      const r = await consume(S2, b);
      check(r.status === 401, "a v1 signature sent without signatureVersion -> 401");
      const lb = await legacyReq(c3, base.messages, { model: FAST, max_tokens: 1024, signatureVersion: 1 });
      const r2 = await consume(S2, lb);
      check(r2.status === 401, "a legacy signature sent as signatureVersion 1 -> 401");
    }
    const first = await v1Req(c3, { max_tokens: 256, messages: user("replay me") });
    const f1 = await served(S2, first, C);
    check(f1.resp.status === 200, "the original v1 request is served");
    const rp = await consume(S2, first);
    check(rp.status === 401 && /already been used/.test(msgOf(rp)), "exact replay -> 401");
    const ws = await consume(S2, { ...first, signature: first.signature + " \n" });
    check(ws.status === 401 && /already been used/.test(msgOf(ws)), "whitespace-appended v1 signature -> 401 (m: key)");
    const lfirst = await legacyReq(c3, user("legacy replay"));
    const lf = await served(S2, lfirst, A);
    const lws = await consume(S2, { ...lfirst, signature: lfirst.signature + " \n" });
    check(lf.resp.status === 200 && lws.status === 401 && /already been used/.test(msgOf(lws)), "whitespace-appended LEGACY signature -> 401 (previously a billable replay)");
    const rts = freshTs();
    const regSig = await signB64(c3.signer, sha(`register|${c3.address}|${rts}`));
    const reg = await call(S2, "POST", "/worker/register", { address: c3.address, ts: rts, signature: regSig, models: [] });
    const rl = await consume(S2, { address: c3.address, ts: rts, messages: user("x"), signature: regSig });
    const rv = await consume(S2, { address: c3.address, ts: rts, model: FAST, max_tokens: 64, messages: user("x"), signatureVersion: 1, signature: regSig });
    check(reg.status === 200 && rl.status === 401 && rv.status === 401, "a registration proof is not a consume signature on either lane");
    check(S2.s._consumerAddresses.size === 0, "no refusal above left a wallet locked");
  }

  /* ================================================================== */
  console.log("\n9) v1 shape and limit refusals (before anything is charged)");
  {
    const c4 = keyPair();
    const v1bad = async (label, over, code, after) => {
      const b = await v1Req(c4, { max_tokens: 64, messages: user("hi"), ...over });
      if (after) after(b);
      const before = ledger(S1, c4.address);
      const r = await consume(S1, b);
      check(
        r.status === 400 && codeOf(r) === code && ledger(S1, c4.address) === before && !S1.s._consumerAddresses.has(c4.address),
        `${label} -> 400 ${code} (got ${r.status} ${codeOf(r)}), nothing charged, lock free`
      );
    };
    for (const mt of [0, 4097, 1.5, "100", -1, null]) await v1bad(`max_tokens ${JSON.stringify(mt)}`, { max_tokens: mt }, "invalid_max_tokens");
    await v1bad("max_tokens missing", {}, "invalid_max_tokens", (b) => { delete b.max_tokens; });
    await v1bad("maxTokens alias only", {}, "invalid_max_tokens", (b) => { b.maxTokens = b.max_tokens; delete b.max_tokens; });
    await v1bad("ts as a string", {}, "invalid_terms", (b) => { b.ts = String(b.ts); });
    await v1bad("unknown model", { model: "gpt-4o" }, "invalid_terms");
    await v1bad("model 'constructor'", { model: "constructor" }, "invalid_terms");
    await v1bad("model missing", {}, "invalid_terms", (b) => { delete b.model; });
    await v1bad("tool turns", {
      messages: [
        { role: "user", content: "what is 6*7?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "calc", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "42" },
      ],
    }, "invalid_terms");
    await v1bad("an extra message key", { messages: [{ role: "user", content: "x", name: "bob" }] }, "invalid_terms");
    await v1bad("role 'tool'", { messages: [{ role: "tool", content: "x" }] }, "invalid_terms");
    await v1bad("an audio part", { messages: user([{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }]) }, "invalid_terms");
    await v1bad("an extra key on a text part", { messages: user([{ type: "text", text: "x", cache_control: { type: "ephemeral" } }]) }, "invalid_terms");
    await v1bad("an image_url part (v1 is text-only)", {
      messages: user([{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]),
    }, "invalid_terms");
    await v1bad("an extra key on image_url", { messages: user([{ type: "image_url", image_url: { url: "data:,", detail: "high" } }]) }, "invalid_terms");
    await v1bad("a nested tool field on a text part", {
      messages: user([{ type: "text", text: "x", tool_calls: [{ id: "c1", type: "function", function: { name: "calc", arguments: "{}" } }] }]),
    }, "invalid_terms");
    await v1bad("a tool_result part", { messages: user([{ type: "tool_result", tool_use_id: "c1", content: "42" }]) }, "invalid_terms");
    await v1bad("a text part whose text is not a string", { messages: user([{ type: "text", text: 42 }]) }, "invalid_terms");
    await v1bad("a part missing text", { messages: user([{ type: "text" }]) }, "invalid_terms");
    await v1bad("a bare-string part (not a plain object)", { messages: user(["x"]) }, "invalid_terms");
    await v1bad("a null part", { messages: user([null]) }, "invalid_terms");
    await v1bad("a message that is an array", { messages: [["user", "x"]] }, "invalid_terms");
    await v1bad("content missing", { messages: [{ role: "user" }] }, "invalid_terms");
    await v1bad("required 32769 (auto)", { model: "auto", max_tokens: 4096, messages: ofEst(28673) }, "context_length_exceeded");
    await v1bad("required 32769", { max_tokens: 4096, messages: ofEst(28673) }, "context_length_exceeded");
    await v1bad("phi-4 required 16385", { model: "phi-4", max_tokens: 1, messages: ofEst(16384) }, "context_length_exceeded");
    const p16 = await consume(S1, await v1Req(c4, { model: "phi-4", max_tokens: 1, messages: ofEst(16383) }));
    check(p16.status === 503 && codeOf(p16) === "insufficient_capacity", "phi-4 required 16384 fits its window (503 only because nobody serves phi-4 here)");

    // Accepted shapes and the tier each lands in (served by C).
    const tp = [{ role: "system", content: "Describe." }, { role: "user", content: [{ type: "text", text: "look" }, { type: "text", text: " closely" }] }];
    const txt = await served(S2, await v1Req(c2, { max_tokens: 64, messages: tp }), C);
    check(
      txt.resp.status === 200 && txt.job?.contextTokens === 4096 && same(txt.job?.messages, tp),
      "plain {type: \"text\", text} parts are a valid v1 shape, delivered as sent"
    );
    // The legacy lane keeps its multimodal path exactly as before.
    const mm = [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }];
    const lmm = await served(S2, await legacyReq(c2, mm), A);
    check(lmm.resp.status === 200 && lmm.job?.contextTokens === 4096 && same(lmm.job?.messages, mm), "the legacy lane still carries text + image_url parts unchanged");
    for (const [label, est, mt, tier] of [
      ["est 6000 + 2048 = 8048", 6000, 2048, 16384],
      ["est 4096 + 1 = 4097", 4096, 1, 16384],
      ["required 32768", 28672, 4096, 32768],
      ["est 10 + 1024", 10, 1024, 4096],
    ]) {
      const r = await served(S2, await v1Req(c2, { max_tokens: mt, messages: ofEst(est) }), C);
      check(r.resp.status === 200 && r.job?.contextTokens === tier && r.job?.maxTokens === mt, `${label} -> job {${mt}, ${tier}} (got {${r.job?.maxTokens}, ${r.job?.contextTokens}})`);
    }
  }

  /* ================================================================== */
  console.log("\n10) insufficient capacity: 503 before any charge; auto is capacity-aware");
  {
    const c5 = keyPair();
    let before = ledger(S1, c5.address);
    let r = await consume(S1, await v1Req(c5, { max_tokens: 1024, messages: user("write a long answer") }));
    check(
      r.status === 503 && codeOf(r) === "insufficient_capacity" && /Nothing was charged/.test(msgOf(r)) && ledger(S1, c5.address) === before,
      "extended v1 with only default workers -> 503 insufficient_capacity, nothing charged or queued (never downgraded)"
    );
    r = await consume(S1, await v1Req(c5, { model: "auto", max_tokens: 1024, messages: user("write a long answer") }));
    check(r.status === 503 && codeOf(r) === "insufficient_capacity" && ledger(S1, c5.address) === before, "…same for auto");
    check(!S1.s._consumerAddresses.has(c5.address), "…and the wallet lock is released");
    r = await consume(S1, await legacyReq(c5, user("hi"), { model: "qwen25-32b" }));
    check(
      r.status === 503 && codeOf(r) === undefined &&
        msgOf(r) === 'No providers are serving "qwen25-32b" right now — try again shortly, or press Start Earning in the app to serve the network yourself.',
      "the legacy 503 is unchanged (message, no code)"
    );

    const S3 = await boot();
    const E = await addWorker(S3, { models: [FAST, "qwen25-32b"], context: ctxOf({ [FAST]: [16384, 2048] }) }); // qwen25-32b stays {4096, 512}
    const F = await addWorker(S3, { models: ["gemma3-27b"], context: ctxOf({ "gemma3-27b": [32768, 4096] }) });
    S3.s.perf[F.address] = { jobs: 0, tokPerSec: 0, cuRating: 0, ok: 0, to: 4, bad: 0, sr: 0.1 }; // probation
    const c6 = keyPair();
    const pick = async (over) => (await queuedBy(S3, await v1Req(c6, { model: "auto", messages: user("hello"), ...over }))).job?.model;
    check((await pick({ max_tokens: 256 })) === "qwen25-32b", "auto, small terms -> the priciest class a healthy worker can hold (qwen25-32b)");
    check((await pick({ max_tokens: 1024 })) === FAST, "auto, 1024 output -> koinos-fast: qwen25-32b is capped at 512 and gemma3-27b's worker is on probation");
    check((await pick({ max_tokens: 4096 })) === "gemma3-27b", "auto, 4096 output -> no healthy worker can, so any live capable one (gemma3-27b)");
    check((await pick({ max_tokens: 512, messages: ofEst(20000) })) === "gemma3-27b", "auto, 32768 window -> only gemma3-27b's worker holds it");
    before = ledger(S3, c6.address);
    r = await consume(S3, await v1Req(c6, { model: FAST, max_tokens: 4096, messages: user("hello") }));
    check(r.status === 503 && codeOf(r) === "insufficient_capacity" && ledger(S3, c6.address) === before, "named class whose holders lack the capacity -> 503 insufficient_capacity");
    r = await consume(S3, await v1Req(c6, { model: "qwen25-32b", max_tokens: 1024, messages: user("hello") }));
    check(r.status === 503 && codeOf(r) === "insufficient_capacity", "…qwen25-32b at 1024 output too");
    check(S3.s.queue.length === 0 && S3.s.pending.size === 0 && E && F, "nothing was left queued");
  }

  /* ================================================================== */
  console.log("\n11) worst case: v1 terms must be affordable before dispatch");
  const S4 = await boot({ freeTokensPerDay: 0 });
  const W4 = await addWorker(S4, { models: [FAST, "qwen25-32b"], context: ctxOf({ [FAST]: [32768, 4096], "qwen25-32b": [32768, 4096] }) });
  {
    check(
      uncoveredOf(6000, 2048, FAST, 0) === 1420 && uncoveredOf(6000, 2048, FAST, 4024) === 710 && uncoveredOf(6000, 2048, FAST, 8048) === 0 &&
        uncoveredOf(20000, 4096, "qwen25-32b", 0) === 36384 && uncoveredOf(20000, 4096, "qwen25-32b", 1000) === 34875 &&
        uncoveredOf(12000, 512, "phi-4", 0) === 7024,
      "contract worst-case vectors hold for these class rates"
    );
    const msgs = ofEst(6000);
    // promptBound = what /worker/result could bill: byte cap or window, whichever is smaller.
    const pb = Math.min(24 + Buffer.byteLength(JSON.stringify(msgs), "utf8"), 16384);
    const need = uncoveredOf(pb, 2048, FAST, 0);
    const c7 = keyPair();
    S4.s.balances[c7.address] = { balanceMicro: String(need - 1), depositHwmSat: "0" };
    let before = ledger(S4, c7.address);
    let r = await consume(S4, await v1Req(c7, { max_tokens: 2048, messages: msgs }));
    check(
      r.status === 402 && codeOf(r) === "worst_case_unaffordable" && r.body.error.type === "insufficient_quota" && ledger(S4, c7.address) === before,
      `balance ${need - 1} µ$ below the ${need} µ$ worst case (prompt bound ${pb}) -> 402 worst_case_unaffordable, nothing charged`
    );
    check(!S4.s._consumerAddresses.has(c7.address), "…lock released");
    S4.s.balances[c7.address].balanceMicro = String(need);
    let ok = await served(S4, await v1Req(c7, { max_tokens: 2048, messages: msgs }), W4, { prompt: 100, completion: 50 });
    check(ok.resp.status === 200, `a balance of exactly ${need} µ$ is enough -> dispatched`);

    // Earnings convert at the epoch's PINNED price.
    const spm = S4.s.price.satPerMicro;
    const c8 = keyPair();
    S4.s.spentSat[c8.address] = (-(BigInt(need) * spm - 1n)).toString(); // earnings worth need-1 µ$
    r = await consume(S4, await v1Req(c8, { max_tokens: 2048, messages: msgs }));
    check(r.status === 402 && codeOf(r) === "worst_case_unaffordable", "spendable earnings one sat short of the worst case at the pinned price -> 402");
    S4.s.spentSat[c8.address] = (-(BigInt(need) * spm)).toString();
    ok = await served(S4, await v1Req(c8, { max_tokens: 2048, messages: msgs }), W4);
    check(ok.resp.status === 200, "…exactly enough -> dispatched");

    // Free tokens cover their share of the worst case first.
    const worstTok = pb + 2048;
    S4.s.freeTokensPerDay = worstTok / 2;
    const half = uncoveredOf(pb, 2048, FAST, worstTok / 2);
    const c9 = keyPair();
    S4.s.balances[c9.address] = { balanceMicro: String(half - 1), depositHwmSat: "0" };
    r = await consume(S4, await v1Req(c9, { max_tokens: 2048, messages: msgs }));
    check(r.status === 402 && codeOf(r) === "worst_case_unaffordable", `half the worst case free, balance ${half - 1} < ${half} -> 402`);
    S4.s.balances[c9.address].balanceMicro = String(half);
    ok = await served(S4, await v1Req(c9, { max_tokens: 2048, messages: msgs }), W4);
    check(ok.resp.status === 200, "…and the remainder covered -> dispatched");
    S4.s.freeTokensPerDay = worstTok;
    const c10 = keyPair();
    ok = await served(S4, await v1Req(c10, { max_tokens: 2048, messages: msgs }), W4);
    check(ok.resp.status === 200, "free tokens covering the whole worst case -> dispatched with no balance at all");
    S4.s.freeTokensPerDay = 0;

    const c11 = keyPair();
    const zero = "Insufficient balance: network usage is billed per AI token after the free allowance. " +
      "Add funds with KAI in the Earn tab, or Start Earning to cover usage with work.";
    r = await consume(S4, await v1Req(c11, { max_tokens: 64, messages: user("hi") }));
    const rl = await consume(S4, await legacyReq(c11, user("hi")));
    check(
      r.status === 402 && msgOf(r) === zero && codeOf(r) === undefined && rl.status === 402 && msgOf(rl) === zero,
      "nothing to spend at all -> the existing zero-gate 402, message unchanged on both lanes"
    );
  }

  /* ================================================================== */
  console.log("\n12) v1 refuses selfHost (it is not signed); own-machine requests keep the legacy lanes");
  {
    const me = keyPair();
    // Capable on purpose: every refusal below is about the unsigned switch,
    // never about capacity.
    const own = await addWorker(S4, { models: [FAST], context: ctxOf({ [FAST]: [32768, 4096] }), signer: me.signer });
    S4.s.balances[me.address] = { balanceMicro: "1000000", depositHwmSat: "0" };
    for (const v of [true, 1, "true", null, 0, {}]) {
      const before = ledger(S4, me.address);
      const r = await consume(S4, await v1Req(me, { max_tokens: 1024, messages: user("mine") }, { selfHost: v }));
      check(
        r.status === 400 && codeOf(r) === "invalid_terms" && /selfHost/.test(msgOf(r)) && ledger(S4, me.address) === before && !S4.s._consumerAddresses.has(me.address),
        `v1 selfHost ${JSON.stringify(v)} -> 400 invalid_terms (got ${r.status} ${codeOf(r)}), nothing charged or queued`
      );
    }
    const forged = await v1Req(me, { max_tokens: 64, messages: user("mine") }, { selfHost: true });
    forged.signature = Buffer.alloc(65).toString("base64");
    const rf = await consume(S4, forged);
    check(rf.status === 400 && codeOf(rf) === "invalid_terms", `…refused before the signature is checked (a bad signature still gets the 400, got ${rf.status})`);
    S4.s._consumerAddresses.add(me.address); // as if another request held the wallet
    const rh = await consume(S4, await v1Req(me, { max_tokens: 64, messages: user("mine") }, { selfHost: true }));
    S4.s._consumerAddresses.delete(me.address);
    check(rh.status === 400 && codeOf(rh) === "invalid_terms", `…and before the wallet lock is ever taken (a held lock still gets the 400, not 409; got ${rh.status})`);

    // A captured, validly signed v1 request with selfHost flipped on.
    const captured = await v1Req(me, { max_tokens: 1024, messages: user("captured") });
    const before = ledger(S4, me.address);
    const flipped = await consume(S4, { ...captured, selfHost: true });
    check(
      flipped.status === 400 && codeOf(flipped) === "invalid_terms" && ledger(S4, me.address) === before,
      "selfHost added to a captured, validly signed v1 request -> 400, nothing charged"
    );
    const receipts0 = S4.s.receipts.length;
    const orig = await served(S4, captured, W4);
    check(
      orig.resp.status === 200 && orig.resp.body.costUsd > 0 && !/own machine/.test(String(orig.resp.body.paidWith)) &&
        !orig.job?.selfServed && S4.s.receipts.length === receipts0 + 1,
      "…the request as signed still verifies only as the ordinary billed request it was (the 400 burnt nothing)"
    );
    const sf = await served(S4, await v1Req(me, { max_tokens: 1024, messages: user("explicitly not mine") }, { selfHost: false }), W4);
    check(sf.resp.status === 200 && sf.resp.body.costUsd > 0 && !sf.job?.selfServed, "v1 with selfHost false -> an ordinary billed request");

    // Own-machine work keeps the legacy wallet lane, exactly as today.
    const receipts = S4.s.receipts.length;
    const clamps = S4.s.perf[me.address]?.clamps || 0;
    const bal = S4.s.balances[me.address].balanceMicro;
    const ss = await served(S4, await legacyReq(me, user("mine"), { selfHost: true, model: FAST, max_tokens: 64 }), own, { completion: 80, prompt: 20 });
    check(ss.resp.status === 200 && ss.resp.body.costUsd === 0 && /own machine/.test(String(ss.resp.body.paidWith)), "legacy wallet selfHost -> served on my own machine at zero cost, as today");
    check(ss.job?.maxTokens === 64 && ss.job?.contextTokens === 4096 && ss.job?.selfServed === true, "…on legacy terms");
    check(
      S4.s.receipts.length === receipts && (S4.s.perf[me.address]?.clamps || 0) === clamps && S4.s.balances[me.address].balanceMicro === bal,
      "…no receipt, no strike, balance untouched"
    );
    check(keysOf(ss.job) === `${VISIBLE.replace("prompt,", "prompt,selfServed,")}`, "self-served job: the consumer keys plus selfServed");
  }

  /* ================================================================== */
  console.log("\n13) visible keys; mystery chats audit the terms a worker sells");
  check(keysOf(legacyJob) === VISIBLE, `legacy consumer job keys: ${keysOf(legacyJob)}`);
  check(keysOf(v1Job) === VISIBLE, "v1 consumer job: the same keys (termsVersion stays server-side)");
  const S5 = await boot();
  const MA = await addWorker(S5, { models: [FAST] });
  const MB = await addWorker(S5, { models: [FAST], context: ctxOf({ [FAST]: [16384, 2048] }) });
  const MC = await addWorker(S5, { models: [FAST], context: ctxOf({ [FAST]: [32768, 4096] }) });
  const onlyTarget = (w) => { for (const x of S5.s.workers.values()) x.mystThisEpoch = x.address === w.address ? 0 : 99; };
  /** Seed one mystery for `w` with Math.random stubbed: `draws` are served
   *  in order, then 0. seedMysteryOnce draws [target, class], and a
   *  v1-capable target then [v1 share, max-capacity, ring pick, ...]: the
   *  default takes the v1-like branch and then the ring. */
  const seeded = (w, draws = [0, 0, 0, 0.99]) => {
    onlyTarget(w);
    const orig = Math.random;
    const queue = [...draws];
    Math.random = () => (queue.length ? queue.shift() : 0);
    try { return seedMysteryOnce(S5.s); } finally { Math.random = orig; }
  };
  const drain = async (w, job) => {
    const got = await poll(S5, w, 2000);
    if (got) await submit(S5, w, got, { output: String(job.challenge.expected) });
    return got;
  };
  {
    const ma = seeded(MA);
    check(ma?.maxTokens === 512 && ma?.contextTokens === 4096 && !("termsVersion" in ma), "a legacy target's mystery carries {512, 4096}");
    const maJob = await drain(MA, ma);
    check(keysOf(maJob) === VISIBLE, "mystery key set equals a consumer chat's");

    S5.s._v1TermsSeen.splice(0, Infinity, { maxTokens: 2048, contextTokens: 32768 });
    const mc = seeded(MC);
    const est = estimateTokensV1(mc?.messages);
    check(mc?.termsVersion === 1 && mc.maxTokens === 2048 && mc.contextTokens === 32768, "a 32K target draws real v1 consumer terms {2048, 32768}");
    check(est + 2048 > 16384 && est + 2048 <= 32768, `the filler lands the request inside (16384, 32768] (required ${est + 2048})`);
    const content = String(mc?.messages?.[0]?.content || "");
    check(
      /^Reference code: 1000\./.test(content) && mc.challenge.expected === "1000" && /very start/.test(content.slice(-160)) && !/\d/.test(content.slice(30, -160)),
      "the answer-bearing fact is at the START; the filler carries no digits"
    );
    check(mc.challengeTier === 0 && mc.forWorker === MC.address, "still a shadow tier-0 audit stamped for its target");
    check(S5.s._canServe(rowOf(S5, MC), mc) && !S5.s._canServe(rowOf(S5, MB), { ...mc, forWorker: undefined }), "within the target's capacity, beyond a 16K worker's");
    const mcJob = await drain(MC, mc);
    check(keysOf(mcJob) === VISIBLE && mcJob.contextTokens === 32768, "a v1-like mystery is indistinguishable by its keys");

    const mb = seeded(MB);
    check(
      mb?.termsVersion === 1 && mb.maxTokens === 1024 && mb.contextTokens === 4096 && S5.s._canServe(rowOf(S5, MB), mb),
      "ring terms beyond a {16384, 2048} target are skipped; fallback output 1024 inside its capacity"
    );
    await drain(MB, mb);
    S5.s._v1TermsSeen.push({ maxTokens: 512, contextTokens: 16384 });
    const mb2 = seeded(MB);
    const est2 = estimateTokensV1(mb2?.messages);
    check(
      mb2?.termsVersion === 1 && mb2.contextTokens === 16384 && est2 + mb2.maxTokens > 4096 && est2 + mb2.maxTokens <= 16384,
      `a fitting 16K ring entry -> filler inside (4096, 16384] (required ${est2 + (mb2?.maxTokens || 0)})`
    );
    await drain(MB, mb2);

    process.env.KAI_MYSTERY_V1_SHARE = "0";
    const off = seeded(MC);
    process.env.KAI_MYSTERY_V1_SHARE = "not-a-number";
    const nan = seeded(MC);
    delete process.env.KAI_MYSTERY_V1_SHARE;
    check(off?.maxTokens === 512 && !("termsVersion" in off), "KAI_MYSTERY_V1_SHARE=0 disables v1-like mysteries");
    check(nan?.termsVersion === 1, "a malformed KAI_MYSTERY_V1_SHARE falls back to the default share");
    await drain(MC, off);
    await drain(MC, nan);

    // §9: a quarter of v1-like mysteries audit the target's own advertised
    // maximum, however the ring has been filled (consumers feed it).
    S5.s._v1TermsSeen.splice(0, Infinity, ...Array.from({ length: 64 }, (_, i) => ({ address: `poison-${i % 16}`, maxTokens: 1, contextTokens: 4096 })));
    const mx = seeded(MC, [0, 0, 0, 0]);
    const estMx = estimateTokensV1(mx?.messages);
    check(
      mx?.termsVersion === 1 && mx.maxTokens === 4096 && mx.contextTokens === 32768 && estMx + 4096 > 16384 && estMx + 4096 <= 32768 &&
        S5.s._canServe(rowOf(S5, MC), mx),
      `stubbed max-capacity draw: a ring full of {1, 4096} still yields MC's own maximum {4096, 32768} with filler (required ${estMx + 4096})`
    );
    await drain(MC, mx);
    const mxb = seeded(MB, [0, 0, 0, 0.2499]);
    const estMxb = estimateTokensV1(mxb?.messages);
    check(
      mxb?.termsVersion === 1 && mxb.maxTokens === 2048 && mxb.contextTokens === 16384 && estMxb + 2048 > 4096 && estMxb + 2048 <= 16384,
      "…and MB's {2048, 16384} just below the 0.25 share"
    );
    await drain(MB, mxb);
    const fromRing = seeded(MC, [0, 0, 0, 0.25]);
    check(fromRing?.termsVersion === 1 && fromRing.maxTokens === 1 && fromRing.contextTokens === 4096, "at 0.25 and above the draw comes from the ring");
    await drain(MC, fromRing);

    // Billed v1 consumer terms are what the ring remembers, bounded at 64.
    const seen = S2.s._v1TermsSeen;
    check(
      seen.length > 0 && seen.every((t) => typeof t.address === "string" && Number.isSafeInteger(t.maxTokens) && CONTEXT_TIERS.includes(t.contextTokens)),
      "billed v1 consumer requests are recorded for mystery sampling, with their consumer address"
    );
    seen.splice(0, Infinity, ...Array.from({ length: 64 }, (_, i) => ({ address: `other-${i}`, maxTokens: 1, contextTokens: 4096 })));
    const rb = await served(S2, await v1Req(c2, { max_tokens: 777, messages: user("ring") }), C);
    check(
      rb.resp.status === 200 && seen.length === 64 && same(seen.at(-1), { address: c2.address, maxTokens: 777, contextTokens: 4096 }) && seen[0].address === "other-1",
      "…in a ring of the last 64"
    );
  }

  /* ================================================================== */
  console.log("\n14) billing never exceeds the agreed terms");
  {
    const c12 = keyPair();
    let clamps = S2.s.perf[C.address]?.clamps || 0;
    let mark = S2.events.length;
    const r1 = await served(S2, await v1Req(c12, { max_tokens: 1024, messages: user("long answer please") }), C, {
      output: "x".repeat(4000), completion: 3000, prompt: 10,
    });
    check(r1.resp.status === 200 && r1.resp.body.usage?.completion_tokens === 1024 && S2.s.receipts.at(-1).usage.completion_tokens === 1024,
      "a v1 completion reported past max_tokens is billed at max_tokens");
    check((S2.s.perf[C.address]?.clamps || 0) === clamps + 1, "…and counts as a clamp");
    check(S2.events.slice(mark).some((e) => e.type === "scheduler:usage-clamped" && e.clamped?.completion_tokens === 1024), "…with a usage-clamped event");

    clamps = S2.s.perf[C.address]?.clamps || 0;
    mark = S2.events.length;
    const r2 = await served(S2, await v1Req(c12, { max_tokens: 512, messages: user("a".repeat(4100)) }), C, { prompt: 4150, completion: 5 });
    check(r2.job?.contextTokens === 4096 && r2.resp.body.usage?.prompt_tokens === 4096 && S2.s.receipts.at(-1).usage.prompt_tokens === 4096,
      "a v1 prompt reported past its window is billed at contextTokens");
    check((S2.s.perf[C.address]?.clamps || 0) === clamps && !S2.events.slice(mark).some((e) => e.type === "scheduler:usage-clamped"),
      "…billing-only: no clamp counted, no event");

    clamps = S2.s.perf[C.address]?.clamps || 0;
    mark = S2.events.length;
    const r3 = await served(S2, await legacyReq(c12, user("a".repeat(14000))), C, { prompt: 12000, completion: 5 });
    const rc = S2.s.receipts.at(-1);
    check(r3.job?.contextTokens === 4096 && r3.resp.body.usage?.prompt_tokens === 4096 && rc.usage.prompt_tokens === 4096 && rc.honest === true,
      "a legacy job an opted-in {32768, 4096} worker reports at 12000 prompt tokens is billed 4096");
    check((S2.s.perf[C.address]?.clamps || 0) === clamps && !S2.events.slice(mark).some((e) => e.type === "scheduler:usage-clamped"),
      "…with no strike and an unchanged clamp counter");
  }

  /* ================================================================== */
  console.log("\n15) requeue keeps terms; stale v1 mysteries are collected");
  {
    const c13 = keyPair();
    const ctl = new AbortController();
    const p = consume(S2, await v1Req(c13, { max_tokens: 1024, messages: ofEst(5000) }), { signal: ctl.signal });
    const first = await poll(S2, C, 2000);
    const toBefore = S2.s.perf[C.address]?.to || 0;
    const lease = first && S2.s.pending.get(first.id);
    if (lease) lease.dispatchedAt = Date.now() - 400000; // past the 300s chat lease
    await call(S2, "GET", "/network/models"); // any request runs the reaper
    const rq = first && S2.s.queue.find((j) => j.id === first.id);
    check(rq?.maxTokens === 1024 && rq?.contextTokens === 16384 && rq?.termsVersion === 1, "a lease-expired v1 job is requeued with its terms intact");
    check((S2.s.perf[C.address]?.to || 0) === toBefore + 1, "…the silent worker takes the timeout");
    check(!(await poll(S2, A, 400)) && !(await poll(S2, D, 400)), "…it is never re-offered to an incapable worker");
    const again = await poll(S2, B, 2000);
    check(!!first && again?.id === first.id, "…and goes to a capable one");
    if (again) await submit(S2, B, again); else ctl.abort();
    check((await p).status === 200, "…which completes the original request");

    S5.s._v1TermsSeen.splice(0, Infinity, { maxTokens: 2048, contextTokens: 32768 });
    const stale = seeded(MC);
    const credit = rowOf(S5, MC).mystThisEpoch;
    MC.context = undefined; // the owner turns the opt-in off: re-registers legacy
    await register(S5, MC);
    const sj = S5.s.queue.find((j) => j.id === stale?.id);
    if (sj) sj.createdAt = new Date(Date.now() - 6 * 60000).toISOString();
    await call(S5, "GET", "/network/models");
    check(!!stale && stale.termsVersion === 1 && !S5.s.queue.some((j) => j.id === stale.id), "a v1 mystery no live worker can hold any more is garbage-collected");
    check(rowOf(S5, MC).mystThisEpoch === credit - 1, "…and its target's audit credit is given back");
    check(S5.events.some((e) => e.type === "scheduler:protocol-dropped" && e.jobId === stale?.id && e.kind === "mystery"), "…with the protocol-dropped event");
  }

  /* ================================================================== */
  console.log("\n16) discovery: /network/models maxima, status detail, roster untouched");
  {
    const nm = await call(S2, "GET", "/network/models");
    const fast = (nm.body.models || []).find((m) => m.model === FAST);
    check(fast?.ctxTokens === 4096 && fast?.ctxTokensMax === 32768 && fast?.maxOutputTokensMax === 4096, "mixed providers: ctxTokens 4096, ctxTokensMax 32768, maxOutputTokensMax 4096");
    const nm1 = await call(S1, "GET", "/network/models");
    const fast1 = (nm1.body.models || []).find((m) => m.model === FAST);
    check(fast1?.ctxTokensMax === 4096 && fast1?.maxOutputTokensMax === 512, "only legacy/default providers: 4096 / 512");
    const st = await call(S2, "GET", "/network/status");
    const row = (w) => (st.body.workers || []).find((x) => x.address === `${w.address.slice(0, 6)}…${w.address.slice(-4)}`);
    check(row(A)?.context === null && same(row(C)?.context, { [FAST]: { contextTokens: 32768, maxOutputTokens: 4096 } }), "status detail shows per-worker capacity (null = legacy)");
    const ro = await call(S2, "GET", "/network/roster");
    check(keysOf(ro.body) === "count,ok,workers" && (ro.body.workers || []).every((x) => typeof x === "string"), "/network/roster shape untouched");

    const oe = await call(S2, "POST", "/operator/enqueue", { type: "chat", model: FAST, messages: user("op"), maxTokens: 99999, contextTokens: 12345, termsVersion: "1" });
    const ev = await call(S2, "POST", "/operator/enqueue", { type: "inference-eval", model: FAST, prompt: "2+2?", maxTokens: 64, contextTokens: 16384, termsVersion: 1 });
    const oj = S2.s.queue.find((j) => j.id === oe.body.job?.id);
    const ej = S2.s.queue.find((j) => j.id === ev.body.job?.id);
    check(oj?.maxTokens === 4096 && oj?.contextTokens === 4096 && !("termsVersion" in oj), "operator chat jobs are sanitized (clamped output, tier-only window, termsVersion only if 1)");
    check(ej && !("maxTokens" in ej) && !("contextTokens" in ej) && !("termsVersion" in ej), "evals carry no terms");
    S2.s.queue = S2.s.queue.filter((j) => j !== oj && j !== ej);
  }

  /* ================================================================== */
  console.log("\n17) own-machine jobs are never offered to another address");
  {
    const svc = new AccountService({ stateDir: tmp(), sendMail: async () => {}, siteOrigin: "http://127.0.0.1", onEvent: () => {} });
    const S6 = await boot({ accounts: svc });
    const me = keyPair("probe-context-own-machine");
    const ownW = await addWorker(S6, { models: [FAST], signer: me.signer });
    const SECRET = "my private note 7421";
    const leak = (r) => JSON.stringify(r?.body || {}).includes(SECRET);
    /** Shorten the job's lease, let it lapse, and run the reaper. */
    const expire = async (id) => {
      const lease = S6.s.pending.get(id);
      if (lease) lease.leaseMs = 1;
      await sleep(10);
      await call(S6, "GET", "/network/models"); // any request runs the reaper
    };

    // Job 1 — legacy wallet lane: the owner takes it and goes silent.
    const spend1 = spendOf(S6, me.address);
    const ctl1 = new AbortController();
    const p1 = consume(S6, await legacyReq(me, user(SECRET), { selfHost: true, model: FAST }), { signal: ctl1.signal });
    const first = await poll(S6, ownW, 2000);
    check(first?.selfServed === true, "the owner's machine takes its own job");
    if (first) await expire(first.id);
    const rq = first && S6.s.queue.find((j) => j.id === first.id);
    check(!!rq && rq.forWorker === me.address && rq.selfServed === true && !S6.s.pending.has(first.id), "a lease-expired own-machine job is requeued still stamped to its owner");
    // A capable worker of ANOTHER address registers only now.
    const other = await addWorker(S6, { models: [FAST], context: ctxOf({ [FAST]: [32768, 4096] }) });
    check(!!rq && !S6.s._canServe(rowOf(S6, other), rq), "a capable worker of another address cannot serve it");
    const stolen = await pollRaw(S6, other, 600);
    check(stolen.status !== 200 && !leak(stolen), `…its /worker/next-job never receives the job or its messages (status ${stolen.status})`);
    const och = await call(S6, "POST", `/worker/chunk?token=${encodeURIComponent(other.token)}`, { jobId: first?.id, delta: "x" });
    const ors = await submit(S6, other, { id: first?.id });
    check(och.status === 404 && ors.status === 404, "…and cannot post a chunk or a result for it (404)");
    check(spendOf(S6, me.address) === spend1 && S6.s.receipts.length === 0, "…no receipt, nothing charged");
    const again = await poll(S6, ownW, 2000);
    check(!!first && again?.id === first.id, "the owner's machine can take it again");
    if (again) await submit(S6, ownW, again); else ctl1.abort();
    const r1 = await p1;
    check(
      r1.status === 200 && r1.body.costUsd === 0 && /own machine/.test(String(r1.body.paidWith)) && S6.s.receipts.length === 0,
      "…and answer it at zero cost, with no receipt"
    );

    // Job 2 — grant lane, streaming: the owner's machine leaves while the job waits.
    const acct = svc._newAccount({ email: "own-machine@example.com" });
    const session = svc._issueSession(acct.id, "probe");
    const lts = Date.now();
    svc.linkWallet(acct, { address: me.address, ts: lts, signature: await signB64(me.signer, sha(`link|${me.address}|${acct.id}|${lts}`)) });
    const exp = Date.now() + 3600000;
    const gts = Date.now() + 1;
    const grant = await svc.grantSpend(acct, {
      address: me.address, maxMicro: 1000000, expiresAt: exp, ts: gts,
      signature: await signB64(me.signer, sha(`spend|${me.address}|${acct.id}|1000000|${exp}|${gts}`)),
    });
    const remaining = () => svc.spendableGrant(acct.id, grant.id).remainingMicro;
    const g0 = remaining();
    const spend2 = spendOf(S6, me.address);
    const sctl = new AbortController();
    const sp = fetch(S6.base + "/consume/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: user(`${SECRET} again`), sessionToken: session, grantId: grant.id, model: FAST, max_tokens: 64, selfHost: true, stream: true }),
      signal: sctl.signal,
    }).then(async (r) => ({ status: r.status, text: await r.text() }), (e) => ({ status: 0, text: "", error: e }));
    const second = await poll(S6, ownW, 2000);
    check(second?.selfServed === true && remaining() < g0, "grant lane, streaming: the owner takes its own job (the grant hold is taken as today)");
    if (second) await expire(second.id);
    check(S6.s.queue.some((j) => j.id === second?.id && j.forWorker === me.address), "…its lease expires: requeued still stamped");
    const stolen2 = await pollRaw(S6, other, 600);
    check(stolen2.status !== 200 && !leak(stolen2), "…the other worker still receives nothing");
    rowOf(S6, ownW).lastSeen = 0; // the owner's machine leaves (it holds no lease)
    await call(S6, "GET", "/network/models");
    const sr = await Promise.race([sp, sleep(3000).then(() => null)]);
    if (!sr) sctl.abort();
    await sleep(20); // the response's close handler returns the grant hold
    check(!S6.s.queue.some((j) => j.id === second?.id) && !S6.s.pending.has(second?.id), "when the owner's machine leaves, the job is dropped (never released to others)");
    check(S6.events.some((e) => e.type === "scheduler:self-serve-dropped" && e.jobId === second?.id && e.worker === me.address), "…with a self-serve-dropped event");
    check(
      sr?.status === 200 && /"error":"no provider answered in time"/.test(sr.text) && /\[DONE\]/.test(sr.text) && !/"done":true/.test(sr.text),
      "…and the waiting consumer's stream gets the existing error frame at once, with no result"
    );
    check(S6.s.receipts.length === 0 && spendOf(S6, me.address) === spend2 && remaining() === g0, "…no receipt, nothing charged, the grant hold returned in full");
    const stolen3 = await pollRaw(S6, other, 400);
    check(stolen3.status !== 200 && !leak(stolen3), "…and the other worker never receives it");

    // Job 3 — legacy wallet, buffered: the machine left before its lease lapsed.
    rowOf(S6, ownW).lastSeen = Date.now();
    const spend3 = spendOf(S6, me.address);
    const ctl3 = new AbortController();
    const p3 = consume(S6, await legacyReq(me, user(`${SECRET} once more`), { selfHost: true, model: FAST }), { signal: ctl3.signal });
    const third = await poll(S6, ownW, 2000);
    rowOf(S6, ownW).lastSeen = 0;
    if (third) await expire(third.id);
    const r3 = await Promise.race([p3, sleep(3000).then(() => null)]);
    if (!r3) ctl3.abort();
    check(
      !!third && r3?.status === 504 && /no provider answered in time/.test(msgOf(r3)) && !S6.s.queue.some((j) => j.id === third.id) && !S6.s.pending.has(third.id),
      `legacy wallet lane: lease expiry after the machine left -> requeued and dropped in one pass, 504 at once (got ${r3?.status})`
    );
    check(S6.s.receipts.length === 0 && spendOf(S6, me.address) === spend3 && !S6.s._consumerAddresses.has(me.address), "…nothing charged, wallet lock released");
    const stolen4 = await pollRaw(S6, other, 400);
    check(stolen4.status !== 200 && !leak(stolen4), "…and the other worker never receives it");
  }

  /* ================================================================== */
  console.log("\n18) a v1 stream whose consumer leaves after the first chunk: no result, no charge");
  {
    const c14 = keyPair();
    const body = await v1Req(c14, { max_tokens: 1024, messages: user("stream, then leave") }, { stream: true });
    const spend = spendOf(S2, c14.address);
    const ctl = new AbortController();
    const resp = await fetch(S2.base + "/consume/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let seen = "";
    const readUntil = async (re, ms = 2000) => {
      const end = Date.now() + ms;
      while (!re.test(seen) && Date.now() < end) {
        const r = await Promise.race([reader.read(), sleep(Math.max(0, end - Date.now())).then(() => null)]);
        if (!r || r.done) break;
        seen += dec.decode(r.value, { stream: true });
      }
      return re.test(seen);
    };
    check(resp.status === 200 && (await readUntil(/"accepted":true/)), "the v1 stream is accepted");
    const job = await poll(S2, C, 2000);
    check(job?.maxTokens === 1024, "…and C takes the job");
    const chunk = (delta) => call(S2, "POST", `/worker/chunk?token=${encodeURIComponent(C.token)}`, { jobId: job?.id, delta });
    const k1 = await chunk("Hel");
    check(k1.status === 200 && (await readUntil(/"delta":"Hel"/)), "the first chunk reaches the consumer");
    ctl.abort(); // the consumer leaves
    await sleep(50);
    const k2 = await chunk("lo");
    check(k2.status === 404 && k2.body.ok === false, "after the consumer leaves, the next /worker/chunk is 404 {ok: false} (the worker's abort signal)");
    const rr = await submit(S2, C, job || { id: "none" }, { completion: 2 });
    check(rr.status === 404, "…and /worker/result for that job is 404");
    check(
      spendOf(S2, c14.address) === spend && !S2.s.pending.has(job?.id) && !S2.s.queue.some((j) => j.id === job?.id) && !S2.s.receipts.some((x) => x.jobId === job?.id),
      "…no receipt, nothing charged, and the job is gone"
    );
    check(!S2.s._consumerAddresses.has(c14.address), "…the wallet lock is released");
    const fresh = await served(S2, await v1Req(c14, { max_tokens: 64, messages: user("fresh") }), C);
    check(fresh.resp.status === 200, `…so a fresh request is served, not 409 (got ${fresh.resp.status})`);
  }

  /* ================================================================== */
  console.log("\n19) v1 reservations: free tokens a v1 gate counted are held until it is billed, on every lane");
  const CAP32 = ctxOf({ [FAST]: [32768, 4096] });
  const big = ofEst(28000); // + max_tokens 4096 -> the 32768 tier, prompt bound = the whole window
  const worstBig = 32768 + 4096;
  const longOut = { output: "x".repeat(4100), prompt: 32000, completion: 4096 }; // 36096 billable tokens
  const ipUsed = (env) => Object.values(env.s.freeUsedByIp).reduce((x, y) => x + y, 0);
  const noDebt = (env, addr) => BigInt(env.s.spentSat[addr] || "0") === 0n && env.s._consumeCapacity(addr, null).earningsLeftSat >= 0n;
  const quiet = (env) => env.s._v1Reservations.size === 0 && env.s._grantInFlight.size === 0;
  const resOf = (env, addr) => [...env.s._v1Reservations.values()].filter((r) => r.address === addr);
  const BUSY = "an earlier request for this wallet is still running";
  {
    // Two zero-balance wallets race one shared IP pool.
    const R = await boot({ freeTokensPerIp: 40000 });
    const W = await addWorker(R, { models: [FAST], context: CAP32 });
    const a = keyPair();
    const z = keyPair();
    check(Math.min(24 + Buffer.byteLength(JSON.stringify(big), "utf8"), 32768) === 32768, "the large request's prompt bound is the whole 32768 window");
    const A = await inFlight(R, await v1Req(a, { max_tokens: 4096, messages: big }));
    const [ra] = resOf(R, a.address);
    check(
      A.job?.contextTokens === 32768 && R.s._v1Reservations.size === 1 && ra?.freeTok === worstBig && ra?.uncoveredMicro === 0n && !!ra?.ip,
      `zero-balance A's v1 {4096, 32768} is accepted and reserves its whole worst case (${worstBig}) from the 40000-token IP pool`
    );
    const before = ledger(R, z.address);
    const rz = await consume(R, await v1Req(z, { max_tokens: 4096, messages: big }));
    check(
      rz.status === 402 && codeOf(rz) === "worst_case_unaffordable" && ledger(R, z.address) === before && R.s._v1Reservations.size === 1,
      `a second zero-balance wallet racing the same pool sees ${40000 - worstBig} free -> 402 worst_case_unaffordable before dispatch (got ${rz.status} ${codeOf(rz)})`
    );
    const ja = await poll(R, W, 2000);
    if (ja) await submit(R, W, ja, longOut); else A.ctl.abort();
    const resA = await A.p;
    check(
      resA.status === 200 && resA.body.paidWith === "free" && resA.body.costUsd === 0 && R.s.freeUsedByDay[a.address] === 36096 && noDebt(R, a.address),
      "A is then billed entirely from free tokens, with no debt"
    );
    check(quiet(R), "…and its reservation is released with the charge");
    await retire(R);
  }
  {
    // Funded B is accepted beside zero-balance A and finishes first.
    const R = await boot({ freeTokensPerIp: 40000 });
    const W1 = await addWorker(R, { models: [FAST], context: CAP32 });
    const W2 = await addWorker(R, { models: [FAST], context: CAP32 });
    const a = keyPair();
    const bf = keyPair();
    R.s.balances[bf.address] = { balanceMicro: "1000000", depositHwmSat: "0" };
    const A = await inFlight(R, await v1Req(a, { max_tokens: 4096, messages: big }));
    const ja = await poll(R, W1, 2000); // A is running
    const B = await inFlight(R, await v1Req(bf, { max_tokens: 4096, messages: big }));
    const [rb] = resOf(R, bf.address);
    const left = 40000 - worstBig;
    check(
      !!ja && !!B.job && rb?.freeTok === left && rb?.uncoveredMicro === BigInt(uncoveredOf(32768, 4096, FAST, left)),
      `funded B's v1 is accepted on the ${left} free tokens A left plus its balance`
    );
    const jb = await poll(R, W2, 2000);
    if (jb) await submit(R, W2, jb, longOut); else B.ctl.abort();
    const resB = await B.p;
    const billB = Math.ceil(costMicro(32000, 4096, FAST) * ((36096 - left) / 36096));
    check(
      resB.status === 200 && R.s.freeUsedByDay[bf.address] === left && ipUsed(R) === left &&
        Math.round(resB.body.costUsd * 1e6) === billB && R.s.balances[bf.address].balanceMicro === String(1000000 - billB),
      `B finishes first: its billing draws only the ${left} unreserved free tokens, never A's, and ${billB} µ$ from its balance`
    );
    check(resOf(R, a.address).length === 1 && resOf(R, bf.address).length === 0, "…B's reservation goes with its charge; A's is still held");
    if (ja) await submit(R, W1, ja, longOut); else A.ctl.abort();
    const resA = await A.p;
    check(
      resA.status === 200 && resA.body.paidWith === "free" && R.s.freeUsedByDay[a.address] === 36096 && ipUsed(R) === left + 36096 && noDebt(R, a.address),
      "A is then billed from free tokens: no debt, spendable earnings not negative"
    );
    check(quiet(R), "…and nothing is left reserved");
    await retire(R);
  }
  {
    // Another wallet's legacy request on the same IP finishes first.
    const R = await boot({ freeTokensPerIp: worstBig });
    const W1 = await addWorker(R, { models: [FAST], context: CAP32 });
    const W2 = await addWorker(R, { models: [FAST] });
    const a = keyPair();
    const cz = keyPair();
    const d = keyPair();
    R.s.balances[d.address] = { balanceMicro: "1000000", depositHwmSat: "0" };
    const A = await inFlight(R, await v1Req(a, { max_tokens: 4096, messages: big }));
    const ja = await poll(R, W1, 2000);
    check(!!ja && resOf(R, a.address)[0]?.freeTok === worstBig, "A's v1 reserves the whole IP pool and is running");
    const beforeC = ledger(R, cz.address);
    const rc = await consume(R, await legacyReq(cz, user("legacy on the same IP")));
    check(
      rc.status === 402 && /^Insufficient balance/.test(msgOf(rc)) && codeOf(rc) === undefined && ledger(R, cz.address) === beforeC,
      `a zero-balance wallet's legacy request on that IP: A's reserved tokens are not free for it -> the existing zero-gate 402 (got ${rc.status})`
    );
    const ld = await served(R, await legacyReq(d, user("legacy, funded")), W2, { output: "y".repeat(100), prompt: 30, completion: 40 });
    check(
      ld.resp.status === 200 && ld.resp.body.paidWith === "balance" && !R.s.freeUsedByDay[d.address] && ipUsed(R) === 0 && ld.job?.maxTokens === 512,
      "a funded wallet's legacy request finishes first on legacy terms, paid from its own balance, drawing none of A's reserved tokens"
    );
    if (ja) await submit(R, W1, ja, longOut); else A.ctl.abort();
    const resA = await A.p;
    check(resA.status === 200 && resA.body.paidWith === "free" && ipUsed(R) === 36096 && noDebt(R, a.address), "A is then billed from free tokens with no debt");
    check(quiet(R), "…and nothing is left reserved");
    await retire(R);
  }
  {
    // Same-address money: grant and v1 requests exclude each other.
    const svc = new AccountService({ stateDir: tmp(), sendMail: async () => {}, siteOrigin: "http://127.0.0.1", onEvent: () => {} });
    const R = await boot({ accounts: svc, freeTokensPerDay: 0 });
    const W1 = await addWorker(R, { models: [FAST], context: CAP32 });
    const W2 = await addWorker(R, { models: [FAST], context: CAP32 });
    const g = keyPair("probe-context-reservation-wallet");
    R.s.balances[g.address] = { balanceMicro: "1000000", depositHwmSat: "0" };
    const acct = svc._newAccount({ email: "reservation@example.com" });
    const session = svc._issueSession(acct.id, "probe");
    const lts = Date.now();
    svc.linkWallet(acct, { address: g.address, ts: lts, signature: await signB64(g.signer, sha(`link|${g.address}|${acct.id}|${lts}`)) });
    const exp = Date.now() + 3600000;
    const gts = Date.now() + 1;
    const grant = await svc.grantSpend(acct, {
      address: g.address, maxMicro: 1000000, expiresAt: exp, ts: gts,
      signature: await signB64(g.signer, sha(`spend|${g.address}|${acct.id}|1000000|${exp}|${gts}`)),
    });
    const remaining = () => svc.spendableGrant(acct.id, grant.id).remainingMicro;
    const gReq = (extra) => ({ messages: user("from the web app"), sessionToken: session, grantId: grant.id, model: FAST, max_tokens: 64, ...extra });

    const V = await inFlight(R, await v1Req(g, { max_tokens: 1024, messages: user("v1 first") }));
    const [rv] = resOf(R, g.address);
    check(!!V.job && rv?.freeTok === 0 && rv?.uncoveredMicro > 0n, "a v1 request whose worst case rests on the wallet's balance is in flight");
    const g0 = remaining();
    const spend0 = spendOf(R, g.address);
    const rg = await consume(R, gReq());
    check(
      rg.status === 409 && msgOf(rg) === BUSY && remaining() === g0 && spendOf(R, g.address) === spend0 && R.s._grantInFlight.size === 0,
      `…a grant-lane request for the same address -> 409 "${BUSY}", no hold, nothing charged (got ${rg.status})`
    );
    const jv = await poll(R, W1, 2000);
    if (jv) await submit(R, W1, jv); else V.ctl.abort();
    check((await V.p).status === 200 && quiet(R), "the v1 request completes and releases its reservation");

    const G = await inFlight(R, gReq());
    check(!!G.job && R.s._grantInFlight.get(g.address) === 1, "a grant-lane request for the wallet is in flight");
    const spend1 = spendOf(R, g.address);
    const rv2 = await consume(R, await v1Req(g, { max_tokens: 1024, messages: user("v1 while the grant runs") }));
    check(
      rv2.status === 409 && msgOf(rv2) === BUSY && R.s._v1Reservations.size === 0 && spendOf(R, g.address) === spend1 && !R.s._consumerAddresses.has(g.address),
      `…a v1 request for that address -> 409, nothing reserved or charged, wallet lock released (got ${rv2.status})`
    );
    const jg = await poll(R, W1, 2000); // the grant job is running
    const lg = await served(R, await legacyReq(g, user("legacy beside the grant")), W2);
    check(lg.resp.status === 200, `the legacy wallet lane beside a running grant request is unchanged (got ${lg.resp.status})`);
    if (jg) await submit(R, W1, jg); else G.ctl.abort();
    check((await G.p).status === 200 && quiet(R), "the grant request completes and its tracking is released");
    const after = await served(R, await v1Req(g, { max_tokens: 1024, messages: user("v1 after the grant") }), W1);
    check(after.resp.status === 200 && quiet(R), "afterwards a v1 request for the address is served");

    // No leaks: every ending leaves nothing reserved and no grant tracked.
    const endings = [];
    let r = await consume(R, await v1Req(g, { max_tokens: 1024, messages: [{ role: "tool", content: "x" }] }));
    endings.push(["v1 refused 400", r.status === 400]);
    r = await consume(R, await v1Req(g, { model: "qwen25-32b", max_tokens: 1024, messages: user("nobody serves it") }));
    endings.push(["v1 refused 503", r.status === 503]);
    const poor = keyPair();
    R.s.balances[poor.address] = { balanceMicro: "1", depositHwmSat: "0" };
    r = await consume(R, await v1Req(poor, { max_tokens: 1024, messages: user("too dear") }));
    endings.push(["v1 refused 402 worst_case_unaffordable", r.status === 402 && codeOf(r) === "worst_case_unaffordable"]);
    // Timed out: the 180 s timer's own callback.
    const T = await inFlight(R, await v1Req(g, { max_tokens: 1024, messages: user("nobody answers") }));
    const heldT = resOf(R, g.address).length === 1;
    R.s._consumers.get(T.job?.id)?.(null);
    r = await T.p;
    endings.push(["v1 timed out (504)", heldT && r.status === 504]);
    // Disconnected after a worker took it: its late result is refused, nothing charged.
    const spendD = spendOf(R, g.address);
    const D = await inFlight(R, await v1Req(g, { max_tokens: 1024, messages: user("then I leave") }));
    const jd = await poll(R, W1, 2000);
    const heldD = resOf(R, g.address).length === 1;
    D.ctl.abort();
    await D.p;
    await until(() => quiet(R), 1000);
    const late = jd ? await submit(R, W1, jd) : { status: 0 };
    endings.push(["v1 disconnected", !!jd && heldD && late.status === 404 && spendOf(R, g.address) === spendD]);
    r = await consume(R, gReq({ max_tokens: undefined }));
    endings.push(["grant refused 400", r.status === 400]);
    const GD = await inFlight(R, gReq({ messages: user("grant, then I leave") }));
    const heldG = R.s._grantInFlight.get(g.address) === 1;
    GD.ctl.abort();
    await GD.p;
    await until(() => quiet(R), 1000);
    endings.push(["grant disconnected", heldG]);
    const own = await addWorker(R, { models: [FAST], signer: g.signer });
    const s1 = await served(R, await legacyReq(g, user("mine"), { selfHost: true, model: FAST }), own);
    endings.push(["legacy self-served", s1.resp.status === 200 && /own machine/.test(String(s1.resp.body.paidWith))]);
    const s2 = await served(R, gReq({ selfHost: true, messages: user("mine, via the web app") }), own);
    endings.push(["grant self-served", s2.resp.status === 200 && /own machine/.test(String(s2.resp.body.paidWith))]);
    for (const [what, ok] of endings) check(ok && quiet(R), `no leak: ${what} -> no reservation and no grant left in flight`);
    check(quiet(R) && R.s._consumerAddresses.size === 0, "…and every wallet lock is released");
    await retire(R);
  }

  /* ================================================================== */
  console.log("\n20) the mystery ring is fed only by billed v1 results, at most 4 per consumer");
  {
    const R = await boot();
    const W = await addWorker(R, { models: [FAST], context: CAP32 });
    const ring = R.s._v1TermsSeen;
    const p = keyPair();
    const Q = await inFlight(R, await v1Req(p, { max_tokens: 900, messages: user("queued") }));
    check(!!Q.job && ring.length === 0, "an accepted, queued v1 job is not recorded at enqueue");
    Q.ctl.abort();
    await Q.p;
    await sleep(30);
    const T = await inFlight(R, await v1Req(p, { max_tokens: 901, messages: user("taken, then abandoned") }));
    const tj = await poll(R, W, 2000);
    T.ctl.abort();
    await T.p;
    await sleep(30);
    const late = tj ? await submit(R, W, tj) : { status: 0 };
    const O = await inFlight(R, await v1Req(p, { max_tokens: 902, messages: user("timed out") }));
    R.s._consumers.get(O.job?.id)?.(null);
    const ro = await O.p;
    const r503 = await consume(R, await v1Req(p, { model: "qwen25-32b", max_tokens: 903, messages: user("nobody serves this") }));
    check(
      !!tj && late.status === 404 && ro.status === 504 && r503.status === 503 && ring.length === 0,
      "abandoned (queued or running), timed-out and refused v1 requests never enter the ring"
    );
    const lg = await served(R, await legacyReq(p, user("legacy")), W);
    const own = await addWorker(R, { models: [FAST], signer: p.signer });
    const ss = await served(R, await legacyReq(p, user("mine"), { selfHost: true, model: FAST }), own);
    check(
      lg.resp.status === 200 && ss.resp.status === 200 && /own machine/.test(String(ss.resp.body.paidWith)) && ring.length === 0,
      "legacy and self-served results are never recorded"
    );
    for (let i = 0; i < 6; i++) await served(R, await v1Req(p, { max_tokens: 101 + i, messages: user(`billed ${i}`) }), W);
    const o = keyPair();
    await served(R, await v1Req(o, { max_tokens: 200, messages: user("someone else") }), W);
    check(
      same(ring.filter((t) => t.address === p.address).map((t) => t.maxTokens), [103, 104, 105, 106]),
      `one consumer keeps at most 4 entries, its newest billed terms (got ${ring.filter((t) => t.address === p.address).map((t) => t.maxTokens)})`
    );
    check(ring.length === 5 && same(ring.at(-1), { address: o.address, maxTokens: 200, contextTokens: 4096 }), "…while other consumers' billed terms are recorded alongside");
    await retire(R);
  }

  for (const s of booted) await s.close().catch(() => {});
  console.log(failures ? `\nCONTEXT CAPACITY PROBE FAILED (${failures})` : "\nCONTEXT CAPACITY PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.error("\nCONTEXT CAPACITY PROBE FAILED (aborted)");
  process.exit(1);
});
