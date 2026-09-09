"use strict";
const assert = require("assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), express = require("express");
const { EventRelay, mountEventRelay } = require("../lib/connection-events");
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-events-")), secret = "synthetic-storage-secret", signing = "synthetic-signing-secret", options = { stateDir: dir, secret, siteOrigin: "https://kai.example" };
  const relay = new EventRelay(options), project = "a".repeat(24), personal = relay.register("alice", { project, userId: "kai-desktop-alice", signingSecret: signing }), managed = relay.register("managed", { project, signingSecret: signing }, true);
  const message = (id, userId = "kai-desktop-alice", stamp = Math.floor(Date.now() / 1000)) => { const raw = Buffer.from(JSON.stringify({ id, type: "composio.trigger.message", metadata: { connected_account_id: "ca_alice", trigger_id: "tr_1", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", user_id: userId }, data: { subject: "synthetic-private-event" } })); return { raw, headers: { "webhook-id": id, "webhook-timestamp": String(stamp), "webhook-signature": "v1," + crypto.createHmac("sha256", signing).update(id + "." + stamp + ".").update(raw).digest("base64") } }; };
  try {
    let m = message("msg_1"); assert.equal(relay.receive(personal.channel, m.raw, m.headers), true); assert.equal(relay.receive(personal.channel, m.raw, m.headers), false);
    assert.throws(() => relay.poll("bob", { channel: personal.channel }), /unavailable/);
    assert.throws(() => relay.receive(personal.channel, Buffer.from("{}"), m.headers), /signature/);
    m = message("msg_old", undefined, 1); assert.throws(() => relay.receive(personal.channel, m.raw, m.headers), /Expired/);
    m = message("msg_wrong", "kai-desktop-bob"); assert.equal(relay.receive(personal.channel, m.raw, m.headers), false);
    let rows = relay.poll("alice", { channel: personal.channel }).items; assert.equal(rows.length, 1); assert.equal(rows[0].payload.subject, "synthetic-private-event");
    relay.poll("alice", { channel: personal.channel, after: rows[0].sequence }); m = message("msg_1"); assert.equal(relay.receive(personal.channel, m.raw, m.headers), false, "acknowledged deliveries remain deduplicated");
    for (const who of ["alice", "bob"]) { m = message("msg_" + who, "kai:" + who); relay.receive(managed.channel, m.raw, m.headers); }
    assert.deepEqual(relay.poll("alice", { channel: managed.channel }).items.map(e => e.id), ["msg_alice"]);
    relay.poll("alice", { channel: managed.channel, after: 10000 }); assert.equal(relay.poll("bob", { channel: managed.channel }).items.length, 1);
    const disk = fs.readFileSync(relay.file, "utf8"); assert.ok(!disk.includes(signing)); assert.ok(!disk.includes("synthetic-private-event"));
    const reopened = new EventRelay(options); assert.equal(reopened.poll("bob", { channel: managed.channel }).items.length, 1);
    assert.throws(() => new EventRelay({ ...options, secret: "wrong" }).register("alice", { project, userId: "kai-desktop-alice" }), /locked/);
    const app = express(); app.use("/connections/webhook", express.raw({ type: "application/json", limit: "40kb" })); app.use(express.json());
    mountEventRelay({ app, ...options, accounts: { requireAccount(req, res) { if (req.headers.authorization !== "Bearer alice") { res.status(401).json({ ok: false }); return null; } return { id: "alice" }; } }, transport: () => { throw Error("unused"); }, generation: () => project });
    const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
    try {
      const base = "http://127.0.0.1:" + server.address().port;
      let r = await fetch(base + "/connections/events/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: managed.channel }) }); assert.equal(r.status, 401);
      m = message("msg_http", "kai:alice"); r = await fetch(base + "/connections/webhook/" + managed.channel, { method: "POST", headers: { ...m.headers, "content-type": "application/json" }, body: m.raw }); assert.equal(r.status, 200);
      r = await fetch(base + "/connections/events/poll", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer alice" }, body: JSON.stringify({ channel: managed.channel, owner: "bob" }) }); rows = (await r.json()).result.items; assert.deepEqual(rows.map(e => e.id), ["msg_http"]);
    } finally { await new Promise(r => server.close(r)); }
    console.log("PASS: signed raw HTTP delivery, replay protection, encrypted persistence, owner isolation and authenticated polling");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
