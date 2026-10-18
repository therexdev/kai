"use strict";
const crypto = require("crypto"), { Serializer, utils } = require("koilib");
const { uint } = require("./policy"), P = require("./job-protocol"), { isUsd } = require("./product");
const serializer = () => new Serializer(require("./prepaid-usd-abi.json").types);
const enc = b => utils.encodeBase64url(b);
const fields = "account,amount,credits,expires_at,id,issued_at,policy_version,usd_per_koin";
const USD_ATOMS = 100000000n, CREDIT_ATOMS = 100000n, MAX_QUOTE_MS = 300000;
// USD packs are selected in cents. Round the native payment upward by less
// than one native atom; the signed quote discloses the actual credited value.
function nativeForDollars(dollars, usdPerKoin) {
  if (typeof dollars !== "string" || dollars.length > 12 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(dollars)) throw Error("Enter a positive USD amount with at most two decimal places");
  const [whole, fraction = ""] = dollars.split(".");
  const requested = uint(BigInt(whole) * USD_ATOMS + BigInt(fraction.padEnd(2, "0")) * 1000000n), price = uint(usdPerKoin);
  if (!requested || !price) throw Error("Positive USD amount and verified price required");
  const amount = uint((requested * USD_ATOMS + price - 1n) / price);
  // Validate the resulting contract amount as well as its credited USD value.
  if (!amount || uint(amount * price / USD_ATOMS) < requested) throw Error("USD amount cannot be represented safely");
  return String(amount);
}
function quote(value) {
  if (!value || Object.keys(value).sort().join() !== fields) throw Error("Exact USD purchase quote required");
  const q = structuredClone(value);
  for (const k of ["amount", "credits", "usd_per_koin", "issued_at", "expires_at", "policy_version"])
    if (typeof q[k] !== "string" || !uint(q[k])) throw Error("Positive purchase quote values required");
  for (const [k, size] of [["id",32],["account",25]]) {
    if (typeof q[k] !== "string") throw Error("Canonical purchase quote bytes required");
    const b = Buffer.from(q[k], "base64url");
    if (b.length !== size || enc(b) !== q[k]) throw Error("Canonical purchase quote bytes required");
  }
  if (!utils.isChecksumAddress(utils.encodeBase58(Buffer.from(q.account,"base64url"))) ||
      uint(q.credits) !== uint(uint(q.amount) * uint(q.usd_per_koin) / USD_ATOMS) ||
      uint(q.expires_at) <= uint(q.issued_at) || uint(q.expires_at) > uint(q.issued_at) + BigInt(MAX_QUOTE_MS))
    throw Error("Invalid USD purchase conversion or expiry");
  return q;
}
async function signingHash(deployment, value) {
  const q = quote(value);
  if (!isUsd(deployment) || !utils.isChecksumAddress(deployment.masterNode)) throw Error("USD purchase deployment required");
  const body = Buffer.concat([Buffer.from("KAI-USD-PURCHASE-V1\0"), Buffer.from(deployment.chainId,"base64url"),
    Buffer.from(utils.decodeBase58(deployment.credits)), Buffer.from(utils.decodeBase58(deployment.masterNode)),
    Buffer.from(await serializer().serialize(q,"koin.PurchaseQuote"))]);
  return crypto.createHash("sha256").update(body).digest();
}
async function verify(deployment, args, { now, version } = {}) {
  const q = quote(args.purchase_quote);
  if (args.account !== q.account || args.amount !== q.amount) throw Error("Purchase quote does not match payment");
  if (typeof args.price_signature !== "string" || Buffer.from(args.price_signature,"base64url").length !== 65 ||
      enc(Buffer.from(args.price_signature,"base64url")) !== args.price_signature) throw Error("Canonical price signature required");
  P.signatureMatches(await signingHash(deployment,q), Buffer.from(args.price_signature,"base64url").toString("base64"), deployment.verifier);
  if (version !== undefined && q.policy_version !== String(version)) throw Error("Purchase policy changed");
  if (now !== undefined) {
    const time = BigInt(P.integer(now));
    if (uint(q.issued_at) > time + 30000n || time > uint(q.expires_at)) throw Error("Purchase price expired. Please buy again for a fresh price.");
  }
  return q;
}
async function issue({ deployment, signer, account, amount, usdPerKoin, version, now, ttlMs = MAX_QUOTE_MS }) {
  if (signer.getAddress() !== deployment.verifier) throw Error("Pinned price signer required");
  P.integer(ttlMs,1000,MAX_QUOTE_MS); P.integer(now);
  const q = quote({ id: enc(crypto.randomBytes(32)), account: enc(utils.decodeBase58(account)), amount,
    credits: String(uint(uint(amount) * uint(usdPerKoin) / USD_ATOMS)), usd_per_koin: usdPerKoin,
    issued_at: String(now), expires_at: String(now + ttlMs), policy_version: String(version) });
  return { account: q.account, amount, purchase_quote: q, price_signature: enc(await signer.signHash(await signingHash(deployment,q))) };
}
function decimal(value, scale) {
  const n=uint(value),s=BigInt(scale), digits=String(s).length-1;
  return `${n/s}.${String(n%s).padStart(digits,"0")}`.replace(/\.?0+$/,"");
}
module.exports = { quote, verify, issue, signingHash, nativeForDollars, USD_ATOMS, CREDIT_ATOMS, MAX_QUOTE_MS,
  credits: value => decimal(value,CREDIT_ATOMS), dollars: value => decimal(value,USD_ATOMS) };
