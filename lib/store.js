"use strict";

/*
 * Waitlist store — the append-only JSONL file is the source of truth.
 * Reads are cheap at waitlist scale; nothing is cached so a download always
 * reflects what's on disk right now.
 */

const fs = require("fs");

const SEGMENTS = ["people", "dev"];

const SEGMENT_LABELS = {
  people: "People — run & earn",
  dev: "Developers — self-host",
};

async function readEntries(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e.email === "string") {
        out.push({
          ts: typeof e.ts === "string" ? e.ts : "",
          email: e.email,
          segment: SEGMENTS.includes(e.segment) ? e.segment : "people",
        });
      }
    } catch {
      // Skip a corrupt line rather than failing the whole export.
    }
  }
  return out;
}

/** Collapse repeat signups, keeping the earliest record for each address. */
function dedupe(entries) {
  const seen = new Map();
  for (const e of entries) {
    const key = e.email.toLowerCase();
    const prev = seen.get(key);
    if (!prev || (e.ts && prev.ts && e.ts < prev.ts)) seen.set(key, e);
  }
  return [...seen.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function bySegment(entries, segment) {
  if (!segment || segment === "all") return entries;
  return entries.filter((e) => e.segment === segment);
}

/*
 * Spreadsheet apps execute cells beginning with =, +, -, @ or a control char.
 * A signup address is attacker-supplied text, so neutralize it before export.
 */
function csvCell(value) {
  let s = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function toCsv(entries) {
  const rows = [["email", "segment", "signed_up_at"].map(csvCell).join(",")];
  for (const e of entries) {
    rows.push([csvCell(e.email), csvCell(e.segment), csvCell(e.ts)].join(","));
  }
  // CRLF + trailing newline: what Excel and Sheets expect.
  return rows.join("\r\n") + "\r\n";
}

function summarize(entries) {
  const counts = { all: entries.length };
  for (const s of SEGMENTS) counts[s] = 0;
  for (const e of entries) counts[e.segment] = (counts[e.segment] || 0) + 1;
  return counts;
}

module.exports = { SEGMENTS, SEGMENT_LABELS, readEntries, dedupe, bySegment, toCsv, summarize };
