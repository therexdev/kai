#!/usr/bin/env node
"use strict";

/*
 * Diagnose an "Incorrect password" at /admin without touching the server.
 * Paste back the ADMIN_PASSWORD_HASH exactly as it is stored in the panel,
 * then enter the password you type on the login form.
 *
 *   node scripts/check-password.js 'scrypt$16384$8$1$…' 'my password'
 *   $env:ADMIN_PASSWORD_HASH='scrypt$…'; node scripts/check-password.js
 */

const readline = require("readline");
const { describeHash, normalizeHash, verifyPassword } = require("../lib/auth");

function ask(query, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.output.write(query);
    if (hidden) rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

(async () => {
  const raw = process.argv[2] || process.env.ADMIN_PASSWORD_HASH ||
    (process.stdin.isTTY ? await ask("Paste ADMIN_PASSWORD_HASH: ", false) : "");
  const stored = normalizeHash(raw);

  console.log("\n--- stored hash ---");
  if (!stored) {
    console.log("No hash given. Pass it as the first argument or set ADMIN_PASSWORD_HASH.");
    process.exit(1);
  }
  console.log(`length:   ${stored.length} characters (a valid hash is ~130)`);
  console.log(`segments: ${stored.split("$").length} (must be 6)`);
  if (stored !== String(raw).trim()) console.log("note:     surrounding quotes were stripped");

  const check = describeHash(stored);
  if (!check.ok) {
    console.log(`\nRESULT: this hash is unusable — ${check.reason}.`);
    console.log("No password can ever match it. Generate a fresh one with");
    console.log("  node scripts/hash-password.js");
    console.log("and copy the entire ADMIN_PASSWORD_HASH= line, including every $ sign.\n");
    process.exit(1);
  }
  console.log(`format:   valid (scrypt N=${check.params.N} r=${check.params.r} p=${check.params.p})`);

  const password = process.argv[3] || process.env.KAI_ADMIN_PW ||
    (process.stdin.isTTY ? await ask("\nPassword you type on the login form: ", true) : "");
  if (!password) {
    console.log("\nNo password given — pass it as the second argument or set KAI_ADMIN_PW.\n");
    process.exit(1);
  }

  const match = verifyPassword(password, stored);
  console.log("\n--- result ---");
  if (match) {
    console.log("MATCH. This password opens /admin with this hash.");
    console.log("If the site still rejects it, the panel is serving a different value:");
    console.log("  - confirm ADMIN_PASSWORD_HASH there matches what you just pasted");
    console.log("  - restart the Node app so it picks up the change");
    console.log("  - check ADMIN_PASSWORD is not also set to something else\n");
  } else {
    console.log("NO MATCH. This hash was generated from different text.");
    console.log("Most often the shell altered the password before hashing:");
    console.log("  - double quotes expand $ in PowerShell and bash — use single quotes");
    console.log('  - a placeholder was hashed literally (e.g. "YourPasswordHere")');
    console.log("Generate a new hash and update the panel:");
    console.log("  node scripts/hash-password.js\n");
    process.exit(1);
  }
})();
