#!/usr/bin/env node
"use strict";

/*
 * The release-notes page, and the promise it makes to the app.
 *
 * The app's update popup deep-links to /updates#v<version>. That link is shown
 * to someone at the exact moment they are deciding whether to install
 * something, which makes it the least forgiving link on the site: a stale
 * cache, a missing entry, or a version format that does not match the anchor
 * all land as "this company does not know what it just shipped".
 */

const fs = require("fs");
const path = require("path");

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`); }
}

const P = (f) => path.join(__dirname, "..", "public", f);
const data = JSON.parse(fs.readFileSync(P("updates.json"), "utf8"));
const html = fs.readFileSync(P("updates.html"), "utf8");
const js = fs.readFileSync(P("updates.js"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

console.log("1) the data is shaped the way the page and the app expect");
const rels = data.releases || [];
check(Array.isArray(rels) && rels.length > 0, `releases present (${rels.length})`);
check(rels.every((r) => /^\d+\.\d+\.\d+$/.test(r.version || "")),
  "every version is a bare semver — the anchor is built as #v<version> and must match exactly");
check(rels.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date || "")), "every release carries an ISO date");
check(rels.every((r) => Array.isArray(r.changes) && r.changes.length > 0), "every release has at least one note");
check(rels.every((r) => (r.changes || []).every((c) => ["new", "fix", "change"].includes(c.kind))),
  "every note has a kind the page knows how to style");
check(new Set(rels.map((r) => r.version)).size === rels.length, "no duplicate versions");

console.log("\n2) newest first, and `latest` agrees with it");
const cmp = (a, b) => {
  const [A, B] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return B[i] - A[i];
  return 0;
};
const sorted = [...rels].map((r) => r.version).sort(cmp);
check(JSON.stringify(sorted) === JSON.stringify(rels.map((r) => r.version)),
  "releases are in descending version order — the page renders them in file order");
check(data.latest === rels[0].version, `latest (${data.latest}) is the newest entry (${rels[0].version})`);

console.log("\n3) the deep link the app sends actually lands");
check(/id="v\$\{esc\(r\.version\)\}"/.test(js), "each card carries the id the app links to");
check(/classList\.add\("hilite"\)/.test(js),
  "the anchored release is highlighted with a CLASS, not :target");
/*
 * This one is the whole reason the probe exists. :target is resolved by the
 * browser at NAVIGATION time. These cards are rendered after a fetch, so the
 * element does not exist yet and :target stays null forever — it works when
 * you click an anchor on the page and silently does nothing for the one case
 * it was added for. Caught in a real browser, not by reading the CSS.
 */
check(/\.hilite\{|\.rel\.hilite/.test(html), "…and the stylesheet defines that class");
check(/scrollIntoView/.test(js), "…and scrolls to it, because the native anchor jump already missed");
check(/it may predate this page/.test(js),
  "an unknown version explains itself instead of dumping the reader at the top");

console.log("\n4) served, and never from a cache");
check(/app\.get\("\/updates"/.test(server), "/updates is a route");
check(/app\.get\("\/updates\.json"/.test(server), "/updates.json is a route");
const seg = server.slice(server.indexOf('app.get("/updates"'), server.indexOf('app.get("/updates"') + 500);
check((seg.match(/no-store/g) || []).length >= 2,
  "both the page and its data are no-store — a cached list omits the release someone just clicked to read");
check(!/requireAccount|accountOf/.test(seg),
  "public: someone mid-update must not hit a sign-in wall to see what they are installing");

console.log("\n5) the page renders its own classes");
const painted = [...js.matchAll(/class="([a-z0-9 -]+)"/g)].flatMap((m) => m[1].split(" ")).filter(Boolean);
const missing = [...new Set(painted)].filter((c) => !new RegExp("\\." + c + "[^a-z0-9-]").test(html));
check(missing.length === 0, `every class the script paints is styled${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);

console.log(failures ? `\n${failures} FAILED` : "\nUPDATES PROBE PASSED");
process.exit(failures ? 1 : 0);
