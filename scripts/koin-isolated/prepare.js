"use strict";
// Disposable, peerless Docker project. Never reads a wallet or live node config.
const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");
const { Signer, utils } = require("koilib");
const upstream = require("./upstream.json"), desktopPin = require("../../lib/koin-network/SOURCE.json").sourceCommit;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const images = {
  amqp: "rabbitmq:3.13-alpine", chain: "koinos/koinos-chain:v1.5.2", jsonrpc: "koinos/koinos-jsonrpc:v1.2.0",
  block_store: "koinos/koinos-block-store:v1.1.0", mempool: "koinos/koinos-mempool:v1.5.0",
  transaction_store: "koinos/koinos-transaction-store:v1.1.0",
};
function verifyCheckout(directory, commit) {
  if (cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim() !== commit) throw Error("Isolated source commit mismatch");
  cp.execFileSync("git", ["diff", "--exit-code", "HEAD"], { cwd: directory, stdio: "pipe" });
}
function prepare(upstreamDir, desktopDir, directory) {
  upstreamDir = path.resolve(upstreamDir); desktopDir = path.resolve(desktopDir); directory = path.resolve(directory);
  verifyCheckout(upstreamDir, upstream.commit); verifyCheckout(desktopDir, desktopPin);
  if (fs.existsSync(directory)) throw Error("Use a new empty rehearsal directory; never reuse node state");
  for (const [name, digest] of Object.entries(upstream.sha256)) if (hash(fs.readFileSync(path.join(upstreamDir, name))) !== digest) throw Error("Upstream artifact pin mismatch: " + name);
  const artifacts = {};
  for (const kind of ["credits", "rewards"]) {
    const wasm = path.join(desktopDir, "contracts/koin-network/build/release", kind + ".wasm");
    const abi = path.join(desktopDir, "contracts/koin-network/abi", kind + ".json");
    if (hash(fs.readFileSync(abi)) !== hash(fs.readFileSync(path.join(__dirname, "../../lib/koin-network", kind + "-abi.json")))) throw Error("Desktop/master ABI mismatch");
    artifacts[kind] = { wasm, sha256: hash(fs.readFileSync(wasm)) };
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = { address: Signer.fromSeed("kai-isolated-genesis-marker-v1").getAddress(), id: 4294967000,
    key: utils.encodeBase64url(Buffer.from("kai-isolated-chain-v1")), value: utils.encodeBase64url(crypto.randomBytes(32)) };
  const genesis = JSON.parse(fs.readFileSync(path.join(upstreamDir, "node_config/genesis_data.json")));
  genesis.entries.push({ space: { zone: utils.encodeBase64url(utils.decodeBase58(marker.address)), id: marker.id }, key: marker.key, value: marker.value });
  const genesisPath = path.join(directory, "genesis.json"); fs.writeFileSync(genesisPath, JSON.stringify(genesis));
  const rabbit = path.join(directory, "rabbitmq.conf"); fs.writeFileSync(rabbit, "max_message_size = 536870912\n");
  const services = {
    amqp: { image: images.amqp, volumes: [rabbit + ":/etc/rabbitmq/rabbitmq.conf:ro"],
      healthcheck: { test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"], interval: "5s", timeout: "5s", retries: 20 } },
  };
  for (const name of ["chain", "mempool", "block_store", "transaction_store", "jsonrpc"]) {
    services[name] = { image: images[name], depends_on: { amqp: { condition: "service_healthy" } },
      command: ["--basedir=/koinos", "-a", "amqp://guest:guest@amqp:5672/"], restart: "on-failure:3" };
  }
  services.chain.volumes = [genesisPath + ":/koinos/chain/genesis_data.json:ro"];
  services.jsonrpc.volumes = [path.join(upstreamDir, "node_config/koinos_descriptors.pb") + ":/koinos/jsonrpc/descriptors/koinos_descriptors.pb:ro"];
  // The runner enters only this container's network namespace. No published
  // ports are needed, and the internal network has no route to public chains.
  services.jsonrpc.command.push("-L", "/tcp/48080");
  const compose = { services, networks: { default: { internal: true } } };
  fs.writeFileSync(path.join(directory, "compose.json"), JSON.stringify(compose, null, 2) + "\n");
  const walletFile = path.join(desktopDir, "core/lib/koin-network/chain.js");
  const manifest = { schema: 1, mode: "isolated-chain", upstreamDir, upstreamCommit: upstream.commit, desktopCommit: desktopPin,
    endpoint: "http://127.0.0.1:48080", marker, images, artifacts, genesisHash: hash(fs.readFileSync(genesisPath)),
    walletClient: { file: walletFile, sha256: hash(fs.readFileSync(walletFile)) } };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifest;
}
if (require.main === module) {
  if (process.argv.length !== 5) throw Error("Usage: prepare.js UPSTREAM_CHECKOUT DESKTOP_CHECKOUT NEW_DIRECTORY");
  const result = prepare(...process.argv.slice(2)); console.log(JSON.stringify({ mode: result.mode, endpoint: result.endpoint, genesisHash: result.genesisHash }));
}
module.exports = { prepare, hash, images };
