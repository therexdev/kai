"use strict";
// Execute the shipped bytes through _start with the SDK VM, not App.run().
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path");
const { MockVM } = require("@koinos/mock-vm");
const C = require("@koinos/mock-vm/src/constants");
const { koinos } = require("@koinos/proto-js");
const { Serializer, utils } = require("koilib");
const { abi, bytes, wasmHash } = require("../../../lib/builder/chain");
const serializer = new Serializer(abi.koilib_types);
const contract = "1PcmKKU4Cy8zzvarSAYCmNtxcChrk7ZsFU";
const owner = "16yt8bWn9V2s4hYi36HnxGE7SxDYDM8eoQ";
function put(vm, key, value) {
  vm.db.putObject(C.METADATA_SPACE, C[key], value);
}
function execute(vm, name, metadata) {
  const imports = vm.getImports();
  const invoke = imports.invoke_system_call;
  imports.invoke_system_call = (id, rp, rl, ap, al, size) => {
    if (id !== 112) return invoke(id, rp, rl, ap, al, size);
    // SDK 1.0's VM predates syscall 112. Model only its wire response;
    // metadata hash/flag validation still executes inside the real guard.
    new Uint8Array(vm.memory.buffer, rp, rl).set(metadata);
    new DataView(vm.memory.buffer).setUint32(size, metadata.length, true);
    return 0;
  };
  const module = new WebAssembly.Module(
    fs.readFileSync(path.join(__dirname, "../build", name + ".wasm")),
  );
  const instance = new WebAssembly.Instance(module, { env: imports });
  vm.setInstance(instance);
  vm.db.commitTransaction();
  try {
    instance.exports._start();
    assert.fail("Contract must exit through Koinos");
  } catch (e) {
    if (e.code !== 0) throw e;
  }
}
function entry(vm, value) {
  put(
    vm,
    "ENTRY_POINT_KEY",
    koinos.chain.value_type.encode({ int32_value: value }).finish(),
  );
}

test("shipped app initializes with a real bootstrap signature and reads back its persisted configuration", async () => {
  const vm = new MockVM(true);
  const fixture = fs.readFileSync(
    path.join(__dirname, "../assembly/__tests__/bootstrap-fixture.ts"),
    "utf8",
  );
  const value = (name) => fixture.match(new RegExp(name + ' = "([^"]+)"'))[1];
  put(vm, "CONTRACT_ID_KEY", utils.decodeBase58(contract));
  put(
    vm,
    "TRANSACTION_KEY",
    koinos.protocol.transaction
      .encode({
        id: Buffer.from(value("bootstrapTransactionId"), "base64"),
        signatures: [Buffer.from(value("bootstrapSignature"), "base64")],
      })
      .finish(),
  );
  entry(vm, abi.methods.initialize.entry_point);
  put(
    vm,
    "CONTRACT_ARGUMENTS_KEY",
    await serializer.serialize(
      {
        account: bytes(owner),
        title: "Runtime test",
        release_hash: utils.encodeBase64url(Buffer.alloc(32, 1)),
      },
      "app.Request",
    ),
  );
  execute(vm, "contract");
  entry(vm, abi.methods.get_config.entry_point);
  put(vm, "CONTRACT_ARGUMENTS_KEY", Buffer.alloc(0));
  execute(vm, "contract");
  const result = await serializer.deserialize(
    vm.db.getObject(C.METADATA_SPACE, C.CONTRACT_RESULT_KEY).value,
    "app.Result",
  );
  assert.equal(result.config.title, "Runtime test");
  assert.equal(result.config.owner, bytes(owner));
  assert.equal(result.config.revision, "1");
});

test("shipped guard accepts the app bytes and rejects a replaced contract", async () => {
  for (const valid of [true, false]) {
    const vm = new MockVM(true);
    entry(vm, 1);
    put(
      vm,
      "CONTRACT_ARGUMENTS_KEY",
      await serializer.serialize(
        { contract_id: bytes(contract) },
        "app.MetadataArgs",
      ),
    );
    const hash = Buffer.from(wasmHash("contract").slice(2), "hex");
    if (!valid) hash[5] ^= 1;
    const metadata = await serializer.serialize(
      {
        value: {
          hash: utils.encodeBase64url(hash),
          authorizes_call_contract: true,
          authorizes_transaction_application: true,
          authorizes_upload_contract: true,
        },
      },
      "app.MetadataResult",
    );
    if (valid) execute(vm, "guard", metadata);
    else
      assert.throws(
        () => execute(vm, "guard", metadata),
        /App code or authority changed/,
      );
  }
});
