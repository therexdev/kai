"use strict";

const fs = require("fs");

/*
 * Repo-carried operational flags. The production box deploys by git pull
 * only (deploy/README.md) and its systemd EnvironmentFile
 * (/opt/koinos/kai.env) is out of the repo's reach — so inert flags
 * (KAI_STORE, the oracle KAI_PRICE_* block) would otherwise need a root
 * login to flip. This loader lets deploy/app.env carry them through git:
 * a flag flip is a commit, and the 1-minute auto-deploy makes it live.
 *
 * Precedence: the REAL environment always wins — a key already set (by
 * systemd, the shell, CI) is never overwritten. The file only fills gaps,
 * so on-box emergency overrides keep working and NO SECRETS may live in
 * the file (it is committed to git; secrets stay in kai.env).
 */
function loadEnvFile(file, env = process.env) {
  const applied = [];
  const skipped = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { applied, skipped }; // no file — loader is a no-op
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Tolerate systemd-style quoting around the value.
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = val;
    applied.push(key);
  }
  return { applied, skipped };
}

module.exports = { loadEnvFile };
