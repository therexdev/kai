const fs = require("fs"),
  crypto = require("crypto");
const hash = Buffer.concat([
  Buffer.from([0x12, 0x20]),
  crypto
    .createHash("sha256")
    .update(fs.readFileSync("build/contract.wasm"))
    .digest(),
]);
fs.writeFileSync(
  "assembly/guard-hash.ts",
  "// Generated from the compiled app template.\nexport function appHash():Uint8Array {return Uint8Array.wrap(changetype<ArrayBuffer>([" +
    Array.from(hash).join(",") +
    "] as StaticArray<u8>));}\n",
);
