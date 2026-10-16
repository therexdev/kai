"use strict";
// One reviewed owner-pilot renewal, not an automatic qualification policy.
// Test 177, native llama.cpp, Local-Only: 8/10 in 4382 ms, 13 calls.
// Letter-count and parity failed. The pilot records those quality limitations.
// Requires live desktop identity/runtime metadata and hashes computed from its
// current benchmark/model files. Only the benchmark pin and expiry may change.
const fs = require("node:fs"), crypto = require("node:crypto");
process.umask(0o077);
const owner = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
const modelHash = "1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370";
const benchmarkHash = "b57a896e1bf4d0cfdf7154ddaca6a89ac17687bdf4a379d6eb2a29fbd8650609";
const priorHash = "730b29967b4397a0251e0a85d50bc5da227941ae5abae7ebbd29f4d87f173b39";
const at = 1791929965183, expires = at + 86400000;
const proof = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
const hw = proof.hardware;
const parts = [hw?.platform ?? "", hw?.arch ?? "", hw?.cpu?.model ?? "", String(hw?.cpu?.cores ?? ""),
  String(hw?.ramBytes ? Math.round(hw.ramBytes / 1e9) : ""),
  ...(Array.isArray(hw?.gpus) ? hw.gpus.map(g => g?.name ?? g?.model ?? "").sort() : [])];
const fingerprint = crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
if (process.getuid() !== 0 || Date.now() < at || Date.now() >= expires) throw Error("Root and an unexpired reviewed benchmark are required");
if (proof.wallet !== owner || proof.configuredOwner !== owner || fingerprint !== "2592ee13a89f212f" ||
    proof.privacy !== "local-only" || proof.version !== "0.54.12-test.177.1" ||
    proof.runtime?.activeAlias !== "koinos-fast" || proof.runtime.loading !== false || proof.runtime.lastLoadError ||
    proof.runtime.runtime?.kind !== "llamacpp" || proof.runtime.runtime.running !== true ||
    proof.modelHash !== modelHash || proof.benchmarkHash !== benchmarkHash || proof.benchmarkAt !== at)
  throw Error("Provider, hardware or reviewed benchmark differs. No qualification was changed.");
const config = JSON.parse(fs.readFileSync("/etc/kai-koin-mainnet-pilot/runtime.json", "utf8"));
if (config.mode !== "mainnet-pilot" || config.schedulerUrl !== "https://payments.koinosai.com/scheduler" ||
    config.deployment.chainId !== "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==" ||
    config.deployment.credits !== "13xiS64Z7mQXBNXniKPYRbFDCaNfvKbrPT" ||
    config.deployment.rewards !== "1E1Stp1xMGt5ZmSTzEknLVyi79j9hDK9iT" || config.tokenizer.modelHash !== modelHash)
  throw Error("Unexpected pilot deployment. No qualification was changed.");
const files = ["/root/kai-mainnet-bootstrap/qualifications.json", "/etc/kai-koin-mainnet-pilot/qualifications.json"];
const edits = files.map(file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o777) !== 0o600)
    throw Error("Expected a protected qualification file: " + file);
  const before = fs.readFileSync(file, "utf8"), list = JSON.parse(before);
  if (!Array.isArray(list) || list.length > 64) throw Error("Unexpected qualification list");
  const rows = list.filter(q => q?.address === owner || q?.capacityId === "pilot-2592ee13a89f212f");
  const q = rows[0];
  if (rows.length !== 1 || q.address !== owner || q.capacityId !== "pilot-2592ee13a89f212f" ||
      q.model !== "koinos-fast" || q.modelHash !== modelHash || String(q.modelWeight) !== "6124" || q.coverageBps !== 10000)
    throw Error("Existing provider identity or reward weight differs: " + file);
  if (q.benchmarkHash === benchmarkHash && q.expires === expires) return { file, before, after: before, stat };
  if (q.benchmarkHash !== priorHash || q.expires !== 1791743121324)
    throw Error("Existing qualification differs from the reviewed record: " + file);
  q.benchmarkHash = benchmarkHash; q.expires = expires;
  return { file, before, after: JSON.stringify(list, null, 2) + "\n", stat };
});
for (const e of edits) {
  if (e.before === e.after) continue;
  if (fs.readFileSync(e.file, "utf8") !== e.before) throw Error("Qualification changed during review; stop and share this message");
  const suffix = crypto.randomBytes(8).toString("hex"), backup = e.file + ".before-renewal-" + suffix, temp = e.file + ".new-" + suffix;
  fs.writeFileSync(backup, e.before, { flag: "wx", mode: 0o600, flush: true });
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600); fs.fchownSync(fd, e.stat.uid, e.stat.gid);
    fs.writeFileSync(fd, e.after); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, e.file);
    const dir = fs.openSync(require("node:path").dirname(e.file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  console.log("Updated " + e.file + "; backup: " + backup);
}
console.log(JSON.stringify({ provider: owner, qualificationUpdated: true, benchmarkHash, expiresAt: new Date(expires).toISOString(),
  next: "Set the provider to Local-First, then use KOIN payments > Earn KOIN > Start providing." }, null, 2));
