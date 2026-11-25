"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), M = require("./managed-protocol");
const VERSION = 2, TTL = 7 * 86400000, ORIGIN = "https://api.akashml.com/v1";
// Changes in the serving adapter invalidate earlier evidence automatically.
function contract() { return crypto.createHash("sha256").update(["native-chat.js", "native-replay.js", "native-probe.js", "native-qualification.js", "managed-provider.js", "../credit-gateway.js"].map(p => fs.readFileSync(path.join(__dirname, p))).join("\n")).digest("hex"); }
function sign(record, key) { return crypto.createHmac("sha256", key).update("kai-native-qualification-v2\n" + JSON.stringify(record)).digest("hex"); }
function evidence(model, usage, key, now = Date.now()) {
  if (!M.find(model) || usage.length !== 2 || usage.some(u => !Number.isSafeInteger(u.input) || u.input < 1 || !Number.isSafeInteger(u.output) || u.output < 1)) throw Error("Incomplete qualification evidence");
  const record = { version: VERSION, model, upstream: M.find(model).upstream, origin: ORIGIN, policy: M.policyHash, contract: contract(),
    checkedAt: now, expiresAt: now + TTL, checks: ["call_schema", "paired_result", "followup_nonce", "bounded_usage", "sealed_replay"], usage };
  return { record, signature: sign(record, key) };
}
function verify(value, model, key, now = Date.now()) {
  const r = value?.record;
  return !!r && r.version === VERSION && r.model === model && r.upstream === M.find(model)?.upstream && r.origin === ORIGIN &&
    r.policy === M.policyHash && r.contract === contract() && Number.isSafeInteger(r.checkedAt) && r.checkedAt <= now &&
    Number.isSafeInteger(r.expiresAt) && r.expiresAt > now && r.expiresAt <= r.checkedAt + TTL &&
    Array.isArray(r.usage) && r.usage.length === 2 && r.usage.every(u => Number.isSafeInteger(u.input) && u.input > 0 && Number.isSafeInteger(u.output) && u.output > 0) &&
    JSON.stringify(r.checks) === JSON.stringify(["call_schema", "paired_result", "followup_nonce", "bounded_usage", "sealed_replay"]) &&
    typeof value.signature === "string" && /^[a-f0-9]{64}$/.test(value.signature) && crypto.timingSafeEqual(Buffer.from(sign(r, key), "hex"), Buffer.from(value.signature, "hex"));
}
function capability(model, env = process.env, now = Date.now()) {
  try {
    if (!String(env.KAI_NATIVE_TOOL_MODELS || "").split(",").map(s => s.trim()).includes(model)) return null;
    const file = env.KAI_NATIVE_QUALIFICATION_FILE;
    if (!file || !path.isAbsolute(file)) return null;
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 131072 || (st.mode & 0o077)) return null;
    const key = require("./managed-provider").secret(env); if (!key) return null;
    const values = JSON.parse(fs.readFileSync(file, "utf8"));
    if (values.schema !== 1 || !Array.isArray(values.routes) || values.routes.length > 32) return null;
    const rows = values.routes.filter(v => v.record?.model === model);
    if (rows.length !== 1 || !verify(rows[0], model, key, now)) return null;
    return { version: VERSION, qualificationId: rows[0].signature, checkedAt: rows[0].record.checkedAt,
      expiresAt: rows[0].record.expiresAt, replay: "sealed-v1" };
  } catch { return null; }
}
module.exports = { VERSION, TTL, ORIGIN, contract, evidence, verify, capability };
