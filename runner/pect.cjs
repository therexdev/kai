"use strict";
const fs = require("node:fs");
const { MockVM } = require("@koinos/mock-vm");
module.exports = {
  include: JSON.parse(fs.readFileSync("/tmp/kai-test-list.json", "utf8")),
  add: ["assembly/__tests__/**/*.include.ts"],
  flags: { "--runtime": ["incremental"], "--config": ["/opt/toolchain/asconfig.json"] },
  disclude: [/node_modules/],
  outputBinary: false,
  imports(memory, createImports, instantiateSync, binary) {
    const mock = new MockVM();
    const instance = instantiateSync(binary, createImports({ env: mock.getImports(), wasi_snapshot_preview1: { fd_write() {}, proc_exit() {} } }));
    instance.exports.memory.grow(512);
    mock.setInstance(instance);
    return instance;
  },
};
