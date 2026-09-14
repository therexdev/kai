import { App, equal } from "../App";
import { app as A } from "../proto/app";
import * as E from "../entries";
import {
  MockVM,
  System,
  authority,
  StringBytes,
  protocol,
  Base58,
  Base64,
} from "@koinos/sdk-as";
import {
  bootstrapAddress,
  bootstrapTransactionId,
  bootstrapSignature,
} from "./bootstrap-fixture";
function bytes(n: i32, v: u8): Uint8Array {
  const a = new Uint8Array(n);
  a.fill(v);
  return a;
}
const contract = bytes(25, 1),
  platform = bytes(25, 2),
  creator = bytes(25, 3),
  visitor = bytes(25, 4),
  key = StringBytes.stringToBytes("config");
function setup(): App {
  MockVM.reset();
  MockVM.setContractId(contract);
  const a = new App(),
    c = new A.Config();
  c.owner = platform;
  c.title = "Community";
  c.release_hash = bytes(32, 5);
  c.revision = 1;
  a.configs.put(key, c);
  return a;
}
function allow(address: Uint8Array): void {
  MockVM.setAuthorities([
    new MockVM.MockAuthority(
      authority.authorization_type.contract_call,
      address,
      true,
    ),
  ]);
}
function record(a: App, poll: bool = false): A.Record {
  const r = new A.Request();
  r.account = platform;
  r.title = "A question";
  r.body = "Some detail";
  if (poll) {
    r.options.push("Yes");
    r.options.push("No");
  }
  allow(platform);
  return a.run(E.create_record, r).record!;
}
describe("KAI Build ownership", () => {
  it("initializes from a real bootstrap signature and immediately retires its authority", () => {
    MockVM.reset();
    MockVM.setContractId(Base58.decode(bootstrapAddress));
    const tx = new protocol.transaction();
    tx.id = Base64.decode(bootstrapTransactionId);
    tx.signatures.push(Base64.decode(bootstrapSignature));
    MockVM.setTransaction(tx);
    const a = new App();
    expect(a.bootstrap()).toBe(true);
    expect(a.authorize(authority.authorization_type.contract_call)).toBe(true);
    const r = new A.Request();
    r.account = platform;
    r.title = "New app";
    r.release_hash = bytes(32, 5);
    a.run(E.initialize, r);
    allow(Base58.decode(bootstrapAddress));
    expect(a.authorize(authority.authorization_type.contract_upload)).toBe(
      false,
    );
    allow(platform);
    expect(a.authorize(authority.authorization_type.contract_upload)).toBe(
      true,
    );
  });
  it("rejects another deployment address using the same bootstrap signature", () => {
    MockVM.reset();
    MockVM.setContractId(contract);
    const tx = new protocol.transaction();
    tx.id = Base64.decode(bootstrapTransactionId);
    tx.signatures.push(Base64.decode(bootstrapSignature));
    MockVM.setTransaction(tx);
    expect(new App().bootstrap()).toBe(false);
  });
  it("requires the current owner for every authority override", () => {
    const a = setup();
    allow(platform);
    expect(a.authorize(authority.authorization_type.contract_call)).toBe(true);
    expect(
      a.authorize(authority.authorization_type.transaction_application),
    ).toBe(true);
    expect(a.authorize(authority.authorization_type.contract_upload)).toBe(
      true,
    );
    allow(contract);
    expect(a.authorize(authority.authorization_type.contract_upload)).toBe(
      false,
    );
  });
  it("keeps ownership with the platform until the recipient accepts", () => {
    const a = setup(),
      r = new A.Request();
    r.account = creator;
    allow(platform);
    a.run(E.propose_owner, r);
    expect(equal(a.config().owner, platform)).toBe(true);
    expect(equal(a.config().pending_owner, creator)).toBe(true);
  });
  it("refuses takeover by an unrelated wallet", () => {
    expect(() => {
      const a = setup(),
        r = new A.Request();
      r.account = creator;
      allow(visitor);
      a.run(E.propose_owner, r);
    }).toThrow();
  });
  it("refuses acceptance by the old controller", () => {
    expect(() => {
      const a = setup(),
        r = new A.Request();
      r.account = creator;
      allow(platform);
      a.run(E.propose_owner, r);
      a.run(E.accept_owner, new A.Request());
    }).toThrow();
  });
  it("removes original controller and deployment-key authority after acceptance", () => {
    const a = setup(),
      r = new A.Request();
    r.account = creator;
    allow(platform);
    a.run(E.propose_owner, r);
    allow(creator);
    a.run(E.accept_owner, new A.Request());
    expect(equal(a.config().owner, creator)).toBe(true);
    expect(a.config().pending_owner).toBeNull();
    for (let k = 0; k < 3; k++) {
      allow(platform);
      expect(a.authorize(k)).toBe(false);
      allow(contract);
      expect(a.authorize(k)).toBe(false);
      allow(creator);
      expect(a.authorize(k)).toBe(true);
    }
  });
  it("prevents the former owner from changing a frontend release", () => {
    expect(() => {
      const a = setup(),
        r = new A.Request();
      r.account = creator;
      allow(platform);
      a.run(E.propose_owner, r);
      allow(creator);
      a.run(E.accept_owner, new A.Request());
      allow(platform);
      r.title = "Stolen release";
      r.release_hash = bytes(32, 6);
      a.run(E.set_release, r);
    }).toThrow();
  });
  it("preserves data when the owner changes or publishes a release", () => {
    const a = setup();
    record(a);
    const r = new A.Request();
    r.account = creator;
    allow(platform);
    a.run(E.propose_owner, r);
    allow(creator);
    a.run(E.accept_owner, new A.Request());
    r.title = "New frontend";
    r.release_hash = bytes(32, 6);
    a.run(E.set_release, r);
    expect(a.config().count).toBe(1);
    const q = new A.Request();
    q.id = 1;
    expect(a.run(E.get_record, q).record!.title).toStrictEqual("A question");
  });
  it("cannot reinitialize an existing app", () => {
    expect(() => {
      const a = setup(),
        r = new A.Request();
      r.account = visitor;
      a.run(E.initialize, r);
    }).toThrow();
  });
  it("rejects self-ownership to avoid recursive authority", () => {
    expect(() => {
      const a = setup(),
        r = new A.Request();
      r.account = contract;
      allow(platform);
      a.run(E.propose_owner, r);
    }).toThrow();
  });
  it("lets an owner cancel a pending transfer", () => {
    const a = setup(),
      r = new A.Request();
    r.account = creator;
    allow(platform);
    a.run(E.propose_owner, r);
    a.run(E.propose_owner, new A.Request());
    expect(a.config().pending_owner).toBeNull();
  });
});
describe("KAI Build app data", () => {
  it("records one vote per wallet and retains totals", () => {
    const a = setup();
    record(a, true);
    allow(visitor);
    const r = new A.Request();
    r.id = 1;
    r.account = visitor;
    r.choice = 1;
    const out = a.run(E.vote, r);
    expect(out.record!.votes[1]).toBe(1);
    expect(out.record!.votes[0]).toBe(0);
  });
  it("rejects a repeated vote", () => {
    expect(() => {
      const a = setup();
      record(a, true);
      allow(visitor);
      const r = new A.Request();
      r.id = 1;
      r.account = visitor;
      a.run(E.vote, r);
      a.run(E.vote, r);
    }).toThrow();
  });
  it("rejects unsigned votes", () => {
    expect(() => {
      const a = setup();
      record(a, true);
      allow(platform);
      const r = new A.Request();
      r.id = 1;
      r.account = visitor;
      a.run(E.vote, r);
    }).toThrow();
  });
  it("rejects votes after a poll closes", () => {
    expect(() => {
      const a = setup();
      record(a, true);
      const r = new A.Request();
      r.id = 1;
      r.account = platform;
      allow(platform);
      a.run(E.close_poll, r);
      allow(visitor);
      r.account = visitor;
      a.run(E.vote, r);
    }).toThrow();
  });
  it("lets signed community members create and close their own polls", () => {
    const a = setup(),
      r = new A.Request();
    r.account = visitor;
    r.title = "Our poll";
    r.options.push("A");
    r.options.push("B");
    allow(visitor);
    const poll = a.run(E.create_record, r).record!;
    r.id = poll.id;
    expect(a.run(E.close_poll, r).record!.closed).toBe(true);
  });
  it("rejects closing another wallet's poll", () => {
    expect(() => {
      const a = setup();
      record(a, true);
      const r = new A.Request();
      r.id = 1;
      r.account = visitor;
      allow(visitor);
      a.run(E.close_poll, r);
    }).toThrow();
  });
  it("allows signed public posts and their author's edits", () => {
    const a = setup(),
      r = new A.Request();
    r.account = visitor;
    r.title = "Hello";
    allow(visitor);
    a.run(E.create_record, r);
    r.id = 1;
    r.title = "Edited";
    expect(a.run(E.edit_record, r).record!.title).toStrictEqual("Edited");
  });
  it("rejects editing another person's post", () => {
    expect(() => {
      const a = setup();
      record(a);
      const r = new A.Request();
      r.id = 1;
      r.account = visitor;
      r.title = "Changed";
      allow(visitor);
      a.run(E.edit_record, r);
    }).toThrow();
  });
  it("rejects empty titles and excessively large bodies", () => {
    expect(() => {
      const a = setup(),
        r = new A.Request();
      r.account = visitor;
      allow(visitor);
      a.run(E.create_record, r);
    }).toThrow();
    expect(() => {
      const a = setup(),
        r = new A.Request();
      r.account = visitor;
      r.title = "Hello";
      r.body = "a".repeat(4001);
      allow(visitor);
      a.run(E.create_record, r);
    }).toThrow();
  });
  it("paginates records and handles extreme offsets", () => {
    const a = setup();
    for (let i = 0; i < 25; i++) record(a);
    const r = new A.Request();
    expect(a.run(E.list_records, r).records.length).toBe(20);
    r.offset = 20;
    expect(a.run(E.list_records, r).records.length).toBe(5);
    r.offset = u32.MAX_VALUE;
    expect(a.run(E.list_records, r).records.length).toBe(0);
  });
});
