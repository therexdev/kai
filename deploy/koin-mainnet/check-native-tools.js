#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), { secret } = require("../../lib/koin-network/managed-provider"), M = require("../../lib/koin-network/managed-protocol");
const { probe } = require("../../lib/koin-network/native-probe");
async function main() {
  const [, , model, flag, budgetFlag, count] = process.argv, maxOutput = Number(count);
  if (process.argv.length !== 6 || flag !== "--probe" || budgetFlag !== "--max-output" || !M.find(model) || !Number.isSafeInteger(maxOutput) || maxOutput < 512 || maxOutput > Math.min(8192, M.find(model).maxOutputTokens))
    throw Error("Usage: node deploy/koin-mainnet/check-native-tools.js <model> --probe --max-output <512..8192>");
  const key = secret(), file = process.env.KAI_NATIVE_QUALIFICATION_FILE;
  if (!key || !file || !path.isAbsolute(file)) throw Error("Configure the protected supplier key and absolute KAI_NATIVE_QUALIFICATION_FILE first");
  process.umask(0o077);
  const lock = fs.openSync(file + ".lock", "wx", 0o600);
  let temporary;
  try {
    let data = { schema: 1, routes: [] };
    if (fs.existsSync(file)) {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 131072 || (st.mode & 0o077)) throw Error("Qualification file must be a protected regular file");
      data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.schema !== 1 || !Array.isArray(data.routes) || data.routes.length > 32) throw Error("Invalid qualification file");
    }
    data.routes = data.routes.filter(r => r.record?.model !== model);
    function save() {
      temporary = file + "." + process.pid + ".tmp";
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file); temporary = undefined;
      const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    // A failed requalification revokes old evidence; no retry or paid escalation.
    save();
    const evidence = await probe({ model, key, maxOutput });
    data.routes.push(evidence); save();
    console.log(JSON.stringify({ model, qualified: true, protocol: 2, calls: 2, usage: evidence.record.usage, expiresAt: evidence.record.expiresAt,
      enabled: false, next: "Review evidence before adding this model to KAI_NATIVE_TOOL_MODELS. This probe does not change the allowlist." }));
  } finally { if (temporary) fs.rmSync(temporary, { force: true }); fs.closeSync(lock); fs.rmSync(file + ".lock", { force: true }); }
}
if (require.main === module) main().catch(() => { console.error("Native qualification failed. No external tool ran; no automatic retry occurred. Check protected configuration and rerun explicitly."); process.exitCode = 1; });
module.exports = { main };
