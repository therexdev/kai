import { System, Protobuf, authority } from "@koinos/sdk-as";
import { app as A } from "./proto/app";
import { verifyTemplate, verifyOwner } from "./Guard";
export function main(): i32 {
  const args = System.getArguments();
  if (args.entry_point == 0x4a2dbd90) {
    System.exit(
      0,
      Protobuf.encode(
        new authority.authorize_result(false),
        authority.authorize_result.encode,
      ),
    );
    return 0;
  }
  System.require(args.entry_point == 1, "Unknown guard action");
  const r = Protobuf.decode<A.MetadataArgs>(args.args, A.MetadataArgs.decode);
  System.require(r.contract_id !== null, "App address required");
  verifyTemplate(r.contract_id!);
  verifyOwner(r.contract_id!, r.expected_owner, r.expected_pending_owner);
  System.exit(0);
  return 0;
}
