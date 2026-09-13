"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path"), crypto = require("crypto"), express = require("express");
(async () => {
  const app = express(); app.use("/producer-signer", require("../lib/producer-signer")(path.resolve(__dirname, "../public")));
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/producer-signer/`;
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../public/producer-signer/manifest.json")));
    for (const [name, digest] of Object.entries(manifest.files)) {
      const response = await fetch(base + name); assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.equal(crypto.createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), digest, name);
    }
    assert.match(await (await fetch(base + "koinos.min.js")).text(), /license information/);
    assert.equal((await fetch(base + "missing.js")).status, 404);
    assert.equal((await fetch(base, { method: "POST", body: "no transaction upload" })).status, 404);
    console.log("Producer signer files, hashes and security headers verified.");
  } finally { await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
