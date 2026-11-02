import { System, Protobuf } from "@koinos/sdk-as";
import { Counter } from "./Counter";
import { counter } from "./proto/counter";
import * as entry from "./entries";

export function main(): i32 {
  const args = System.getArguments();
  const contract = new Counter();
  System.require(args.args.length == 0, "This method takes no arguments");
  let result = new counter.State();
  if (args.entry_point == entry.get_count) result = contract.get_count();
  else if (args.entry_point == entry.increment) result = contract.increment();
  else System.fail("Unknown entry point");
  System.exit(0, Protobuf.encode(result, counter.State.encode));
  return 0;
}
// Koinos invokes the module start function.
main();
