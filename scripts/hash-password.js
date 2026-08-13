#!/usr/bin/env node
"use strict";

/*
 * Generate an ADMIN_PASSWORD_HASH value.
 *
 * Reads the password from the first source that supplies one:
 *   1. command-line argument   node scripts/hash-password.js "my password"
 *   2. KAI_ADMIN_PW env var    $env:KAI_ADMIN_PW="my password"; node scripts/hash-password.js
 *   3. piped stdin             echo "my password" | node scripts/hash-password.js
 *   4. interactive prompt      node scripts/hash-password.js
 *
 * Terminal detection is unreliable on Windows (npm wraps scripts in cmd.exe,
 * and Git Bash/MinTTY reports stdin as a pipe), so stdin is read line-wise
 * rather than waiting for EOF, and every failure path explains what to run.
 */

const readline = require("readline");
const { hashPassword } = require("../lib/auth");

const USAGE = `
No password given — nothing to hash.

Use whichever of these fits your shell:

  PowerShell / cmd
    node scripts/hash-password.js "your password"
    $env:KAI_ADMIN_PW="your password"; node scripts/hash-password.js

  bash / zsh
    node scripts/hash-password.js 'your password'
    KAI_ADMIN_PW='your password' node scripts/hash-password.js
    echo 'your password' | node scripts/hash-password.js

A password passed as an argument is saved in your shell history; clear it
afterwards (PowerShell keeps it in ConsoleHost_history.txt) or use the
KAI_ADMIN_PW form instead.
`;

function emit(password) {
  // Strip the line ending only — PowerShell and cmd pipe CRLF, so a lone
  // trailing \r would otherwise be hashed as part of the password.
  const pw = String(password).replace(/[\r\n]+$/, "");
  if (!pw) {
    console.error(USAGE);
    process.exit(1);
  }
  if (pw.length < 12) {
    console.error(`Warning: ${pw.length} characters. Use 16+ for an internet-facing admin page.\n`);
  }
  console.log("\nAdd this to your environment variables:\n");
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}\n`);
}

/**
 * Resolve on the first complete line rather than on EOF, so this also works
 * where stdin is an interactive pipe that never closes (MinTTY).
 */
function readFirstLine(stream) {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      stream.pause();
      resolve(value);
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl));
    });
    stream.on("end", () => finish(buf));
    stream.on("error", () => finish(""));
  });
}

function promptHidden() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.output.write("Password (hidden as you type, then press Enter): ");
    // Swallow the echo so the password never appears on screen or in scrollback.
    rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

(async () => {
  const arg = process.argv.slice(2).join(" ").trim();
  if (arg) return emit(arg);

  if (process.env.KAI_ADMIN_PW) return emit(process.env.KAI_ADMIN_PW);

  if (process.stdin.isTTY) return emit(await promptHidden());

  // Not a detected terminal: it may still be a pipe carrying the password,
  // or an empty stdin (npm's cmd.exe wrapper), which falls through to usage.
  return emit(await readFirstLine(process.stdin));
})();
