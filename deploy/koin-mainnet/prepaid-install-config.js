"use strict";
// Prepare service-owned copies only. No RPC, signatures, database access or
// systemd changes; the installer validates deployment/keys/tokenizer first.
const fs = require("node:fs"), path = require("node:path");
const { configuration: pricing, verifyParity } = require("../../lib/koin-network/v4-purchase-oracle");
const { TestAccounts } = require("../../lib/koin-network/test-accounts");
const { LIMITS } = require("../../lib/koin-network/tokenizer");
const CONFIG_DIR = "/etc/kai-koin-prepaid";
const { accountEnvironmentValues, MAX_ACCOUNT_AUTH_BYTES } = require("./account-auth-input");

function bytes(file, label, maximum, secret = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maximum || (secret && process.platform !== "win32" &&
        ((st.mode & 0o077) || st.uid !== process.getuid()))) throw Error();
    const data = fs.readFileSync(fd);
    if (data.length > maximum) throw Error();
    return data;
  } catch { throw Error(`Expected protected regular ${label} file`); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function json(data, label) {
  try { return JSON.parse(data.toString("utf8")); }
  catch { throw Error(`Invalid ${label} JSON`); }
}
function accountEnvironment(file, required) {
  if (!file) {
    if (required) throw Error("Public accounts require an explicit protected account-auth JSON file");
    return "# Invitation mode: public account sign-in is disabled.\n";
  }
  if (!path.isAbsolute(file)) throw Error("Use an absolute account-auth JSON path");
  const auth = json(bytes(file, "account-auth", MAX_ACCOUNT_AUTH_BYTES, true), "account-auth");
  return accountEnvironmentValues(auth, required);
}

function installationFiles(bootstrap, authFile, { now = Date.now() } = {}) {
  if (!path.isAbsolute(bootstrap)) throw Error("Absolute private bootstrap directory required");
  const original = bytes(path.join(bootstrap, "runtime.json"), "runtime", 1048576, true);
  const runtime = json(original, "runtime");
  if (![undefined, "invitations", "public"].includes(runtime.accountMode)) throw Error("Invalid account mode");
  const publicAccounts = runtime.accountMode === "public";
  if (publicAccounts && runtime.deployment?.product !== "prepaid-usd-v1") throw Error("Public accounts require the USD credit product");
  const files = new Map();
  files.set("account.env", Buffer.from(accountEnvironment(authFile, publicAccounts)));
  for (const name of ["runtime-keys.json", "qualifications.json"]) {
    files.set(name, bytes(path.join(bootstrap, name), name, 65536, true));
  }
  const operator = bytes(path.join(bootstrap, "operator-secret"), "operator-secret", 256, true);
  if (!/^[a-f0-9]{64}$/.test(operator.toString("utf8").trim())) throw Error("Independent Test operator secret required");
  files.set("operator-secret", operator);
  if (!publicAccounts) {
    const invitationFile = path.join(bootstrap, "invitations.json");
    const invitations = bytes(invitationFile, "invitations", 65536, true);
    const rows = json(invitations, "invitations");
    if (!Array.isArray(rows) || !rows.length || rows.length > 64) throw Error("Invitation mode requires its explicit invitation list");
    // Reuse the runtime's complete schema and duplicate checks on this private
    // source. Keep the validated bytes fixed for the later copy.
    new TestAccounts(invitationFile);
    if (!bytes(invitationFile, "invitations", 65536, true).equals(invitations)) throw Error("Invitation file changed during validation");
    files.set("invitations.json", invitations);
  }
  if (runtime.purchasePricing) {
    const c = pricing(runtime.purchasePricing, runtime.deployment);
    if (c.schema === 1) {
      const envelope = bytes(c.parityFile, "parity attestation", 8192);
      verifyParity(json(envelope, "parity attestation"), { signer: c.paritySigner, source: c.policy.paritySource,
        nativeChainId: runtime.deployment.chainId, nativeToken: runtime.deployment.token, now, maxAgeMs: c.policy.maxParityAgeMs });
      files.set("parity.json", envelope);
      // Only the local file location changes. Its signed bytes and all market,
      // contract, signer and policy pins stay exactly as reviewed.
      runtime.purchasePricing.parityFile = path.join(CONFIG_DIR, "parity.json");
      pricing(runtime.purchasePricing, runtime.deployment);
      files.set("runtime.json", Buffer.from(JSON.stringify(runtime, null, 2) + "\n"));
    } else {
      // Explicit merchant reference mode makes no bridge-redemption assertion.
      // Preserve the reviewed native identity, reference and policy byte-for-byte.
      files.set("runtime.json", original);
    }
  } else files.set("runtime.json", original);
  const packs = runtime.schema === 2
    ? require("../../lib/koin-network/model-configuration").entries(runtime).map(e => ({ directory: "tokenizer/" + e.tariff.model, manifest: e.tokenizer }))
    : [{ directory: "tokenizer", manifest: null }];
  for (const { directory, manifest } of packs) {
    // O_NOFOLLOW on files does not protect parent directories. Reject linked
    // pack directories before collecting their immutable bytes for staging.
    for (const relative of ["tokenizer", directory]) {
      const st = fs.lstatSync(path.join(bootstrap, relative));
      if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Expected real tokenizer pack directory");
    }
    for (const [name, limit, pin] of [["tokenizer.json", LIMITS.tokenizer, "tokenizerHash"], ["tokenizer_config.json", LIMITS.config, "configHash"]]) {
      const data = bytes(path.join(bootstrap, directory, name), name, limit);
      if (manifest && require("../../lib/koin-network/job-protocol").hash(data) !== manifest[pin]) throw Error("Tokenizer pack checksum changed before installation");
      files.set(directory + "/" + name, data);
    }
  }
  return files;
}
function stageConfiguration(bootstrap, directory, authFile) {
  const files = installationFiles(bootstrap, authFile);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(directory).length ||
      (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw Error("Use an empty private staging directory");
  for (const [name, data] of files) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, name), data, { mode: 0o600, flag: "wx" });
  }
  return { accountMode: files.has("invitations.json") ? "invitations" : "public", parityInstalled: files.has("parity.json") };
}
if (require.main === module) {
  const [bootstrap, directory, authFile, ...extra] = process.argv.slice(2);
  try {
    if (!bootstrap || !directory || extra.length) throw Error("Usage: node deploy/koin-mainnet/prepaid-install-config.js BOOTSTRAP PRIVATE_STAGE [ACCOUNT_AUTH_JSON]");
    const result = stageConfiguration(bootstrap, directory, authFile);
    console.log(`Prepared ${result.accountMode} account configuration; parity file ${result.parityInstalled ? "included" : "not configured"}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { accountEnvironment, accountEnvironmentValues, installationFiles, stageConfiguration, CONFIG_DIR };
