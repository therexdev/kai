"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), cp = require("node:child_process"), crypto = require("node:crypto");
const { verifySource } = require("./verify-source");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-source-pin-")), desktop = path.join(root, "desktop"), backend = path.join(root, "backend");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(desktop, "core/lib/koin-network"), copied = path.join(backend, "lib/koin-network"), abis = path.join(desktop, "contracts/koin-network/abi");
  for (const dir of [shared, copied, abis]) fs.mkdirSync(dir, { recursive: true });
  const sha256 = {};
  for (const name of ["policy.js", "credits-abi.json", "rewards-abi.json", "prepaid-abi.json", "prepaid-usd-abi.json"]) {
    const bytes = name.endsWith(".js") ? '"use strict";\n' : JSON.stringify({ fixture: name }) + "\n";
    for (const dir of [shared, copied]) fs.writeFileSync(path.join(dir, name), bytes);
    sha256[name] = hash(bytes);
    if (name.endsWith("-abi.json")) fs.writeFileSync(path.join(abis, name.replace("-abi", "")), bytes);
  }
  const git = args => cp.execFileSync("git", args, { cwd: desktop, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]); git(["add", "."]); git(["-c", "user.name=Source fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "source fixture"]);
  const pin = { source: "therexdev/kaiapp/core/lib/koin-network", sourceCommit: git(["rev-parse", "HEAD"]), sha256 };
  const save = () => fs.writeFileSync(path.join(copied, "SOURCE.json"), JSON.stringify(pin)); save();
  return { desktop, backend, copied, abis, pin, save, git };
}
test("source provenance accepts exact clean commit, shared hashes and all contract ABIs", t => {
  const f = fixture(t);
  assert.deepEqual(verifySource(f.desktop, f.backend), { desktopCommit: f.pin.sourceCommit, sharedFiles: 5, contractAbis: 4 });
});
test("source provenance rejects an older pin, backend drift and stale hash metadata", t => {
  const f = fixture(t), original = f.pin.sourceCommit;
  f.pin.sourceCommit = "0".repeat(40); f.save();
  assert.throws(() => verifySource(f.desktop, f.backend), /source commit mismatch/);
  f.pin.sourceCommit = original; f.save();
  const policy = path.join(f.copied, "policy.js"), bytes = fs.readFileSync(policy);
  fs.appendFileSync(policy, "// changed backend\n");
  assert.throws(() => verifySource(f.desktop, f.backend), /shared source mismatch: policy.js/);
  fs.writeFileSync(policy, bytes); f.pin.sha256["policy.js"] = "0".repeat(64); f.save();
  assert.throws(() => verifySource(f.desktop, f.backend), /shared source mismatch: policy.js/);
});
test("source provenance rejects a changed desktop checkout and a committed contract ABI mismatch", t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.abis, "prepaid-usd.json"), " ");
  assert.throws(() => verifySource(f.desktop, f.backend));
  f.git(["add", "."]); f.git(["-c", "user.name=Source fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "different ABI"]);
  f.pin.sourceCommit = f.git(["rev-parse", "HEAD"]); f.save();
  assert.throws(() => verifySource(f.desktop, f.backend), /Desktop\/master ABI mismatch: prepaid-usd/);
});
