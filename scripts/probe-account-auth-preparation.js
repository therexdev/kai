"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { prepareAccountAuth, selectedEnvironment, accountInput, readBounded, argumentsFor, MAX_ENV, OUTPUT } = require("../deploy/koin-mainnet/prepare-account-auth");
const { accountEnvironment } = require("../deploy/koin-mainnet/prepaid-install-config");
const env = values => Buffer.from(Object.entries(values).map(([key, value]) => `${key}=${value}\0`).join(""));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-account-prep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, "private-inputs", "account-auth.json"), source = path.join(dir, "source-environ");
  const values = { SMTP_HOST: "smtp.example.invalid", SMTP_USER: "signin@example.invalid", SMTP_PASS: 'fixture-only $dollar `tick` "quote" \\backslash',
    SMTP_PORT: "465", GOOGLE_CLIENT_ID: "isolated-client", GOOGLE_CLIENT_SECRET: "isolated-google-secret",
    SESSION_SECRET: "never-copy-session-secret", KAI_STATE_DIR: "/existing/live/state", WALLET_WIF: "never-copy-signing-key", SMTP_TO: "private-notification-recipient" };
  fs.writeFileSync(source, env(values), { mode: 0o600 });
  return { dir, output, source, values, options: { output, snapshot: () => 321, environment: () => readBounded(source) } };
}
test("default check is read-only and reports capabilities without credential values", t => {
  const f = fixture(t), before = fs.readFileSync(f.source), report = prepareAccountAuth(f.options), serialized = JSON.stringify(report);
  assert.equal(report.prepared, false); assert.equal(report.ready, true); assert.equal(report.outputExists, false);
  assert.equal(report.providers.email.ready, true); assert.equal(report.providers.google.ready, true);
  assert.equal(fs.existsSync(path.dirname(f.output)), false);
  assert.deepEqual(fs.readFileSync(f.source), before);
  for (const value of Object.values(f.values)) assert.equal(serialized.includes(value), false);
  assert.equal(OUTPUT, "/root/kai-prepaid-inputs/account-auth.json");
});
test("explicit preparation writes only allowlisted credentials in a new private file", t => {
  const f = fixture(t), before = fs.readFileSync(f.source);
  const report = prepareAccountAuth({ ...f.options, prepare: true }); assert.equal(report.prepared, true);
  const saved = JSON.parse(fs.readFileSync(f.output, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SMTP_HOST", "SMTP_PASS", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER"]);
  assert.equal(saved.SMTP_PASS, f.values.SMTP_PASS); assert.equal(saved.SMTP_SECURE, "true");
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(f.output)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.output).uid, process.getuid()); assert.doesNotThrow(() => accountEnvironment(f.output, true));
  assert.deepEqual(fs.readFileSync(f.source), before);
  const first = fs.readFileSync(f.output), initialStat = fs.statSync(f.output);
  const repeated = prepareAccountAuth({ ...f.options, prepare: true });
  assert.equal(repeated.prepared, true); assert.equal(repeated.alreadyPrepared, true);
  assert.deepEqual(fs.readFileSync(f.output), first);
  assert.equal(fs.statSync(f.output).mtimeMs, initialStat.mtimeMs); assert.equal(fs.statSync(f.output).ctimeMs, initialStat.ctimeMs);
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, environment: () => env({ ...f.values, SMTP_PASS: "changed-fixture" }) }), error => error.code === "OUTPUT");
  assert.deepEqual(fs.readFileSync(f.output), first);
  assert.equal(prepareAccountAuth(f.options).outputExists, true);
});
test("the complete serialized account input stays within the installer file limit", t => {
  const f = fixture(t), long = "x".repeat(4096), values = { SMTP_HOST: "smtp.example.invalid", SMTP_USER: long, SMTP_PASS: long,
    SMTP_FROM: long, GOOGLE_CLIENT_ID: long, GOOGLE_CLIENT_SECRET: long };
  const report = prepareAccountAuth({ ...f.options, environment: () => env(values) });
  assert.equal(report.ready, false); assert.match(report.problem, /supported limit/);
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, environment: () => env(values) }), error => error.code === "AUTH");
  assert.equal(fs.existsSync(f.output), false);
});
test("SMTP normalization preserves the production TLS semantics, relay and sender behavior", () => {
  for (const [port, secure, expected] of [[undefined, undefined, "false"], ["465", undefined, "true"], ["465", "false", "false"],
    ["587", "true", "true"], ["587", "yes", "true"], ["587", "1", "true"], ["587", "FALSE", "false"], ["465", "", "true"]]) {
    const source = { SMTP_HOST: "smtp.example.invalid", SMTP_FROM: "KAI <signin@example.invalid>", SMTP_PORT: port, SMTP_SECURE: secure };
    const input = accountInput(source); assert.equal(input.ready, true); assert.equal(input.auth.SMTP_SECURE, expected);
    assert.equal(input.auth.SMTP_PORT, port || "587"); assert.equal(Object.hasOwn(input.auth, "SMTP_PASS"), false);
  }
  assert.equal(accountInput({ SMTP_HOST: "smtp.example.invalid", SMTP_FROM: "sender", SMTP_PASS: "ignored-without-user" }).auth.SMTP_PASS, undefined);
});
test("incomplete providers report only missing names and never become a usable input", t => {
  const f = fixture(t), values = { SMTP_HOST: "smtp.example.invalid", SMTP_USER: "user", GOOGLE_CLIENT_ID: "client" };
  const report = prepareAccountAuth({ ...f.options, environment: () => env(values) });
  assert.equal(report.ready, false); assert.deepEqual(report.providers.email.missing, ["SMTP_PASS"]);
  assert.deepEqual(report.providers.google.missing, ["GOOGLE_CLIENT_SECRET"]);
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, environment: () => env(values) }), error => error.code === "AUTH");
  assert.equal(fs.existsSync(path.dirname(f.output)), false);
  const oneReady = accountInput({ ...values, GOOGLE_CLIENT_SECRET: "complete-google-fixture" });
  assert.equal(oneReady.ready, true); assert.deepEqual(Object.keys(oneReady.auth).sort(), ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  assert.equal(accountInput({ SMTP_HOST: "smtp.example.invalid", SMTP_FROM: "sender", SMTP_PORT: "invalid" }).ready, false);
});
test("source reads are bounded and reject malformed, duplicate or invalid UTF-8 account settings", t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, Buffer.alloc(MAX_ENV + 1)); assert.throws(() => readBounded(f.source), error => error.code === "SOURCE");
  for (const source of [Buffer.from("SMTP_HOST=unterminated"), Buffer.from("SMTP_HOST=a\0SMTP_HOST=b\0"), Buffer.from([0xff, 0])]) {
    assert.throws(() => selectedEnvironment(source), error => error.code === "SOURCE");
  }
  fs.writeFileSync(f.source, env(f.values)); const linked = path.join(f.dir, "source-link"); fs.symlinkSync(f.source, linked);
  assert.throws(() => readBounded(linked), error => error.code === "SOURCE");
});
test("a website restart aborts before credential writing", t => {
  for (const changeAt of [2, 3]) {
    const f = fixture(t); let snapshots = 0;
    assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, snapshot: () => ++snapshots < changeAt ? 321 : 654 }), error => error.code === "CHANGED");
    assert.equal(fs.existsSync(f.output), false);
  }
});
test("existing files, directory links and permissive destinations are preserved", t => {
  const f = fixture(t), legacy = path.join(f.dir, "legacy"), linked = path.join(f.dir, "linked");
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, output: "/account-auth.json" }), error => error.code === "OUTPUT");
  fs.mkdirSync(legacy, { mode: 0o700 }); fs.writeFileSync(path.join(legacy, "account-auth.json"), "do-not-change", { mode: 0o600 });
  const before = fs.statSync(legacy); fs.symlinkSync(legacy, linked);
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, output: path.join(linked, "account-auth.json") }), error => error.code === "OUTPUT");
  assert.equal(fs.readFileSync(path.join(legacy, "account-auth.json"), "utf8"), "do-not-change");
  assert.equal(fs.statSync(legacy).ctimeMs, before.ctimeMs);
  fs.mkdirSync(path.dirname(f.output), { mode: 0o755 });
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true }), error => error.code === "OUTPUT");
  fs.chmodSync(path.dirname(f.output), 0o700); fs.symlinkSync(path.join(legacy, "account-auth.json"), f.output);
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true }), error => error.code === "OUTPUT");
  assert.equal(fs.readFileSync(path.join(legacy, "account-auth.json"), "utf8"), "do-not-change");
  const writable = path.join(f.dir, "writable-ancestor"), privateLeaf = path.join(writable, "private");
  fs.mkdirSync(writable, { mode: 0o777 }); fs.chmodSync(writable, 0o777); fs.mkdirSync(privateLeaf, { mode: 0o700 });
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, output: path.join(privateLeaf, "account-auth.json") }), error => error.code === "OUTPUT");
  assert.equal(fs.readdirSync(privateLeaf).length, 0);
});
test("idempotent preparation rejects unsafe existing permissions and a changing source process", t => {
  const f = fixture(t); prepareAccountAuth({ ...f.options, prepare: true });
  fs.chmodSync(f.output, 0o644);
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true }), error => error.code === "OUTPUT");
  fs.chmodSync(f.output, 0o600); let snapshots = 0;
  assert.throws(() => prepareAccountAuth({ ...f.options, prepare: true, snapshot: () => ++snapshots < 3 ? 321 : 654 }), error => error.code === "CHANGED");
});
test("the preparation handoff runs with only its two files and Node builtins", t => {
  const f = fixture(t), directory = path.join(f.dir, "standalone"); fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of ["prepare-account-auth.js", "account-auth-input.js"]) fs.copyFileSync(path.join(__dirname, "../deploy/koin-mainnet", name), path.join(directory, name));
  const result = spawnSync(process.execPath, ["-e", 'const m=require(process.argv[1]); console.log(m.accountInput({GOOGLE_CLIENT_ID:"fixture-client",GOOGLE_CLIENT_SECRET:"fixture-secret"}).ready)', path.join(directory, "prepare-account-auth.js")], { encoding: "utf8", cwd: directory, env: {} });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "true");
});
test("CLI accepts only known options and sanitizes failures without echoing arguments", () => {
  assert.deepEqual(argumentsFor([]), {}); assert.deepEqual(argumentsFor(["--prepare"]), { prepare: true });
  assert.throws(() => argumentsFor(["--service", "arbitrary.service"]), error => error.code === "ARGS");
  const result = spawnSync(process.execPath, [path.join(__dirname, "../deploy/koin-mainnet/prepare-account-auth.js"), "--unknown", "synthetic-secret-never-print"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret-never-print/);
});
test("CLI rejects a non-root identity before trying to read a service", t => {
  const f = fixture(t), preload = path.join(f.dir, "nonroot-preload.js");
  fs.writeFileSync(preload, "process.getuid = () => 65534;\n", { mode: 0o600 });
  const result = spawnSync(process.execPath, ["--require", preload, path.join(__dirname, "../deploy/koin-mainnet/prepare-account-auth.js"), "--prepare", "--output", f.output], { encoding: "utf8", env: {} });
  assert.equal(result.status, 1); assert.match(result.stderr, /Run account-auth preparation as root/);
  assert.equal(result.stdout, ""); assert.equal(fs.existsSync(path.dirname(f.output)), false);
});
