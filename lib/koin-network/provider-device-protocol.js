"use strict";
const crypto = require("node:crypto"), { Signer, utils } = require("koilib"), D = require("./session-delegation");
const ACTIONS = Object.freeze(["register", "presence", "qualification", "result", "chunk", "revoke", "status"]);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest();
function exact(value, keys, message) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw Error(message);
}
function base64(value, length, message) {
  if (typeof value !== "string") throw Error(message);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) throw Error(message);
  return bytes;
}
function validateAuthorization(value, expected = {}) {
  exact(value, ["schema", "purpose", "schedulerUrl", "target", "wallet", "deviceId", "publicKey", "challenge", "issuedAt", "challengeExpiresAt", "expiresAt", "actions"], "Invalid provider device authorization");
  let url; try { url = new URL(value.schedulerUrl); } catch { throw Error("Invalid provider service origin"); }
  if (value.schema !== 1 || value.purpose !== "provider" || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.href !== value.schedulerUrl || url.pathname !== "/scheduler" || !utils.isChecksumAddress(value.wallet) ||
      !/^[a-f0-9]{64}$/.test(value.deviceId) || !/^[a-f0-9]{64}$/.test(value.challenge) ||
      ![value.issuedAt, value.challengeExpiresAt, value.expiresAt].every(n => Number.isSafeInteger(n) && n >= 0) ||
      value.challengeExpiresAt !== value.issuedAt + 300000 || value.expiresAt !== value.issuedAt + 2592000000 ||
      JSON.stringify(value.actions) !== JSON.stringify(ACTIONS)) throw Error("Invalid provider device authority or lifetime");
  const publicKey = base64(value.publicKey, 44, "Invalid provider device public key");
  if (!publicKey.subarray(0, 12).equals(Buffer.from("302a300506032b6570032100", "hex"))) throw Error("Provider device requires an Ed25519 key");
  const target = D.target(value.target);
  if ((expected.schedulerUrl !== undefined && expected.schedulerUrl !== value.schedulerUrl) ||
      (expected.wallet !== undefined && expected.wallet !== value.wallet) ||
      (expected.target !== undefined && JSON.stringify(D.target(expected.target)) !== JSON.stringify(target))) throw Error("Provider device deployment or reward wallet changed");
  return { schema: 1, purpose: "provider", schedulerUrl: value.schedulerUrl, target, wallet: value.wallet,
    deviceId: value.deviceId, publicKey: value.publicKey, challenge: value.challenge, issuedAt: value.issuedAt,
    challengeExpiresAt: value.challengeExpiresAt, expiresAt: value.expiresAt, actions: [...ACTIONS] };
}
function authorizationHash(value) { return hash(JSON.stringify(["KAI-PROVIDER-DEVICE-AUTHORIZATION-V1", validateAuthorization(value)])); }
function authorizationId(value) { return authorizationHash(value).toString("hex"); }
function actionHash(value, action, digest, at) {
  const a = validateAuthorization(value), bytes = Buffer.from(digest);
  if (!ACTIONS.includes(action) || bytes.length !== 32 || !Number.isSafeInteger(at) || at < a.issuedAt || at >= a.expiresAt) throw Error("Provider device action is outside its authorization");
  return Buffer.from(JSON.stringify(["KAI-PROVIDER-DEVICE-ACTION-V1", authorizationId(a), a.deviceId, action, at, bytes.toString("hex")]));
}
function verifyWalletAuthorization(value, walletSignature, expected = {}) {
  const authorization = validateAuthorization(value, expected);
  const proof = base64(walletSignature, 65, "Invalid provider wallet authorization proof");
  if (Signer.recoverAddress(authorizationHash(authorization), proof) !== authorization.wallet) throw Error("Provider wallet authorization signature mismatch");
  return authorization;
}
function encodeAction(authorization, walletSignature, privateKey, action, digest, at = Date.now()) {
  const a = verifyWalletAuthorization(authorization, walletSignature);
  const signature = crypto.sign(null, actionHash(a, action, digest, at), privateKey).toString("base64");
  return "pd1." + Buffer.from(JSON.stringify({ authorization: a, walletSignature, at, signature })).toString("base64url");
}
function decodeAction(value) {
  if (typeof value !== "string" || !value.startsWith("pd1.") || value.length > 12000) throw Error("Invalid provider device proof");
  const bytes = Buffer.from(value.slice(4), "base64url");
  if (bytes.toString("base64url") !== value.slice(4)) throw Error("Invalid provider device encoding");
  let proof; try { proof = JSON.parse(bytes.toString("utf8")); } catch { throw Error("Invalid provider device proof"); }
  exact(proof, ["authorization", "walletSignature", "at", "signature"], "Invalid provider device proof fields");
  return proof;
}
function verifyAction(encoded, action, digest, expected = {}) {
  const proof = decodeAction(encoded), authorization = verifyWalletAuthorization(proof.authorization, proof.walletSignature, expected);
  const at = proof.at, now = expected.now ?? Date.now();
  if (!Number.isSafeInteger(now) || at > now + 5000 || (!expected.historical && now - at > 60000)) throw Error("Provider device proof expired");
  if (expected.completedAt !== undefined && (!Number.isSafeInteger(expected.completedAt) || Math.abs(expected.completedAt - at) > 60000)) throw Error("Provider receipt time differs from its authorization proof");
  const signature = base64(proof.signature, 64, "Invalid provider device signature");
  const key = crypto.createPublicKey({ key: Buffer.from(authorization.publicKey, "base64"), format: "der", type: "spki" });
  if (!crypto.verify(null, actionHash(authorization, action, digest, at), key, signature)) throw Error("Provider device signature mismatch");
  return { authorization, authorizationId: authorizationId(authorization), deviceId: authorization.deviceId, wallet: authorization.wallet, at };
}
function canonical(value, depth = 0) {
  if (depth > 8) throw Error("Provider registration is too complex");
  if (value === null || typeof value === "boolean" || typeof value === "string" && value.length <= 4096 || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 128) return value.map(v => canonical(v, depth + 1));
  if (value && typeof value === "object" && Object.keys(value).length <= 128) return Object.fromEntries(Object.keys(value).sort().map(k => {
    if (["__proto__", "prototype", "constructor"].includes(k) || k.length > 100) throw Error("Invalid provider registration field");
    return [k, canonical(value[k], depth + 1)];
  }));
  throw Error("Invalid provider registration data");
}
function registrationHash(body) {
  if (!body || !utils.isChecksumAddress(body.address) || !Number.isSafeInteger(body.ts) || body.ts < 0 ||
      typeof body.fingerprint !== "string" || !/^[a-f0-9]{16}$/.test(body.fingerprint) || !Array.isArray(body.models) || !body.capabilities || typeof body.capabilities !== "object") throw Error("Invalid delegated provider registration");
  return hash(JSON.stringify(["KAI-PROVIDER-REGISTER-V1", body.address, body.ts, body.fingerprint, canonical(body.models), canonical(body.capabilities)]));
}
module.exports = { ACTIONS, validateAuthorization, authorizationHash, authorizationId, actionHash, verifyWalletAuthorization, encodeAction, decodeAction, verifyAction, registrationHash, hash };
