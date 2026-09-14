import {
  System,
  Storage,
  StringBytes,
  authority,
  Crypto,
} from "@koinos/sdk-as";
import { app as A } from "./proto/app";
import * as E from "./entries";
const KEY = StringBytes.stringToBytes("config");
export function equal(a: Uint8Array | null, b: Uint8Array | null): bool {
  if (a === null || b === null) return a === b;
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}
function address(a: Uint8Array | null): Uint8Array {
  System.require(a !== null && a!.length == 25, "Invalid wallet address");
  return a!;
}
function auth(a: Uint8Array): bool {
  return System.checkAuthority(authority.authorization_type.contract_call, a);
}
function key(id: u32): Uint8Array {
  return StringBytes.stringToBytes(id.toString());
}
export class App {
  id: Uint8Array = System.getContractId();
  configs: Storage.Map<Uint8Array, A.Config> = new Storage.Map(
    this.id,
    0,
    A.Config.decode,
    A.Config.encode,
  );
  records: Storage.Map<Uint8Array, A.Record> = new Storage.Map(
    this.id,
    1,
    A.Record.decode,
    A.Record.encode,
  );
  ballots: Storage.Map<Uint8Array, A.Ballot> = new Storage.Map(
    this.id,
    2,
    A.Ballot.decode,
    A.Ballot.encode,
  );
  config(): A.Config {
    const c = this.configs.get(KEY);
    System.require(c !== null, "App is not initialized");
    return c!;
  }
  bootstrap(): bool {
    const tx = System.getTransaction();
    if (tx.id === null) return false;
    for (let i = 0; i < tx.signatures.length; i++) {
      const pub = System.recoverPublicKey(tx.signatures[i], tx.id!);
      if (pub !== null && equal(Crypto.addressFromPublicKey(pub!), this.id))
        return true;
    }
    return false;
  }
  // All three override flags are installed. Once initialized, the bootstrap
  // private key has no authority: only the current on-chain owner does.
  authorize(kind: authority.authorization_type): bool {
    const c = this.configs.get(KEY);
    if (c === null) return this.bootstrap();
    if (
      kind != authority.authorization_type.contract_call &&
      kind != authority.authorization_type.transaction_application &&
      kind != authority.authorization_type.contract_upload
    )
      return false;
    return auth(c!.owner!);
  }
  owner(c: A.Config): void {
    System.require(auth(c.owner!), "Owner approval required");
  }
  run(method: u32, r: A.Request): A.Result {
    const out = new A.Result();
    out.ok = true;
    if (r.title === null) r.title = "";
    if (r.body === null) r.body = "";
    if (method == E.initialize) {
      System.require(
        this.configs.get(KEY) === null && this.bootstrap(),
        "Initialization requires the deployment key",
      );
      const c = new A.Config();
      c.owner = address(r.account);
      System.require(
        !equal(c.owner, this.id),
        "Owner must be a separate wallet",
      );
      System.require(
        r.title!.length > 0 &&
          r.title!.length <= 120 &&
          r.release_hash !== null &&
          r.release_hash!.length == 32,
        "Invalid initial release",
      );
      c.title = r.title;
      c.release_hash = r.release_hash;
      c.revision = 1;
      this.configs.put(KEY, c);
      out.config = c;
      return out;
    }
    const c = this.config();
    if (method == E.get_config) {
      out.config = c;
      return out;
    }
    if (method == E.get_record) {
      out.record = this.records.get(key(r.id));
      return out;
    }
    if (method == E.list_records) {
      for (
        let i = r.offset + 1;
        i <= c.count && i <= r.offset + 20 && i > r.offset;
        i++
      ) {
        const v = this.records.get(key(i));
        if (v !== null) out.records.push(v!);
      }
      out.config = c;
      return out;
    }
    if (method == E.set_release) {
      this.owner(c);
      System.require(
        r.release_hash !== null &&
          r.release_hash!.length == 32 &&
          r.title!.length > 0 &&
          r.title!.length <= 120,
        "Invalid release",
      );
      c.release_hash = r.release_hash;
      c.title = r.title;
      c.revision++;
      this.configs.put(KEY, c);
      out.config = c;
      return out;
    }
    if (method == E.propose_owner) {
      this.owner(c);
      if (r.account === null || r.account!.length == 0) c.pending_owner = null;
      else {
        c.pending_owner = address(r.account);
        System.require(
          !equal(c.pending_owner, this.id) && !equal(c.pending_owner, c.owner),
          "Choose a different wallet",
        );
      }
      this.configs.put(KEY, c);
      out.config = c;
      return out;
    }
    if (method == E.accept_owner) {
      System.require(
        c.pending_owner !== null && auth(c.pending_owner!),
        "New owner must accept with their wallet",
      );
      c.owner = c.pending_owner;
      c.pending_owner = null;
      c.revision++;
      this.configs.put(KEY, c);
      out.config = c;
      return out;
    }
    if (method == E.create_record) {
      const a = address(r.account);
      System.require(auth(a), "Wallet approval required");
      System.require(
        c.count < 10000 &&
          r.title!.length > 0 &&
          r.title!.length <= 160 &&
          r.body!.length <= 4000,
        "Record limit exceeded",
      );
      System.require(
        r.options.length == 0 ||
          (r.options.length >= 2 && r.options.length <= 8),
        "Polls need 2 to 8 options",
      );
      const v = new A.Record();
      v.id = ++c.count;
      v.author = a;
      v.title = r.title;
      v.body = r.body;
      for (let i = 0; i < r.options.length; i++) {
        System.require(
          r.options[i].length > 0 && r.options[i].length <= 120,
          "Invalid option",
        );
        v.options.push(r.options[i]);
        v.votes.push(0);
      }
      this.records.put(key(v.id), v);
      this.configs.put(KEY, c);
      out.record = v;
      return out;
    }
    const saved = this.records.get(key(r.id));
    System.require(saved !== null, "Record not found");
    const v = saved!;
    if (method == E.edit_record) {
      const a = address(r.account);
      System.require(
        (equal(a, v.author) || equal(a, c.owner)) && auth(a),
        "Author or owner approval required",
      );
      System.require(
        v.options.length == 0 &&
          r.title!.length > 0 &&
          r.title!.length <= 160 &&
          r.body!.length <= 4000,
        "Polls cannot be edited; close and replace them",
      );
      v.title = r.title;
      v.body = r.body;
    } else if (method == E.close_poll) {
      const a = address(r.account);
      System.require(
        (equal(a, v.author) || equal(a, c.owner)) && auth(a),
        "Poll author or owner approval required",
      );
      System.require(v.options.length > 0, "Not a poll");
      v.closed = true;
    } else if (method == E.vote) {
      const a = address(r.account);
      System.require(auth(a), "Wallet approval required");
      System.require(
        !v.closed && v.options.length > 0 && r.choice < u32(v.options.length),
        "Invalid or closed poll",
      );
      const suffix = key(r.id),
        ballot = new Uint8Array(a.length + suffix.length);
      ballot.set(a);
      ballot.set(suffix, a.length);
      System.require(
        this.ballots.get(ballot) === null,
        "This wallet already voted",
      );
      const b = new A.Ballot();
      b.voted = true;
      this.ballots.put(ballot, b);
      System.require(v.votes[r.choice] < u32.MAX_VALUE, "Vote limit reached");
      v.votes[r.choice]++;
    } else System.require(false, "Unknown action");
    this.records.put(key(v.id), v);
    out.record = v;
    return out;
  }
}
