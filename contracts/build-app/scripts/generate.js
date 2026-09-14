"use strict";
const fs = require("fs"),
  cp = require("child_process"),
  pb = require("protobufjs"),
  crypto = require("crypto");
const desc = require("protobufjs/ext/descriptor"),
  google = require("google-protobuf/google/protobuf/descriptor_pb"),
  plugin = require("google-protobuf/google/protobuf/compiler/plugin_pb");
const root = pb
    .parse(fs.readFileSync("assembly/proto/app.proto", "utf8"), {
      keepCase: true,
    })
    .root.resolveAll(),
  descriptor = root.toDescriptor("proto3"),
  request = new plugin.CodeGeneratorRequest();
for (const file of descriptor.file) {
  file.name = "assembly/proto/app.proto";
  for (const m of file.messageType)
    for (const f of m.field)
      if (f.typeName && !f.typeName.startsWith("."))
        f.typeName = "." + file.package + "." + f.typeName;
  request.addProtoFile(
    google.FileDescriptorProto.deserializeBinary(
      desc.FileDescriptorProto.encode(file).finish(),
    ),
  );
}
request.setFileToGenerateList(["assembly/proto/app.proto"]);
const result = cp.spawnSync(
  process.execPath,
  [require.resolve("@koinos/as-proto-gen/lib/index")],
  { input: Buffer.from(request.serializeBinary()), maxBuffer: 4 * 1024 * 1024 },
);
if (result.status !== 0) throw Error(result.stderr.toString());
const response = plugin.CodeGeneratorResponse.deserializeBinary(result.stdout);
if (response.getError()) throw Error(response.getError());
for (const file of response.getFileList())
  fs.writeFileSync(file.getName(), file.getContent());
const methods = [
  "initialize",
  "get_config",
  "list_records",
  "get_record",
  "create_record",
  "edit_record",
  "vote",
  "close_poll",
  "set_release",
  "propose_owner",
  "accept_owner",
];
const entries = Object.fromEntries(
  methods.map((name) => [
    name,
    parseInt(
      crypto.createHash("sha256").update(name).digest("hex").slice(0, 8),
      16,
    ),
  ]),
);
fs.writeFileSync(
  "assembly/entries.ts",
  Object.entries(entries)
    .map(([k, v]) => `export const ${k}: u32 = ${v};`)
    .join("\n") + "\n",
);
fs.mkdirSync("build", { recursive: true });
const abi = {
  methods: Object.fromEntries(
    methods.map((name) => [
      name,
      {
        argument: "app.Request",
        return: "app.Result",
        entry_point: entries[name],
        read_only: ["get_config", "list_records", "get_record"].includes(name),
      },
    ]),
  ),
  koilib_types: root.toJSON(),
  types: Buffer.from(
    desc.FileDescriptorSet.encode(descriptor).finish(),
  ).toString("base64"),
};
fs.writeFileSync("build/contract.abi.json", JSON.stringify(abi, null, 2));
