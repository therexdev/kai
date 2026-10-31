"use strict";
// Local compatibility/security fixtures only: no real mail, RPC or signing keys.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const http = require("node:http"), zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const express = require("express"), nodemailer = require("nodemailer");

async function main() {
  // The producer signer and exported apps use the bundled browser serializer,
  // not Node's override. Exercise that bundle separately and compare wire bytes.
  const sdk = require("koilib");
  const browser = { TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, console };
  browser.window = browser; browser.self = browser;
  const bundle = path.join(path.dirname(require.resolve("koilib/package.json")), "dist/koinos.min.js");
  vm.runInNewContext(fs.readFileSync(bundle, "utf8"), browser, { timeout: 5000 });
  const args = { from: "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK", to: "1NsyZDCnHcm1rGFoUaUgHWs2FrsbQFqp2Q", value: "100000000" };
  const wires = [];
  for (const implementation of [sdk, browser]) {
    const contract = new implementation.Contract({ id: args.from, abi: implementation.utils.tokenAbi });
    assert.ok(contract.functions.transfer);
    const serializer = new implementation.Serializer(implementation.utils.tokenAbi.types);
    const wire = await serializer.serialize(args, "transfer_arguments");
    const result = await serializer.deserialize(wire, "transfer_arguments");
    assert.equal(result.from, args.from); assert.equal(result.to, args.to); assert.equal(String(result.value), args.value);
    wires.push(Buffer.from(wire).toString("hex"));
  }
  assert.equal(wires[0], wires[1]);
  console.log("PASS Node and browser Koinos contracts encode the same transfer bytes");

  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const mail = await transport.sendMail({ from: "KAI <sender@example.invalid>", to: "reader@example.invalid", subject: "Your KAI sign-in code", text: "Synthetic verification code: 123456" });
  assert.deepEqual(mail.envelope.to, ["reader@example.invalid"]);
  assert.match(mail.message.toString(), /Synthetic verification code: 123456/);
  transport.close();
  // Isolate a historically quadratic parser input so a regression cannot hang
  // this probe or its runner. This builds/parses mail in memory; no SMTP traffic.
  execFileSync(process.execPath, ["-e", `const assert=require('node:assert/strict'),parse=require('nodemailer/lib/addressparser');
    parse(' >' + '>[x][x]'.repeat(40000));
    assert.deepEqual(parse('Alice (outer (inner) hidden@example.invalid) <safe@example.invalid>').map(x=>x.address),['safe@example.invalid']);`],
  { cwd: path.join(__dirname, ".."), timeout: 5000, stdio: "pipe" });
  console.log("PASS sign-in mail composes and hostile address text stays bounded");

  const app = express(); app.use(express.json({ limit: "10kb" }));
  app.post("/body", (req, res) => res.json(req.body)); app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(400).json({ error: "invalid body" }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const compressed = zlib.gzipSync(Buffer.from('{"ok":true}'));
    const normal = await fetch(origin + "/body", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: compressed });
    assert.equal(normal.status, 200); assert.deepEqual(await normal.json(), { ok: true });
    // Send trailing bytes only after the parser has delivered the first frame.
    await new Promise((resolve, reject) => {
      const request = http.request(origin + "/body", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" } }, response => {
        response.resume(); response.once("end", resolve); response.once("error", reject);
      });
      request.once("error", reject); request.setTimeout(5000, () => request.destroy(Error("Local request timed out")));
      request.write(compressed); setTimeout(() => request.end(Buffer.from([0, 0, 0, 1])), 30);
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await (await fetch(origin + "/health")).json(), { ok: true });
    console.log("PASS malformed compressed request leaves the HTTP server healthy");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
