"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { Signer } = require("koilib");
const { accountEnvironment, installationFiles, stageConfiguration, CONFIG_DIR } = require("../deploy/koin-mainnet/prepaid-install-config");
const { parityHash, verifyParity } = require("../lib/koin-network/v4-purchase-oracle");
const { MARKET } = require("../lib/koin-network/purchase-price");

function write(file, value) {
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
}
function fixture(t, accountMode = "public") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-prepaid-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bootstrap = path.join(dir, "bootstrap"), stage = path.join(dir, "stage"), auth = path.join(dir, "account-auth.json");
  fs.mkdirSync(bootstrap, { mode: 0o700 }); fs.mkdirSync(stage, { mode: 0o700 });
  fs.mkdirSync(path.join(bootstrap, "tokenizer"), { mode: 0o700 });
  const runtime = { accountMode, deployment: { product: "prepaid-usd-v1", chainId: "isolated-chain", token: Signer.fromSeed("isolated-install-native-token").getAddress() } };
  write(path.join(bootstrap, "runtime.json"), runtime);
  for (const name of ["runtime-keys.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"]) write(path.join(bootstrap, name), {});
  write(path.join(bootstrap, "qualifications.json"), []);
  write(path.join(bootstrap, "operator-secret"), "a".repeat(64));
  write(auth, { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_FROM: "KAI <signin@example.invalid>" });
  // These must never be copied or modified by the new service installer.
  for (const name of ["offline-keys.json", "accounts.sqlite", "legacy-payment-journal.sqlite"]) write(path.join(bootstrap, name), "preserved-" + name);
  const snapshot = () => Object.fromEntries(fs.readdirSync(bootstrap).filter(name => fs.statSync(path.join(bootstrap, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(bootstrap, name)).toString("hex")]));
  return { dir, bootstrap, stage, auth, runtime, snapshot };
}

test("public installation succeeds without invitations and preserves bootstrap and old state", t => {
  const f = fixture(t), before = f.snapshot();
  assert.deepEqual(stageConfiguration(f.bootstrap, f.stage, f.auth), { accountMode: "public", parityInstalled: false });
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(fs.readdirSync(f.stage).sort(), ["account.env", "operator-secret", "qualifications.json", "runtime-keys.json", "runtime.json", "tokenizer"]);
  const env = fs.readFileSync(path.join(f.stage, "account.env"), "utf8");
  assert.match(env, /SMTP_HOST="smtp.example.invalid"/);
  assert.equal(fs.statSync(path.join(f.stage, "account.env")).mode & 0o777, 0o600);
  assert.throws(() => stageConfiguration(f.bootstrap, f.stage, f.auth), /empty private/);
});

test("invitation mode requires its invitation file and never silently enables public auth", t => {
  const f = fixture(t, "invitations");
  assert.throws(() => stageConfiguration(f.bootstrap, f.stage), /invitations/);
  assert.deepEqual(fs.readdirSync(f.stage), [], "failed validation writes no staged files");
  write(path.join(f.bootstrap, "invitations.json"), []);
  assert.throws(() => stageConfiguration(f.bootstrap, f.stage), /explicit invitation list/);
  write(path.join(f.bootstrap, "invitations.json"), [{ id: "isolated-invalid-invitation" }]);
  assert.throws(() => stageConfiguration(f.bootstrap, f.stage), /Invalid Test invitation/);
  assert.deepEqual(fs.readdirSync(f.stage), []);
  const invitation = { accountId: "test_isolated", grantId: "grant_isolated", owner: Signer.fromSeed("isolated-install-owner").getAddress(),
    tokenHash: "b".repeat(64), expiresAt: Date.now() + 86400000, enabled: true };
  write(path.join(f.bootstrap, "invitations.json"), [invitation, invitation]);
  assert.throws(() => stageConfiguration(f.bootstrap, f.stage), /Duplicate Test invitation/);
  assert.deepEqual(fs.readdirSync(f.stage), []);
  write(path.join(f.bootstrap, "invitations.json"), [invitation]);
  assert.throws(() => stageConfiguration(f.bootstrap, f.stage, f.auth), /only accepted for public/);
  assert.equal(stageConfiguration(f.bootstrap, f.stage).accountMode, "invitations");
  assert.match(fs.readFileSync(path.join(f.stage, "account.env"), "utf8"), /public account sign-in is disabled/);
  assert.deepEqual(fs.readFileSync(path.join(f.stage, "invitations.json")), fs.readFileSync(path.join(f.bootstrap, "invitations.json")));
});

test("an invalid operator secret fails before writing any staged configuration", t => {
  const f = fixture(t);
  for (const secret of ["fixture", "A".repeat(64), "a".repeat(257)]) {
    write(path.join(f.bootstrap, "operator-secret"), secret);
    assert.throws(() => stageConfiguration(f.bootstrap, f.stage, f.auth), /operator.secret/);
    assert.deepEqual(fs.readdirSync(f.stage), []);
  }
});

