"use strict";

/*
 * Minimal WebAuthn (passkey) server verification — Node's built-in crypto
 * only, no deps, matching the repo's posture (lib/auth.js). Scope is exactly
 * what consumer passkeys need and nothing more:
 *
 *  - Registration: parse the attestationObject, verify the ceremony binding
 *    (challenge / origin / rpIdHash / user-present), extract the credential
 *    id + COSE public key. Attestation statements are deliberately IGNORED
 *    ("none" trust model): we are binding a key to an already-authenticated
 *    account, not proving authenticator provenance — the industry-standard
 *    posture for consumer sign-in.
 *  - Assertion: verify the signature over authenticatorData || sha256(
 *    clientDataJSON) with the stored key, plus the same ceremony binding.
 *
 * Algorithms: ES256 (-7, every platform authenticator) and RS256 (-257,
 * older Windows Hello). Both verify through crypto.createPublicKey(JWK).
 *
 * CBOR: authenticators emit CTAP2 canonical CBOR — definite lengths only —
 * so the decoder below handles exactly that subset and throws on anything
 * else rather than guessing.
 */

const crypto = require("crypto");

/* ------------------------------------------------------------- CBOR read */
function cborDecode(buf) {
  const [v, off] = cborItem(buf, 0);
  return { value: v, bytesRead: off };
}

function cborItem(buf, off) {
  if (off >= buf.length) throw new Error("cbor: truncated");
  const b = buf[off];
  const major = b >> 5;
  const info = b & 0x1f;
  let len = 0;
  let head = 1;
  if (info < 24) len = info;
  else if (info === 24) { len = buf[off + 1]; head = 2; }
  else if (info === 25) { len = buf.readUInt16BE(off + 1); head = 3; }
  else if (info === 26) { len = buf.readUInt32BE(off + 1); head = 5; }
  else throw new Error(`cbor: unsupported additional info ${info} (indefinite/64-bit)`);
  const start = off + head;
  switch (major) {
    case 0: return [len, start]; // unsigned int
    case 1: return [-1 - len, start]; // negative int
    case 2: { // byte string
      if (start + len > buf.length) throw new Error("cbor: bytes past end");
      return [buf.subarray(start, start + len), start + len];
    }
    case 3: { // text string
      if (start + len > buf.length) throw new Error("cbor: text past end");
      return [buf.toString("utf8", start, start + len), start + len];
    }
    case 4: { // array
      const arr = [];
      let p = start;
      for (let i = 0; i < len; i++) { const [v, np] = cborItem(buf, p); arr.push(v); p = np; }
      return [arr, p];
    }
    case 5: { // map — keys are ints or strings in COSE/CTAP2
      const map = new Map();
      let p = start;
      for (let i = 0; i < len; i++) {
        const [k, kp] = cborItem(buf, p);
        const [v, vp] = cborItem(buf, kp);
        map.set(k, v);
        p = vp;
      }
      return [map, p];
    }
    case 7: { // simple values: only true/false/null appear in our inputs
      if (info === 20) return [false, start];
      if (info === 21) return [true, start];
      if (info === 22) return [null, start];
      throw new Error(`cbor: unsupported simple value ${info}`);
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

/* -------------------------------------------------------- COSE -> crypto */
const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** COSE_Key map -> { alg, jwk } or throws. */
function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2) { // EC2
    if (alg !== -7) throw new Error(`passkey: unsupported EC algorithm ${alg}`);
    if (cose.get(-1) !== 1) throw new Error("passkey: unsupported EC curve (need P-256)");
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw new Error("passkey: malformed P-256 coordinates");
    }
    return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) } };
  }
  if (kty === 3) { // RSA
    if (alg !== -257) throw new Error(`passkey: unsupported RSA algorithm ${alg}`);
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error("passkey: malformed RSA key");
    return { alg: -257, jwk: { kty: "RSA", n: b64url(n), e: b64url(e) } };
  }
  throw new Error(`passkey: unsupported key type ${kty}`);
}

