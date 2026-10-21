"use strict";
// Read-only provenance check before building or creating isolated chain state.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function verifyCheckout(directory, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit) || cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() !== commit) throw Error("Isolated source commit mismatch");
  cp.execFileSync("git", ["diff", "--exit-code", "HEAD"], { cwd: directory, stdio: "pipe" });
}
function verifySource(desktopDir, backendDir = path.resolve(__dirname, "../..")) {
  const base = path.join(backendDir, "lib/koin-network"), pin = JSON.parse(fs.readFileSync(path.join(base, "SOURCE.json"), "utf8"));
  if (pin.source !== "therexdev/kaiapp/core/lib/koin-network" || !pin.sha256 || !Object.keys(pin.sha256).length) throw Error("Pinned shared source metadata required");
  verifyCheckout(desktopDir, pin.sourceCommit);
  let checked = 0;
  for (const [name, expected] of Object.entries(pin.sha256)) {
    if (!/^[a-z0-9-]+\.(js|json)$/.test(name) || !/^[a-f0-9]{64}$/.test(expected)) throw Error("Invalid shared source hash metadata");
    for (const directory of [base, path.join(desktopDir, "core/lib/koin-network")]) {
      if (hash(fs.readFileSync(path.join(directory, name))) !== expected) throw Error("Pinned shared source mismatch: " + name);
    }
    checked++;
  }
  for (const kind of ["credits", "rewards", "prepaid", "prepaid-usd"]) {
    const abi = fs.readFileSync(path.join(desktopDir, "contracts/koin-network/abi", kind + ".json"));
    if (hash(abi) !== hash(fs.readFileSync(path.join(base, kind + "-abi.json")))) throw Error("Desktop/master ABI mismatch: " + kind);
  }
  return { desktopCommit: pin.sourceCommit, sharedFiles: checked, contractAbis: 4 };
}
if (require.main === module) {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) { console.error("Usage: node scripts/koin-isolated/verify-source.js DESKTOP_CHECKOUT"); process.exitCode = 1; }
  else {
    try { console.log(JSON.stringify(verifySource(path.resolve(directory)))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { verifySource, verifyCheckout };
