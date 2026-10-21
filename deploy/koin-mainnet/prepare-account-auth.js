#!/usr/bin/env node
"use strict";
// Local preparation only: read the existing website's effective environment,
// then optionally create one private input file. No service or database writes.
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { isUtf8 } = require("node:buffer");
const { accountEnvironmentValues, AUTH_KEYS, MAX_ACCOUNT_AUTH_BYTES } = require("./account-auth-input");
const SERVICE = "koinos.service", OUTPUT = "/root/kai-prepaid-inputs/account-auth.json", MAX_ENV = 262144;
const MESSAGES = Object.freeze({ ROOT: "Run account-auth preparation as root on the existing website host.",
  SERVICE: "The existing koinos.service must be active with an identifiable process.", SOURCE: "Could not safely read the existing service environment.",
  CHANGED: "The existing website process changed; no credentials were written. Run the check again.",
  AUTH: "No complete usable email or Google provider was found; inspect the check report's field names locally.",
  OUTPUT: "Use a new file in a private root-owned real directory; existing files and links are never overwritten.",
  WRITE: "Could not create the private account-auth input; no service configuration was changed.",
  ARGS: "Usage: node deploy/koin-mainnet/prepare-account-auth.js [--prepare] [--output /absolute/private/account-auth.json]" });
function failure(code) { return Object.assign(Error(MESSAGES[code]), { code }); }
function serviceSnapshot() {
  const result = spawnSync("systemctl", ["show", SERVICE, "--property=ActiveState", "--property=MainPID"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 });
  const fields = Object.fromEntries(String(result.stdout || "").trim().split("\n").map(line => line.split("=")));
  if (result.error || result.status !== 0 || fields.ActiveState !== "active" || !/^[1-9]\d{0,9}$/.test(fields.MainPID || "")) throw failure("SERVICE");
  return Number(fields.MainPID);
}
function readBounded(file, { max = MAX_ENV, secret = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (secret) {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > max) throw failure("OUTPUT");
    }
    const result = Buffer.alloc(max + 1); let length = 0, count;
    do { count = fs.readSync(fd, result, length, result.length - length, null); length += count; } while (count && length <= max);
    if (length > max) throw failure("SOURCE");
    const value = result.subarray(0, length);
    if (secret && !isUtf8(value)) throw failure("SOURCE");
    return value;
  } catch { throw failure("SOURCE"); } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readServiceEnvironment(pid) { return readBounded(`/proc/${pid}/environ`); }
