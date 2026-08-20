"use strict";

/*
 * Probe: the tester docs site (task #59).
 *
 * Boots the REAL server (child process, throwaway state dir, random port)
 * and pins both serving paths:
 *   1. koinosai.com/docs  -> redirect to /docs/ -> the shell + assets + every
 *      sidebar page's markdown answer 200
 *   2. Host: docs.koinosai.com -> the same site from the root path
 * Plus a consistency check: every page id in the shell's sidebar manifest
 * has a matching content/<id>.md, and vice versa — a dead sidebar link can
 * never ship silently.
 *
 * Old code (no docs dir, no route): everything here fails.
 */

const { spawn } = require("child_process");
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

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

/** Raw http request so the Host header can be spoofed (fetch refuses to). */
const raw = (port, reqPath, host) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, headers: host ? { host } : {} },
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
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), KAI_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "probe-docs-")) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // Wait for the server to answer health (scheduler boot included).
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await raw(port, "/api/health").then((r) => r.status === 200).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    check(up, "server boots");

    console.log("\n1) path route: koinosai.com/docs");
    const redir = await raw(port, "/docs");
    check(redir.status === 302 && redir.headers.location === "/docs/", "/docs redirects to /docs/ (relative assets)");
    const shell = await raw(port, "/docs/");
    check(shell.status === 200 && shell.body.includes("Koinos AI Docs"), "the shell serves");
    const md = await raw(port, "/docs/md.js");
    check(md.status === 200 && md.body.includes("mdToHtml"), "the renderer serves");

    console.log("\n2) sidebar manifest <-> content files agree");
    const ids = [...shell.body.matchAll(/id: "([a-z-]+)"/g)].map((m) => m[1]);
    check(ids.length >= 10, `sidebar lists ${ids.length} pages`);
    const contentDir = path.join(__dirname, "..", "public", "docs", "content");
    const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
    const missing = ids.filter((id) => !files.includes(id));
    const orphaned = files.filter((f) => !ids.includes(f));
    check(missing.length === 0, `every sidebar page has content (missing: ${missing.join(", ") || "none"})`);
    check(orphaned.length === 0, `every content file is reachable (orphaned: ${orphaned.join(", ") || "none"})`);
    let all200 = true;
    for (const id of ids) {
      const page = await raw(port, `/docs/content/${id}.md`);
      if (page.status !== 200 || page.body.length < 100) all200 = false;
    }
    check(all200, "every page serves with real content over HTTP");

    console.log("\n3) host route: docs.koinosai.com");
    const sub = await raw(port, "/", "docs.koinosai.com");
    check(sub.status === 200 && sub.body.includes("Koinos AI Docs"), "the subdomain serves the shell from /");
    const subMd = await raw(port, "/content/wallet.md", "docs.koinosai.com");
    check(subMd.status === 200 && subMd.body.includes("KOIN"), "…and its assets from the subdomain root");
    const main404 = await raw(port, "/content/wallet.md");
    check(main404.status === 404, "the main hostname does NOT leak docs assets at the root");

    console.log(failures ? `\nDOCS PROBE FAILED (${failures})` : "\nDOCS PROBE PASSED");
  } finally {
    child.kill("SIGTERM");
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
