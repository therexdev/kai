import { Writer, Reader } from "as-proto";

export namespace app {
  export class Config {
    static encode(message: Config, writer: Writer): void {
      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_owner);
      }

      const unique_name_pending_owner = message.pending_owner;
      if (unique_name_pending_owner !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_pending_owner);
      }

      const unique_name_title = message.title;
      if (unique_name_title !== null) {
        writer.uint32(26);
        writer.string(unique_name_title);
      }

      if (message.count != 0) {
        writer.uint32(32);
        writer.uint32(message.count);
      }

      if (message.revision != 0) {
        writer.uint32(40);
        writer.uint64(message.revision);
      }

      const unique_name_release_hash = message.release_hash;
      if (unique_name_release_hash !== null) {
        writer.uint32(50);
        writer.bytes(unique_name_release_hash);
      }
    }

    static decode(reader: Reader, length: i32): Config {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Config();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.owner = reader.bytes();
            break;

          case 2:
            message.pending_owner = reader.bytes();
            break;

          case 3:
            message.title = reader.string();
            break;

          case 4:
            message.count = reader.uint32();
            break;

          case 5:
            message.revision = reader.uint64();
            break;

          case 6:
            message.release_hash = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    owner: Uint8Array | null;
    pending_owner: Uint8Array | null;
    title: string | null;
    count: u32;
    revision: u64;
    release_hash: Uint8Array | null;

    constructor(
      owner: Uint8Array | null = null,
      pending_owner: Uint8Array | null = null,
      title: string | null = null,
      count: u32 = 0,
      revision: u64 = 0,
      release_hash: Uint8Array | null = null
    ) {
      this.owner = owner;
      this.pending_owner = pending_owner;
      this.title = title;
      this.count = count;
      this.revision = revision;
      this.release_hash = release_hash;
    }
  }

  export class Record {
    static encode(message: Record, writer: Writer): void {
      if (message.id != 0) {
        writer.uint32(8);
        writer.uint32(message.id);
      }

      const unique_name_author = message.author;
      if (unique_name_author !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_author);
      }

      const unique_name_title = message.title;
      if (unique_name_title !== null) {
        writer.uint32(26);
        writer.string(unique_name_title);
      }

      const unique_name_body = message.body;
      if (unique_name_body !== null) {
        writer.uint32(34);
        writer.string(unique_name_body);
      }

      const unique_name_options = message.options;
      if (unique_name_options.length !== 0) {
        for (let i = 0; i < unique_name_options.length; ++i) {
          writer.uint32(42);
          writer.string(unique_name_options[i]);
        }
      }

      const unique_name_votes = message.votes;
      if (unique_name_votes.length !== 0) {
        for (let i = 0; i < unique_name_votes.length; ++i) {
          writer.uint32(48);
          writer.uint32(unique_name_votes[i]);
        }
      }

      if (message.closed != false) {
        writer.uint32(56);
        writer.bool(message.closed);
      }
    }

    static decode(reader: Reader, length: i32): Record {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Record();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.id = reader.uint32();
            break;

          case 2:
            message.author = reader.bytes();
            break;

          case 3:
            message.title = reader.string();
            break;

          case 4:
            message.body = reader.string();
            break;

          case 5:
            message.options.push(reader.string());
            break;

          case 6:
            message.votes.push(reader.uint32());
            break;

          case 7:
            message.closed = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    id: u32;
    author: Uint8Array | null;
    title: string | null;
    body: string | null;
    options: Array<string>;
    votes: Array<u32>;
    closed: bool;

    constructor(
      id: u32 = 0,
      author: Uint8Array | null = null,
      title: string | null = null,
      body: string | null = null,
      options: Array<string> = [],
      votes: Array<u32> = [],
      closed: bool = false
    ) {
      this.id = id;
      this.author = author;
      this.title = title;
      this.body = body;
      this.options = options;
      this.votes = votes;
      this.closed = closed;
    }
  }

  @unmanaged
  export class Ballot {
    static encode(message: Ballot, writer: Writer): void {
      if (message.voted != false) {
        writer.uint32(8);
        writer.bool(message.voted);
      }
    }

    static decode(reader: Reader, length: i32): Ballot {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Ballot();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.voted = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    voted: bool;

    constructor(voted: bool = false) {
      this.voted = voted;
    }
  }

  export class Request {
    static encode(message: Request, writer: Writer): void {
      const unique_name_account = message.account;
      if (unique_name_account !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_account);
      }

      const unique_name_title = message.title;
      if (unique_name_title !== null) {
        writer.uint32(18);
        writer.string(unique_name_title);
      }

      const unique_name_body = message.body;
      if (unique_name_body !== null) {
        writer.uint32(26);
        writer.string(unique_name_body);
      }

      const unique_name_options = message.options;
      if (unique_name_options.length !== 0) {
        for (let i = 0; i < unique_name_options.length; ++i) {
          writer.uint32(34);
          writer.string(unique_name_options[i]);
        }
      }

      if (message.id != 0) {
        writer.uint32(40);
        writer.uint32(message.id);
      }

      if (message.choice != 0) {
        writer.uint32(48);
        writer.uint32(message.choice);
      }

      if (message.offset != 0) {
        writer.uint32(56);
        writer.uint32(message.offset);
      }

      const unique_name_release_hash = message.release_hash;
      if (unique_name_release_hash !== null) {
        writer.uint32(66);
        writer.bytes(unique_name_release_hash);
      }
    }

    static decode(reader: Reader, length: i32): Request {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Request();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.account = reader.bytes();
            break;

          case 2:
            message.title = reader.string();
            break;

          case 3:
            message.body = reader.string();
            break;

          case 4:
            message.options.push(reader.string());
            break;

          case 5:
            message.id = reader.uint32();
            break;

          case 6:
            message.choice = reader.uint32();
            break;

          case 7:
            message.offset = reader.uint32();
            break;

          case 8:
            message.release_hash = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    account: Uint8Array | null;
    title: string | null;
    body: string | null;
    options: Array<string>;
    id: u32;
    choice: u32;
    offset: u32;
    release_hash: Uint8Array | null;

    constructor(
      account: Uint8Array | null = null,
      title: string | null = null,
      body: string | null = null,
      options: Array<string> = [],
      id: u32 = 0,
      choice: u32 = 0,
      offset: u32 = 0,
      release_hash: Uint8Array | null = null
    ) {
      this.account = account;
      this.title = title;
      this.body = body;
      this.options = options;
      this.id = id;
      this.choice = choice;
      this.offset = offset;
      this.release_hash = release_hash;
    }
  }

  export class Result {
    static encode(message: Result, writer: Writer): void {
      const unique_name_config = message.config;
      if (unique_name_config !== null) {
        writer.uint32(10);
        writer.fork();
        Config.encode(unique_name_config, writer);
        writer.ldelim();
      }

      const unique_name_records = message.records;
      for (let i = 0; i < unique_name_records.length; ++i) {
        writer.uint32(18);
        writer.fork();
        Record.encode(unique_name_records[i], writer);
        writer.ldelim();
      }

      const unique_name_record = message.record;
      if (unique_name_record !== null) {
        writer.uint32(26);
        writer.fork();
        Record.encode(unique_name_record, writer);
        writer.ldelim();
      }

      if (message.ok != false) {
        writer.uint32(32);
        writer.bool(message.ok);
      }
    }

    static decode(reader: Reader, length: i32): Result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.config = Config.decode(reader, reader.uint32());
            break;

          case 2:
            message.records.push(Record.decode(reader, reader.uint32()));
            break;

          case 3:
            message.record = Record.decode(reader, reader.uint32());
            break;

          case 4:
            message.ok = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    config: Config | null;
    records: Array<Record>;
    record: Record | null;
    ok: bool;

    constructor(
      config: Config | null = null,
      records: Array<Record> = [],
      record: Record | null = null,
      ok: bool = false
    ) {
      this.config = config;
      this.records = records;
      this.record = record;
      this.ok = ok;
    }
  }

  export class MetadataArgs {
    static encode(message: MetadataArgs, writer: Writer): void {
      const unique_name_contract_id = message.contract_id;
      if (unique_name_contract_id !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_contract_id);
      }

      const unique_name_expected_owner = message.expected_owner;
      if (unique_name_expected_owner !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_expected_owner);
      }

      const unique_name_expected_pending_owner = message.expected_pending_owner;
      if (unique_name_expected_pending_owner !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_expected_pending_owner);
      }
    }

    static decode(reader: Reader, length: i32): MetadataArgs {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new MetadataArgs();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.contract_id = reader.bytes();
            break;

          case 2:
            message.expected_owner = reader.bytes();
            break;

          case 3:
            message.expected_pending_owner = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    contract_id: Uint8Array | null;
    expected_owner: Uint8Array | null;
    expected_pending_owner: Uint8Array | null;

    constructor(
      contract_id: Uint8Array | null = null,
      expected_owner: Uint8Array | null = null,
      expected_pending_owner: Uint8Array | null = null
    ) {
      this.contract_id = contract_id;
      this.expected_owner = expected_owner;
      this.expected_pending_owner = expected_pending_owner;
    }
  }

  export class Metadata {
    static encode(message: Metadata, writer: Writer): void {
      const unique_name_hash = message.hash;
      if (unique_name_hash !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_hash);
      }

      if (message.system != false) {
        writer.uint32(16);
        writer.bool(message.system);
      }

      if (message.authorizes_call_contract != false) {
        writer.uint32(24);
        writer.bool(message.authorizes_call_contract);
      }

      if (message.authorizes_transaction_application != false) {
        writer.uint32(32);
        writer.bool(message.authorizes_transaction_application);
      }

      if (message.authorizes_upload_contract != false) {
        writer.uint32(40);
        writer.bool(message.authorizes_upload_contract);
      }
    }

    static decode(reader: Reader, length: i32): Metadata {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Metadata();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.hash = reader.bytes();
            break;

          case 2:
            message.system = reader.bool();
            break;

          case 3:
            message.authorizes_call_contract = reader.bool();
            break;

          case 4:
            message.authorizes_transaction_application = reader.bool();
            break;

          case 5:
            message.authorizes_upload_contract = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    hash: Uint8Array | null;
    system: bool;
    authorizes_call_contract: bool;
    authorizes_transaction_application: bool;
    authorizes_upload_contract: bool;

    constructor(
      hash: Uint8Array | null = null,
      system: bool = false,
      authorizes_call_contract: bool = false,
      authorizes_transaction_application: bool = false,
      authorizes_upload_contract: bool = false
    ) {
      this.hash = hash;
      this.system = system;
      this.authorizes_call_contract = authorizes_call_contract;
      this.authorizes_transaction_application =
        authorizes_transaction_application;
      this.authorizes_upload_contract = authorizes_upload_contract;
    }
  }

  export class MetadataResult {
    static encode(message: MetadataResult, writer: Writer): void {
      const unique_name_value = message.value;
      if (unique_name_value !== null) {
        writer.uint32(10);
        writer.fork();
        Metadata.encode(unique_name_value, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): MetadataResult {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new MetadataResult();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = Metadata.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: Metadata | null;

    constructor(value: Metadata | null = null) {
      this.value = value;
    }
  }
}
