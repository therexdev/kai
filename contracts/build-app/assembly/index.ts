import { System, Protobuf, authority } from "@koinos/sdk-as";
import { App } from "./App";
import { app as A } from "./proto/app";
export function main(): i32 {
  // Arguments may be 12 KB; stored records can also exceed the SDK's default
  // 1 KB. This bounds individual argument/storage reads with room for protobuf.
  System.setSystemBufferSize(32 * 1024);
  const args = System.getArguments(),
    c = new App();
  if (args.entry_point == 0x4a2dbd90) {
    const r = Protobuf.decode<authority.authorize_arguments>(
      args.args,
      authority.authorize_arguments.decode,
    );
    System.exit(
      0,
      Protobuf.encode(
        new authority.authorize_result(c.authorize(r.type)),
        authority.authorize_result.encode,
      ),
    );
    return 0;
  }
  System.require(args.args.length <= 12000, "Request too large");
  const r = Protobuf.decode<A.Request>(args.args, A.Request.decode),
    out = c.run(args.entry_point, r);
  System.exit(0, Protobuf.encode(out, A.Result.encode));
  return 0;
}

// Koinos executes the module start function, not an exported `main` by name.
main();
