"use strict";
// Browser reports are untrusted debugging evidence, never model instructions.
// Persist only bounded error details from the revision being edited; no form
// values, wallet arguments, page HTML, stacks or arbitrary client fields.
function previewDiagnostics(value, revision) {
  if (!value || value.revision !== revision || !Array.isArray(value.errors))
    return [];
  const clean = (s) =>
    typeof s === "string"
      ? s
          .replace(
            /\b(?:5[HJK][1-9A-HJ-NP-Za-km-z]{49}|[KL][1-9A-HJ-NP-Za-km-z]{51}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b/g,
            "[redacted]",
          )
          .slice(0, 500)
      : "";
  return value.errors
    .slice(-8)
    .filter((e) => e && typeof e.message === "string")
    .map((e) => ({
      kind: ["javascript", "promise", "policy", "bridge"].includes(e.kind)
        ? e.kind
        : "javascript",
      message: clean(e.message),
      action: clean(e.action).slice(0, 80),
      line: Number.isSafeInteger(e.line) && e.line > 0 ? e.line : null,
      column: Number.isSafeInteger(e.column) && e.column > 0 ? e.column : null,
    }));
}
module.exports = { previewDiagnostics };
