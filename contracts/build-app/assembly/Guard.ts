import { System, Protobuf } from "@koinos/sdk-as";
import { env } from "../node_modules/@koinos/sdk-as/assembly/env/index";
import { app as A } from "./proto/app";
import { equal } from "./App";
import * as E from "./entries";
import { appHash } from "./guard-hash";
export function verifiedMetadata(meta: A.Metadata | null): bool {
  if (
    meta === null ||
    meta!.hash === null ||
    !meta!.authorizes_call_contract ||
    !meta!.authorizes_transaction_application ||
    !meta!.authorizes_upload_contract ||
    meta!.system
  )
    return false;
  const expected = appHash(),
    actual = meta!.hash!;
  if (actual.length != expected.length) return false;
  for (let i = 0; i < actual.length; i++)
    if (actual[i] != expected[i]) return false;
  return true;
}
export function verifyTemplate(id: Uint8Array): void {
  System.require(id.length == 25, "Invalid app address");
  const args = Protobuf.encode(new A.MetadataArgs(id), A.MetadataArgs.encode),
    result = new Uint8Array(512),
    size = new Uint32Array(1);
  // Pinned from koinos/koinos-proto koinos/chain/system_call_ids.proto.
  const status = env.invokeSystemCall(
    112,
    result.dataStart as u32,
    512,
    args.dataStart as u32,
    args.length,
    size.dataStart as u32,
  );
  System.require(
    status == 0 && size[0] > 0 && size[0] <= 512,
    "Cannot verify app code",
  );
  const metadata = Protobuf.decode<A.MetadataResult>(
    result,
    A.MetadataResult.decode,
    size[0],
  );
  System.require(
    verifiedMetadata(metadata.value),
    "App code or authority changed; platform signature refused",
  );
}

export function verifyOwner(
  id: Uint8Array,
  owner: Uint8Array | null,
  pending: Uint8Array | null,
): void {
  if (
    (owner === null || owner!.length == 0) &&
    (pending === null || pending!.length == 0)
  )
    return;
  const result = System.call(
    id,
    E.get_config,
    Protobuf.encode(new A.Request(), A.Request.encode),
  );
  System.require(
    result.code == 0 && result.res.object !== null,
    "Cannot verify app owner",
  );
  const config = Protobuf.decode<A.Result>(
    result.res.object!,
    A.Result.decode,
  ).config;
  System.require(config !== null, "App is not initialized");
  if (owner !== null && owner!.length > 0)
    System.require(
      equal(config!.owner, owner),
      "App ownership changed before signing action",
    );
  if (pending !== null && pending!.length > 0)
    System.require(
      equal(config!.pending_owner, pending),
      "Ownership recipient changed before acceptance",
    );
}
