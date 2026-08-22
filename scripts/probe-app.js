"use strict";

/*
 * Probe: the Koinos AI web app shell (/app) — task #79.
 *
 * Boots the REAL server (child process, throwaway state dir, random port) and
 * pins the property the whole design rests on:
 *
 *   THE SHELL IS NOT IN THE STATIC TREE.
 *
 * `app.use(express.static(PUBLIC_DIR))` serves that directory to the open
 * internet. A gated page cannot live inside it — not "should not", CANNOT.
 * So the shell lives in views/, reachable through exactly one route, and that
 * route asks who you are first. Section 2 tries every spelling an attacker
 * would try (/app.html, /views/app.html, a traversal) and every one must miss.
 *
 * The rest: the gate redirects a signed-out browser to a door instead of
 * handing it a JSON error it will render as text; a signed-in browser gets the
 * shell with a CSP that has no 'unsafe-inline' in script-src and headers that
 * keep it out of caches and frames; the account view carries the grants the
 * shell renders; and the client script is genuinely servable, because a shell
 * whose <script> 404s is a blank page.
 *
 * Sessions are written straight into the accounts DB rather than driven
 * through the sign-in flow: this probe is about the ROUTE's gate, and
 * probe-accounts.js already walks email/passkey/Google end to end against a
 * mock transport. Boring beats duplicated.
 *
 * Old code (no /app route, no views/app.html): sections 1-6 fail.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

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
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

/** Raw request: no redirect following, so a 302 stays visible. */
const raw = (port, reqPath, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, headers: headers || {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });

