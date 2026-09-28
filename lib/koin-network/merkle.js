"use strict";
const crypto = require("crypto"),
  { utils } = require("koilib"),
  P = require("./policy");
const hash = (b) => crypto.createHash("sha256").update(b).digest();
function atomBytes(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(P.uint(v));
  return b;
}
function bytesAddress(address) {
  const b = Buffer.from(utils.decodeBase58(address));
  if (b.length !== 25) throw Error("Invalid address");
  return b;
}
function domain(d) {
  const chain = Buffer.from(d.chainId, "base64");
  if (chain.length !== 34) throw Error("Invalid chain domain");
  return Buffer.concat([
    Buffer.from("KAI-KOIN-REWARDS-V1\0"),
    chain,
    bytesAddress(d.contract),
    atomBytes(String(d.epoch)),
    atomBytes(String(d.version)),
  ]);
}
function leaf(d, row) {
  const a = P.uint(row.availability),
    w = P.uint(row.work);
  return {
    hash: hash(
      Buffer.concat([
        Buffer.from([0]),
        domain(d),
        bytesAddress(row.address),
        atomBytes(a),
        atomBytes(w),
      ]),
    ),
    availability: a,
    work: w,
  };
}
function parent(a, b) {
  const availability = P.add(a.availability, b.availability),
    work = P.add(a.work, b.work);
  return {
    hash: hash(
      Buffer.concat([
        Buffer.from([1]),
        a.hash,
        atomBytes(a.availability),
        atomBytes(a.work),
        b.hash,
        atomBytes(b.availability),
        atomBytes(b.work),
      ]),
    ),
    availability,
    work,
  };
}
function wire(n) {
  return {
    hash: n.hash.toString("hex"),
    availability: n.availability.toString(),
    work: n.work.toString(),
  };
}
function unwire(n) {
  if (!n || !/^[a-f0-9]{64}$/.test(n.hash)) throw Error("Invalid Merkle node");
  return {
    hash: Buffer.from(n.hash, "hex"),
    availability: P.uint(n.availability),
    work: P.uint(n.work),
  };
}
function build(d, allocations) {
  const rows = allocations
    .filter((r) => P.add(r.availability, r.work) > 0n)
    .sort((a, b) =>
      Buffer.compare(bytesAddress(a.address), bytesAddress(b.address)),
    );
  if (
    !rows.length ||
    rows.length > 65536 ||
    new Set(rows.map((x) => x.address)).size !== rows.length
  )
    throw Error("Empty, duplicate or oversized allocation list");
  const levels = [rows.map((r) => leaf(d, r))];
  // Promote odd nodes instead of duplicating their monetary sums.
  while (levels.at(-1).length > 1) {
    const v = levels.at(-1),
      next = [];
    for (let i = 0; i < v.length; i += 2)
      next.push(i + 1 < v.length ? parent(v[i], v[i + 1]) : v[i]);
    levels.push(next);
  }
  const claims = rows.map((row, i) => {
    let index = i;
    const proof = [];
    for (const level of levels.slice(0, -1)) {
      const sibling = index ^ 1;
      if (sibling < level.length)
        proof.push({ ...wire(level[sibling]), left: sibling < index });
      index = Math.floor(index / 2);
    }
    return { ...row, proof };
  });
  return { domain: d, root: wire(levels.at(-1)[0]), claims };
}
function verify(d, claim, root) {
  try {
    if (!Array.isArray(claim.proof) || claim.proof.length > 16) return false;
    let node = leaf(d, claim);
    for (const sibling of claim.proof) {
      if (typeof sibling.left !== "boolean") return false;
      const n = unwire(sibling);
      node = sibling.left ? parent(n, node) : parent(node, n);
    }
    const expected = unwire(root);
    return (
      node.hash.equals(expected.hash) &&
      node.availability === expected.availability &&
      node.work === expected.work
    );
  } catch {
    return false;
  }
}
module.exports = { build, verify, domain, leaf, parent };
