"use strict";

/*
 * The dashboard: what your machines are doing, split by the two different
 * things they can do.
 *
 * This used to live on the account page, mixed in with sign-in methods and
 * spending grants. Those are questions about WHO YOU ARE; this is a question
 * about WHAT YOUR HARDWARE IS DOING, and they were crowding each other out.
 * The account page now links here and keeps to its own subject.
 *
 * One machine can appear in both sections — a computer that answers chat AND
 * produces blocks is one computer with two jobs, and splitting by job is what
 * makes each set of numbers readable.
 *
 * It polls, because the previous version did not and the numbers went stale on
 * screen while the machines carried on working.
 */

const REFRESH_MS = 20000;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const num = (v, d = 1) => (v == null || !isFinite(v) ? null : Number(v).toFixed(d));
const pct = (v) => (v == null || !isFinite(v) ? null : `${(Number(v) * 100).toFixed(0)}%`);

/**
 * Money for a person: cents, and no more.
 *
 * "$0.2900 a day" reads as a measurement taken to four decimal places. It is
 * an estimate annualised from a block lottery; two decimals is already more
 * precision than it has.
 */
function usd(v) {
  if (v == null || !isFinite(v)) return "—";
  const d = Math.abs(v) >= 1000 ? 0 : 2;
  return "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * A PRICE, which is the one place the small digits matter — KOIN trades below
 * a cent, and "$0.01" would collapse exactly what someone is comparing
 * against another venue.
 */
function price(v) {
  if (v == null || !isFinite(v)) return "—";
  return "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

/** KOIN satoshis (8-dec, arriving as strings) to a readable KOIN amount. */
function koin(sats) {
  if (sats == null) return "—";
  const n = Number(sats) / 1e8;
  if (!isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " KOIN";
}

function ago(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const tile = (label, value, sub) =>
  `<div class="tile"><div class="t-label">${esc(label)}</div><div class="t-value">${esc(value)}</div>` +
  `<div class="t-sub">${esc(sub || "")}</div></div>`;

const rows = (pairs) =>
  `<div class="node-grid">${pairs
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span>`)
    .join("")}</div>`;

function head(n) {
  const dot = n.online ? (n.busy ? "busy" : "ok") : "off";
  const state = n.online
    ? n.busy ? "Working now" : "Online, waiting for jobs"
    : n.lastSeenAt ? `Offline — last seen ${ago(n.lastSeenAt) || "a while ago"}` : "Offline";
  return `<div class="node-state"><span class="node-dot ${dot}"></span>${esc(state)}</div>
          <div class="addr">${esc(n.address)}</div>`;
}

/* ---- AI: what this machine serves to the network ---- */
function aiCard(n) {
  const p = n.perf || {};
  const r = n.reputation || {};
  const models = (n.models || []).length
    ? `<div class="node-models">${n.models.map((m) => `<span class="chip">${esc(m)}</span>`).join("")}</div>`
    : `<div class="muted">Offering no models to the network. The app's Earn tab says which of your downloaded models fit this machine, and why.</div>`;
  return `<div class="card">${head(n)}${models}${rows([
    ["Memory", n.ramGb ? `${n.ramGb} GB${n.accelerated ? " · GPU accelerated" : ""}` : n.accelerated ? "GPU accelerated" : null],
    // What the NETWORK clocked, not what the machine claimed.
    ["Speed (measured)", num(p.srvTokPerSec) ? `${num(p.srvTokPerSec)} tok/s` : null],
    ["Speed (self-reported)", !num(p.srvTokPerSec) && num(p.tokPerSec) ? `${num(p.tokPerSec)} tok/s` : null],
    ["Reliability", pct(p.sr)],
    ["Jobs", p.ok != null || p.to != null ? `${p.ok || 0} delivered · ${p.to || 0} timed out · ${p.bad || 0} failed audit` : null],
    ["This epoch", n.online && n.jobsThisEpoch != null ? `${n.jobsThisEpoch} job${n.jobsThisEpoch === 1 ? "" : "s"}` : null],
    ["On the network", r.ageDays != null ? `${num(r.ageDays, 2)} days` : null],
    ["Trust", r.r != null ? num(r.r, 3) : null],
  ])}</div>`;
}

/* ---- Koinos: what this machine holds and produces ---- */
function koinosCard(n) {
  const k = n.producer || {};
  const measured = k.basis === "measured";
  // "not enough history yet" is a different statement from "$0.00 a day", and
  // the difference is the whole question for someone deciding whether to keep
  // a machine running.
  const earnSub = measured
    ? `from ${k.daysTracked} day${k.daysTracked === 1 ? "" : "s"} measured`
    : "not enough history yet";

  const tiles = [
    tile("Node value", usd(k.nodeValueUsd), k.usdPerKoin != null ? `KOIN + VHP at ${price(k.usdPerKoin)}` : "waiting for a price"),
    tile("Est. daily", usd(measured ? k.dailyUsd : null), earnSub),
    tile("Est. weekly", usd(measured ? k.weeklyUsd : null), earnSub),
    tile("Est. yearly", usd(measured ? k.yearlyUsd : null), earnSub),
  ].join("");

  const share = k.sharePct != null
    ? `${Number(k.sharePct).toFixed(5)}%${k.oneInBlocks != null ? ` (1 in ${Math.round(k.oneInBlocks).toLocaleString()})` : ""}`
    : null;

  /*
   * Its own header. Reusing the AI worker's would caption a block producer
   * "Online, waiting for jobs", which is a true sentence about a different
   * machine role and a confusing one here — this node is not waiting, it is
   * entered in a lottery every three seconds.
   */
  const producing = k.producingVhp != null && k.producingVhp > 0;
  const phead =
    `<div class="node-state"><span class="node-dot ${producing ? "ok" : "off"}"></span>` +
    `${producing ? "Producing blocks" : "Not producing"}</div>` +
    `<div class="addr">${esc(n.address)}</div>`;

  return `<div class="card">${phead}<div class="tiles">${tiles}</div>${rows([
    ["KOIN", koin(k.koinSats)],
    ["VHP (producing)", k.vhpSats != null ? koin(k.vhpSats).replace(" KOIN", " VHP") : k.producingVhp != null ? `${num(k.producingVhp, 2)} VHP` : null],
    ["Network total", k.networkVhp != null ? `${Math.round(k.networkVhp).toLocaleString()} VHP` : null],
    ["Your share", share],
    ["Expected rate", k.blocksPerDay != null
      ? `${num(k.blocksPerDay, 2)} blocks/day${k.hoursPerBlock != null ? ` — about one every ${num(k.hoursPerBlock, 1)} h` : ""}`
      : null],
  ])}
  <p class="muted" style="margin-top:10px;font-size:12px">Expected rate is an average — block production is a lottery, so quiet stretches of several hours are normal at a small share.${
    k.priceStale ? " The price used here could not be refreshed recently." : ""
  }</p>
  ${k.reportedAt ? `<p class="stamp">Reported by the machine ${esc(ago(k.reportedAt) || "just now")}.</p>` : ""}
  </div>`;
}

async function load() {
  let nodes;
  try {
    const r = await fetch("/account/api/nodes", { headers: { accept: "application/json" }, cache: "no-store" });
    if (r.status === 401 || r.status === 403) { location.href = "/account?next=/dashboard"; return; }
    nodes = (await r.json()).nodes || [];
  } catch {
    $("stamp").textContent = "Could not reach the network just now — showing the last successful reading.";
    return;
  }

  const ai = nodes.filter((n) => !n.neverSeen);
  const koinos = nodes.filter((n) => n.producer && (n.producer.producingVhp != null || n.producer.nodeValueUsd != null));

  $("ai").innerHTML = ai.length
    ? ai.map(aiCard).join("")
    : `<p class="empty">No machine has connected yet. Run Koinos AI and switch on Earning to put one to work.</p>`;

  $("koinos").innerHTML = koinos.length
    ? koinos.map(koinosCard).join("")
    : `<p class="empty">No Koinos node is reporting. A machine shows up here once it is producing blocks AND Earning is on — the node's report travels with the app's connection to the network.</p>`;

  $("stamp").textContent = `Updated ${new Date().toLocaleTimeString()} · refreshes every ${REFRESH_MS / 1000}s`;
}

load();
setInterval(load, REFRESH_MS);