test("public mode ignores stale invitations and permits complete email or Google credentials", t => {
  const f = fixture(t);
  write(path.join(f.bootstrap, "invitations.json"), "a stale invitation must not enter public configuration");
  assert.equal(installationFiles(f.bootstrap, f.auth).has("invitations.json"), false);
  write(f.auth, { GOOGLE_CLIENT_ID: "isolated.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "isolated-fixture-only" });
  assert.match(installationFiles(f.bootstrap, f.auth).get("account.env").toString(), /GOOGLE_CLIENT_ID=/);
  assert.throws(() => installationFiles(f.bootstrap), /explicit protected account-auth/);
  f.runtime.deployment.product = "prepaid-v1"; write(path.join(f.bootstrap, "runtime.json"), f.runtime);
  assert.throws(() => installationFiles(f.bootstrap, f.auth), /USD credit product/);
});

test("account credential validation rejects incomplete providers, arbitrary env, unsafe values and files", t => {
  const f = fixture(t);
  for (const auth of [{}, { SMTP_HOST: "smtp.example.invalid" }, { SMTP_HOST: "smtp.example.invalid", SMTP_USER: "user" },
    { SMTP_HOST: "smtp.example.invalid", SMTP_FROM: "sender", SMTP_PORT: "0" },
    { SMTP_HOST: "smtp.example.invalid", SMTP_FROM: "sender", SMTP_SECURE: "yes" },
    { GOOGLE_CLIENT_ID: "client" }, { GOOGLE_CLIENT_SECRET: "secret" },
    { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", NODE_OPTIONS: "--require=untrusted" },
    { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "line\nbreak" }]) {
    write(f.auth, auth); assert.throws(() => stageConfiguration(f.bootstrap, f.stage, f.auth));
    assert.deepEqual(fs.readdirSync(f.stage), []);
  }
  write(f.auth, { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "fixture" });
  fs.chmodSync(f.auth, 0o644); assert.throws(() => accountEnvironment(f.auth, true), /protected regular account-auth/);
  fs.chmodSync(f.auth, 0o600);
  const linked = path.join(f.dir, "linked-auth.json"); fs.symlinkSync(f.auth, linked);
  assert.throws(() => accountEnvironment(linked, true), /protected regular account-auth/);
  // A mapped container UID cannot chown to another host user; change only the
  // reported owner to exercise the rejection without requiring host access.
  const stat = fs.fstatSync;
  const wrongOwner = t.mock.method(fs, "fstatSync", fd => { const value = stat(fd); value.uid = process.getuid() + 1; return value; });
  assert.throws(() => accountEnvironment(f.auth, true), /protected regular account-auth/);
  wrongOwner.mock.restore();
});

test("account credentials are serialized as literal systemd values and never printed on failure", t => {
  const f = fixture(t), secret = 'fixture $dollar `backtick` "quote" \\slash';
  write(f.auth, { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: secret });
  assert.equal(accountEnvironment(f.auth, true).split("\n")[2], 'GOOGLE_CLIENT_SECRET="fixture \\$dollar \\`backtick\\` \\"quote\\" \\\\slash"');
  write(f.auth, '{"GOOGLE_CLIENT_SECRET":"synthetic-never-log-this-secret", broken}');
  const result = spawnSync(process.execPath, [path.join(__dirname, "../deploy/koin-mainnet/prepaid-install-config.js"), f.bootstrap, f.stage, f.auth], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /Invalid account-auth JSON/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-never-log-this-secret/);
});

async function parityFixture(t) {
  const f = fixture(t), now = 1800000000000, signer = Signer.fromSeed("isolated-install-parity-signer"), feed = "0x" + "3".repeat(40);
  const privateParity = path.join(f.bootstrap, "parity-private.json");
  const config = { schema: 1, rpcUrls: ["https://archive-a.invalid/private-fixture-key", "https://archive-b.invalid/private-fixture-key"], usdtFeed: feed,
    paritySigner: signer.getAddress(), parityFile: privateParity,
    policy: { version: 1, windowSeconds: 60, maxBlockGapSeconds: 12, maxPriceAgeMs: 30000, maxQuoteMs: 20000,
      maxDeviationBps: 100, maxSlippageBps: 100, maxUsdtAgeMs: 20000, maxUsdtDeviationBps: 100, maxParityAgeMs: 20000, maxParityDeviationBps: 100,
      minLiquidity: "1000000000", minProbeUsdtAtoms: "1000000", usdtSource: "ethereum:chainlink:" + feed, paritySource: "isolated:reviewed-parity" } };
  const statement = { schema: 1, nativeChainId: f.runtime.deployment.chainId, nativeToken: f.runtime.deployment.token, wrappedChainId: 1,
    wrappedToken: MARKET.wrappedToken, wrappedPerNativeAtoms: "100000000", observedAt: now - 1000, validUntil: now + 10000,
    source: config.policy.paritySource, state: "verified", redemption: "available", evidenceHash: "0x" + "1".repeat(64) };
  const envelope = { statement, signature: Buffer.from(await signer.signHash(parityHash(statement))).toString("base64") };
  write(privateParity, envelope); f.runtime.purchasePricing = config; write(path.join(f.bootstrap, "runtime.json"), f.runtime);
  return { ...f, now, config, envelope, privateParity };
}

test("parity installation relocates the file but preserves signed bytes and every reviewed pricing pin", async t => {
  const f = await parityFixture(t), before = f.snapshot(), files = installationFiles(f.bootstrap, f.auth, { now: f.now });
  const installed = JSON.parse(files.get("runtime.json"));
  assert.equal(installed.purchasePricing.parityFile, path.join(CONFIG_DIR, "parity.json"));
  assert.deepEqual(installed, { ...f.runtime, purchasePricing: { ...f.config, parityFile: path.join(CONFIG_DIR, "parity.json") } });
  assert.deepEqual(files.get("parity.json"), fs.readFileSync(f.privateParity));
  verifyParity(JSON.parse(files.get("parity.json")), { signer: f.config.paritySigner, source: f.config.policy.paritySource,
    nativeChainId: installed.deployment.chainId, nativeToken: installed.deployment.token, now: f.now, maxAgeMs: f.config.policy.maxParityAgeMs });
  assert.deepEqual(f.snapshot(), before);
  assert.throws(() => installationFiles(f.bootstrap, f.auth, { now: f.now + 10001 }), /Fresh/);
  const changed = structuredClone(f.envelope); changed.statement.wrappedPerNativeAtoms = "100000001"; write(f.privateParity, changed);
  assert.throws(() => installationFiles(f.bootstrap, f.auth, { now: f.now }), /Signature/);
});

test("service installer wires only the separate account environment and state paths", () => {
  const script = fs.readFileSync(path.join(__dirname, "../deploy/koin-mainnet/install-prepaid.sh"), "utf8");
  assert.match(script, /^EnvironmentFile=\/etc\/kai-koin-prepaid\/account.env$/m);
  assert.match(script, /^Environment=KAI_KOIN_TEST_STATE_DIR=\/var\/lib\/kai-koin-prepaid$/m);
  assert.match(script, /^ReadOnlyPaths=\/etc\/kai-koin-prepaid$/m);
  assert.match(script, /install -m 0600 -o root -g root/);
  assert.match(script, /install -m 0640 -o root -g kai-koin-prepaid/);
  assert.ok(script.indexOf('deploy/koin-mainnet/prepaid-install-config.js "${prepare_args[@]}"') < script.indexOf("useradd --system"));
  assert.doesNotMatch(script, /(?:systemctl (?:stop|restart)|cp |install .*)[^\n]*kai-koin-mainnet-pilot/);
  assert.equal(spawnSync("bash", ["-n", path.join(__dirname, "../deploy/koin-mainnet/install-prepaid.sh")]).status, 0);
});

test("destination guard refuses directory links before changing another service's files or metadata", t => {
  const f = fixture(t), script = fs.readFileSync(path.join(__dirname, "../deploy/koin-mainnet/install-prepaid.sh"), "utf8");
  const guard = script.match(/require_real_directory\(\) \{[\s\S]+?\n\}/)?.[0]; assert.ok(guard);
  assert.ok(script.indexOf('require_real_directory "$directory"') < script.indexOf("useradd --system"));
  assert.match(script, /! -L \/etc\/systemd\/system\/kai-koin-prepaid.service/);
  const legacy = path.join(f.dir, "legacy-service"), linked = path.join(f.dir, "linked-config");
  fs.mkdirSync(legacy, { mode: 0o700 }); write(path.join(legacy, "payment-journal.sqlite"), "unchanged-existing-payments");
  fs.symlinkSync(legacy, linked); const before = fs.statSync(legacy);
  const check = destination => spawnSync("bash", ["-c", guard + '\nrequire_real_directory "$1"', "guard", destination], { encoding: "utf8" });
  assert.equal(check(linked).status, 1);
  const dangling = path.join(f.dir, "dangling-config"); fs.symlinkSync(path.join(f.dir, "absent"), dangling);
  assert.equal(check(dangling).status, 1);
  assert.equal(check(path.join(legacy, "payment-journal.sqlite")).status, 1);
  assert.equal(check(path.join(f.dir, "new-config")).status, 0);
  assert.equal(check(legacy).status, 0);
  const after = fs.statSync(legacy);
  for (const field of ["mode", "uid", "gid", "mtimeMs", "ctimeMs"]) assert.equal(after[field], before[field]);
  assert.equal(fs.readFileSync(path.join(legacy, "payment-journal.sqlite"), "utf8"), "unchanged-existing-payments");
});
