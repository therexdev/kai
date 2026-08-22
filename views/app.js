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

/* Phone-shaped, by the same breakpoint the stylesheet uses. Several places
 * need to behave differently there, not just look different. */
const narrow = () => window.matchMedia("(max-width: 760px)").matches;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/*
 * Money, at whatever precision the number actually needs.
 *
 * A single answer can cost six millionths of a dollar. A fixed 4dp would
 * print that as "$0.0000", which reads as free and is not — and on a network
 * that bills per token, a price that rounds to nothing is the one number
 * people would be right to distrust. Below a millionth there is genuinely
 * nothing to show, so it says so rather than inventing a digit.
 */
function usd(n) {
  const v = Number(n || 0);
  if (v >= 1) return "$" + v.toFixed(2);
  if (v >= 0.01) return "$" + v.toFixed(4);
  if (v > 0 && v < 0.000001) return "<$0.000001";
  return "$" + v.toFixed(6);
}
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

/**
 * Turn a refusal into a sentence that makes sense HERE.
 *
 * Two error shapes reach this app: its own routes answer {error: "..."} and
 * the scheduler answers OpenAI-style {error: {message, type}}. Both are real,
 * so read whichever arrived rather than guessing.
 *
 * The one that needed translating is `insufficient_quota`. The network's own
 * words tell you to "add KAI in the Earn tab, or Start Earning" — correct
 * advice, written for someone sitting in the desktop app, and useless to
 * someone in a browser who may not have it open. It is also the single most
 * likely refusal a new web user will meet, because a grant is permission and
 * not funds. So the browser gets browser-shaped guidance, and the network's
 * own sentence is kept after it rather than thrown away: it says which limit
 * was hit, personal or network-wide, and that distinction is real.
 */