/* ------------------------------------------------------ authData parsing */
function parseAuthData(authData) {
  if (authData.length < 37) throw new Error("passkey: authData too short");
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const out = { rpIdHash, flags, signCount, userPresent: !!(flags & 0x01), userVerified: !!(flags & 0x04) };
  if (flags & 0x40) { // AT: attested credential data follows
    if (authData.length < 55) throw new Error("passkey: attested data truncated");
    const credIdLen = authData.readUInt16BE(53);
    const credId = authData.subarray(55, 55 + credIdLen);
    if (credId.length !== credIdLen) throw new Error("passkey: credId truncated");
    const { value: cose } = cborDecode(authData.subarray(55 + credIdLen));
    out.credentialId = credId;
    out.cose = cose;
  }
  return out;
}

/* ---------------------------------------------------- ceremonyassertions */
function checkClientData(clientDataJSON, { type, challenge, origin }) {
  let cd;
  try {
    cd = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    throw new Error("passkey: clientDataJSON is not JSON");
  }
  if (cd.type !== type) throw new Error(`passkey: ceremony type ${cd.type}, wanted ${type}`);
  // The browser echoes our challenge base64url-encoded.
  const want = Buffer.from(challenge).toString("base64url");
  if (cd.challenge !== want) throw new Error("passkey: challenge mismatch");
  if (cd.origin !== origin) throw new Error(`passkey: origin ${cd.origin}, wanted ${origin}`);
  return cd;
}

function rpIdHashOk(rpIdHash, rpId) {
  return crypto.timingSafeEqual(rpIdHash, crypto.createHash("sha256").update(rpId).digest());
}

/**
 * Verify a registration (navigator.credentials.create) response.
 * @returns {{ credentialId: Buffer, alg: number, jwk: object, signCount: number, userVerified: boolean }}
 */
function verifyRegistration({ attestationObject, clientDataJSON, challenge, origin, rpId }) {
  checkClientData(clientDataJSON, { type: "webauthn.create", challenge, origin });
  const { value: att } = cborDecode(attestationObject);
  if (!(att instanceof Map)) throw new Error("passkey: attestationObject is not a map");
  const authData = att.get("authData");
  if (!Buffer.isBuffer(authData)) throw new Error("passkey: missing authData");
  const parsed = parseAuthData(authData);
  if (!rpIdHashOk(parsed.rpIdHash, rpId)) throw new Error("passkey: rpIdHash mismatch");
  if (!parsed.userPresent) throw new Error("passkey: user-present flag missing");
  if (!parsed.credentialId || !parsed.cose) throw new Error("passkey: no attested credential data");
  const { alg, jwk } = coseToJwk(parsed.cose);
  // att.get("fmt") / attStmt intentionally unread — "none" trust model.
  return { credentialId: parsed.credentialId, alg, jwk, signCount: parsed.signCount, userVerified: parsed.userVerified };
}

/**
 * Verify an assertion (navigator.credentials.get) response against a stored
 * credential. Returns the authenticator's new signCount.
 */
function verifyAssertion({ authenticatorData, clientDataJSON, signature, challenge, origin, rpId, jwk, alg }) {
  checkClientData(clientDataJSON, { type: "webauthn.get", challenge, origin });
  const parsed = parseAuthData(authenticatorData);
  if (!rpIdHashOk(parsed.rpIdHash, rpId)) throw new Error("passkey: rpIdHash mismatch");
  if (!parsed.userPresent) throw new Error("passkey: user-present flag missing");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signed = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
  // ES256 assertions carry ASN.1/DER ECDSA signatures — node's default.
  const ok = crypto.verify("sha256", signed, key, signature);
  if (!ok) throw new Error("passkey: signature verification failed");
  return { signCount: parsed.signCount, userVerified: parsed.userVerified };
}

module.exports = { verifyRegistration, verifyAssertion, cborDecode, coseToJwk, parseAuthData };
