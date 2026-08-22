"use strict";

/*
 * Koinos AI on the web — the shell's brain.
 *
 * This file deliberately holds no authority. It cannot sign, it cannot
 * spend, and it does not decide whether you are allowed in: the server
 * already answered that before it handed you app.html, and the scheduler
 * re-checks the spending grant on every single request that costs money
 * (lib/accounts.js spendableGrant). What lives here is presentation and
 * one honest number — how much of your cap is left — kept fresh because a
 * balance that only updates on reload is a balance people stop trusting.
 *
 * The gate below is therefore a UX gate, not a security gate. If someone
 * deleted it in their devtools they would reach four views that all fail
 * server-side, which is exactly the right failure.
 */

const VIEWS = ["chat", "docs", "tasks", "wallet"];
const SPENDS = new Set(["chat", "docs", "tasks"]); // need a live grant to be useful

const state = {
  account: null,
  grant: null, // the live one, if any
  view: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const usd = (n) => "$" + Number(n || 0).toFixed(Number(n) < 1 ? 4 : 2);
const short = (a) => (String(a).length > 14 ? String(a).slice(0, 6) + "…" + String(a).slice(-4) : String(a));

/** Human gap, past or future, without a date library. */
function span(ms) {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hr`;
  return `${Math.round(h / 24)} days`;
}

/* --------------------------------------------------------------- loading */

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  /*
   * A dead session is the one failure this page cannot paper over: every
   * view would render empty and blame the network. Send them to the door.
   */
  if (res.status === 401) {
    location.replace("/account?next=/app");
    throw new Error("signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Pick the grant to spend through: live, and the one with the most room. */
function liveGrant(grants) {
  return (grants || [])
    .filter((g) => g.live)
    .sort((a, b) => b.remainingUsd - a.remainingUsd)[0] || null;
}

async function load() {
  const { account } = await api("/account/api");
  state.account = account;
  state.grant = liveGrant(account.grants);
  paintChrome();
  if (state.view === "wallet") paintWallet();
  return account;
}

/* ---------------------------------------------------------------- chrome */

function paintChrome() {
  const a = state.account;
  $("who").textContent = a ? a.email || `account ${a.id.slice(0, 8)}` : "";

  const g = state.grant;
  $("spend").textContent = g
    ? `${usd(g.remainingUsd)} left of ${usd(g.maxUsd)}`
    : "No spending limit set";
  $("spend").style.color = g ? "" : "var(--danger)";

  // Views that cost money are unreachable without a grant — and they SAY so,
  // rather than silently doing nothing when clicked.
  for (const btn of document.querySelectorAll(".nav-item")) {
    const needs = SPENDS.has(btn.dataset.view) && !g;
    btn.disabled = false; // still clickable: clicking explains why
    btn.title = needs ? "Set a spending limit first" : "";
    btn.style.opacity = needs ? ".55" : "";
  }
}

function show(view) {
  if (!VIEWS.includes(view)) view = "chat";
  // The gate replaces the destination rather than sitting in front of it, so
  // the sidebar keeps working and the reason stays on screen.
  const gated = SPENDS.has(view) && !state.grant;
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = true;
  $("view-gate").hidden = !gated;
  if (!gated) $(`view-${view}`).hidden = false;
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
  if (gated) {
    $("gate-msg").textContent = state.account?.wallets?.length
      ? "Your wallet is linked — it just has no spending limit authorised yet."
      : "You have no wallet linked to this account yet.";
  }
  if (view === "wallet") paintWallet();
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
}

/* ---------------------------------------------------------------- wallet */

function grantCard(g, isCurrent) {
  const pct = g.maxUsd > 0 ? Math.min(100, (g.spentUsd / g.maxUsd) * 100) : 0;
  const until = g.expiresAt - Date.now();
  const status = g.revokedAt
    ? "Revoked"
    : until <= 0
      ? "Expired"
      : g.remainingUsd <= 0
        ? "Used up"
        : `Expires in ${span(until)}`;
  return `
    <div class="card${g.live ? "" : " spent"}">
      <h2>${esc(short(g.address))}${isCurrent ? " <span class=\"hint\">— in use</span>" : ""}</h2>
      <div class="bal"><b>${esc(usd(g.remainingUsd))}</b><span class="hint">left of ${esc(usd(g.maxUsd))}</span></div>
      <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
      <p class="hint">Spent ${esc(usd(g.spentUsd))} since ${esc(span(Date.now() - g.createdAt))} ago · ${esc(status)}</p>
    </div>`;
}

function paintWallet() {
  const a = state.account;
  const body = $("wallet-body");
  if (!a) { body.innerHTML = ""; return; }
  const grants = a.grants || [];
  if (!grants.length) {
    body.innerHTML = `<div class="card warn"><h2>Nothing authorised</h2>
      <p class="hint">This site cannot spend anything on your behalf. That is the default, and it is the correct one — a grant is something you create deliberately, on your <a href="/account">account page</a>, by signing with the wallet that will pay.</p></div>`;
    return;
  }
  const cur = state.grant;
  const live = grants.filter((g) => g.live);
  const past = grants.filter((g) => !g.live);
  body.innerHTML =
    live.map((g) => grantCard(g, cur && g.id === cur.id)).join("") +
    (past.length
      ? `<h2 class="section">No longer spendable</h2>` + past.map((g) => grantCard(g, false)).join("")
      : "");
}

/* ------------------------------------------------------------------ boot */

function boot() {
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.addEventListener("click", () => show(btn.dataset.view));
  }
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));

  load()
    .then(() => show(location.hash.slice(1) || "chat"))
    .catch((e) => {
      // Not the signed-out case (that redirected already) — something broke.
      $("gate-msg").textContent = `Could not load your account: ${e.message}`;
      $("view-gate").hidden = false;
    });

  /*
   * Money moves without this tab doing anything — a desktop session, a
   * scheduled task, another browser. Re-read the grant on a slow timer and
   * whenever the tab comes back to the foreground, so the number in the
   * corner is one someone can act on.
   */
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 45000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) load().catch(() => {});
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