function netError(j, status) {
  const raw = typeof j.error === "string" ? j.error : j.error?.message;
  const type = typeof j.error === "object" ? j.error?.type : null;
  if (type === "insufficient_quota") {
    const e = new Error(
      "This wallet has nothing left to draw on. A spending grant is permission, not funds — " +
      "the wallet still needs KAI on the network. Add some from the Koinos AI desktop app " +
      "(Earn), or run a node and earn it. " + (raw || "")
    );
    e.quota = true;
    return e;
  }
  return new Error(raw || `the network answered ${status}`);
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
  if (view === "wallet") { paintWallet(); paintSpend().catch(() => {}); }
  if (view === "chat") {
    loadChats().catch((e) => note(e.message, true));
    loadNetwork().catch(() => {});
  }
  if (view === "docs") loadDocs().catch((e) => docNote(e.message, true));
  if (view === "tasks") loadTasks().catch((e) => taskNote(e.message, true));
  // Leaving Docs must not leave an edit on a timer that fires into a view
  // nobody is looking at — and might land after the document was switched.
  if (view !== "docs") flushDoc().catch(() => {});
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

/*
 * Where the money went.
 *
 * The cards above say how much is LEFT. Only this says what spent the rest,
 * and it matters most for tasks — the one spend nobody was present for.
 */
async function paintSpend() {
  const el = $("spend-log");
  el.innerHTML = '<p class="hint">loading…</p>';
  let data;
  try {
    data = await api("/app/api/spend");
  } catch (e) {
    el.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    return;
  }
  if (!data.events.length) {
    el.innerHTML = '<p class="hint">Nothing spent yet.</p>';
    return;
  }
  const capped = data.count >= data.retained;
  el.innerHTML =
    `<div class="card">` +
    data.events.map((e) => `
      <div class="spend-row">
        <span class="tag">${esc(e.source)}</span>
        <span class="what">${esc(e.label || "—")}${e.model ? ` <span class="hint">· ${esc(e.model)}</span>` : ""}</span>
        <span class="hint">${esc(when(e.createdAt))}</span>
        <span class="amt${e.costUsd > 0 ? "" : " free"}">${e.costUsd > 0 ? esc(usd(e.costUsd)) : "free"}</span>
      </div>`).join("") +
    `<p class="hint" style="margin-top:12px">${esc(usd(data.totalUsd))} across ${data.count} request${data.count === 1 ? "" : "s"}` +
    (capped ? `, the most recent ${data.retained} kept` : "") +
    `. Each grant's own total above is the lifetime figure.</p></div>`;
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

/* ------------------------------------------------------------------ chat */

const chat = { list: [], current: null, messages: [], busy: false };

function note(text, bad) {
  const el = $("chat-note");
  el.textContent = text || "";
  el.style.color = bad ? "var(--danger)" : "";
}

async function loadChats(select) {
  const { chats } = await api("/app/api/chats");
  chat.list = chats;
  if (select) chat.current = select;
  if (!chat.current || !chats.some((c) => c.id === chat.current)) chat.current = chats[0]?.id || null;
  paintChatList();
  await loadThread();
}

/*
 * On a phone the list starts COLLAPSED. Full height it ate a third of the
 * screen before a single word of the answer, and the list is something you
 * touch when SWITCHING chats, not while reading one. The switch button shows
 * where you are; tapping it opens the list. On a wide screen the rail is
 * always open and the button never renders.
 */
function paintChatList() {
  const el = $("chat-list");
  const here = chat.list.find((c) => c.id === chat.current);
  // Preserve the open/closed state across repaints — a repaint happens on
  // every send, and a list that reopened itself each time would be worse
  // than one that never collapsed.
  const open = el.classList.contains("open");
  el.className = `chat-list${narrow() && !open ? " collapsed" : ""}${open ? " open" : ""}`;
  el.innerHTML =
    `<button class="new-chat" id="new-chat">+ New chat</button>` +
    `<button class="chat-switch" id="chat-switch"><span>${esc(here ? here.title : "No chats yet")}</span>▾</button>` +
    chat.list.map((c) => `
      <div class="chat-row${c.id === chat.current ? " active" : ""}" data-id="${esc(c.id)}">
        <button class="pick" title="${esc(c.title)}">${esc(c.title)}</button>
        <button class="del" title="Delete this chat">✕</button>
      </div>`).join("");
  $("new-chat").onclick = newChat;
  $("chat-switch").onclick = () => {
    el.classList.toggle("open");
    el.classList.toggle("collapsed");
  };
  for (const row of el.querySelectorAll(".chat-row")) {
    const cid = row.dataset.id;
    row.querySelector(".pick").onclick = () => {
      chat.current = cid;
      // Picking one is the end of switching: fold the list away again so the
      // answer gets the screen.
      el.classList.remove("open");
      paintChatList();
      loadThread();
    };
    row.querySelector(".del").onclick = () => removeChat(cid);
  }
}

async function newChat() {
  if (chat.busy) return;
  try {
    const { chat: c } = await api("/app/api/chats", {});
    await loadChats(c.id);
    $("composer-input").focus();
  } catch (e) { note(e.message, true); }
}

async function removeChat(cid) {
  const c = chat.list.find((x) => x.id === cid);
  // Deleting a conversation is not undoable and the button is one pixel from
  // the one that opens it, so it asks — but only when there is something to
  // lose. Confirming the deletion of an empty chat is just noise.
  if (c && c.messages > 0 && !confirm(`Delete "${c.title}"? The messages in it go too.`)) return;
  try {
    const { chats } = await api(`/app/api/chats/${encodeURIComponent(cid)}`, undefined, "DELETE");
    chat.list = chats;
    if (chat.current === cid) chat.current = chats[0]?.id || null;
    paintChatList();
    await loadThread();
  } catch (e) { note(e.message, true); }
}

async function loadThread() {
  const t = $("thread");
  if (!chat.current) {
    chat.messages = [];
    t.innerHTML = `<div class="empty"><p>Nothing here yet.</p><p class="hint" style="margin-top:8px">Every answer is generated on someone else's machine and paid for from your spending limit. Start a chat and ask something.</p></div>`;
    return;
  }
  try {
    const { messages } = await api(`/app/api/chats/${encodeURIComponent(chat.current)}`);
    chat.messages = messages;
  } catch (e) {
    chat.messages = [];
    note(e.message, true);
  }
  paintThread();
}

function msgHtml(m) {
  const bits = [];
  if (m.servedModel) bits.push(`answered by ${esc(m.servedModel)}`);
  // Zero is a real answer here (the free allowance covered it) and must not
  // be swallowed by a falsy check — that is how "free" becomes "unknown".
  if (typeof m.costUsd === "number") bits.push(m.costUsd > 0 ? esc(usd(m.costUsd)) : "free allowance");
  const meta = bits.length ? `<div class="meta">${bits.join(" · ")}</div>` : "";
  return `<div class="msg ${m.role === "user" ? "user" : "bot"}${m.error ? " err" : ""}">
    <div class="who">${m.role === "user" ? "You" : "Koinos AI"}</div>
    <div class="body">${esc(m.content)}</div>${meta}
  </div>`;
}

function paintThread(pending) {
  const t = $("thread");
  if (!chat.messages.length && !pending) {
    t.innerHTML = `<div class="empty"><p>Ask anything.</p><p class="hint" style="margin-top:8px">Answers come from models running on the Koinos Network — real machines, paid per token from the limit you authorised.</p></div>`;
    return;
  }
  t.innerHTML = chat.messages.map(msgHtml).join("") + (pending || "");
  t.scrollTop = t.scrollHeight;
}

/**
 * Send, and stream the answer in as it is generated.
 *
 * The reply is stored server-side the moment it completes, so what is drawn
 * here is a live view of something already durable — a closed tab loses the
 * animation, not the answer.
 */
async function send(text) {
  if (chat.busy) return;
  if (!chat.current) {
    try {
      const { chat: c } = await api("/app/api/chats", {});
      await loadChats(c.id);
    } catch (e) { return note(e.message, true); }
  }
  chat.busy = true;
  $("composer-send").disabled = true;
  note("");
  chat.messages.push({ role: "user", content: text, servedModel: null });
  let answer = "";
  const draw = () => paintThread(
    `<div class="msg bot"><div class="who">Koinos AI</div><div class="body">${esc(answer)}${answer ? "" : '<span class="dots"></span>'}</div></div>`
  );
  draw();

  try {
    const res = await fetch(`/app/api/chats/${encodeURIComponent(chat.current)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, model: network.choice, grantId: state.grant?.id }),
    });
    if (res.status === 401) { location.replace("/account?next=/app"); return; }
    /*
     * The error path is NOT a stream. A refusal — no grant, cap reached,
     * nobody online — comes back as JSON with a status, because a failure
     * dressed up as an empty stream is how you get a spinner that never
     * resolves and no explanation anywhere.
     */
    if (!res.ok || !/text\/event-stream/.test(res.headers.get("content-type") || "")) {
      throw netError(await res.json().catch(() => ({})), res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";
      for (const f of frames) {
        const line = f.split("\n").find((x) => x.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        let d;
        try { d = JSON.parse(payload); } catch { continue; }
        if (d.error) throw new Error(typeof d.error === "string" ? d.error : d.error.message || "the network refused that");
        if (typeof d.delta === "string") { answer += d.delta; draw(); }
        if (d.done) {
          answer = String(d.output ?? answer);
          chat.messages.push({
            role: "assistant",
            content: answer,
            servedModel: d.servedModel || null,
            costUsd: typeof d.costUsd === "number" ? d.costUsd : null,
          });
          paintThread();
          // The message's own meta line already carries the model and the
          // price. Repeating it here said the same thing twice and, on a
          // phone, cost a line of screen to do it.
          note("");
        }
      }
    }
    if (!chat.messages.length || chat.messages[chat.messages.length - 1].role !== "assistant") {
      throw new Error("the stream ended before an answer arrived");
    }
    // The reply cost money, so the number in the corner is now wrong.
    load().catch(() => {});
    loadChats(chat.current).catch(() => {});
  } catch (e) {
    chat.messages.push({ role: "assistant", content: e.message, servedModel: null, error: true });
    paintThread();
    note(e.message, true);
  } finally {
    chat.busy = false;
    $("composer-send").disabled = false;
    $("composer-input").focus();
  }
}

function wireComposer() {
  const input = $("composer-input");
  /*
   * The keyboard hint is ADDED on a wide screen, not removed on a narrow one.
   * The markup ships the short version so the first paint is right at any
   * width — the long one flashed and was cut mid-word on a phone before this
   * ran. On a phone the advice is also just wrong: there is no Shift+Enter.
   */
  const setHint = () => {
    input.placeholder = narrow() ? "Ask anything…" : "Ask anything — Enter to send, Shift+Enter for a new line";
  };
  setHint();
  window.addEventListener("resize", setHint);

  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(200, input.scrollHeight) + "px"; };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    /*
     * Enter sends, Shift+Enter is a newline — ON A KEYBOARD. A phone's Enter
     * key is a newline key and there is no Shift to hold, so sending on it
     * fires the message the first time someone wants a paragraph break. The
     * Send button is right there and is the only sensible way to send.
     *
     * IME composition must never send either: pressing Enter to accept a
     * candidate character is not pressing send.
     */
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !narrow()) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("composer-model").addEventListener("change", (e) => { network.choice = e.target.value; });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    grow();
    send(text);
  });
}

/* ------------------------------------------------------------------ docs */

const docs = { list: [], current: null, body: "", title: "", busy: false, saveTimer: null, dirty: false };

function docNote(text, bad) {
  const el = $("doc-note");
  el.textContent = text || "";
  el.style.color = bad ? "var(--danger)" : "";
}

async function loadDocs(select) {
  const { docs: list } = await api("/app/api/docs");
  docs.list = list;
  if (select) docs.current = select;
  if (!docs.current || !list.some((d) => d.id === docs.current)) docs.current = list[0]?.id || null;
  paintDocList();
  await openDoc(docs.current);
}

function paintDocList() {
  const el = $("doc-list");
  el.innerHTML = `<button class="new-chat" id="new-doc">+ New document</button>` +
    docs.list.map((d) => `
      <div class="chat-row${d.id === docs.current ? " active" : ""}" data-id="${esc(d.id)}">
        <button class="pick" title="${esc(d.title)}">${esc(d.title)}</button>
      </div>`).join("");
  $("new-doc").onclick = newDoc;
  for (const row of el.querySelectorAll(".chat-row")) {
    const did = row.dataset.id;
    // Switching documents flushes first: an autosave still on its timer
    // would otherwise land AFTER the next document loads and write this
    // one's text into that one.
    row.querySelector(".pick").onclick = async () => { await flushDoc(); docs.current = did; paintDocList(); openDoc(did); };
  }
}

async function newDoc() {
  try {
    await flushDoc();
    const { doc } = await api("/app/api/docs", {});
    await loadDocs(doc.id);
    $("doc-title").focus();
  } catch (e) { docNote(e.message, true); }
}

async function openDoc(did) {
  hideAnswer();
  if (!did) {
    docs.current = null;
    $("doc-title").value = "";
    $("doc-body").value = "";
    $("doc-status").textContent = "";
    return;
  }
  try {
    const { doc } = await api(`/app/api/docs/${encodeURIComponent(did)}`);
    docs.current = doc.id;
    docs.title = doc.title === "Untitled" ? "" : doc.title;
    docs.body = doc.body;
    docs.dirty = false;
    $("doc-title").value = docs.title;
    $("doc-body").value = docs.body;
    $("doc-status").textContent = "Saved";
    docNote("");
  } catch (e) { docNote(e.message, true); }
}

/** Write now, rather than whenever the timer was going to fire. */
async function flushDoc() {
  if (docs.saveTimer) { clearTimeout(docs.saveTimer); docs.saveTimer = null; }
  if (!docs.dirty || !docs.current) return;
  await saveDoc();
}

async function saveDoc() {
  if (!docs.current) return;
  const id = docs.current;
  const title = $("doc-title").value;
  const body = $("doc-body").value;
  $("doc-status").textContent = "Saving…";
  try {
    const r = await api(`/app/api/docs/${encodeURIComponent(id)}`, { title, body }, "PUT");
    docs.list = r.docs;
    docs.dirty = false;
    // Only repaint the list if this document's NAME changed — repainting on
    // every keystroke's save would steal focus from the field being typed in.
    const shown = $("doc-list").querySelector(`.chat-row[data-id="${id}"] .pick`);
    if (shown && shown.textContent !== r.doc.title) paintDocList();
    $("doc-status").textContent = "Saved";
  } catch (e) {
    $("doc-status").textContent = "";
    docNote(e.message, true);
  }
}

function touchDoc() {
  docs.dirty = true;
  $("doc-status").textContent = "Unsaved";
  if (docs.saveTimer) clearTimeout(docs.saveTimer);
  docs.saveTimer = setTimeout(() => { docs.saveTimer = null; saveDoc(); }, 900);
}

function hideAnswer() {
  $("doc-answer").hidden = true;
  $("doc-answer-body").textContent = "";
}

/** What is selected in the editor right now, or "" if nothing is. */
function docSelection() {
  const el = $("doc-body");
  return el.value.slice(el.selectionStart, el.selectionEnd);
}

async function askDoc(instruction) {
  if (docs.busy || !docs.current) return;
  await flushDoc();
  const selection = docSelection();
  docs.busy = true;
  $("doc-ai-send").disabled = true;
  docNote(selection ? "Asking about the selected passage…" : "Asking about the whole document…");
  $("doc-answer").hidden = false;
  const out = $("doc-answer-body");
  out.innerHTML = '<span class="dots"></span>';
  let answer = "";

  try {
    const res = await fetch(`/app/api/docs/${encodeURIComponent(docs.current)}/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction, selection, grantId: state.grant?.id }),
    });
    if (res.status === 401) { location.replace("/account?next=/app"); return; }
    if (!res.ok || !/text\/event-stream/.test(res.headers.get("content-type") || "")) {
      throw netError(await res.json().catch(() => ({})), res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";
      for (const f of frames) {
        const line = f.split("\n").find((x) => x.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        let d;
        try { d = JSON.parse(payload); } catch { continue; }
        if (d.error) throw new Error(typeof d.error === "string" ? d.error : d.error.message || "the network refused that");
        if (typeof d.delta === "string") { answer += d.delta; out.textContent = answer; }
        if (d.done) {
          answer = String(d.output ?? answer);
          out.textContent = answer;
          docNote(d.servedModel ? `Answered by ${d.servedModel}. Nothing has been changed in your document.` : "");
        }
      }
    }
    if (!answer.trim()) throw new Error("the stream ended before an answer arrived");
    load().catch(() => {});
  } catch (e) {
    out.textContent = "";
    hideAnswer();
    docNote(e.message, true);
  } finally {
    docs.busy = false;
    $("doc-ai-send").disabled = false;
  }
}

function wireDocs() {
  $("doc-title").addEventListener("input", touchDoc);
  $("doc-body").addEventListener("input", touchDoc);
  // A closing tab should not take the last paragraph with it.
  window.addEventListener("beforeunload", () => { if (docs.dirty && docs.current) saveDoc(); });

  $("doc-delete").addEventListener("click", async () => {
    if (!docs.current) return;
    const d = docs.list.find((x) => x.id === docs.current);
    if (!confirm(`Delete "${d?.title || "this document"}"? This cannot be undone.`)) return;
    if (docs.saveTimer) { clearTimeout(docs.saveTimer); docs.saveTimer = null; }
    docs.dirty = false; // do not resurrect it with a queued autosave
    try {
      const { docs: list } = await api(`/app/api/docs/${encodeURIComponent(docs.current)}`, undefined, "DELETE");
      docs.list = list;
      docs.current = list[0]?.id || null;
      paintDocList();
      await openDoc(docs.current);
    } catch (e) { docNote(e.message, true); }
  });

  const input = $("doc-ai-input");
  input.addEventListener("keydown", (e) => {
    // Same as the chat composer: a phone's Enter is a newline, not a send.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !narrow()) {
      e.preventDefault();
      $("doc-ai-form").requestSubmit();
    }
  });
  $("doc-ai-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    askDoc(text);
  });

  /*
   * The three things you can do with a suggestion, all explicit. Insert and
   * Replace both go through the editor's own selection, so the browser's
   * undo stack still has the previous text in it — a model's paragraph
   * should be as undoable as one you typed.
   */
  const put = (mode) => {
    const el = $("doc-body");
    const text = $("doc-answer-body").textContent;
    if (!text) return;
    const start = el.selectionStart;
    const end = mode === "replace" ? el.selectionEnd : start;
    el.focus();
    el.setSelectionRange(start, end);
    if (!document.execCommand || !document.execCommand("insertText", false, text)) {
      el.setRangeText(text, start, end, "end");
    }
    touchDoc();
    hideAnswer();
    docNote("Inserted. Ctrl+Z undoes it.");
  };
  $("doc-insert").addEventListener("click", () => put("insert"));
  $("doc-replace").addEventListener("click", () => put("replace"));
  $("doc-dismiss").addEventListener("click", () => { hideAnswer(); docNote(""); });
}

