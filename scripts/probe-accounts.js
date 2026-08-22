"use strict";

/*
 * Probe: accounts + cross-device auth (task #49, phase 1).
 *
 * Runs the REAL router over real HTTP (ephemeral port, tmp sqlite) and walks
 * every flow end to end:
 *
 *   1. email-code sign-in (mock transport captures the mail), wrong-code
 *      lockout, per-address send rate limit
 *   2. session semantics: Bearer + cookie, logout revokes
 *   3. device-link: pending -> approve -> token, single-use consumption
 *   4. wallet link with a REAL koilib signature (same recoverAddress
 *      convention the scheduler trusts), plus replay/decline paths
 *   5. passkeys with a SOFTWARE AUTHENTICATOR: a P-256 key built here signs
 *      genuine WebAuthn ceremonies (CBOR attestation, authenticatorData,
 *      DER signatures) through lib/webauthn.js — registration, login,
 *      tamper rejection, wrong-origin rejection
 *   6. degraded modes: no SMTP -> 503 with the env name; no Google -> 503,
 *      and /auth/methods reporting which doors are open WITHOUT leaking how
 *   8. "your nodes": a linked wallet joined IN-PROCESS to its live worker row,
 *      filtered to the caller's own addresses
 *   7. cookie CSRF posture: cross-origin mutating request -> 403
 *
 * Old code (no lib/accounts.js, nothing mounted): everything here fails —
 * which is the point. server.js wiring is asserted textually in section 8
 * (the flows above already prove the router itself behaviorally).
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { Signer } = require("koilib");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

/* ------------------------------------------------- tiny CBOR encoder ---- */
// Just enough for a WebAuthn attestation object: ints, byte strings, text,
// and maps (string or int keys). Definite lengths, like real authenticators.
function cborEncode(v) {
  const head = (major, len) => {
    if (len < 24) return Buffer.from([(major << 5) | len]);
    if (len < 256) return Buffer.from([(major << 5) | 24, len]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(len, 1);
    return b;
  };
  if (typeof v === "number" && Number.isInteger(v)) {
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor encode: unsupported ${typeof v}`);
}

/* --------------------------------------------- software authenticator --- */
class SoftPasskey {
  constructor(origin, rpId) {
    this.origin = origin;
    this.rpId = rpId;
    this.credId = crypto.randomBytes(16);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: "jwk" });
    this.signCount = 0;
  }

  _clientData(type, challengeB64u) {
    return Buffer.from(JSON.stringify({ type, challenge: challengeB64u, origin: this.origin }), "utf8");
  }

  /** navigator.credentials.create() equivalent. */
  create(publicKeyOptions) {
    const cose = new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this.jwk.x, "base64url")],
      [-3, Buffer.from(this.jwk.y, "base64url")],
    ]);
    const rpIdHash = crypto.createHash("sha256").update(this.rpId).digest();
    const credData = Buffer.concat([
      Buffer.alloc(16), // AAGUID
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(this.credId.length); return b; })(),
      this.credId,
      cborEncode(cose),
    ]);
    const flags = Buffer.from([0x41]); // UP | AT
    const count = Buffer.alloc(4);
    const authData = Buffer.concat([rpIdHash, flags, count, credData]);
    const att = new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]);
    return {
      attestationObject: cborEncode(att).toString("base64url"),
      clientDataJSON: this._clientData("webauthn.create", publicKeyOptions.challenge).toString("base64url"),
    };
  }

  /** navigator.credentials.get() equivalent. */
  get(publicKeyOptions, { tamper = false, wrongOrigin = false } = {}) {
    this.signCount += 1;
    const rpIdHash = crypto.createHash("sha256").update(this.rpId).digest();
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x01]), count]);
    const cd = this._clientData("webauthn.get", publicKeyOptions.challenge);
    if (wrongOrigin) {
      const parsed = JSON.parse(cd.toString());
      parsed.origin = "https://evil.example";
      return this._assemble(authData, Buffer.from(JSON.stringify(parsed)), tamper);
    }
    return this._assemble(authData, cd, tamper);
  }

  _assemble(authData, clientDataJSON, tamper) {
    const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
    let signature = crypto.sign("sha256", signed, this.privateKey);
    if (tamper) signature[8] ^= 0xff;
    return {
      credentialId: this.credId.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      clientDataJSON: clientDataJSON.toString("base64url"),
      signature: signature.toString("base64url"),
    };
  }
}

/* ----------------------------------------------------------- harness ---- */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "probe-accounts-"));

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function main() {
  const { createAccounts } = require("../lib/accounts");

  const sentMails = [];
  const full = createAccounts({
    stateDir: tmp(),
    sendMail: async (m) => sentMails.push(m),
    siteOrigin: "http://127.0.0.1:0", // placeholder; fixed after listen()
    onEvent: () => {},
  });
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use(full.router);
  const srv = await listen(app);
  const origin = `http://127.0.0.1:${srv.address().port}`;
  // The service compares Origin/rpId against what it was constructed with —
  // point it at the real ephemeral origin.
  full.service.siteOrigin = origin;
  full.service.rpId = "127.0.0.1";

  const call = async (pathname, { method = "GET", body, headers = {} } = {}) => {
    const r = await fetch(origin + pathname, {
      method: body !== undefined && method === "GET" ? "POST" : method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) };
  };

  console.log("\n1) email-code sign-in");
  let r = await call("/auth/email/start", { body: { email: "not-an-email" } });
  check(r.status === 400, "garbage email is refused");
  r = await call("/auth/email/start", { body: { email: "Owner@Example.COM" } });
  check(r.status === 200 && sentMails.length === 1, "code email actually sent through the transport");
  check(sentMails[0].to === "owner@example.com", "address normalized to lowercase");
  const code = (sentMails[0].text.match(/\b(\d{6})\b/) || [])[1];
  check(Boolean(code), "mail body carries a 6-digit code");
  r = await call("/auth/email/verify", { body: { email: "owner@example.com", code: "000000" } });
  check(r.status === 401 || code === "000000", "wrong code is refused");
  r = await call("/auth/email/verify", { body: { email: "owner@example.com", code } });
  check(r.status === 200 && r.data.account?.email === "owner@example.com", "right code signs in");
  check(String(r.headers.get("set-cookie")).includes("kai_session="), "and sets the session cookie");
  /*
   * The token must NOT be in the response body. It used to be, which put a
   * 30-day credential where page JavaScript could read it — and a session can
   * now authorise SPENDING through a grant, so that is a financial credential.
   * The cookie is httpOnly; the body carries nothing.
   */
  check(r.data.token === undefined, "the session token is NOT handed to page JavaScript");
  // Read it from the cookie, the way a browser would. The probe then uses it
  // as a Bearer to exercise the same lane the desktop app uses.
  const token = /kai_session=([^;]+)/.exec(String(r.headers.get("set-cookie")))?.[1];
  check(token?.startsWith("sk_"), "…and the cookie carries a real session token");
  const accountId = r.data.account.id;
  r = await call("/auth/email/verify", { body: { email: "owner@example.com", code } });
  check(r.status === 401, "a code is single-use");

  console.log("\n2) send rate limit per address");
  // The successful verify consumed the code row (single-use), which also
  // reset the send window — so build a fresh window of 3 sends here.
  await call("/auth/email/start", { body: { email: "owner@example.com" } });
  await call("/auth/email/start", { body: { email: "owner@example.com" } });
  await call("/auth/email/start", { body: { email: "owner@example.com" } });
  r = await call("/auth/email/start", { body: { email: "owner@example.com" } });
  check(r.status === 429, "4th send inside one window is throttled");

  console.log("\n3) sessions");
  const bearer = { authorization: `Bearer ${token}` };
  r = await call("/auth/session", { headers: bearer });
  check(r.status === 200 && r.data.account.email === "owner@example.com", "Bearer token authenticates");
  r = await call("/auth/session");
  check(r.status === 401, "no credentials -> 401");

  console.log("\n4) device link (the desktop app's flow)");
  r = await call("/auth/device/start", { body: {} });
  const dev = r.data;
  check(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(dev.userCode || ""), `human code shape (${dev.userCode})`);
  r = await call("/auth/device/poll", { body: { userCode: dev.userCode, deviceSecret: dev.deviceSecret } });
  check(r.status === 200 && r.data.pending === true, "poll before approval reports pending");
  r = await call("/auth/device/poll", { body: { userCode: dev.userCode, deviceSecret: "ds_wrong" } });
  check(r.status === 401, "poll with the wrong device secret is refused");
  r = await call("/auth/device/approve", { body: { userCode: dev.userCode }, headers: bearer });
  check(r.status === 200, "a signed-in browser approves the code");
  r = await call("/auth/device/poll", { body: { userCode: dev.userCode, deviceSecret: dev.deviceSecret } });
  check(r.status === 200 && r.data.token?.startsWith("sk_"), "the device receives its own session token");
  const appToken = r.data.token;
  r = await call("/auth/device/poll", { body: { userCode: dev.userCode, deviceSecret: dev.deviceSecret } });
  check(r.status === 404, "the code is consumed — single use");
  r = await call("/auth/session", { headers: { authorization: `Bearer ${appToken}` } });
  check(r.status === 200 && r.data.account.id === accountId, "the app token belongs to the same account");

  console.log("\n5) wallet link with a real koilib signature");
  const wallet = Signer.fromSeed("probe-accounts-wallet");
  const address = wallet.getAddress();
  const ts = Date.now();
  const hash = crypto.createHash("sha256").update(`link|${address}|${accountId}|${ts}`).digest();
  const signature = Buffer.from(await wallet.signHash(hash)).toString("base64");
  r = await call("/account/wallets", { body: { address, ts, signature }, headers: bearer });
  check(r.status === 200 && r.data.account.wallets.some((w) => w.address === address), "wallet linked");
  r = await call("/account/wallets", { body: { address, ts: Date.now(), signature }, headers: bearer });
  check(r.status === 400, "a signature for one ts cannot be replayed at another");
  r = await call("/account/wallets", { body: { address, ts: ts - 10 * 60 * 1000, signature }, headers: bearer });
  check(r.status === 400, "stale timestamps are refused");
  r = await call(`/account/wallets/${address}`, { method: "DELETE", headers: bearer });
  check(r.status === 200 && r.data.account.wallets.length === 0, "unlink works");

  console.log("\n6) passkeys — full ceremonies through a software authenticator");
  const authenticator = new SoftPasskey(origin, "127.0.0.1");
  r = await call("/auth/passkey/register/options", { body: {}, headers: bearer });
  check(r.status === 200 && r.data.publicKey.challenge, "registration options served");
  let cred = authenticator.create(r.data.publicKey);
  r = await call("/auth/passkey/register/verify", { body: { challengeId: r.data.challengeId, ...cred, label: "probe" }, headers: bearer });
  check(r.status === 200, "registration verified — CBOR/COSE/authData all parsed");
  r = await call("/auth/passkey/register/verify", { body: { challengeId: "nope", ...cred }, headers: bearer });
  check(r.status === 400, "a registration cannot be replayed (challenge is single-use)");

  r = await call("/auth/passkey/login/options", { body: {} });
  let login = authenticator.get(r.data.publicKey, { tamper: true });
  let rr = await call("/auth/passkey/login/verify", { body: { challengeId: r.data.challengeId, ...login } });
  check(rr.status >= 400, "a tampered assertion signature is refused");
  r = await call("/auth/passkey/login/options", { body: {} });
  login = authenticator.get(r.data.publicKey, { wrongOrigin: true });
  rr = await call("/auth/passkey/login/verify", { body: { challengeId: r.data.challengeId, ...login } });
  check(rr.status >= 400, "a wrong-origin assertion is refused");
  r = await call("/auth/passkey/login/options", { body: { email: "owner@example.com" } });
  check((r.data.publicKey.allowCredentials || []).length === 1, "login options list the registered credential for the email");
  login = authenticator.get(r.data.publicKey);
  rr = await call("/auth/passkey/login/verify", { body: { challengeId: r.data.challengeId, ...login } });
  check(rr.status === 200 && rr.data.account.id === accountId, "genuine passkey assertion signs in to the right account");

  console.log("\n7) degraded modes + CSRF posture");
  const bare = createAccounts({ stateDir: tmp(), sendMail: null, siteOrigin: origin, onEvent: () => {} });
  const bareApp = express();
  bareApp.use(express.json());
  bareApp.use(bare.router);
  const bareSrv = await listen(bareApp);
  const bareOrigin = `http://127.0.0.1:${bareSrv.address().port}`;
  let br = await fetch(`${bareOrigin}/auth/email/start`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }),
  });
  check(br.status === 503 && (await br.json()).error.includes("SMTP_HOST"), "no SMTP -> 503 naming the env var to set");
  br = await fetch(`${bareOrigin}/auth/google`, { redirect: "manual" });
  check(br.status === 503, "no Google config -> 503");

  /*
   * /auth/methods — the answer to "what do I need to do to get account
   * creation working?", served by the thing that actually knows. A 503 on
   * click is a bad way to learn a method is switched off.
   */
  br = await fetch(`${bareOrigin}/auth/methods`);
  let cap = await br.json();
  check(br.status === 200 && cap.ok === true, "/auth/methods answers without a session");
  check(cap.signin.passkey === true && cap.signin.email === false && cap.signin.google === false,
        "an unconfigured server reports exactly which doors are open");
  check(cap.signup.passkey === false,
        "a passkey is never listed as a way to CREATE an account — it needs one to attach to");
  check(cap.canCreateAccount === false, "no email and no Google means nobody can sign up, and it says so");
  check(cap.missing.includes("SMTP_HOST") && cap.missing.includes("GOOGLE_CLIENT_ID"),
        "the gap is reported as env NAMES to set");
  // Env NAMES are the point of `missing` (GOOGLE_CLIENT_SECRET is a name, not
  // a secret). What must never appear is a VALUE: a host, an address, a key.
  check(!/@|https?:|\d{1,3}(\.\d{1,3}){3}/.test(JSON.stringify(cap).replace(/"[A-Z_]+"/g, '""')),
        "no host, address or URL is leaked by the capability report");
  bareSrv.close();

  // Configured the other way: email on, Google on -> signup is possible.
  const bothOn = createAccounts({
    stateDir: tmp(), sendMail: async () => {}, siteOrigin: origin,
    google: { clientId: "test-client-id", clientSecret: "test-secret" }, onEvent: () => {},
  });
  const bothOnApp = express();
  bothOnApp.use(express.json());
  bothOnApp.use(bothOn.router);
  const bothOnSrv = await listen(bothOnApp);
  cap = await (await fetch(`http://127.0.0.1:${bothOnSrv.address().port}/auth/methods`)).json();
  check(cap.signup.email === true && cap.signup.google === true && cap.canCreateAccount === true,
        "with SMTP and Google configured, both signup doors report open");
  check(cap.missing.length === 0, "nothing missing when both are configured");
  check(!JSON.stringify(cap).includes("test-client-id"), "the client id is never echoed back");
  bothOnSrv.close();

  // Cookie-authenticated mutation from a foreign origin must be refused.
  const cookieHeader = { cookie: `kai_session=${encodeURIComponent(token)}`, origin: "https://evil.example" };
  r = await call("/auth/device/approve", { body: { userCode: "AAAA-AAAA" }, headers: cookieHeader });
  check(r.status === 403, "cross-site cookie-authed mutation -> 403");
  r = await call("/auth/logout", { body: {}, headers: bearer });
  check(r.status === 200, "logout");
  r = await call("/auth/session", { headers: bearer });
  check(r.status === 401, "revoked token no longer authenticates");

  /*
   * YOUR NODES — the account page's join of linked wallets to live workers.
   *
   * The join is only free because the address a wallet LINKS with is
   * byte-identical to the one its worker REGISTERS with. That is the load-
   * bearing assumption of the whole feature, so it is asserted here against
   * both real code paths rather than believed.
   */
  console.log("\n8) your nodes — linked wallet joined to its worker row");
  {
    const { Scheduler } = require("../lib/scheduler");
    const sched = new Scheduler({ dataDir: tmp(), onEvent: () => {} });
    const schedPort = await sched.listen();

    // A worker registers over the REAL endpoint with the SAME address the
    // wallet linked with above. That identity is the whole feature.
    const reg = await fetch(`http://127.0.0.1:${schedPort}/worker/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, models: ["koinos-fast"], capabilities: { ramGb: 16, cudaEligible: true } }),
    })
      .then((x) => x.json())
      .catch(() => null);

    const joinApp = express();
    joinApp.use(express.json());
    joinApp.use(full.router);
    joinApp.get("/account/api/nodes", (req, res) => {
      const account = full.requireAccount(req, res);
      if (!account) return;
      const live = (() => { try { return sched.statsPublic({ detail: true }).workers || []; } catch { return []; } })();
      const wallets = full.service.accountView(account).wallets || [];
      res.json({
        ok: true,
        nodes: wallets.map((w) => {
          const on = live.find((x) => x.address === w.address) || null;
          return on
            ? { address: w.address, online: true, models: on.models || [], ramGb: on.ram ?? null }
            : { address: w.address, online: false, models: [] };
        }),
      });
    });
    const joinSrv = await listen(joinApp);
    const joinOrigin = `http://127.0.0.1:${joinSrv.address().port}`;

    // Section 7 logged out and section 4 unlinked the wallet, so re-establish
    // both rather than reusing state this probe has already torn down.
    const nodeToken = full.service._issueSession(accountId, "probe (your nodes)");
    {
      const ts2 = Date.now();
      const h2 = crypto.createHash("sha256").update(`link|${address}|${accountId}|${ts2}`).digest();
      const sig = Buffer.from(await wallet.signHash(h2)).toString("base64");
      await fetch(`${origin}/account/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${nodeToken}` },
        body: JSON.stringify({ address, ts: ts2, signature: sig }),
      });
    }

    // requireAccount is EXPORTED, not re-derived — a lookalike gate is one
    // forgotten crossSite check away from being a CSRF hole.
    check(typeof full.requireAccount === "function", "createAccounts exports requireAccount for in-process reuse");

    let nr = await fetch(`${joinOrigin}/account/api/nodes`);
    check(nr.status === 401, "your-nodes refuses an anonymous caller");

    nr = await fetch(`${joinOrigin}/account/api/nodes`, { headers: { authorization: `Bearer ${nodeToken}` } });
    const nodes = (await nr.json()).nodes || [];
    check(nr.status === 200 && nodes.length >= 1, "a signed-in caller gets a row per linked wallet");
    const mine = nodes.find((n) => n.address === address);
    check(Boolean(mine), "the row is keyed by the FULL address, not a truncated form");
    if (reg) {
      check(mine?.online === true, "a live worker on that address joins to the wallet");
      check((mine?.models || []).includes("koinos-fast"), "and its advertised models come through");
      check(mine?.ramGb === 16, "…along with the memory the machine reported");
    }
    // Nobody sees anybody else's node.
    check(
      nodes.every((n) => n.address === address),
      "the join is filtered to the caller's own wallets — no other worker leaks"
    );
    joinSrv.close();
    sched.server?.close();
  }

  /*
   * SPEND GRANTS — the seam the web app spends through.
   *
   * The distinction under test: LINKING proves you own a wallet once;
   * GRANTING says a site may draw on it, capped and dated. Conflating them
   * would invent consent nobody gave, so the two proofs must not be
   * interchangeable in either direction.
   */
  console.log("\n9) spend grants — capped, dated, revocable, and NOT a link proof");
  {
    const gToken = full.service._issueSession(accountId, "probe (grants)");
    const gb = { authorization: `Bearer ${gToken}` };
    const sign = async (msg) =>
      Buffer.from(await wallet.signHash(crypto.createHash("sha256").update(msg).digest())).toString("base64");
    const grant = async (over = {}) => {
      const body = {
        address,
        maxMicro: 5 * 1e6,
        expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        ts: Date.now(),
        ...over,
      };
      if (!("signature" in over)) {
        body.signature = await sign(`spend|${body.address}|${accountId}|${Math.floor(body.maxMicro)}|${Math.floor(body.expiresAt)}|${body.ts}`);
      }
      return call("/account/grants", { body, headers: gb });
    };

    // A grant needs a linked wallet first — spending authority cannot precede
    // proof of ownership.
    r = await call(`/account/wallets/${address}`, { method: "DELETE", headers: gb });
    let g = await grant();
    check(g.status === 409, "granting on an unlinked wallet is refused");
    {
      const ts3 = Date.now();
      const sig3 = Buffer.from(await wallet.signHash(crypto.createHash("sha256").update(`link|${address}|${accountId}|${ts3}`).digest())).toString("base64");
      await call("/account/wallets", { body: { address, ts: ts3, signature: sig3 }, headers: gb });
    }

    g = await grant();
    check(g.status === 200 && g.data.grant?.live === true, "a signed grant is created and live");
    const grantId = g.data.grant?.id;
    check(g.data.grant?.maxUsd === 5 && g.data.grant?.remainingUsd === 5, "the cap is recorded in dollars, unspent");

    // A LINK proof must never be accepted as a SPEND proof. The verb in the
    // signed message is what separates them.
    const linkTs = Date.now();
    const linkSig = await sign(`link|${address}|${accountId}|${linkTs}`);
    g = await grant({ ts: linkTs, signature: linkSig });
    check(g.status === 400, "a LINK signature is refused as a spend grant");

    // Terms are pinned by the signature: raising the cap after signing fails.
    const ts4 = Date.now();
    const sig4 = await sign(`spend|${address}|${accountId}|${5 * 1e6}|${Date.now() + 86400000}|${ts4}`);
    g = await grant({ maxMicro: 500 * 1e6, ts: ts4, signature: sig4 });
    check(g.status === 400, "a signature for one cap cannot authorise a bigger one");

    g = await grant({ maxMicro: 0 });
    check(g.status === 400, "a zero cap is refused");
    g = await grant({ maxMicro: 5000 * 1e6 });
    check(g.status === 400, "an absurd cap is refused");
    g = await grant({ expiresAt: Date.now() - 1000 });
    check(g.status === 400, "an expiry in the past is refused");

    // Resolution + charging, the path money actually takes.
    const live = full.service.spendableGrant(accountId, grantId);
    check(live.address === address && live.remainingMicro === 5 * 1e6, "a live grant resolves to its address and remaining cap");
    full.service.chargeGrant(grantId, 2 * 1e6);
    check(full.service.spendableGrant(accountId, grantId).remainingMicro === 3 * 1e6, "spend is booked against the cap");
    let capped = false;
    try { full.service.chargeGrant(grantId, 10 * 1e6); } catch { capped = true; }
    check(capped, "a charge past the cap is REFUSED, not silently allowed");
    check(full.service.spendableGrant(accountId, grantId).remainingMicro === 3 * 1e6, "…and the refusal booked nothing");

    // Another account cannot resolve someone else's grant.
    const other = full.service._newAccount({ email: `other-${Date.now()}@example.com` });
    let leaked = false;
    try { full.service.spendableGrant(other.id, grantId); leaked = true; } catch { /* expected */ }
    check(!leaked, "a grant cannot be resolved by a different account");

    // Revocation, and the fact that unlinking kills spending authority.
    r = await call(`/account/grants/${grantId}`, { method: "DELETE", headers: gb });
    check(r.status === 200, "a grant can be revoked");
    let dead = false;
    try { full.service.spendableGrant(accountId, grantId); } catch { dead = true; }
    check(dead, "a revoked grant no longer resolves");

    g = await grant();
    const g2 = g.data.grant?.id;
    r = await call(`/account/wallets/${address}`, { method: "DELETE", headers: gb });
    let killedByUnlink = false;
    try { full.service.spendableGrant(accountId, g2); } catch { killedByUnlink = true; }
    check(killedByUnlink, "unlinking a wallet revokes its spending grant");
  }

  /*
   * SESSION CONTROL. Before this there was no way to see what was signed in
   * as you, and no way to end it — on a system where a session can now spend.
   * "I think someone has my account" had no answer.
   */
  console.log("\n10) sessions can be seen and ended");
  {
    const t1 = full.service._issueSession(accountId, "probe (one)");
    const t2 = full.service._issueSession(accountId, "probe (two)");
    const h1 = { authorization: `Bearer ${t1}` };

    r = await call("/account/sessions", { headers: h1 });
    check(r.status === 200 && r.data.sessions.length >= 2, "a signed-in caller can list their live sessions");
    const mine = r.data.sessions.find((x) => x.current);
    check(Boolean(mine), "the session making the request is marked current");
    check(
      r.data.sessions.every((x) => /^[0-9a-f]{12}$/.test(x.id)) &&
        !JSON.stringify(r.data.sessions).includes(t1) &&
        !JSON.stringify(r.data.sessions).includes(t2),
      "the list carries handles, never the tokens themselves"
    );
    check(r.data.sessions.some((x) => x.label === "probe (two)"), "each session is labelled well enough to recognise");

    const other = r.data.sessions.find((x) => !x.current);
    r = await call(`/account/sessions/${other.id}`, { method: "DELETE", headers: h1 });
    check(r.status === 200, "one session can be ended by its handle");
    check(full.service.sessionAccount(t2) === null || full.service.sessionAccount(t1) === null, "…and that token stops working");

    // Sign out everywhere must also kill spending authority — a stolen
    // session whose grant survives is still a live drain.
    const ts5 = Date.now();
    const sig5 = Buffer.from(await wallet.signHash(crypto.createHash("sha256").update(`link|${address}|${accountId}|${ts5}`).digest())).toString("base64");
    await call("/account/wallets", { body: { address, ts: ts5, signature: sig5 }, headers: h1 });
    const gExp = Date.now() + 3600000;
    const gTs = Date.now();
    const gSig = Buffer.from(await wallet.signHash(crypto.createHash("sha256").update(`spend|${address}|${accountId}|${1000000}|${gExp}|${gTs}`).digest())).toString("base64");
    const gr = await call("/account/grants", { body: { address, maxMicro: 1000000, expiresAt: gExp, ts: gTs, signature: gSig }, headers: h1 });
    check(gr.status === 200, "a grant exists before signing out everywhere");

    r = await call("/account/sessions/revoke-all", { body: {}, headers: h1 });
    check(r.status === 200 && r.data.sessions >= 1, "sign out everywhere ends every session");
    check(r.data.grants >= 1, "…AND revokes spending grants, not just sessions");
    check(full.service.sessionAccount(t1) === null, "the calling session is gone too");
    let stillSpendable = false;
    try { full.service.spendableGrant(accountId, gr.data.grant.id); stillSpendable = true; } catch { /* expected */ }
    check(!stillSpendable, "the grant cannot spend after signing out everywhere");
  }

  console.log("\n11) server.js actually mounts all of this");
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  check(serverSrc.includes("createAccounts"), "server.js constructs the accounts service");
  check(serverSrc.includes("account.html"), "server.js serves the /account + /link page");
  check(serverSrc.includes("/account/api/nodes"), "server.js serves the your-nodes join");
  check(
    serverSrc.includes("accounts?.requireAccount?.(req, res)"),
    "…gated by the EXPORTED requireAccount, not a hand-rolled second gate"
  );

  srv.close();
  console.log(failures ? `\nACCOUNTS PROBE FAILED (${failures})` : "\nACCOUNTS PROBE PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
