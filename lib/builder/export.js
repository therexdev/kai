"use strict";
const fs = require("fs"),
  path = require("path"),
  { html } = require("./projects"),
  { abi, guardAbi, wasmHash, metadataContract } = require("./chain");
// Store-only ZIP: bounded, known filenames; no subprocesses or archive deps.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const b of buffer) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const chunks = [],
    central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = Buffer.from(name),
      b = Buffer.isBuffer(content) ? content : Buffer.from(content),
      crc = crc32(b),
      h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(b.length, 18);
    h.writeUInt32LE(b.length, 22);
    h.writeUInt16LE(n.length, 26);
    chunks.push(h, n, b);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(b.length, 20);
    c.writeUInt32LE(b.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += h.length + n.length + b.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
function bundle(project, version) {
  const root = path.join(__dirname, "../.."),
    read = (p) => fs.readFileSync(path.join(root, p));
  const config = {
    title: project.title,
    template: project.template,
    contract_id: project.contract_id,
    chainId: project.chain_id,
    network: project.network,
    guard_id: project.guard_id,
    metadataContract: metadataContract(project.chain_id),
    guardAbi,
    appHash: wasmHash("contract"),
    guardHash: wasmHash("guard"),
    rpc:
      project.network === "mainnet"
        ? "https://api.koinos.io"
        : "https://testnet.koinosfoundation.org/jsonrpc",
    abi,
  };
  const record = {
    format: "kai-build-project-v1",
    project: {
      title: project.title,
      template: project.template,
      contractId: project.contract_id,
      chainId: project.chain_id,
      network: project.network,
    },
    revision: version.revision,
    hash: version.hash,
    files: version.files,
  };
  let shell = read("views/build/host.html")
    .toString()
    .replaceAll("/build/assets/build.css", "build.css")
    .replaceAll("/producer-signer/kondor.min.js", "kondor.min.js")
    .replaceAll("/build/assets/bridge.js", "bridge.js")
    .replaceAll("/build/assets/host.js", "host.js")
    .replace(
      '<script src="kondor.min.js"',
      '<script src="koinos.min.js" defer></script><script src="kondor.min.js"',
    )
    .replace('href="/build"', 'href="./"')
    .replace('src="/redesign/brand-mark.svg"', 'src="brand-mark.svg"');
  const files = {
    "project.json": JSON.stringify(record, null, 2),
    "site/index.html": shell,
    "site/app.html": html(version.files),
    "site/config.json": JSON.stringify(config, null, 2),
    "site/bridge.js": read("views/build/bridge.js"),
    "site/host.js": read("views/build/standalone.js"),
    "site/build.css": read("views/build/build.css"),
    "site/brand-mark.svg": read("public/redesign/brand-mark.svg"),
    "site/kondor.min.js": read("public/producer-signer/kondor.min.js"),
    "site/koinos.min.js": fs.readFileSync(
      path.join(
        path.dirname(require.resolve("koilib/package.json")),
        "dist/koinos.min.js",
      ),
    ),
    "site/koinos.min.js.LICENSE.txt": fs.readFileSync(
      path.join(
        path.dirname(require.resolve("koilib/package.json")),
        "dist/koinos.min.js.LICENSE.txt",
      ),
    ),
    "contract/contract.wasm": read("contracts/build-app/build/contract.wasm"),
    "contract/contract.abi.json": JSON.stringify(abi, null, 2),
    "contract/guard.wasm": read("contracts/build-app/build/guard.wasm"),
    "README.md": `# ${project.title}\n\nUpload the contents of site/ to a separate website origin with HTTPS. Open index.html through your web server (not file://). The exported site uses public Koinos RPC and Kondor directly; it does not depend on the Koinos AI server. Set the public RPC in site/config.json if needed. Never add private keys to these files.\n\n${project.contract_id ? "This export connects to the existing contract " + project.contract_id + "." : "This draft has no deployed contract yet. Publish it first, or deploy the supplied contract with all three authority overrides enabled and initialize it in the same signed transaction, deploy the bundled immutable guard with its upload-authority override enabled, then configure both addresses, chain ID and bytecode hashes."}\n\nproject.json can be imported into KAI Build as a NEW project. That does not transfer or duplicate ownership of the original chain contract. The source/ folder contains editable files; site/app.html is the rendered version with the wallet bridge. After editing source, rebuild/export through KAI Build or update site/app.html and the matching embedded CSS/JS yourself.\n\nThe contract source and build toolchain are in https://github.com/therexdev/kai/tree/claude/kai-production-website-fqx4pf/contracts/build-app . The wallet bridge requires the pinned template and immutable guard; replacing app code disables its wallet actions. Owners should preserve all authority overrides when replacing code. A new upload can change the authorization model; review it carefully.\n\nThe frontend is hosted separately from Koinos. On-chain records are public. One-wallet-one-vote does not prevent one person using multiple wallets.\n`,
  };
  for (const [name, source] of Object.entries(version.files))
    files["source/" + name] = source;
  for (const name of [
    "App.ts",
    "index.ts",
    "entries.ts",
    "Guard.ts",
    "guard-entry.ts",
    "guard-hash.ts",
    "proto/app.proto",
    "proto/app.ts",
  ])
    files["contract/assembly/" + name] = read(
      "contracts/build-app/assembly/" + name,
    );
  return zip(files);
}
module.exports = { bundle, zip };
