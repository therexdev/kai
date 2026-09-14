import { verifiedMetadata } from "../Guard";
import { appHash } from "../guard-hash";
import { app as A } from "../proto/app";
function meta(): A.Metadata {
  const m = new A.Metadata();
  m.hash = appHash();
  m.authorizes_call_contract = true;
  m.authorizes_transaction_application = true;
  m.authorizes_upload_contract = true;
  return m;
}
describe("Immutable template guard", () => {
  it("accepts only the pinned bytecode with all authority overrides", () => {
    expect(verifiedMetadata(meta())).toBe(true);
  });
  it("rejects replacement bytecode and missing contracts", () => {
    const m = meta();
    m.hash![4] ^= 1;
    expect(verifiedMetadata(m)).toBe(false);
    expect(verifiedMetadata(null)).toBe(false);
  });
  it("rejects changes to each authority flag and system status", () => {
    let m = meta();
    m.authorizes_call_contract = false;
    expect(verifiedMetadata(m)).toBe(false);
    m = meta();
    m.authorizes_transaction_application = false;
    expect(verifiedMetadata(m)).toBe(false);
    m = meta();
    m.authorizes_upload_contract = false;
    expect(verifiedMetadata(m)).toBe(false);
    m = meta();
    m.system = true;
    expect(verifiedMetadata(m)).toBe(false);
  });
});

import { verifyOwner } from "../Guard";
import { MockVM, Protobuf, system_calls, chain } from "@koinos/sdk-as";
function wallet(v: u8): Uint8Array {
  const a = new Uint8Array(25);
  a.fill(v);
  return a;
}
function response(): void {
  MockVM.reset();
  MockVM.setContractId(wallet(1));
  const c = new A.Config();
  c.owner = wallet(2);
  c.pending_owner = wallet(3);
  const r = new A.Result();
  r.config = c;
  MockVM.setCallContractResults([
    new system_calls.exit_arguments(
      0,
      new chain.result(Protobuf.encode(r, A.Result.encode)),
    ),
  ]);
}
describe("Guard owner race protection", () => {
  it("accepts the current owner and pending recipient", () => {
    response();
    verifyOwner(wallet(4), wallet(2), wallet(3));
  });
  it("rejects a release if ownership changed before execution", () => {
    expect(() => {
      response();
      verifyOwner(wallet(4), wallet(9), null);
    }).toThrow();
  });
  it("rejects acceptance if the pending recipient changed", () => {
    expect(() => {
      response();
      verifyOwner(wallet(4), null, wallet(9));
    }).toThrow();
  });
});