async function main() {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-app-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(port), KAI_STATE_DIR: stateDir, KAI_SITE_ORIGIN: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});

  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await raw(port, "/api/health").then((r) => r.status === 200).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    check(up, "server boots");
    if (!up) return;

    /* ------------------------------------------------------------------ */
    console.log("\n1) the shell is gated");
    const anon = await raw(port, "/app");
    check(anon.status === 302, `signed out -> redirect (got ${anon.status})`);
    check(String(anon.headers.location || "").startsWith("/account"), "redirect points at the sign-in page");
    check(!/view-gate|nav-item/.test(anon.body), "the shell's markup does not leak in the redirect body");
    // The desktop app talks JSON; a browser asking for a page gets a door.
    // What must never happen is the shell rendering for an anonymous caller.
    check(anon.status !== 200, "no 200 without a session");

    /* ------------------------------------------------------------------ */
    console.log("\n2) the shell is NOT reachable through the static tree");
    check(!fs.existsSync(path.join(ROOT, "public", "app.html")), "public/app.html does not exist on disk");
    check(fs.existsSync(path.join(ROOT, "views", "app.html")), "views/app.html does exist");
    for (const spelling of [
      "/app.html",
      "/views/app.html",
      "/app/app.html",
      "/app/index.html",
      "/../views/app.html",
    ]) {
      const r = await raw(port, spelling);
      const leaked = r.status === 200 && /id="view-gate"/.test(r.body);
      check(!leaked, `${spelling} does not serve the shell (${r.status})`);
    }

    /* ------------------------------------------------------------------ */
    console.log("\n3) a real session gets in");
    // Write an account + session directly into the DB the server just opened.
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(stateDir, "accounts", "accounts.sqlite"));
    const accountId = "acc_probe_" + crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    db.prepare("INSERT INTO accounts (id, email, created_at, last_seen_at) VALUES (?,?,?,?)")
      .run(accountId, "probe@example.test", t, t);
    const token = "sk_" + crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (token_hash, account_id, label, created_at, expires_at, last_used_at) VALUES (?,?,?,?,?,?)")
      .run(sha256hex(token), accountId, "probe", t, t + 3600e3, t);
    const cookie = { cookie: `kai_session=${encodeURIComponent(token)}` };

    const shell = await raw(port, "/app", cookie);
    check(shell.status === 200, `signed in -> 200 (got ${shell.status})`);
    check(/id="view-gate"/.test(shell.body) && /id="view-wallet"/.test(shell.body), "the shell body is the shell");
    check(/src="\/app\/app\.js"/.test(shell.body), "the shell loads its client script");

    /* ------------------------------------------------------------------ */
    console.log("\n4) headers a signed-in page needs");
    const h = shell.headers;
    const csp = String(h["content-security-policy"] || "");
    check(csp.includes("script-src 'self'"), "CSP pins script-src to self");
    check(!/script-src[^;]*unsafe-inline/.test(csp), "CSP has no 'unsafe-inline' in script-src");
    check(csp.includes("frame-ancestors 'none'"), "CSP forbids framing");
    check(csp.includes("object-src 'none'") && csp.includes("base-uri 'none'"), "CSP closes object-src and base-uri");
    check(String(h["x-frame-options"] || "").toUpperCase() === "DENY", "X-Frame-Options: DENY");
    check(/no-store/.test(String(h["cache-control"] || "")), "Cache-Control: no-store");
    check(/noindex/.test(String(h["x-robots-tag"] || "")), "X-Robots-Tag: noindex");
    check(String(h["x-content-type-options"] || "") === "nosniff", "nosniff");
    // A CSP with no inline-script escape hatch is only honest if the page has
    // no inline script to need one. Assert the shell actually has none.
    const shellSrc = fs.readFileSync(path.join(ROOT, "views", "app.html"), "utf8");
    check(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(shellSrc),
      "the shell contains no inline script (so the strict CSP is not a lie)");
    check(!/\son[a-z]+\s*=/.test(shellSrc), "the shell uses no inline event handlers");

    /* ------------------------------------------------------------------ */
    console.log("\n5) the client script serves");
    const js = await raw(port, "/app/app.js");
    check(js.status === 200, `/app/app.js -> 200 (got ${js.status})`);
    check(/javascript/.test(String(js.headers["content-type"] || "")), "served as javascript, not sniffed");
    check(/liveGrant|paintWallet/.test(js.body), "it is the real client");
    // Ungated on purpose (see server.js) — but that only holds because it has
    // no authority of its own. Nothing in it may sign or hold a key.
    check(!/signHash|signMessage|signTransaction|privateKey|Signer\(/.test(js.body),
      "the client neither signs nor holds a key");

    /* ------------------------------------------------------------------ */
    console.log("\n6) the account view carries what the shell renders");
    const me = await raw(port, "/account/api", cookie);
    check(me.status === 200, "/account/api answers for the session");
    const acct = JSON.parse(me.body).account;
    check(Array.isArray(acct.grants), "accountView includes grants[]");
    check(acct.grants.length === 0, "a fresh account has no grants (so the shell gates)");

    // Now give it one and prove the shape the shell reads is really there.
    const addr = "1ProbeAddressNotReal" + crypto.randomBytes(3).toString("hex");
    db.prepare("INSERT INTO wallets (address, account_id, linked_at) VALUES (?,?,?)").run(addr, accountId, t);
    db.prepare("INSERT INTO spend_grants (id, account_id, address, max_micro, spent_micro, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run("gr_probe", accountId, addr, 5 * 1e6, 1 * 1e6, t, t + 86400e3);
    const me2 = JSON.parse((await raw(port, "/account/api", cookie)).body).account;
    const g = me2.grants[0];
    check(!!g && g.live === true, "the grant reports live");
    check(g.maxUsd === 5 && g.spentUsd === 1 && g.remainingUsd === 4, "usd fields the wallet view renders are right");
    check(g.address === addr, "the grant names its wallet");
    db.close();

    /* ------------------------------------------------------------------ */
    console.log("\n7) the account page can END web access, and cannot create it");
    /*
     * The asymmetry is the design: creating a grant needs the wallet's
     * signature, which only the machine holding the key can produce. Ending
     * one needs no key — just the session. So this page must offer revoke and
     * must NOT pretend to offer create, or someone will click a button that
     * cannot work and conclude the feature is broken.
     */
    const acctPage = await raw(port, "/account", cookie);
    check(acctPage.status === 200, "the account page serves");
    check(/Web access/.test(acctPage.body), "it has a web-access section");
    check(/Signed-in browsers/.test(acctPage.body), "…and a signed-in-browsers section");
    check(/\/account\/grants\//.test(acctPage.body), "it calls the grant revoke route");
    check(/\/account\/sessions/.test(acctPage.body), "…and the session routes");
    check(!/\/account\/grants["'`]\s*,\s*\{/.test(acctPage.body),
      "and never POSTs a grant — this page has nothing to sign with");
    check(/desktop app/i.test(acctPage.body), "it says where a grant IS created");

    /* ------------------------------------------------------------------ */
    console.log("\n8) the phone layout, where this app was actually first used");
    /*
     * Textual, because these are stylesheet and event-handler facts rather
     * than HTTP ones — but each pins a specific thing that WAS wrong on a
     * real phone, so a silent regression is what these exist to catch.
     */
    const shellCss = fs.readFileSync(path.join(ROOT, "views", "app.html"), "utf8");
    const clientJs = fs.readFileSync(path.join(ROOT, "views", "app.js"), "utf8");
    const phone = shellCss.slice(shellCss.indexOf("@media (max-width:760px)"));
    check(phone.length > 200, "there is a phone block at all");

    // 100% of a viewport that resizes with the URL bar scrolls the whole PAGE,
    // taking the nav with it.
    check(/height:100dvh/.test(phone), "the phone layout is sized in dvh, not %");

    /*
     * The balance is PLACED by the grid, not pushed by an auto margin. It
     * used to be shoved right with margin-left:auto inside the horizontally
     * scrolling nav row, which put it in the overflow rather than on screen.
     * It now has its own cell beside the nav, and the nav is the half that
     * scrolls if anything has to.
     */
    const tight = phone.replace(/\s+/g, "");
    check(/\.foot\{grid-column:2;grid-row:2/.test(tight),
      "the balance has its own grid cell beside the nav");
    check(!/\.foot\{[^}]*margin:0 0 0 auto/.test(tight) && !/\.foot\{[^}]*margin-left:auto/.test(tight),
      "…and is not pushed there by an auto margin, which is how it got lost");
    check(/nav\{grid-column:1;grid-row:2/.test(tight), "the nav shares that row rather than owning one");

    // The email answers a question you ask once; the balance answers one that
    // is live. Only the second earns permanent space on a phone.
    // Whitespace-stripped, `.foot p,.foot #who` keeps its inner space because
    // the descendant combinator IS a space — matching on the id alone is both
    // simpler and the thing actually being asserted.
    check(/#who\{display:none\}/.test(tight.replace(/,\s*/g, ",")) || /#who[^{]*\{display:none\}/.test(phone.replace(/\n/g, "")),
      "the email is not in the phone header");

    // A phone's Enter key is a newline and there is no Shift to hold, so
    // Enter-to-send fired the message on the first paragraph break.
    const enters = clientJs.match(/e\.key === "Enter"[^}]*?\)/g) || [];
    check(enters.length >= 2, `both composers handle Enter (${enters.length})`);
    check(enters.every((h) => h.includes("!narrow()")),
      "…and neither sends on Enter on a phone");

    // The long placeholder ran past the single visible row and was cut
    // mid-word; it is set from JS so the phone gets a short one.
    check(/placeholder = narrow\(\)/.test(clientJs), "the placeholder shortens on a phone");
    // The markup ships the SHORT one so the first paint is right at any
    // width; JS adds the keyboard hint on a wide screen.
    check(/placeholder="Ask anything…"/.test(shellCss), "…and the markup ships the short one, so nothing flashes");

    // The conversation list ate a third of the screen before a word of the
    // answer. It collapses, and it must be able to open again.
    check(/chat-list\.collapsed \.chat-row\{display:none\}/.test(phone.replace(/\s+/g, " ").replace(/ \{/g, "{").replace(/\{ /g, "{")),
      "the conversation list collapses on a phone");
    check(/classList\.toggle\("open"\)/.test(clientJs), "…and a control opens it again");

    // The collapse control is phone-only and had NO base rule, so a desktop
    // rendered the raw browser-default button above the rail. Shipped that
    // way in the first phone pass and only caught it by rendering at 1280.
    check(/\.chat-switch\{display:none\}/.test(shellCss.replace(/\s+/g, "")),
      "the collapse control is hidden at desktop width");

    // Docs is the same rail with the same problem: five documents ate the top
    // third of the screen above the editor, with no way to fold them away.
    check(/id="doc-switch"/.test(clientJs), "the document list collapses too");
    check(/No documents yet/.test(clientJs), "…and says so when there is nothing to switch to");
    // Same long-placeholder cut as the chat composer had.
    check(/placeholder = narrow\(\)\s*\n?\s*\?\s*"Ask about this document…"/.test(clientJs)
      || /narrow\(\)[\s\S]{0,40}"Ask about this document…"/.test(clientJs),
      "the docs placeholder shortens on a phone");
    check(/placeholder="Ask about this document…"/.test(shellCss),
      "…and the markup ships the short one there too");

    /* ------------------------------------------------------------------ */
    console.log("\n9) a wider window is never a worse one");

    /*
     * The memory rail used to appear at max-width:900, on top of the two
     * rails already there — so dragging a window from 899 to 901 took the
     * conversation from 479px to 231px and it did not recover until ~1170.
     * Widening the window made the chat worse.
     *
     * Rather than pin the number, assert the arithmetic that produced it, so
     * this still holds if any of the three widths is ever changed: the rail
     * may only appear once what is left over is wider than the conversation
     * was just before it appeared.
     */
    const px = (re) => { const m = shellCss.match(re); return m ? Number(m[1]) : null; };
    const asideW = px(/aside\{width:(\d+)px/);
    const railW = px(/\n\.chat-list\{width:(\d+)px/);
    const memW = px(/\.memory-panel\{width:(\d+)px/);
    const memAt = px(/@media \(max-width:(\d+)px\)\{\.memory-panel\{display:none\}\}/);
    check([asideW, railW, memW, memAt].every((n) => typeof n === "number"),
      `the three rail widths and the breakpoint are all readable (${asideW}/${railW}/${memW} @ ${memAt})`);
    if (asideW && railW && memW && memAt) {
      const withRail = memAt + 1 - asideW - railW - memW;   // conversation the moment it appears
      const without = memAt - asideW - railW;               // conversation one pixel earlier
      const before900 = 900 - asideW - railW;               // what it used to get at the old breakpoint
      check(withRail >= before900,
        `the memory rail waits until the conversation can afford it — ${withRail}px, vs ${before900}px at the old 900 breakpoint`);
      check(without > withRail, `…and it is genuinely a trade (${without}px without it)`);
    }

    /* ------------------------------------------------------------------ */
    console.log("\n10) the conversation scrolls, the page does not");

    // The whole document used to scroll: the composer rode off the bottom of
    // the screen and you had to scroll back down to type. A flex item defaults
    // to min-height:auto, so every ancestor of the thread grew to fit the full
    // conversation instead of capping it. The scroller only exists if the
    // chain above it is allowed to shrink.
    const flat = shellCss.replace(/\s+/g, "");
    for (const rule of ["\nmain{flex:1;min-width:0;min-height:0", ".chat-main{flex:1;min-width:0;min-height:0"]) {
      check(flat.includes(rule.replace(/\s+/g, "")),
        `${rule.trim().split("{")[0]} may shrink below its content`);
    }
    check(/\.thread\{[^}]*overflow-y:auto/.test(flat), "the thread itself is the scroller");
    // Both of these sit below the thread; if either can be squeezed the
    // composer stops being pinned and starts drifting.
    check(/\.composer\{[^}]*flex:0 0 auto/.test(shellCss.replace(/\n/g, "")), "the composer keeps its height");
    check(/\.composer-note\{[^}]*flex:0 0 auto/.test(shellCss.replace(/\n/g, "")), "…and so does the note under it");

    // Following the answer as it streams is the default, but it is the
    // READER's call. Scrolling up has to interrupt it, and scrolling back to
    // the bottom has to resume it — a repaint that always jumped to the end
    // made reading anything above the fold impossible mid-answer.
    check(/chat\.stick/.test(clientJs), "the client tracks whether the reader is at the bottom");
    check(/if \(chat\.stick\) t\.scrollTop = t\.scrollHeight/.test(clientJs),
      "…and only follows the text when they are");
    check(/addEventListener\("scroll"[\s\S]{0,200}chat\.stick = atBottom/.test(clientJs),
      "scrolling away turns following off, scrolling back turns it on");
    // innerHTML resets scrollTop to 0, which fires a scroll event that looks
    // exactly like the reader jumping to the top. Without the guard the first
    // repaint of a streaming answer would unstick it.
    check(/chat\.painting = true/.test(clientJs) && /if \(!chat\.painting\)/.test(clientJs),
      "…and a repaint is not mistaken for the reader scrolling");

    /* ------------------------------------------------------------------ */
    console.log("\n11) crawlers are told to stay out");
    const robots = await raw(port, "/robots.txt");
    check(/^Disallow: \/app$/m.test(robots.body), "robots.txt disallows /app");

    /* ------------------------------------------------------------------ */
    console.log("\n12) server.js wiring, textually");
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    check(/VIEWS_DIR, "app\.html"/.test(src), "the shell is resolved out of VIEWS_DIR");
    check(!/PUBLIC_DIR, "app\.html"/.test(src), "and never out of PUBLIC_DIR");
    check(/accounts\.accountOf\(req\)/.test(src), "the /app gate reuses the exported resolver");
    const acc = fs.readFileSync(path.join(ROOT, "lib", "accounts.js"), "utf8");
    check(/const account = accountOf\(req\)/.test(acc), "requireAccount is built on that same resolver, not beside it");
  } finally {
    child.kill("SIGTERM");
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
