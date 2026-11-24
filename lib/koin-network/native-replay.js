"use strict";
// Provider continuation state is opaque to clients, logs, tools and prompts.
// It conveys no action authority. Rotation of the supplier key invalidates it.
const crypto = require("node:crypto");
const MAX = 24000, TTL = 30 * 86400000;
function key(secret) { if (typeof secret !== "string" || secret.length < 16) throw Error("Native replay key unavailable"); return crypto.createHmac("sha256", secret).update("kai-native-replay-v1").digest(); }
function visible(message) { return { role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls || [] }; }
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
function aad(scope, message) {
  if (!scope?.domain || !scope.owner || !scope.model) throw Error("Native replay scope unavailable");
  return Buffer.from(JSON.stringify(["kai-native-replay-v1", scope.domain, scope.owner, scope.model, canonical(visible(message))]));
}
function valid(token) { return typeof token === "string" && token.length <= 34000 && /^kr1\.[A-Za-z0-9_-]+$/.test(token); }
function seal(message, scope, secret, now = Date.now()) {
  if (message?.kai_replay !== undefined) throw Error("Supplier cannot supply gateway replay metadata");
  if (!message?.tool_calls?.length) return undefined;
  const fields = {};
  for (const name of ["reasoning_content", "reasoning"]) {
    const value = message[name];
    if (value != null) { if (typeof value !== "string") throw Error("Unsupported provider replay state"); if (value) fields[name] = value; }
  }
  if (!Object.keys(fields).length) return undefined;
  const plain = Buffer.from(JSON.stringify({ expires: now + TTL, fields }));
  if (plain.length > MAX) throw Error("Provider replay state exceeds limit");
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(aad(scope, message));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return "kr1." + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
function open(token, message, scope, secret, now = Date.now()) {
  try {
    if (!valid(token)) throw Error();
    const raw = Buffer.from(token.slice(4), "base64url");
    if (raw.length < 29 || raw.length > MAX + 28) throw Error();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(secret), raw.subarray(0, 12));
    decipher.setAAD(aad(scope, message)); decipher.setAuthTag(raw.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
    if (!Number.isSafeInteger(value.expires) || value.expires <= now || value.expires > now + TTL || !value.fields ||
        Object.entries(value.fields).some(([k, v]) => !["reasoning_content", "reasoning"].includes(k) || typeof v !== "string")) throw Error();
    return value.fields;
  } catch { throw Error("Native continuation is invalid, expired or belongs to another route/account"); }
}
module.exports = { seal, open, valid, TTL };