/* ------------------------------------------------------- what is online */

/*
 * The network's classes, with their prices. Public data — no session needed —
 * and it drives both the picker and what the composer admits about cost.
 *
 * "auto" is first and is the default because it means "the best class anyone
 * is serving right now", which is the correct answer for almost everyone. The
 * named classes exist for the person who wants a cheaper answer, and they can
 * see the price before they choose rather than after the bill.
 */
const network = { models: [], choice: "auto" };

async function loadNetwork() {
  let list = [];
  try {
    const r = await fetch("/scheduler/network/models");
    const j = await r.json();
    list = j.models || [];
  } catch { /* offline picker is still a picker */ }
  network.models = list;
  const sel = $("composer-model");
  const prev = sel.value || network.choice;
  sel.innerHTML =
    `<option value="auto">Best available</option>` +
    list.map((m) => `<option value="${esc(m.model)}">${esc(m.model)} — ${usd(m.outUsdPerM)}/M out</option>`).join("");
  sel.value = list.some((m) => m.model === prev) || prev === "auto" ? prev : "auto";
  network.choice = sel.value;
  if (!list.length) note("Nobody is serving the network right now — an answer may take a moment or be refused.");
}

/* ---------------------------------------------------------------- memory */

const memory = { list: [] };

async function loadMemory() {
  const { memories } = await api("/app/api/memory");
  memory.list = memories;
  paintMemory();
}

