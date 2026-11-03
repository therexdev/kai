"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "../plugin"), manifest = require("../plugin/manifest.json");
test("the sandboxed plugin uses the supported shared local services", () => {
  assert.equal(manifest.schema, 2); assert.equal(manifest.apiVersion, 3);
  assert.equal(manifest.runtime, "sandboxed"); assert.equal(manifest.service, undefined);
  assert.ok(fs.existsSync(path.join(root, manifest.entry)));
  for (const permission of ["storage.read", "storage.write", "models.read", "inference.local"]) assert.ok(manifest.permissions.includes(permission));
  assert.ok(!manifest.permissions.includes("native.execute"));
  assert.ok(!manifest.permissions.includes("inference.network"));
});
