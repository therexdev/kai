"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
class EventRelay {
  constructor({ stateDir, secret, siteOrigin }) {
    this.file = path.join(stateDir, "connection-events.json"); this.secret = secret; this.origin = new URL(siteOrigin).origin; this.data = { channels: {}, events: [], sequence: 0 }; this.locked = false;
    if (fs.existsSync(this.file)) try { const raw = JSON.parse(fs.readFileSync(this.file, "utf8")), dec = crypto.createDecipheriv("aes-256-gcm", this.key(), Buffer.from(raw.iv, "base64")); dec.setAuthTag(Buffer.from(raw.tag, "base64")); this.data = JSON.parse(Buffer.concat([dec.update(Buffer.from(raw.data, "base64")), dec.final()]).toString()); } catch { this.locked = true; }
    this.committed = JSON.stringify(this.data);
  }
  key() { if (!this.secret) throw Error("A persistent SESSION_SECRET is required for event delivery."); return crypto.createHash("sha256").update("kai-event-relay:" + this.secret).digest(); }
  save() {
    try {
      if (this.locked) throw Error("The event store is locked. Restore the original SESSION_SECRET.");
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", this.key(), iv), content = JSON.stringify(this.data);
      if (content.length > 24000000) throw Error("Event queue is full.");
      const bytes = Buffer.concat([cipher.update(content), cipher.final()]); fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: bytes.toString("base64") }), { mode: 0o600 }); fs.renameSync(tmp, this.file); this.committed = content;
    } catch (e) { this.data = JSON.parse(this.committed); throw e; }
  }
  register(owner, input, managed = false) {
    if (this.locked) throw Error("The event store is locked.");
    const project = String(input.project || ""); if (!/^[a-f0-9]{24}$/.test(project)) throw Error("Invalid project binding.");
    const mode = managed ? "managed" : "personal", userId = managed ? "" : String(input.userId || ""); if (!managed && !/^kai-desktop-[a-z0-9-]{1,80}$/i.test(userId)) throw Error("Invalid personal event identity.");
    const identity = managed ? "managed:" + project : owner + ":" + project;
    const channel = crypto.createHmac("sha256", this.key()).update(identity).digest("hex").slice(0, 40), existing = this.data.channels[channel];
    if (!existing && Object.values(this.data.channels).filter(c => c.owner === owner).length >= 4) throw Error("Remove unused event projects before adding another.");
    const signing = input.signingSecret || existing?.signingSecret || ""; if (signing && (typeof signing !== "string" || !/^[\x21-\x7e]{8,512}$/.test(signing))) throw Error("Invalid event signing secret.");
    this.data.channels[channel] = { owner: managed ? "managed" : owner, project, mode, userId, signingSecret: signing, updatedAt: Date.now() }; this.save(); return { channel, webhookUrl: this.origin + "/connections/webhook/" + channel, configured: !!signing };
  }
  receive(channel, raw, headers) {
    const c = this.data.channels[channel]; if (!c?.signingSecret || this.locked) throw Error("Unknown event channel.");
    const messageId = String(headers["webhook-id"] || ""), stamp = String(headers["webhook-timestamp"] || "");
    if (!/^[\w-]{1,160}$/.test(messageId) || !/^\d{9,12}$/.test(stamp) || Math.abs(Date.now() / 1000 - Number(stamp)) > 300) throw Error("Expired event signature.");
    if (!Buffer.isBuffer(raw) || raw.length > 40000) throw Error("Invalid event body.");
    const expected = crypto.createHmac("sha256", c.signingSecret).update(messageId + "." + stamp + ".").update(raw).digest();
    const signatures = String(headers["webhook-signature"] || "").split(/\s+/).filter(s => s.startsWith("v1,")).map(s => Buffer.from(s.slice(3), "base64"));
    if (!signatures.some(s => s.length === expected.length && crypto.timingSafeEqual(s, expected))) throw Error("Invalid event signature.");
    const body = JSON.parse(raw.toString("utf8")), m = body.metadata;
    if (body.type !== "composio.trigger.message") return false;
    if (body.id !== messageId || !m || !/^[\w-]{1,160}$/.test(m.connected_account_id || "") || !/^[\w-]{1,160}$/.test(m.trigger_slug || "") || !/^[\w-]{1,160}$/.test(m.trigger_id || "")) throw Error("Invalid event metadata.");
    const owner = c.mode === "managed" ? /^kai:([\w-]{1,160})$/.exec(m.user_id || "")?.[1] : c.owner;
    if (!owner || c.mode === "personal" && m.user_id !== c.userId) return false;
    if ((this.data.receipts || []).some(e => e.channel === channel && e.id === messageId)) return false;
    const now = Date.now(); this.data.events = this.data.events.filter(e => e.at > now - 86400000); const queue = this.data.events.filter(e => e.channel === channel && e.owner === owner);
    if (queue.length >= 100) throw Error("Event queue is full for this account.");
    this.data.receipts = (this.data.receipts || []).filter(e => e.at > now - 86400000).slice(-19999); this.data.receipts.push({ channel, id: messageId, at: now });
    this.data.events.push({ channel, owner, id: messageId, sequence: ++this.data.sequence, at: now, project: c.project, accountId: m.connected_account_id, triggerId: m.trigger_id, triggerSlug: m.trigger_slug, payload: body.data }); this.save(); return true;
  }
  poll(owner, input) { const c = this.data.channels[input.channel]; if (!c || c.mode === "personal" && c.owner !== owner) throw Error("Event channel unavailable."); const after = Number(input.after) || 0; const length = this.data.events.length; this.data.events = this.data.events.filter(e => !(e.channel === input.channel && e.owner === owner && e.sequence <= after)); if (this.data.events.length !== length) this.save(); return { items: this.data.events.filter(e => e.channel === input.channel && e.owner === owner && e.sequence > after && e.at > Date.now() - 86400000).slice(0, 20).map(({ owner, channel, ...e }) => e) }; }
}
function mountEventRelay({ app, accounts, stateDir, secret, siteOrigin, transport, generation }) {
  const relay = new EventRelay({ stateDir, secret, siteOrigin });
  app.post("/connections/webhook/:channel", (req, res) => { try { relay.receive(req.params.channel, req.body, req.headers); res.status(200).json({ ok: true }); } catch (e) { res.status(/queue is full|ENOSPC|EIO/.test(e.message) ? 503 : 401).json({ ok: false, error: "Event delivery could not be verified or queued." }); } });
  const rates = new Map();
  app.post("/connections/events/:action", async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); const owner = accounts?.requireAccount(req, res); if (!owner) return;
    const rateKey = owner.id + ":" + Math.floor(Date.now() / 60000), used = rates.get(rateKey) || 0; if (used >= 30) return res.status(429).json({ ok: false, error: "Wait before checking events again." }); rates.set(rateKey, used + 1); if (rates.size > 10000) rates.clear();
    try {
      let result; const input = req.body || {};
      if (req.params.action === "register") result = relay.register(owner.id, input);
      else if (req.params.action === "managedSetup") { const api = transport(), project = generation(); const channel = relay.register("managed", { project }, true); if (!channel.configured) { const subscription = await api.webhookSetup(channel.webhookUrl); relay.register("managed", { project, signingSecret: subscription.secret }, true); } result = { ...channel, configured: true, project }; }
      else if (req.params.action === "poll") result = relay.poll(owner.id, input);
      else return res.status(404).json({ ok: false, error: "Unknown event operation." });
      res.json({ ok: true, result });
    } catch (e) { res.status(400).json({ ok: false, error: String(e.message || "Event service unavailable").slice(0, 350) }); }
  });
  return relay;
}
module.exports = { EventRelay, mountEventRelay };
