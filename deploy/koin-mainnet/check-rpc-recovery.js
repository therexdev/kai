"use strict";
const fs = require("node:fs"), path = require("node:path");
const { KoinChain } = require("../../lib/koin-network/chain");
const { rpcDiagnostics } = require("../../lib/koin-network/rpc-provider");
// Read-only pre-activation check. KoinChain.verify reads the pinned native token,
// contract metadata and policy; no keys, signer, submitter or journal are loaded.
async function check(file, { createChain = deployment => new KoinChain(deployment), log = console.log } = {}) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const chain = createChain(config.deployment), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000), started = Date.now();
  try {
    await chain.provider.withSignal(controller.signal, () => chain.verify());
    log(JSON.stringify({ probe: "new RPC transport contract verification", ok: true, elapsedMs: Date.now() - started }));
  } finally { clearTimeout(timer); controller.abort(); }
}
if (require.main === module) {
  const file = process.argv[2];
  if (process.argv.length !== 3 || !path.isAbsolute(file)) throw Error("Absolute runtime configuration path required");
  check(file).catch(error => {
    console.error(JSON.stringify({ probe: "new RPC transport contract verification", ok: false, rpc: rpcDiagnostics(error) }));
    process.exitCode = 1;
  });
}
module.exports = { check };
