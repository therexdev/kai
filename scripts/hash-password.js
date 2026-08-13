#!/usr/bin/env node
"use strict";

/*
 * Generate an ADMIN_PASSWORD_HASH value.
 *
 *   npm run hash-password                  (prompts, nothing hits shell history)
 *   echo 'my password' | npm run hash-password
 *   npm run hash-password -- 'my password' (convenient; leaks to shell history)
 */

const readline = require("readline");
const { hashPassword } = require("../lib/auth");

function emit(password) {
  const pw = String(password).replace(/\r?\n$/, "");
  if (!pw) {
    console.error("No password given — nothing to hash.");
    process.exit(1);
  }
  if (pw.length < 12) {
    console.error(`Warning: ${pw.length} characters. Use 16+ for an internet-facing admin page.\n`);
  }
  console.log("\nAdd this to your environment variables:\n");
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}\n`);
}

const arg = process.argv.slice(2).join(" ").trim();
if (arg) {
  emit(arg);
} else if (!process.stdin.isTTY) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => emit(buf.split("\n")[0]));
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Mute the echo so the password never appears on screen.
  rl.output.write("Password: ");
  rl._writeToOutput = () => {};
  rl.question("", (answer) => {
    rl.close();
    process.stdout.write("\n");
    emit(answer);
  });
}
