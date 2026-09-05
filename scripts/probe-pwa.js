"use strict";

/*
 * Probe: the web app is installable — add to homescreen, open without browser
 * chrome. Owner request, 2026-09-05.
 *
 * Boots the REAL server and checks the three things a browser actually looks
 * at, because "I added a manifest" and "the install prompt appears" are
 * different claims and only the second one is what was asked for.
 *
 * The failure this exists to catch is silent by nature. When a manifest is
 * unreachable, malformed, or missing a required icon size, browsers do not
 * report it anywhere the developer will see — the install option simply never
 * appears, and everything else about the page looks perfect. So every rule
 * below is asserted here rather than trusted.
 *
 * Two of them are worth naming, because they are the ones that would have
 * bitten:
 *
 *   THE MANIFEST MUST BE UNGATED. Browsers fetch it WITHOUT credentials
 *   unless the <link> says crossorigin="use-credentials". Behind /app's
 *   session gate it would come back as a 302 to the sign-in page, and the
 *   app would simply never be installable, with nothing in the console.
 *
 *   THE WORKER MUST NOT CACHE THE APP. The shell is per-account and
 *   `no-store`; app.js and the API are a matched pair; the API carries
 *   balances. A worker that cached any of those would serve one person's
 *   page to the next, or a stale balance stated confidently. Section 4 reads
 *   the worker's source and refuses the patterns that would do it.
 *
 * Old code (no manifest, no worker, no icons): sections 1-5 fail.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
}

const ROOT = path.join(__dirname, "..");

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const raw = (port, reqPath, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });

async function main() {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-pwa-"));
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
    console.log("\n1) the manifest is reachable WITHOUT a session");
    const m = await raw(port, "/app/manifest.webmanifest");
    check(m.status === 200, "200 for an anonymous caller", `got ${m.status}`);
    check(
      String(m.headers["content-type"] || "").startsWith("application/manifest+json"),
      "served as application/manifest+json",
      String(m.headers["content-type"])
    );

    let man = null;
    try { man = JSON.parse(m.body.toString("utf8")); } catch { /* stays null */ }
    check(!!man, "manifest is valid JSON");
    if (!man) return;

    /* ------------------------------------------------------------------ */
    console.log("\n2) the manifest says what a browser needs to install it");
    check(typeof man.name === "string" && man.name.length > 0, "has name", man.name);
    check(typeof man.short_name === "string" && man.short_name.length <= 12, "short_name fits a homescreen label", man.short_name);
    check(man.start_url === "/app", "start_url is the app", man.start_url);
    check(man.display === "standalone", "display: standalone — this is the 'without the browser' bit", man.display);
    check(/^#[0-9a-f]{6}$/i.test(man.background_color || ""), "background_color set (the splash)", man.background_color);
    check(/^#[0-9a-f]{6}$/i.test(man.theme_color || ""), "theme_color set (the system bars)", man.theme_color);

    /*
     * scope MUST cover /account. Sign-in lives there, and a scope of "/app"
     * would push an expired session out into a browser tab — leaving the
     * installed app on a dead end that looks like it crashed.
     */
    check(man.scope === "/", "scope covers /account so sign-in stays inside the app", man.scope);

    const sizes = (man.icons || []).map((i) => i.sizes);
    check(sizes.includes("192x192"), "has a 192x192 icon (required)", sizes.join(" "));
    check(sizes.includes("512x512"), "has a 512x512 icon (required)");
    check(
      (man.icons || []).some((i) => String(i.purpose || "").split(/\s+/).includes("maskable")),
      "has a maskable icon, so Android does not letterbox it in a white circle"
    );

    /* ------------------------------------------------------------------ */
    console.log("\n3) every icon the manifest promises actually exists");
    for (const icon of man.icons || []) {
      const r = await raw(port, icon.src);
      const isPng = r.body.length > 8 && r.body.readUInt32BE(0) === 0x89504e47;
      check(r.status === 200 && isPng, `${icon.src} is a real PNG`, `${r.status}, ${r.body.length} bytes`);
      // The declared size has to be the true size: a browser that asks for
      // 512 and gets 192 renders it blurry on the splash screen.
      if (isPng) {
        const w = r.body.readUInt32BE(16);
        const h = r.body.readUInt32BE(20);
        check(`${w}x${h}` === icon.sizes, `${icon.src} is really ${icon.sizes}`, `${w}x${h}`);
      }
    }
    // iOS ignores the manifest for this one and looks only at the <link>.
    const apple = await raw(port, "/apple-touch-icon.png");
    check(apple.status === 200 && apple.body.readUInt32BE(0) === 0x89504e47, "apple-touch-icon.png exists (iOS reads only this)");

    /* ------------------------------------------------------------------ */
    console.log("\n4) the service worker is servable, scoped, and caches nothing dangerous");
    const sw = await raw(port, "/app/sw.js");
    check(sw.status === 200, "/app/sw.js serves", `got ${sw.status}`);
    check(
      String(sw.headers["content-type"] || "").startsWith("application/javascript"),
      "served as javascript (a worker with the wrong type is refused)",
      String(sw.headers["content-type"])
    );
    check(
      /no-cache|no-store|max-age=0/.test(String(sw.headers["cache-control"] || "")),
      "not long-cached — a worker that cannot be replaced is an app that cannot be fixed",
      String(sw.headers["cache-control"])
    );
    /*
     * The scope bug, pinned.
     *
     * A worker at /app/sw.js defaults to controlling "/app/" — which does NOT
     * include "/app", and "/app" is the start_url. The homescreen icon opens
     * the one page the worker would never control, and every structural check
     * still passes: the file serves, the handler exists, the cache fills.
     * Only driving a real browser offline revealed it, and only this header
     * plus a matching scope on register() fixes it.
     */
    check(
      String(sw.headers["service-worker-allowed"] || "") === "/app",
      "Service-Worker-Allowed: /app — without it the worker cannot claim the start_url",
      String(sw.headers["service-worker-allowed"])
    );

    const src = sw.body.toString("utf8");
    check(/addEventListener\(\s*["']fetch["']/.test(src), "has a fetch handler (installability has required one)");
    check(
      /req\.mode\s*!==\s*["']navigate["']/.test(src),
      "only handles navigations — API and script requests are passed through untouched"
    );

    /*
     * Comments stripped FIRST. The first version of this check searched the
     * whole file for "app.js" and failed on the worker's own comment
     * explaining why it does not cache app.js — a check that fires on the
     * documentation of the correct behaviour is worse than no check, because
     * the obvious way to make it pass is to delete the explanation.
     */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    // Whatever else it does, the cache may hold exactly ONE thing: the
    // offline page. Enumerate every way something gets in.
    const writes = code.match(/\.(add|addAll|put)\s*\(/g) || [];
    check(writes.length === 1, "exactly one cache write in the whole worker", writes.join(" ") || "none");
    check(/\.add\(\s*new Request\(\s*OFFLINE_URL/.test(code), "and it is the offline page");
    check(!/app\.js/.test(code), "no code path caches app.js, which must stay in step with the server");
    check(!/\/app\/api/.test(code), "no code path touches /app/api");
    check(!/["'`]\/app["'`]/.test(code), "no code path caches the account-specific shell");

    /* ------------------------------------------------------------------ */
    console.log("\n5) the offline page exists and is honest");
    const off = await raw(port, "/app/offline.html");
    const offText = off.body.toString("utf8");
    check(off.status === 200, "/app/offline.html serves", `got ${off.status}`);
    check(/offline/i.test(offText), "says it is offline");
    check(/nothing you'd written is lost|nothing you have written is lost/i.test(offText), "reassures that nothing was lost");
    check(!/<script/i.test(offText), "no script — it must render under the app CSP with nothing to load");

    /* ------------------------------------------------------------------ */
    console.log("\n6) the shell links it all up (signed-out body must not, but the file must)");
    const shell = fs.readFileSync(path.join(ROOT, "views", "app.html"), "utf8");
    check(/<link rel="manifest" href="\/app\/manifest.webmanifest"/.test(shell), "shell links the manifest");
    check(/rel="apple-touch-icon"/.test(shell), "shell links the apple touch icon");
    check(/name="apple-mobile-web-app-capable" content="yes"/.test(shell), "iOS standalone flag set");
    check(
      /name="apple-mobile-web-app-status-bar-style" content="black"/.test(shell),
      "status bar is 'black', not 'black-translucent' — translucent needs safe-area padding the layout does not have"
    );
    check(/name="theme-color"/.test(shell), "theme-color set");
    const client = fs.readFileSync(path.join(ROOT, "views", "app.js"), "utf8");
    check(/navigator\.serviceWorker\.register\("\/app\/sw\.js"/.test(client), "client registers the worker");
    check(
      /register\("\/app\/sw\.js",\s*\{\s*scope:\s*"\/app"\s*\}\)/.test(client),
      "and asks for scope '/app' — the default '/app/' would exclude the start_url"
    );
    check(/\.catch\(\(\) => \{\}\)/.test(client.slice(client.indexOf("serviceWorker"))), "registration failure is swallowed — no worker must never mean no app");
  } finally {
    child.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nPWA PROBE OK" : `\nPWA PROBE FAILED — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe crashed", e);
  process.exit(1);
});
