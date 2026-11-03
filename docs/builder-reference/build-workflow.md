# Koinos build and test workflow

The IDE edits actual source. `validate_project` performs static checks only.
`read_capabilities` reports whether the isolated worker is configured. If it is,
`run_project` compiles or tests the current working source, including a pending
proposal. A report is tied to the SHA-256 of all project files, a target and the
immutable toolchain image. A later edit makes that report stale. Read real errors,
repair them, and run the affected target again. At most two runs per AI request;
the user can run saved versions from Builds & tests.

## Declaring targets

Create `kai.project.json` at the project root. This is data, not an executable
build script. The example below is the counter starter; replace the ABI types,
methods and paths to match the actual contract. Multiple targets are supported.

```json
{
  "schema": 1,
  "targets": [
    {
      "id": "counter",
      "type": "koinos-as",
      "root": "contracts/counter",
      "entry": "assembly/index.ts",
      "protobuf": ["assembly/proto/counter.proto"],
      "entries": "assembly/entries.ts",
      "methods": {
        "get_count": {"argument":"counter.Request","return":"counter.State","read_only":true},
        "increment": {"argument":"counter.Request","return":"counter.State","read_only":false}
      },
      "tests": ["assembly/__tests__/Counter.spec.ts"]
    },
    {"id":"service","type":"node-test","root":"services","tests":["feed.test.cjs"]}
  ]
}
```

All paths are relative to the declared root. Root `.` is supported. Source paths
must exist; the generated entries file need not exist. Up to 24 targets. Protobuf
imports must resolve locally or to standard protobuf definitions. Include every
project schema that needs generated AssemblyScript in `protobuf`. No external
URLs, dependency installation or shell commands. Method entrypoints default to
the first four bytes of SHA-256(method name), big endian; declare `entry_point`
as a uint32 when compatibility requires an existing value. ABI argument/return
types must exist in the protobuf descriptor. Update source dispatch and ABI
together. Existing counter and bundled App projects have inferred targets for
backward compatibility; custom contracts should always use an explicit manifest.

## Fixed toolchain

Profile `koinos-as-1.0.0-node22-v1`: Node 22, @koinos/sdk-as 1.0.0,
the starter's locked AssemblyScript and as-pect 6.2.4 dependencies, protoc,
@koinos/as-proto-gen and @koinos/mock-vm. Build commands, compiler options and
MockVM imports are owned by the runner. It ignores project package scripts,
asconfig, as-pect config, JS test-import hooks and custom transforms. It installs
no requested dependencies. AssemblyScript compilation copies TS/proto source
only. Nonstandard toolchains need a separately reviewed runner profile.

`compile` generates protobuf TS and entries, compiles the target entry to WASM,
and creates its ABI from the descriptor and declared methods. It returns the
WASM and ABI with hashes. `test` on a Koinos target runs declared `.spec.ts`
files through as-pect and MockVM. It does not compile a deployable artifact.
Node targets execute declared `.js`, `.cjs` or `.mjs` tests with `node --test`.
These support pure service logic and integration stubs using built-in Node
modules. They do not start a persistent backend or install npm dependencies.

The isolated job has no network, host mounts, wallet keys or API credentials.
It has a 120-second wall deadline, one CPU, 1 GiB memory and bounded scratch
storage/output. Network integration, live wallets, full chain simulation and
long-running services need distinct environments. A passing test demonstrates
only the assertions present, not security, deployment readiness or real payment.

## SDK reference and larger applications

Read the pinned `system`, `storage`, `token` and `mock-vm` topics for exact public
SDK declarations. AssemblyScript is not JavaScript or general TypeScript.
Start from the real contract entrypoint, protobuf schema and MockVM tests.
Check authorization for mutations, storage-space allocation, bounds and integer
overflow. Test rejected unauthorized calls as well as intended state changes.

For a social application, document a staged design: profile/posts/relationship
contracts; events and paginated reads; an off-chain indexer and feed projection;
frontend and exact-chain wallet integration. Keep separate targets and tests.
Define stable schemas, authorization, upgrade/ownership policy, indexing and
pagination before expanding features. The supplied workspace is a counter and
a pure feed projection example; it is not an implementation of Open Social.

Managed Publish still uses only the unchanged bundled App v1 contract. It never
uploads generated WASM. Custom token purchases need actual token/escrow source,
authorization tests and a separate reviewed deployment/wallet integration.
Custom deployments, randomness services and fund custody are not implemented by
this runner. Do not present a disabled purchase UI as a working on-chain feature.
