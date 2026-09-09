"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { ComposioClient, ComposioError, slug } = require("./composio-client");
class ConnectionSettings {
  constructor({ stateDir, secret, env = process.env }) {
    this.file = path.join(stateDir, "connections.json"); this.secret = secret; this.env = env; this.saved = { enabled: false, key: "" }; this.locked = false;
    if (fs.existsSync(this.file)) try {
      const p = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const d = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(p.iv, "base64")); d.setAuthTag(Buffer.from(p.tag, "base64"));
      this.saved = JSON.parse(Buffer.concat([d.update(Buffer.from(p.data, "base64")), d.final()]).toString());
    } catch { this.locked = true; }
  }
  encryptionKey() { if (!this.secret) throw new ComposioError("Set a persistent SESSION_SECRET before saving a Composio key."); return crypto.createHash("sha256").update("kai-connections-v1:" + this.secret).digest(); }
  config() { return { enabled: !this.locked && (this.env.KAI_COMPOSIO_ENABLED !== undefined ? this.env.KAI_COMPOSIO_ENABLED === "true" : this.saved.enabled), key: this.env.COMPOSIO_API_KEY || this.saved.key }; }
  status() { const c = this.config(); return { enabled: !!c.enabled, configured: !!c.key, available: !!c.enabled && !!c.key, locked: this.locked, keySource: this.env.COMPOSIO_API_KEY ? "environment" : "admin", writable: !!this.secret && !this.locked, generation: c.key ? crypto.createHash("sha256").update(c.key).digest("hex").slice(0, 24) : null }; }
  save(input) {
    if (this.locked) throw new ComposioError("The saved key is locked. Restore the original SESSION_SECRET.");
    if (this.env.COMPOSIO_API_KEY && input.key) throw new ComposioError("This key is managed by COMPOSIO_API_KEY on the server.");
    if (this.env.KAI_COMPOSIO_ENABLED !== undefined) throw new ComposioError("Enablement is managed by KAI_COMPOSIO_ENABLED on the server.");
    const key = input.clearKey ? "" : input.key || this.saved.key;
    if (key && (typeof key !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(key))) throw new ComposioError("Enter a valid Composio project API key.");
    const next = { enabled: input.enabled === true, key }; if (next.enabled && !key && !this.env.COMPOSIO_API_KEY) throw new ComposioError("Add a key before enabling managed connections.");
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 }); fs.renameSync(tmp, this.file); this.saved = next; return this.status();
  }
}
function mountConnections({ app, accounts, requireAdmin, stateDir, secret, siteOrigin, env, fetchImpl }) {
  const settings = new ConnectionSettings({ stateDir, secret, env }); let client, generation; const counts = new Map(); let active = 0;
  const transport = () => { const s = settings.status(); if (!s.available) throw new ComposioError("KAI-managed connections are not enabled on this server.", 503); if (generation !== s.generation) { generation = s.generation; client = new ComposioClient({ key: settings.config().key, fetchImpl }); } return client; };
  const fail = (res, e) => res.status(e instanceof ComposioError ? e.status : 502).json({ ok: false, error: e instanceof ComposioError ? e.message : "The connection service could not complete the request." });
  app.get("/connections/status", (_req, res) => { res.setHeader("Cache-Control", "no-store"); const s = settings.status(); res.json({ ok: true, available: s.available, generation: s.generation, protocol: 1 }); });
  app.get("/admin/api/connections", requireAdmin, (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.json({ ok: true, ...settings.status() }); });
  app.post("/admin/api/connections", requireAdmin, async (req, res) => {
    try {
      const origin = req.headers.origin || req.headers.referer;
      if (!origin || new URL(origin).origin !== new URL(siteOrigin).origin) throw new ComposioError("Open these settings from this site's admin page.", 403);
      if (req.body?.key) {
        if (typeof req.body.key !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(req.body.key)) throw new ComposioError("Enter a valid Composio project API key.");
        if (!settings.status().writable || settings.env.COMPOSIO_API_KEY) throw new ComposioError("This server key cannot be changed from the admin page.");
        await new ComposioClient({ key: req.body.key, fetchImpl }).catalog();
      }
      res.json({ ok: true, ...settings.save(req.body || {}) });
    } catch (e) { fail(res, e); }
  });
  app.post("/connections/api/:action", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!accounts) return res.status(503).json({ ok: false, error: "KAI account sign-in is unavailable." });
    const owner = accounts.requireAccount(req, res); if (!owner) return;
    const userId = "kai:" + owner.id, action = req.params.action, input = req.body || {};
    const countKey = owner.id + ":" + Math.floor(Date.now() / 60000), used = counts.get(countKey) || 0;
    if (used >= 90 || active >= 12) return res.status(429).json({ ok: false, error: "Too many connection requests. Try again shortly." });
    if (counts.size > 10000) for (const k of counts.keys()) if (!k.endsWith(":" + Math.floor(Date.now() / 60000))) counts.delete(k);
    counts.set(countKey, used + 1); active++;
    const controller = new AbortController(); res.on("close", () => controller.abort());
    try {
      const api = transport(), signal = controller.signal; let result;
      if (input.generation && input.generation !== generation) throw new ComposioError("The server's Composio project changed. Refresh Connections before continuing.", 409);
      switch (action) {
        case "catalog": result = await api.catalog(input, signal); break;
        case "toolkit": result = await api.toolkit(input.slug, signal); break;
        case "tools": result = await api.tools(input, signal); break;
        case "tool": result = await api.tool(input.slug, input.version, signal); break;
        case "accounts": result = { userId, accounts: await api.accounts(userId, signal), generation }; break;
        case "connect": result = await api.connect(slug(input.slug), userId, signal); break;
        case "disconnect": result = await api.disconnect(input.id, userId, signal); break;
        case "execute": result = await api.execute(input, userId, signal); break;
        default: throw new ComposioError("Unknown connection action.", 404);
      }
      res.json({ ok: true, result });
    } catch (e) { if (!res.destroyed) fail(res, e); }
    finally { active--; }
  });
  return settings;
}
module.exports = { ConnectionSettings, mountConnections };
