"use strict";
const { Readable } = require("node:stream"), { EventEmitter } = require("node:events");
const crypto = require("node:crypto"), path = require("node:path"), express = require("express");
const { Transaction, utils } = require("koilib");
const { CreditApiKeys, CREDIT_ACCESS, fail } = require("./credit-api-keys");
const P = require("./koin-network/job-protocol");
const accountRoutes = require("../public/platform/account-routes");
const Diagnostics = require("./koin-network/inference-diagnostics");

function errorBody(message, status = 400) {
  return { error: { message, type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error", code: String(status), param: null } };
}
function networkError(value, status = 400) {
  const error = Diagnostics.envelope(value.inferenceFailure, value.requestId);
  return error ? { error } : errorBody(value.error, status);
}
function completion(value, created) {
  return { id: "chatcmpl-" + value.id, object: "chat.completion", created, model: value.servedModel,
    choices: value.choices, usage: value.usage, kai: { cost_usd: value.costUsd, credits_atoms: value.koin.credits } };
}
// Translate cumulative, verified network replies into OpenAI text deltas.
// It forwards the actual socket lifecycle so disconnects cancel queued work.
class CompletionResponse {
  constructor(res, { created, includeUsage = false }) { this.res = res; this.created = created; this.includeUsage = includeUsage; this.buffer = ""; this.output = ""; this.sentRole = false; this.finished = false; }
  get destroyed() { return this.res.destroyed; }
  get writableEnded() { return this.res.writableEnded; }
  get writableLength() { return this.res.writableLength; }
  on(...args) { this.res.on(...args); return this; }
  removeListener(...args) { this.res.removeListener(...args); return this; }
  destroy() { return this.res.destroy(); }
  flushHeaders() { this.res.flushHeaders?.(); }
  writeHead(status, headers) {
    this.status = status; this.streaming = headers["content-type"].startsWith("text/event-stream");
    this.headers = headers;
    if (this.streaming) this.res.writeHead(status, headers);
  }
  write(chunk) {
    this.buffer += String(chunk);
    if (!this.streaming) return true;
    let at;
    while ((at = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 2);
      if (frame.startsWith(":")) { this.res.write(frame + "\n\n"); continue; }
      if (!frame.startsWith("data: ")) continue;
      const text = frame.slice(6);
      if (text === "[DONE]") { this.res.write("data: [DONE]\n\n"); continue; }
      const value = JSON.parse(text);
      if (!value.ok) { this.res.write("data: " + JSON.stringify(networkError(value, value.status || 400)) + "\n\n"); continue; }
      const c = value.completion, content = c.choices[0].message.content;
      if (!content.startsWith(this.output)) throw fail("Provider changed an already delivered reply", 502);
      const delta = { ...(!this.sentRole ? { role: "assistant" } : {}), content: content.slice(this.output.length) };
      this.output = content; this.sentRole = true;
      const final = c.koin.state === "charged";
      if (this.finished) continue;
      const base = { id: "chatcmpl-" + c.id, object: "chat.completion.chunk", created: this.created, model: c.servedModel };
      this.res.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: final ? c.choices[0].finish_reason || "stop" : null }] }) + "\n\n");
      if (final) {
        this.finished = true;
        if (this.includeUsage) this.res.write("data: " + JSON.stringify({ ...base, choices: [], usage: c.usage }) + "\n\n");
      }
    }
    return this.res.writableLength < 2000000;
  }
  end(chunk = "") {
    this.write(chunk);
    if (this.streaming) return this.res.end();
    const value = JSON.parse(this.buffer), body = value.ok ? completion(value.completion, this.created) : networkError(value, this.status);
    this.res.writeHead(this.status, this.headers); this.res.end(JSON.stringify(body));
  }
}
function requestFor(req, body, resolve, url) {
  const internal = Readable.from([Buffer.from(JSON.stringify(body))]);
  internal.method = "POST"; internal.url = url; internal.headers = { "x-kai-credit-stream": "keepalive-v1", "x-kai-managed-catalog": require("./koin-network/managed-protocol").policyHash }; internal.socket = req.socket;
  internal[CREDIT_ACCESS] = resolve;
  return internal;
}
async function prepaidCall(prepaid, req, resolve, action, args = {}) {
  const access = resolve(), response = new EventEmitter(); let status, value;
  response.writeHead = code => { status = code; };
  response.end = body => { value = JSON.parse(body); response.writableEnded = true; };
  await prepaid.handle(requestFor(req, { ...args, creditWallet: access.wallet }, resolve, "/koin/prepaid/" + action), response);
  if (!value?.ok) throw fail(value?.error || "Credit service is unavailable", status || 503);
  return value;
}
function textChat(body, tariffs) {
  if (!body || Array.isArray(body) || Object.keys(body).some(k => !["model", "messages", "max_tokens", "max_completion_tokens", "stream", "stream_options"].includes(k)))
    throw fail("Supported fields: model, messages, max_tokens (or max_completion_tokens), stream, stream_options. Tools, images and sampling controls are not supported yet.");
  const tariff = tariffs.find(t => t.model === body.model);
  if (!tariff) throw fail("Choose a model returned by /v1/models");
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw fail("Use one output token limit");
  const max = body.max_tokens ?? body.max_completion_tokens ?? Math.min(512, tariff.maxOutputTokens);
  if (!Number.isSafeInteger(max) || max < 1 || max > tariff.maxOutputTokens) throw fail("Output token limit exceeds this model's maximum");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw fail("stream must be a boolean");
  if (body.stream_options !== undefined && (!body.stream_options || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== "include_usage") || typeof body.stream_options.include_usage !== "boolean" || body.stream !== true)) throw fail("stream_options supports include_usage for streaming requests");
  return { model: body.model, messages: P.messages(body.messages), max_tokens: max, stream: body.stream === true };
}
function createCreditGateway({ accounts, runtime, clock = Date.now }) {
  if (runtime.client.d.product !== "prepaid-usd-v1") throw Error("Web API requires the existing USD prepaid runtime");
  const router = express.Router(), keys = new CreditApiKeys(accounts.service, clock), prepaid = runtime.scheduler.koinPrepaid;
  const vault = new (require("./credit-vault").CreditVault)(accounts.service, { clock });
  const publicDir = path.join(__dirname, "../public/platform");
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const embedded = ["/app", "/app/"].includes(req.path) && req.query.embed === "workspace";
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors " + (embedded ? "https://koinosai.com" : "'none'") + "; base-uri 'none'; form-action 'self'");
    next();
  });
  const returnCookie = "kai_login_return", returnOptions = { httpOnly: true, secure: accounts.service.siteOrigin.startsWith("https:"), sameSite: "lax", path: "/" };
  router.use("/auth/workspace/authorize", (req, res, next) => { if (accounts.accountOf(req)) res.clearCookie(returnCookie, returnOptions); next(); });
  router.use(require("./workspace-sso").workspaceSso(accounts, clock));
  router.get(["/login", "/login/"], (req, res) => {
    if (accounts.accountOf(req)) return res.redirect(accountRoutes.destination(req.query.next || "/workspace/chat"));
    res.cookie(returnCookie, accountRoutes.destination(req.query.next || "/workspace/chat"), { ...returnOptions, maxAge: 600000 });
    res.sendFile(path.join(publicDir, "login.html"));
  });
  router.get(["/platform", "/platform/", "/link"], (req, res) => res.redirect(accountRoutes.destination(req.originalUrl)));
  router.get("/workspace/chat", (_req, res) => { res.clearCookie(returnCookie, returnOptions); res.redirect("https://koinosai.com/chat"); });
  router.get(["/account", "/account/", "/app", "/app/"], (req, res) => {
    const embedded = req.path.startsWith("/app") && req.query.embed === "workspace";
    if (req.path.startsWith("/app") && !embedded) return res.redirect("https://koinosai.com/chat");
    if (embedded && !accounts.accountOf(req)) return res.status(401).type("html").send('<p>Your session has ended.</p><a href="https://koinosai.com/login" target="_top">Sign in to Koinos AI</a>');
    if (!accounts.accountOf(req)) return res.redirect("/login?next=" + encodeURIComponent(accountRoutes.destination(req.originalUrl)));
    const returning = String(req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(returnCookie + "="));
    if (returning && !embedded) {
      res.clearCookie(returnCookie, returnOptions);
      let target; try { target = accountRoutes.destination(decodeURIComponent(returning.slice(returnCookie.length + 1))); } catch { target = "/account"; }
      return res.redirect(target);
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });
  router.get("/platform/docs", (_req, res) => res.sendFile(path.join(publicDir, "docs.html")));
  for (const name of ["platform.js", "platform.css", "account-routes.js", "login.js", "account-settings.js", "markdown-it.min.js", "markdown-it.LICENSE.txt", "chat-ui.js", "chat-ui.css"]) router.get("/platform/assets/" + name, (_req, res) => res.sendFile(path.join(publicDir, name)));
  router.get("/platform/assets/kondor.js", (_req, res) => res.sendFile(path.join(__dirname, "../public/producer-signer/kondor.min.js")));
  router.use(express.json({ limit: "128kb", strict: true }));
  function browser(req, res) {
    const account = accounts.requireAccount(req, res); if (!account) return null;
    keys.rate(account.id);
    const supplied = req.method === "GET" ? req.query.wallet : req.body?.creditWallet;
    const input = { creditWallet: supplied === undefined || supplied === "" ? null : supplied };
    let wallet = require("./koin-network/credit-wallet").select(accounts.service.creditAccountView(account).wallets, input, { walletless: true });
    const resolve = () => {
      const live = accounts.accountOf(req);
      if (!live || live.id !== account.id) throw fail("Sign in again", 401);
      if (wallet && !accounts.service.creditAccountView(live).wallets.some(w => w.address === wallet)) throw fail("Wallet is no longer linked", 403);
      return { account: live, wallet, automatic: supplied === undefined };
    };
    resolve.selectWallet = address => { wallet = address; resolve(); };
    return resolve;
  }
  function api(req, scope) {
    const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ""))?.[1];
    const resolved = keys.resolve(token, scope, true); keys.rate(resolved.account.id);
    return () => keys.resolve(token, scope);
  }
  function idempotency(req, access) {
    const supplied = req.headers["idempotency-key"];
    if (supplied !== undefined && (typeof supplied !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(supplied))) throw fail("Idempotency-Key must be 8–128 letters, numbers, dots, colons, underscores or hyphens");
    return P.hash(JSON.stringify(["credit-api-v1", access.account.id, access.key?.id || "browser", access.automatic ? "automatic" : access.wallet, supplied || crypto.randomUUID()]));
  }
  async function chat(req, res, resolve, input, freeOnly) {
    let access = resolve();
    const clean = textChat(input, prepaid.ledger.meter.tariffs()), requestId = idempotency(req, access);
    if (access.automatic && resolve.selectWallet) {
      const view = accounts.service.creditAccountView(access.account), ordered = view.wallets.map(w => w.address);
      if (view.primaryCreditWallet) ordered.splice(0, 0, ...ordered.splice(ordered.indexOf(view.primaryCreditWallet), 1));
      const ownBalance = "account-" + P.hash("verified-account:" + access.account.id), prior = prepaid.ledger.job(requestId);
      let chosen;
      if (prior) {
        // A retry stays with the original balance, even after the primary
        // setting changes. Never resubmit a charged request on another wallet.
        chosen = prior.owner === ownBalance ? null : prior.owner;
        if (chosen !== null && !ordered.includes(chosen)) throw fail("The credit account for this saved reply is no longer linked", 403);
      } else {
        const tariff = prepaid.ledger.meter.tariffs().find(t => t.model === clean.model);
        const maximum = BigInt(prepaid.ledger.meter.quote(prepaid.ledger.target.domain, tariff.model, tariff.version, clean.messages, clean.max_tokens, clock()).maxCharge);
        chosen = ordered[0] || null;
        for (const candidate of [...ordered, null]) {
          const effective = accounts.service.creditWalletAccount(access.account, candidate), accountId = P.hash("verified-account:" + effective.id);
          const credits = prepaid.ledger.creditView(candidate || ownBalance, { accountId, origin: P.hash("origin:" + (req.socket?.remoteAddress || "unknown")) }, clean.model);
          if (BigInt(credits.free.available || "0") + (freeOnly === false ? BigInt(credits.purchased.available || "0") : 0n) >= maximum) { chosen = candidate; break; }
        }
      }
      resolve.selectWallet(chosen); access = resolve();
    }
    res.setHeader("x-request-id", requestId);
    const body = { ...clean, requestId, billing: "koin-prepaid-usd-v1", creditWallet: access.wallet, providerDeviceProof: 1,
      freeOnly: access.key ? access.key.freeOnly : freeOnly !== false };
    const internal = requestFor(req, body, resolve, "/consume/chat/completions");
    return prepaid.work.chat(internal, new CompletionResponse(res, { created: Math.floor(clock() / 1000), includeUsage: input.stream_options?.include_usage === true }), body);
  }
  async function purchaseQuote(req, resolve, dollars, intentId) {
    const access = resolve(); if (!access.wallet) throw fail("Connect a payment wallet to buy credits");
    const q = await prepaidCall(prepaid, req, resolve, "quote-usd", { dollars, intentId: intentId ?? idempotency(req, access) });
    const operations = await runtime.client.operations("credits", "purchase", q.args, access.wallet);
    const transaction = await Transaction.prepareTransaction({ header: { chain_id: runtime.client.d.chainId, payer: access.wallet, rc_limit: runtime.config.maxRcPerTransaction }, operations }, runtime.client.provider, access.wallet);
    return { ...q, transaction, chainId: runtime.client.d.chainId, signerAddress: access.wallet,
      abis: { [runtime.client.d.token]: utils.tokenAbi, [runtime.client.d.credits]: runtime.client.abis.credits },
      credits: require("./koin-network/purchase-quote").credits(q.args.purchase_quote.credits),
      koin: require("./koin-network/purchase-quote").dollars(q.args.amount), expiresAt: Number(q.args.purchase_quote.expires_at) };
  }
  router.get("/platform/api/overview", wrap(async (req, res) => {
    const resolve = browser(req, res); if (!resolve) return;
    const status = await prepaidCall(prepaid, req, resolve, "status"), models = await prepaidCall(prepaid, req, resolve, "models");
    res.json({ ...status, account: accounts.service.creditAccountView(resolve().account), selectedWallet: resolve().wallet, models: models.catalog.models,
      features: { koinVault: 1, nativeAccount: 1 }, freePolicy: prepaid.ledger.free.policy, apiBase: accounts.service.siteOrigin + "/v1" });
  }));
  // Management uses the full account session, never an API key.
  router.get("/platform/api/keys", (req, res) => { const a = accounts.requireAccount(req, res); if (a) res.json({ keys: keys.list(a) }); });
  router.post("/platform/api/keys", wrap((req, res) => { const a = accounts.requireAccount(req, res); if (a) { keys.rate(a.id); res.status(201).json(keys.create(a, req.body)); } }));
  router.delete("/platform/api/keys/:id", wrap((req, res) => { const a = accounts.requireAccount(req, res); if (a) { keys.revoke(a, req.params.id); res.json({ ok: true }); } }));
  // Read-only context sizing through the same tokenizer/meter as admission.
  // This creates no reservation, job or charge and never drops old messages.
  router.post("/platform/api/chat/limits", wrap((req, res) => {
    if (!browser(req, res)) return;
    if (!req.body || Object.keys(req.body).some(k => !["model", "messages"].includes(k))) throw fail("Choose a model and conversation");
    const tariffs = prepaid.ledger.meter.tariffs(), clean = textChat({ ...req.body, max_tokens: 1 }, tariffs);
    const tariff = tariffs.find(t => t.model === clean.model);
    const quote = prepaid.ledger.meter.quote(prepaid.ledger.target.domain, tariff.model, tariff.version, clean.messages, 1, clock());
    res.json({ model: tariff.model, contextTokens: tariff.contextTokens, inputTokens: quote.inputTokens,
      modelMaxOutput: tariff.maxOutputTokens, maxOutput: Math.min(tariff.maxOutputTokens, tariff.contextTokens - quote.inputTokens) });
  }));
  router.post("/platform/api/chat", wrap(async (req, res) => {
    const resolve = browser(req, res); if (!resolve) return;
    const { creditWallet, freeOnly, ...body } = req.body;
    if (freeOnly !== undefined && typeof freeOnly !== "boolean") throw fail("Invalid credit preference");
    return chat(req, res, resolve, body, freeOnly);
  }));
  router.post("/platform/api/purchase-quote", wrap(async (req, res) => {
    const resolve = browser(req, res); if (resolve) res.json(vault.rememberQuote(resolve().account, await purchaseQuote(req, resolve, req.body.dollars, req.body.intentId)));
  }));
  router.post("/platform/api/purchases", wrap(async (req, res) => {
    const resolve = browser(req, res); if (resolve) res.json(await prepaidCall(prepaid, req, resolve, "purchase", { txId: req.body.txId }));
  }));
  for (const [route, method] of [["connect","connect"],["status","status"],["request","request"],["result","result"]]) {
    router.post("/platform/api/vault/" + route, wrap(async (req,res) => {
      const account = accounts.requireAccount(req,res); if (!account) return;
      keys.rate(account.id);
      res.json(await vault[method](account,req.body));
    }));
  }
  router.get("/v1/models", wrap(async (req, res) => {
    const resolve = api(req, "inference"), models = await prepaidCall(prepaid, req, resolve, "models");
    res.json({ object: "list", data: models.catalog.models.filter(m => m.available).map(m => ({ id: m.model, object: "model", created: 0, owned_by: "koinos-ai", kai: m })) });
  }));
  router.post("/v1/chat/completions", wrap((req, res) => chat(req, res, api(req, "inference"), req.body)));
  router.get("/v1/credits", wrap(async (req, res) => {
    const resolve = api(req, "billing:read"), status = await prepaidCall(prepaid, req, resolve, "status");
    res.json({ credits: status.credits, wallet: resolve().wallet, purchases: status.purchases, usage: status.usage });
  }));
  router.post("/v1/credits/purchase-quote", wrap(async (req, res) => res.json(await purchaseQuote(req, api(req, "billing:purchase"), req.body.dollars, req.body.intent_id))));
  router.post("/v1/credits/purchases", wrap(async (req, res) => res.json(await prepaidCall(prepaid, req, api(req, "billing:purchase"), "purchase", { txId: req.body.tx_id }))));
  router.use((req, res) => res.status(404).json(errorBody("Endpoint not found", 404)));
  router.use((err, req, res, next) => {
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    const status = err.status || 400;
    if (status === 429) res.setHeader("Retry-After", "60");
    const message = err.type === "entity.parse.failed" ? "Invalid JSON request" : status >= 500 ? "Credit service temporarily unavailable" : String(err.message).slice(0, 220);
    res.status(status).json(errorBody(message, status));
  });
  return { router, keys };
}
module.exports = { createCreditGateway, prepaidCall, CompletionResponse, textChat };