function paintMemory() {
  const el = $("mem-list");
  if (!memory.list.length) {
    el.innerHTML = `<p class="hint" style="margin-top:10px">Nothing remembered yet.</p>`;
    return;
  }
  el.innerHTML = memory.list.map((m) => `
    <div class="mem-item" data-id="${esc(m.id)}">
      <span>${esc(m.text)}<i class="u">${m.uses ? `used ${m.uses}×` : "not used yet"}</i></span>
      <button title="Forget this">✕</button>
    </div>`).join("");
  for (const row of el.querySelectorAll(".mem-item")) {
    row.querySelector("button").onclick = async () => {
      try {
        const { memories } = await api(`/app/api/memory/${encodeURIComponent(row.dataset.id)}`, undefined, "DELETE");
        memory.list = memories;
        paintMemory();
      } catch (e) { note(e.message, true); }
    };
  }
}

function wireMemory() {
  const body = $("mem-body");
  const toggle = $("mem-toggle");
  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.classList.toggle("open", !body.hidden);
    if (!body.hidden) loadMemory().catch((e) => note(e.message, true));
  });
  $("mem-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("mem-input").value.trim();
    if (!text) return;
    try {
      const { memories } = await api("/app/api/memory", { text });
      memory.list = memories;
      $("mem-input").value = "";
      paintMemory();
    } catch (e2) { note(e2.message, true); }
  });
}

