"use strict";
// Original KAI transport for Composio's documented v3.1 REST API. Shared with
// the account server; never a general-purpose authenticated HTTP proxy.
const API = "https://backend.composio.dev/api/v3.1";
class ComposioError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const slug = value => { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new ComposioError("Choose a valid app or action."); return value; };
const short = (value, max = 200) => String(value ?? "").slice(0, max);
const page = (result, clean) => ({ items: (Array.isArray(result.items) ? result.items : []).map(clean), nextCursor: short(result.next_cursor, 2000) || null, total: Number(result.total_items) || 0 });
function toolkit(t) {
  return { slug: slug(t.slug), name: short(t.name || t.slug, 100), description: short(t.meta?.description || t.description, 500),
    logo: short(t.meta?.logo || t.logo, 1000), categories: (t.meta?.categories || []).map(c => short(c.name || c.id || c, 60)).slice(0, 5),
    noAuth: t.no_auth === true, authSchemes: t.auth_schemes || [], managedSchemes: t.composio_managed_auth_schemes || [] };
}
function account(a) {
  // The upstream state/data objects may contain OAuth tokens. Never return them.
  return { id: slug(a.id), toolkit: slug(a.toolkit?.slug), userId: short(a.user_id), status: short(a.status, 40),
    name: short(a.alias || a.word_id || a.toolkit?.slug, 100), disabled: a.is_disabled === true, createdAt: short(a.created_at, 50) };
}
function tool(t) {
  const raw = t.input_parameters || {}, properties = raw.properties || Object.fromEntries(Object.entries(raw).filter(([, v]) => v && typeof v === "object"));
  const required = Array.isArray(raw.required) ? raw.required : Object.keys(properties).filter(k => properties[k].required === true);
  const tags = (t.tags || []).map(x => String(x).toLowerCase());
  const readOnly = t.annotations?.readOnlyHint === true || tags.some(x => ["readonlyhint", "read_only", "read-only"].includes(x));
  return { id: slug(t.slug), name: short(t.name || t.slug.replace(/_/g, " "), 120), description: short(t.description, 1200),
    toolkit: slug(t.toolkit?.slug), version: short(t.version || "latest", 60), readOnly,
    schema: { type: "object", properties, required }, method: readOnly ? "GET" : "POST", path: t.slug };
}
function args(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 16000) throw new ComposioError("Action inputs must be an object smaller than 16 KB.");
  return JSON.parse(JSON.stringify(value));
}
function validateArgs(value, schema) {
  const out = args(value);
  for (const k of schema.required || []) if (out[k] === undefined || out[k] === "") throw new ComposioError(`Enter ${k.replace(/_/g, " ")}.`);
  for (const [k, v] of Object.entries(out)) {
    const p = schema.properties?.[k]; if (!p) throw new ComposioError(`Unknown input: ${k}.`);
    if (p.enum && !p.enum.includes(v)) throw new ComposioError(`Choose a listed value for ${k}.`);
    if (p.type === "array" ? !Array.isArray(v) : p.type === "object" ? !v || typeof v !== "object" || Array.isArray(v) : p.type === "integer" ? !Number.isInteger(v) : ["string", "number", "boolean"].includes(p.type) && typeof v !== p.type) throw new ComposioError(`Check the value for ${k}.`);
  }
  return out;
}
function connectURL(value) {
  let u; try { u = new URL(value); } catch { throw new ComposioError("Composio did not return a valid sign-in link."); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !["connect.composio.dev", "backend.composio.dev"].includes(u.hostname)) throw new ComposioError("Composio returned an unsupported sign-in link.");
  return u.href;
}
class ComposioClient {
  constructor({ key, fetchImpl = fetch }) { this.key = key; this.fetch = fetchImpl; this.configs = new Map(); this.metadata = new Map(); this.categories = null; }
  async request(path, { method = "GET", body, signal } = {}) {
    const response = await this.fetch(API + path, { method, headers: { "x-api-key": this.key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new ComposioError(({ 401: "Composio rejected this key. Check your project API key.", 403: "This Composio key or account lacks permission for this action.", 404: "This app, account or action is no longer available.", 429: "Composio is busy or your usage limit was reached. Try again shortly." })[response.status] || `Composio returned HTTP ${response.status}. Check the connection and try again.`, response.status);
    let content = "", bytes = 0; const decoder = new TextDecoder();
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new ComposioError("Composio returned too much data. Narrow your search."); content += decoder.decode(chunk, { stream: true }); }
    content += decoder.decode(); signal?.throwIfAborted();
    if (!content) return {};
    try { return JSON.parse(content); } catch { throw new ComposioError("Composio returned an unreadable response.", 502); }
  }
  async catalog({ search = "", cursor = "", category = "" } = {}, signal) {
    const q = new URLSearchParams({ limit: "48", sort_by: "usage", include_deprecated: "false" });
    if (search) q.set("search", short(search, 160)); if (cursor) q.set("cursor", short(cursor, 2000)); if (category) q.set("category", short(category, 80));
    const result = page(await this.request("/toolkits?" + q, { signal }), toolkit);
    if (!this.categories) {
      const r = await this.request("/toolkits/categories", { signal });
      this.categories = (r.items || []).map(c => ({ id: short(c.id, 80), name: short(c.name, 80) }));
    }
    return { ...result, categories: this.categories };
  }
  async toolkit(key, signal) { return toolkit(await this.request("/toolkits/" + slug(key), { signal })); }
  async tools({ toolkit: key, search = "", cursor = "" }, signal) {
    const q = new URLSearchParams({ toolkit_slug: slug(key), limit: "40", toolkit_versions: "latest", include_deprecated: "false" });
    if (search) q.set("query", short(search, 160)); if (cursor) q.set("cursor", short(cursor, 2000));
    return page(await this.request("/tools?" + q, { signal }), tool);
  }
  async tool(key, version = "latest", signal) {
    const cache = key + ":" + version; if (this.metadata.has(cache)) return this.metadata.get(cache);
    const result = tool(await this.request("/tools/" + slug(key) + "?version=" + encodeURIComponent(short(version, 60)), { signal }));
    if (this.metadata.size > 500) this.metadata.clear(); this.metadata.set(cache, result); return result;
  }
  async accounts(userId, signal) {
    const q = new URLSearchParams({ user_ids: userId, limit: "100" }); let items = [], cursor;
    for (let i = 0; i < 10; i++) {
      if (cursor) q.set("cursor", cursor); const p = await this.request("/connected_accounts?" + q, { signal });
      items.push(...(p.items || []).filter(a => a.user_id === userId).map(account)); cursor = p.next_cursor; if (!cursor) return items;
    }
    throw new ComposioError("Too many linked accounts. Remove unused connections in Composio.");
  }
  async owned(id, userId, signal) {
    const raw = await this.request("/connected_accounts/" + slug(id), { signal });
    if (raw.user_id !== userId) throw new ComposioError("This connection belongs to a different account.", 403);
    return account(raw);
  }
  async connect(key, userId, signal) {
    const t = await this.toolkit(key, signal); let authId = this.configs.get(key);
    if (!authId) {
      const listed = await this.request("/auth_configs?" + new URLSearchParams({ toolkit_slug: t.slug, show_disabled: "false", limit: "50" }), { signal });
      const candidates = (listed.items || []).filter(c => c.toolkit?.slug === t.slug && c.status === "ENABLED");
      const existing = candidates.find(c => c.is_composio_managed) || candidates[0];
      if (existing) authId = slug(existing.id);
      else {
        try { const created = await this.request("/auth_configs", { method: "POST", signal, body: { toolkit: { slug: t.slug } } }); authId = slug(created.auth_config?.id); }
        catch (e) { if (e instanceof ComposioError && e.status === 400) throw new ComposioError("This app needs an authentication configuration in your Composio project. Add one in Composio settings, then try connecting again."); throw e; }
      }
      this.configs.set(key, authId);
    }
    const r = await this.request("/connected_accounts/link", { method: "POST", signal, body: { auth_config_id: authId, user_id: userId } });
    return { url: connectURL(r.redirect_url), id: r.connected_account_id ? slug(r.connected_account_id) : null, expiresAt: r.expires_at || null, toolkit: t.slug };
  }
  async disconnect(id, userId, signal) { await this.owned(id, userId, signal); await this.request("/connected_accounts/" + slug(id), { method: "DELETE", signal }); return true; }
  async execute({ id, tool: key, version, arguments: values }, userId, signal) {
    const a = await this.owned(id, userId, signal); if (a.status !== "ACTIVE" || a.disabled) throw new ComposioError("Reconnect this account before using it.");
    const t = await this.tool(key, version, signal); if (t.toolkit !== a.toolkit) throw new ComposioError("This action does not belong to the connected app.", 403);
    const r = await this.request("/tools/execute/" + slug(key), { method: "POST", signal, body: { connected_account_id: id, user_id: userId, version: t.version, arguments: validateArgs(values, t.schema) } });
    if (r.successful !== true) throw new ComposioError("The app could not complete this action. Check its inputs and account permissions.");
    const result = JSON.stringify(r.data ?? {}); if (Buffer.byteLength(result) > 200000) throw new ComposioError("The result is larger than 200 KB. Narrow the request.");
    return result.split(this.key).join("[credential removed]");
  }
}
module.exports = { ComposioClient, ComposioError, slug, toolkit, account, tool, args, validateArgs, connectURL };
