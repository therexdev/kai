"use strict";
// Original, account-scoped adapters for the documented Composio v3.1 trigger API.
function extend(Client) {
  const { ComposioError, slug, args } = require("./composio-client");
  Client.prototype.triggerTypes = async function ({ toolkit, cursor = "" }, signal) {
    const q = new URLSearchParams({ toolkit_slugs: slug(toolkit), limit: "50", toolkit_versions: "latest" }); if (cursor) q.set("cursor", String(cursor).slice(0, 2000));
    const r = await this.request("/triggers_types?" + q, { signal }); return { items: (r.items || []).map(t => ({ slug: slug(t.slug), name: String(t.name || t.slug).slice(0, 120), description: String(t.description || "").slice(0, 600), config: t.config || {}, payload: t.payload || {} })), nextCursor: r.next_cursor || null };
  };
  Client.prototype.triggerUpsert = async function ({ id, triggerSlug, config = {} }, userId, signal) {
    const account = await this.owned(id, userId, signal), info = await this.request("/triggers_types/" + slug(triggerSlug), { signal });
    const toolkit = info.toolkit?.slug || info.toolkit_slug; if (!toolkit || toolkit.toLowerCase() !== account.toolkit.toLowerCase()) throw new ComposioError("This event does not belong to the selected app.", 403);
    const r = await this.request("/trigger_instances/" + slug(triggerSlug) + "/upsert", { method: "POST", body: { connected_account_id: id, user_id: userId, trigger_config: args(config) }, signal }); return { triggerId: slug(r.trigger_id) };
  };
  Client.prototype.triggerRemove = async function ({ id, triggerId }, userId, signal) {
    await this.owned(id, userId, signal); const q = new URLSearchParams({ connected_account_ids: id, trigger_ids: slug(triggerId), limit: "50" }), list = await this.request("/trigger_instances/active?" + q, { signal });
    const owned = (list.items || []).some(t => (t.id || t.trigger_id) === triggerId && (t.connected_account_id || t.connected_account?.id) === id);
    if (!owned) throw new ComposioError("This event subscription is unavailable for the selected account.", 403);
    await this.request("/trigger_instances/manage/" + slug(triggerId), { method: "DELETE", signal }); return true;
  };
  Client.prototype.webhookSetup = async function (url, signal) {
    const u = new URL(url); if (u.protocol !== "https:" || u.username || u.password) throw new ComposioError("Event delivery requires a public HTTPS server.");
    const existing = await this.request("/webhook_subscriptions", { signal }), list = Array.isArray(existing) ? existing : existing.items || existing.webhook_subscriptions || (existing.id ? [existing] : []);
    if (list.length) { const current = list.find(x => x.webhook_url === url && x.version === "V3" && x.enabled_events?.includes("composio.trigger.message")); if (!current?.secret) throw new ComposioError("This Composio project already delivers events elsewhere. Keep that subscription and use an App-change watch, or configure a dedicated project for KAI."); return { secret: current.secret, id: current.id }; }
    const r = await this.request("/webhook_subscriptions", { method: "POST", body: { webhook_url: url, enabled_events: ["composio.trigger.message"], version: "V3" }, signal }); if (!r.secret) throw new ComposioError("Composio did not return an event signing secret."); return { secret: r.secret, id: r.id };
  };
}
module.exports = { extend };