/* ----------------------------------------------------------------- tasks */

const tasks = { list: [], busy: false };

function taskNote(text, bad) {
  const el = $("task-note");
  el.textContent = text || "";
  el.style.color = bad ? "var(--danger)" : "";
}

const EVERY_LABEL = { 60: "every hour", 360: "every 6 hours", 720: "every 12 hours", 1440: "every day", 10080: "every week" };
const everyLabel = (m) => EVERY_LABEL[m] || `every ${m} minutes`;

function when(ms, future) {
  if (!ms) return "never";
  const d = future ? ms - Date.now() : Date.now() - ms;
  if (d < 0 && future) return "any moment";
  return future ? `in ${span(d)}` : `${span(d)} ago`;
}

async function loadTasks() {
  const { tasks: list } = await api("/app/api/tasks");
  tasks.list = list;
  paintTasks();
}

function taskCard(t) {
  const last = t.lastRunAt
    ? t.lastOk
      ? `<div class="hint" style="margin-bottom:5px">Last run ${esc(when(t.lastRunAt))} · run ${t.runs}</div><div class="last">${esc(t.lastOutput || "(empty answer)")}</div>`
      : `<div class="hint" style="margin-bottom:5px;color:var(--danger)">Last run ${esc(when(t.lastRunAt))} failed: ${esc(t.lastError || "")}</div>`
    : `<p class="hint">Has not run yet.</p>`;
  return `
    <div class="card task-card${t.enabled ? "" : " paused"}" data-id="${esc(t.id)}">
      <h2>${esc(t.title)}</h2>
      <div class="when">${esc(everyLabel(t.everyMinutes))} · ${t.enabled ? `next ${esc(when(t.nextRunAt, true))}` : "not scheduled"}</div>
      <div class="prompt">${esc(t.prompt)}</div>
      ${last}
      <div class="task-actions">
        <button class="btn small" data-act="run">Run now</button>
        <button class="btn small ghost" data-act="toggle">${t.enabled ? "Pause" : "Resume"}</button>
        <button class="btn small ghost" data-act="delete">Delete</button>
      </div>
    </div>`;
}

