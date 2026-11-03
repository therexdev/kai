"use strict";
const fs = require("fs"), path = require("path");
const { fail } = require("./store");
const CORE_REVISION = "324c18835bbbba3ff3be1f34a31b09b03fa32167";
const base = "https://github.com/therexdev/kai-core/blob/" + CORE_REVISION;
const topics = Object.freeze([
  { id: "start", title: "Plugin builder guide & ideas", file: "public/docs/content/plugin-builder.md", format: "markdown", sourceUrl: "https://koinosai.com/docs/#plugin-builder" },
  { id: "author-guide", title: "Core plugin author guide", file: "docs/builder-reference/PLUGIN_AUTHOR_GUIDE.md", format: "markdown", sourceUrl: base + "/docs/foundation/PLUGIN_AUTHOR_GUIDE.md" },
  { id: "api", title: "Core SDK type reference", file: "docs/builder-reference/api-v1.d.ts", format: "code", sourceUrl: base + "/docs/foundation/api-v1.d.ts" },
]);
function read(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) throw fail("Choose an available plugin reference.", 404);
  const { file, ...metadata } = topic;
  return { ...metadata, coreRevision: CORE_REVISION,
    content: fs.readFileSync(path.join(__dirname, "../..", file), "utf8"),
    note: "Versioned reference. Consult the linked Core documentation for changes after this snapshot; workspace files cannot replace this reference." };
}
module.exports = { read, CORE_REVISION, topics: topics.map(({ file, ...topic }) => topic) };
