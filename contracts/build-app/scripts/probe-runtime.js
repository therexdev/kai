"use strict";
// Execute the shipped bytes through _start with the SDK VM, not App.run().
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path");
const { MockVM } = require("@koinos/mock-vm");
const C = require("@koinos/mock-vm/src/constants");
const { koinos } = require("@koinos/proto-js");
const { Serializer, utils, Signer, Transaction } = require("koilib");
const {
  abi,
  bytes,
  wasmHash,
  BuildChain,
  guardOperation,
} = require("../../../lib/builder/chain");
const serializer = new Serializer(abi.koilib_types);
const nativeSerializer = new Serializer(require("@koinos/proto-js/index.json"));
const bootstrap = Signer.fromSeed("public runtime bootstrap fixture");
const platform = Signer.fromSeed("public runtime platform fixture");
const guard = Signer.fromSeed("public runtime guard fixture");
const contract = bootstrap.getAddress(),
  owner = platform.getAddress();
function put(vm, key, value) {
  vm.db.putObject(C.METADATA_SPACE, C[key], value);
}
function execute(vm, name, metadata, wasm) {
  const imports = vm.getImports();
  const invoke = imports.invoke_system_call;
  imports.invoke_system_call = (id, rp, rl, ap, al, size) => {
    if (id !== 112) {
      const code = invoke(id, rp, rl, ap, al, size);
      // MockVM's Buffer.copy silently truncates oversized responses. The real
      // chain rejects them; enforce that boundary before WASM can read them.
      const actual = new DataView(vm.memory.buffer).getUint32(size, true);
      if (actual > rl)
        throw Error(
          "return buffer is not large enough for the return value (syscall " +
            id +
            ", " +
            actual +
            " > " +
            rl +
            ")",
        );
      return code;
    }
    // SDK 1.0's VM predates syscall 112. Model only its wire response;
    // metadata hash/flag validation still executes inside the real guard.
    new Uint8Array(vm.memory.buffer, rp, rl).set(metadata);
    new DataView(vm.memory.buffer).setUint32(size, metadata.length, true);
    return 0;
  };
  const module = new WebAssembly.Module(
    wasm || fs.readFileSync(path.join(__dirname, "../build", name + ".wasm")),
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

async function deployment(includeBootstrap = true) {
  const vm = new MockVM(true);
  const chain = new BuildChain();
  const init = await chain.operation(contract, "initialize", {
    account: bytes(owner),
    title: "Runtime test",
    release_hash: utils.encodeBase64url(Buffer.alloc(32, 1)),
  });
  const tx = await Transaction.prepareTransaction({
    header: {
      chain_id: chain.config.chainId,
      payer: owner,
      nonce: "KAE=",
      rc_limit: "2000000000",
    },
    operations: [
      {
        upload_contract: {
          contract_id: guard.getAddress(),
          bytecode: utils.encodeBase64url(
            fs.readFileSync(path.join(__dirname, "../build/guard.wasm")),
          ),
          authorizes_upload_contract: true,
        },
      },
      {
        upload_contract: {
          contract_id: contract,
          bytecode: utils.encodeBase64url(
            fs.readFileSync(path.join(__dirname, "../build/contract.wasm")),
          ),
          abi: JSON.stringify(abi),
          authorizes_call_contract: true,
          authorizes_transaction_application: true,
          authorizes_upload_contract: true,
        },
      },
      guardOperation(contract, guard.getAddress()),
      init,
    ],
  });
  for (const signer of includeBootstrap
    ? [guard, bootstrap, platform]
    : [guard, platform])
    await signer.signTransaction(tx);
  const encoded = await nativeSerializer.serialize(
    tx,
    "koinos.protocol.transaction",
  );
  assert.ok(
    encoded.length > 64000,
    "exercise full code uploads and ABI, not a miniature transaction",
  );
  put(vm, "CONTRACT_ID_KEY", utils.decodeBase58(contract));
  put(vm, "TRANSACTION_KEY", encoded);
  entry(vm, abi.methods.initialize.entry_point);
  put(
    vm,
    "CONTRACT_ARGUMENTS_KEY",
    utils.decodeBase64url(init.call_contract.args),
  );
  return vm;
}

test("previous shipped bytes reproduce the exact return-buffer failure with a full signed deployment", async () => {
  const vm = await deployment();
  const old = fs.readFileSync(
    path.join(__dirname, "../../../scripts/fixtures/builder-small-buffer.wasm"),
  );
  assert.throws(
    () => execute(vm, "contract", null, old),
    /return buffer is not large enough.*syscall 102.*> 1024/,
  );
});

test("shipped app initializes from a full signed deployment and reads persisted configuration", async () => {
  const vm = await deployment();
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

test("full deployment still requires the bootstrap signature", async () => {
  const vm = await deployment(false);
  assert.throws(
    () => execute(vm, "contract"),
    /Initialization requires the deployment key/,
  );
});

test("shipped app accepts and reads records above 1 KB and a full result page", async () => {
  const vm = await deployment();
  execute(vm, "contract");
  put(
    vm,
    "AUTHORITY_KEY",
    koinos.chain.list_type
      .encode({
        values: [
          {
            bool_value: true,
            bytes_value: utils.decodeBase58(owner),
            int32_value: koinos.chain.authorization_type.contract_call,
          },
        ],
      })
      .finish(),
  );
  const body = "A".repeat(4000),
    args = await serializer.serialize(
      {
        account: bytes(owner),
        title: "Large record",
        body,
        options: ["Yes", "No"],
      },
      "app.Request",
    );
  assert.ok(args.length > 1024);
  for (let i = 0; i < 20; i++) {
    entry(vm, abi.methods.create_record.entry_point);
    put(vm, "CONTRACT_ARGUMENTS_KEY", args);
    execute(vm, "contract");
  }
  entry(vm, abi.methods.list_records.entry_point);
  put(vm, "CONTRACT_ARGUMENTS_KEY", Buffer.alloc(0));
  execute(vm, "contract");
  const raw = vm.db.getObject(C.METADATA_SPACE, C.CONTRACT_RESULT_KEY).value;
  assert.ok(raw.length > 80000);
  const result = await serializer.deserialize(raw, "app.Result");
  assert.equal(result.records.length, 20);
  assert.ok(result.records.every((r) => r.body === body));
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
