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

/**
 * KOIN satoshis (8-dec, arriving as strings) to a readable amount.
 *
 * Returns NULL, not a dash, when there is nothing to show — `rows()` drops
 * empty pairs, and a row reading "KOIN —" is worse than no row: it looks like
 * a balance of zero rather than a figure this machine never sent.
 */
function koin(sats, unit = "KOIN") {
  if (sats == null) return null;
  const n = Number(sats) / 1e8;
  if (!isFinite(n)) return null;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " " + unit;
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

/*
 * The value tiles, or an honest sentence instead of them.
 *
 * The first version drew all four unconditionally. On a machine that had not
 * sent the figures that rendered as four boxes containing a dash and an
 * apology — on a phone, four full screens of nothing, and the reader still had
 * no idea WHY. Tiles now appear only where there is a number, and the reason
 * for their absence is stated once, in words.
 */
function valueTiles(k) {
  const measured = k.basis === "measured";
  const hasPrice = k.usdPerKoin != null || k.nodeValueUsd != null;
  const tiles = [];
  let note = "";

  if (hasPrice) {
    tiles.push(tile("Node value", usd(k.nodeValueUsd),
      k.usdPerKoin != null ? `KOIN + VHP at ${price(k.usdPerKoin)}` : "at the last price seen"));
  }
  if (measured) {
    const sub = `from ${k.daysTracked} day${k.daysTracked === 1 ? "" : "s"} measured`;
    tiles.push(tile("Est. daily", usd(k.dailyUsd), sub));
    tiles.push(tile("Est. weekly", usd(k.weeklyUsd), sub));
    tiles.push(tile("Est. yearly", usd(k.yearlyUsd), sub));
  } else if (hasPrice) {
    // One line beats three tiles that all say the same thing.
    note = "Earnings estimates need a day or so of measured block rewards before they mean anything — they will appear here once this node has some history.";
  } else if (k.appVersion == null) {
    /*
     * The version is the whole diagnosis. Before it existed the app sent the
     * block share alone, so empty value tiles and a node whose RPC was simply
     * unreachable looked identical from here.
     */
    note = "This machine is reporting from an older version of the desktop app, which sent the block share and nothing else. Update it and the value and earnings figures will appear here.";
  } else {
    note = "This machine could not read its balances or a price for this reading — the figures should return on the next one.";
  }
  return { tiles: tiles.join(""), note };
}

function koinosCard(n) {
  const k = n.producer || {};
  const { tiles, note } = valueTiles(k);

  const share = k.sharePct != null
    ? `${Number(k.sharePct).toFixed(5)}%${k.oneInBlocks != null ? ` (1 in ${Math.round(k.oneInBlocks).toLocaleString()})` : ""}`
    : null;

  /*
   * Two VHP figures, and they do not always agree: the node's own log says
   * what it is producing with, the chain says what the wallet holds. Showing
   * only one of them would hide a real disagreement — and showing the WALLET
   * figure next to a share derived from the LOG figure, which is what the
   * first version did, quietly published an inconsistent card.
   *
   * So: the producing figure leads, because it is the one the share is built
   * from, and the wallet balance appears beside it only when it differs
   * enough to matter. No explanation is offered for the gap, because there is
   * more than one thing it could mean and guessing would be worse than
   * showing the person both numbers.
   */
  const walletVhp = k.vhpSats != null && isFinite(Number(k.vhpSats)) ? Number(k.vhpSats) / 1e8 : null;
  const prodVhp = k.producingVhp != null && isFinite(k.producingVhp) ? Number(k.producingVhp) : null;
  const bothKnown = walletVhp != null && prodVhp != null && prodVhp > 0;
  const mismatch = bothKnown && Math.abs(walletVhp - prodVhp) / prodVhp > 0.01;

  const producing = prodVhp != null && prodVhp > 0;
  const phead =
    `<div class="node-state"><span class="node-dot ${producing ? "ok" : "off"}"></span>` +
    `${producing ? "Producing blocks" : "Not producing"}</div>` +
    `<div class="addr">${esc(n.address)}</div>`;

  return `<div class="card">${phead}${tiles ? `<div class="tiles">${tiles}</div>` : ""}${rows([
    ["KOIN", koin(k.koinSats)],
    ["VHP producing", prodVhp != null
      ? `${prodVhp.toLocaleString(undefined, { maximumFractionDigits: 2 })} VHP`
      : koin(k.vhpSats, "VHP")],
    ["VHP in wallet", mismatch ? koin(k.vhpSats, "VHP") : null],
    ["Network total", k.networkVhp != null ? `${Math.round(k.networkVhp).toLocaleString()} VHP` : null],
    ["Your share", share],
    ["Expected rate", k.blocksPerDay != null
      ? `${num(k.blocksPerDay, 2)} blocks/day${k.hoursPerBlock != null ? ` — about one every ${num(k.hoursPerBlock, 1)} h` : ""}`
      : null],
  ])}
  ${mismatch ? `<p class="note warn">${
    /*
     * When the machine itself has judged this a real shortfall, say what to do
     * about it. It is not a display quirk: in proof-of-burn the producer works
     * out from its own VHP figure when its proof becomes valid, so a node that
     * understates its stake submits late and loses races it should have won.
     * Stake sitting out of the lottery is the most expensive thing this page
     * can fail to mention.
     */
    k.stakeBehind
      ? `This node is producing with ${esc(prodVhp.toLocaleString(undefined, { maximumFractionDigits: 2 }))} VHP but the wallet holds ${esc(koin(k.vhpSats, "VHP"))} — ${esc(Number(k.stakeShortfallPct ?? 0).toFixed(0))}% of your stake is sitting out of the block lottery, and the share and rate above are understated to match. Restart the Koinos node so the producer re-reads your stake.`
      : `The node reports producing with ${esc(prodVhp.toLocaleString(undefined, { maximumFractionDigits: 2 }))} VHP while the wallet holds ${esc(koin(k.vhpSats, "VHP"))}. The share and rate above use the node's own figure.`
  }</p>` : ""}
  ${note ? `<p class="note">${esc(note)}</p>` : ""}
  <p class="note">Expected rate is an average — block production is a lottery, so quiet stretches of several hours are normal at a small share.${
    k.priceStale ? " The price used here could not be refreshed recently." : ""
  }</p>
  ${k.reportedAt ? `<p class="stamp">Reported by the machine ${esc(ago(k.reportedAt) || "just now")}${k.appVersion ? ` · app ${esc(k.appVersion)}` : ""}.</p>` : ""}
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