function paintTasks() {
  const el = $("task-list");
  if (!tasks.list.length) {
    el.innerHTML = `<div class="card"><p class="hint">No tasks yet. A good first one: “Summarise what changed on the Koinos Network today.”</p></div>`;
    return;
  }
  el.innerHTML = tasks.list.map(taskCard).join("");
  for (const card of el.querySelectorAll(".task-card")) {
    const id = card.dataset.id;
    const t = tasks.list.find((x) => x.id === id);
    card.querySelector('[data-act="run"]').onclick = () => runTaskNow(id, card);
    card.querySelector('[data-act="toggle"]').onclick = () => patchTask(id, { enabled: !t.enabled });
    card.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(`Delete "${t.title}"? It stops running immediately.`)) return;
      try {
        const r = await api(`/app/api/tasks/${encodeURIComponent(id)}`, undefined, "DELETE");
        tasks.list = r.tasks;
        paintTasks();
      } catch (e) { taskNote(e.message, true); }
    };
  }
}

async function patchTask(id, patch) {
  try {
    const r = await api(`/app/api/tasks/${encodeURIComponent(id)}`, patch, "PATCH");
    tasks.list = r.tasks;
    paintTasks();
    taskNote("");
  } catch (e) { taskNote(e.message, true); }
}

async function runTaskNow(id, card) {
  if (tasks.busy) return;
  tasks.busy = true;
  const btn = card.querySelector('[data-act="run"]');
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    // Run-now takes the same code path the schedule takes, so this is a real
    // rehearsal rather than a lookalike. It can take a while — a big class
    // legitimately generates for minutes.
    await api(`/app/api/tasks/${encodeURIComponent(id)}/run`, {});
    taskNote("");
  } catch (e) {
    taskNote(e.message, true);
  } finally {
    tasks.busy = false;
    await loadTasks().catch(() => {});
    load().catch(() => {}); // it cost money; refresh what is left
  }
}