function selectedEnvironment(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ENV || !isUtf8(buffer) || (buffer.length && buffer.at(-1) !== 0)) throw failure("SOURCE");
  const selected = Object.create(null);
  for (const entry of buffer.toString("utf8").split("\0")) {
    const at = entry.indexOf("="), name = entry.slice(0, at);
    if (at < 1 || !AUTH_KEYS.has(name)) continue;
    if (Object.hasOwn(selected, name)) throw failure("SOURCE");
    selected[name] = entry.slice(at + 1);
  }
  return selected;
}
function accountInput(source) {
  const auth = {}, providers = { email: { configured: Boolean(source.SMTP_HOST), ready: false, missing: [] },
    google: { configured: Boolean(source.GOOGLE_CLIENT_ID && source.GOOGLE_CLIENT_SECRET), ready: false, missing: [] } };
  if (!source.SMTP_HOST) providers.email.missing.push("SMTP_HOST");
  else {
    if (!(source.SMTP_FROM || source.SMTP_USER)) providers.email.missing.push("SMTP_FROM");
    if (source.SMTP_USER && !source.SMTP_PASS) providers.email.missing.push("SMTP_PASS");
    const port = Number(source.SMTP_PORT || 587), email = { SMTP_HOST: source.SMTP_HOST, SMTP_PORT: String(port),
      // Preserve server.js semantics, including implicit TLS on port 465 and
      // the existing true/yes/1 spelling. The prepaid server uses true/false.
      SMTP_SECURE: String(source.SMTP_SECURE ? /^(1|true|yes)$/i.test(source.SMTP_SECURE) : port === 465),
      ...(source.SMTP_FROM ? { SMTP_FROM: source.SMTP_FROM } : {}),
      ...(source.SMTP_USER ? { SMTP_USER: source.SMTP_USER, SMTP_PASS: source.SMTP_PASS } : {}) };
    try { accountEnvironmentValues(email); Object.assign(auth, email); providers.email.ready = true; }
    catch { providers.email.invalid = true; }
  }
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) if (!source[name]) providers.google.missing.push(name);
  if (providers.google.configured) {
    const google = { GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET };
    try { accountEnvironmentValues(google); Object.assign(auth, google); providers.google.ready = true; }
    catch { providers.google.invalid = true; }
  }
  let ready = providers.email.ready || providers.google.ready, problem;
  if (ready) {
    try { accountEnvironmentValues(auth); }
    catch { ready = false; problem = "Combined credential input exceeds the supported limit"; }
  }
  return { auth, providers, ready, ...(problem ? { problem } : {}) };
}
function destination(output, create = false) {
  if (typeof output !== "string" || !path.isAbsolute(output) || path.resolve(output) !== output) throw failure("OUTPUT");
  const directory = path.dirname(output); let current = path.parse(directory).root;
  if (directory === current) throw failure("OUTPUT");
  try {
    for (const piece of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, piece);
      if (!fs.existsSync(current) && create && current === directory) fs.mkdirSync(current, { mode: 0o700 });
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === "ENOENT" && current === directory && !create) continue; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || (current === directory && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw failure("OUTPUT");
      // Root-owned sticky ancestors such as /tmp protect an existing private
      // root-owned child. Other writable/untrusted ancestors permit swaps.
      if (![0, process.getuid()].includes(stat.uid) || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))) throw failure("OUTPUT");
    }
    try { fs.lstatSync(output); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  } catch { throw failure("OUTPUT"); }
}
function createPrivate(output, value) {
  let fd, created = false;
  try {
    fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); created = true;
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd);
  } catch { if (created) { try { fs.unlinkSync(output); } catch {} } throw failure("WRITE"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function prepareAccountAuth({ prepare = false, output = OUTPUT, snapshot = serviceSnapshot, environment = readServiceEnvironment } = {}) {
  const pid = snapshot(), input = accountInput(selectedEnvironment(environment(pid))), exists = destination(output);
  const report = { schema: 1, service: SERVICE, configurationOnly: true, signInVerified: false, serviceChanged: false,
    ready: input.ready, providers: input.providers, ...(input.problem ? { problem: input.problem } : {}),
    output, outputExists: exists, prepared: false, alreadyPrepared: false };
  if (snapshot() !== pid) throw failure("CHANGED");
  if (!prepare) return report;
  if (!input.ready) throw failure("AUTH");
  accountEnvironmentValues(input.auth);
  if (exists) {
    try {
      const saved = JSON.parse(readBounded(output, { max: MAX_ACCOUNT_AUTH_BYTES, secret: true }).toString("utf8"));
      accountEnvironmentValues(saved);
      const canonical = value => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
      if (canonical(saved) !== canonical(input.auth)) throw failure("OUTPUT");
    } catch { throw failure("OUTPUT"); }
    if (snapshot() !== pid) throw failure("CHANGED");
    return { ...report, prepared: true, alreadyPrepared: true };
  }
  destination(output, true);
  if (snapshot() !== pid) throw failure("CHANGED");
  createPrivate(output, input.auth);
  return { ...report, outputExists: true, prepared: true };
}
function argumentsFor(args) {
  const options = {}; for (let index = 0; index < args.length; index++) {
    if (args[index] === "--prepare" && options.prepare === undefined) options.prepare = true;
    else if (args[index] === "--output" && options.output === undefined && args[index + 1]) options.output = args[++index];
    else throw failure("ARGS");
  } return options;
}
if (require.main === module) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    if (process.platform !== "linux" || process.getuid() !== 0) throw failure("ROOT");
    console.log(JSON.stringify(prepareAccountAuth(options), null, 2));
  }
  catch (error) { console.error(MESSAGES[error.code] || "Account-auth preparation failed; no service configuration was changed."); process.exitCode = 1; }
}
module.exports = { prepareAccountAuth, selectedEnvironment, accountInput, readBounded, argumentsFor, MAX_ENV, SERVICE, OUTPUT };
