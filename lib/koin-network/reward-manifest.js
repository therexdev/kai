"use strict";
// Rehearsal certificates are deliberately separate from live root authority.
// They authenticate a bounded allocation list, not the truth of its telemetry.
const { utils } = require("koilib");
const P = require("./job-protocol"), M = require("./merkle");
const { uint, add } = require("./policy"), { address } = require("./metering");
function exact(v, keys) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== keys) throw Error("Exact reward schema required");
}
function target(v) {
  exact(v, "chainId,credits,creditsHash,rewards,rewardsHash,token,tokenHash,verifier,version,workCapBps");
  const chain = typeof v.chainId === "string" && Buffer.from(v.chainId, "base64url");
  if (!chain || chain.length !== 34 || chain[0] !== 0x12 || chain[1] !== 0x20 || utils.encodeBase64url(chain) !== v.chainId) throw Error("Canonical reward chain pin required");
  for (const k of ["creditsHash", "rewardsHash", "tokenHash"]) if (!/^0x1220[a-f0-9]{64}$/.test(v[k])) throw Error("Reward bytecode pins required");
  if (typeof v.version !== "string" || !uint(v.version)) throw Error("Reward policy version required");
  P.integer(v.workCapBps, 0, 9000);
  const out = { chainId: v.chainId, rewards: address(v.rewards), rewardsHash: v.rewardsHash,
    credits: address(v.credits), creditsHash: v.creditsHash, token: address(v.token), tokenHash: v.tokenHash,
    verifier: address(v.verifier), version: v.version, workCapBps: v.workCapBps };
  if (new Set([out.rewards, out.credits, out.token]).size !== 3) throw Error("Separate reward custody required");
  return out;
}
function canonical(v) {
  exact(v, "allocations,epoch,evidenceHash,mode,root,schema,target");
  if (v.schema !== 1 || v.mode !== "reward-rehearsal" || typeof v.epoch !== "string") throw Error("Rehearsal reward manifest required");
  uint(v.epoch); P.digest(v.evidenceHash);
  const pins = target(v.target);
  if (!Array.isArray(v.allocations) || !v.allocations.length || v.allocations.length > 1024) throw Error("Reward manifest size limit");
  const allocations = v.allocations.map(row => {
    exact(row, "address,availability,work"); address(row.address);
    if (typeof row.availability !== "string" || typeof row.work !== "string" || !add(row.availability, row.work)) throw Error("Positive reward allocation required");
    return { address: row.address, availability: row.availability, work: row.work };
  });
  const tree = M.build({ chainId: pins.chainId, contract: pins.rewards, epoch: v.epoch, version: pins.version }, allocations);
  if (tree.claims.some((c, i) => c.address !== allocations[i].address)) throw Error("Canonical address ordering required");
  exact(v.root, "availability,hash,work");
  if (["hash", "availability", "work"].some(k => v.root[k] !== tree.root[k])) throw Error("Reward root or sums mismatch");
  return { schema: 1, mode: "reward-rehearsal", target: pins, epoch: v.epoch,
    evidenceHash: v.evidenceHash, root: tree.root, allocations };
}
function signingHash(manifest) {
  return Buffer.from(P.hash(JSON.stringify(["KAI-KOIN-REWARD-MANIFEST-REHEARSAL-V1", canonical(manifest)])), "hex");
}
function verify(envelope, pins) {
  exact(envelope, "manifest,signature");
  const manifest = canonical(envelope.manifest);
  if (JSON.stringify(manifest.target) !== JSON.stringify(target(pins))) throw Error("Reward deployment mismatch");
  const digest = signingHash(manifest);
  P.signatureMatches(digest, envelope.signature, manifest.target.verifier);
  const tree = M.build({ chainId: pins.chainId, contract: pins.rewards, epoch: manifest.epoch, version: pins.version }, manifest.allocations);
  return { envelope: { manifest, signature: envelope.signature }, hash: digest.toString("hex"), claims: tree.claims };
}
module.exports = { target, canonical, signingHash, verify };