function wireTasks() {
  $("task-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = $("task-prompt").value.trim();
    if (!prompt) return taskNote("A task needs a prompt.", true);
    const everyMinutes = Number($("task-every").value);
    const btn = $("task-create");
    btn.disabled = true;
    try {
      await api("/app/api/tasks", {
        title: $("task-title").value.trim(),
        prompt,
        everyMinutes,
        grantId: state.grant?.id,
      });
      $("task-title").value = "";
      $("task-prompt").value = "";
      taskNote("Created. It will run " + everyLabel(everyMinutes) + " from now.");
      await loadTasks();
    } catch (e2) {
      taskNote(e2.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

/* --------------------------------------------------------- delete my data */

function wirePurge() {
  $("purge").addEventListener("click", async () => {
    // Two confirmations, because this is not undoable and the button sits on
    // a page people visit to read a balance.
    if (!confirm("Delete every chat, document, task and memory stored here?\n\nThis cannot be undone. Your account, wallets and spending grants are not affected.")) return;
    if (!confirm("Last check — this deletes all of it, permanently.")) return;
    const note = $("purge-note");
    note.textContent = "Deleting…";
    try {
      const { deleted } = await api("/app/api/data", undefined, "DELETE");
      const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
      note.textContent =
        `Deleted ${n(deleted.chats, "chat", "chats")}, ` +
        `${n(deleted.docs, "document", "documents")}, ` +
        `${n(deleted.tasks, "task", "tasks")}, ` +
        `${n(deleted.memories, "memory", "memories")} and ` +
        `${n(deleted.spendEvents, "spend record", "spend records")}.`;
      // Everything on screen is now stale — reload the views that showed it.
      chat.current = null;
      docs.current = null;
      chat.list = []; docs.list = []; tasks.list = []; memory.list = [];
    } catch (e) {
      note.textContent = e.message;
      note.style.color = "var(--danger)";
    }
  });
}

/* ------------------------------------------------------------------ boot */

function boot() {
  for (const btn of document.querySelectorAll(".nav-item")) {
    btn.addEventListener("click", () => show(btn.dataset.view));
  }
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  wireComposer();
  wireDocs();
  wireTasks();
  wireMemory();
  wirePurge();

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
