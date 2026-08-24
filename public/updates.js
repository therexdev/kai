"use strict";

/*
 * The updates page.
 *
 * Its most important reader is not browsing. They are someone who just saw an
 * update popup in the app and clicked "What's new" — they arrived at
 * /updates#v0.47.2 wanting one specific answer: what am I about to install, or
 * what did I just install. Everything here serves that: the anchored release
 * gets highlighted, and it gets scrolled to even when the browser would not
 * bother (the cards are rendered after load, so the native anchor jump has
 * already happened and found nothing).
 *
 * Data comes from /updates.json, which ships with the site. No API, no auth,
 * no external call — a page about "is the network working" must not itself
 * depend on the network being interesting.
 */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Only the three kinds the page styles; anything else renders neutrally. */
const KINDS = new Set(["new", "fix", "change"]);
const kindOf = (k) => (KINDS.has(String(k)) ? String(k) : "change");

function when(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function releaseCard(r, isLatest) {
  const items = (r.changes || [])
    .map((c) => `<li><span class="kind ${kindOf(c.kind)}">${esc(kindOf(c.kind))}</span><span>${esc(c.text)}</span></li>`)
    .join("");
  return `<article class="rel" id="v${esc(r.version)}">
    <div class="rel-head">
      <a class="ver" href="#v${esc(r.version)}">v${esc(r.version)}</a>
      <span class="date">${when(r.date)}</span>
      ${isLatest ? `<span class="tag">Latest</span>` : ""}
    </div>
    ${r.title ? `<h2>${esc(r.title)}</h2>` : ""}
    <ul>${items || `<li><span>No notes for this release.</span></li>`}</ul>
  </article>`;
}

async function load() {
  let data;
  try {
    const r = await fetch("/updates.json", { headers: { accept: "application/json" }, cache: "no-store" });
    data = await r.json();
  } catch {
    document.getElementById("list").innerHTML =
      `<p class="empty">Couldn't load the update list just now. Try again in a moment.</p>`;
    return;
  }

  const releases = Array.isArray(data.releases) ? data.releases : [];
  document.getElementById("list").innerHTML = releases.length
    ? releases.map((r) => releaseCard(r, r.version === data.latest)).join("")
    : `<p class="empty">No releases listed yet.</p>`;

  document.getElementById("foot").textContent = releases.length
    ? `${releases.length} release${releases.length === 1 ? "" : "s"} listed · latest v${data.latest}`
    : "";

  /*
   * Land on the release the app asked about. The browser already tried this
   * before the cards existed, so it has to be done again by hand — and if the
   * app links to a version older than this list goes back to, say so rather
   * than dumping someone at the top with no explanation.
   */
  const want = decodeURIComponent(location.hash || "").replace(/^#/, "");
  if (!want) return;
  const el = document.getElementById(want);
  if (el) {
    /*
     * Highlight with a class, NOT with :target. The browser resolves the
     * document's target element at navigation time, and these cards are
     * rendered after the fetch resolves — so by the time #v0.47.2 exists,
     * :target has already been decided and stays null. It matches when you
     * click an anchor on the page and silently does nothing for the one
     * case it was added for: someone arriving from the app's update popup.
     */
    el.classList.add("hilite");
    el.scrollIntoView({ block: "start" });
  } else if (/^v\d/.test(want)) {
    const note = document.createElement("p");
    note.className = "empty";
    note.style.marginBottom = "14px";
    note.textContent = `No notes listed for ${want.slice(1)} — it may predate this page. The releases below are the ones on record.`;
    document.getElementById("list").prepend(note);
  }
}

load();
