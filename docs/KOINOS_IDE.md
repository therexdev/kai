# Build on Koinos: AI-assisted IDE

The product stays at `/build`, inside Koinos AI. A guided dApp launch is one
workflow inside the IDE. The development workflow is:

**Create contract → edit and review → compile → test locally → deploy to testnet
→ refine → explicitly launch on mainnet.**

The web workspace coordinates projects, source, AI assistance and development
jobs. KAI Core integration should use documented shared service APIs for models,
permissions, controlled execution and signing. Feature UI, templates and workflow
logic belong to Build Koinos; this change does not add them to Core or depend on
a desktop installation.

## Implemented in this foundation

- A new `contract` project type with nested source files, a file explorer, filter,
  create/rename/delete, line numbers, indentation and save shortcut.
- An AssemblyScript counter starter with protobuf schema, explicit Koinos
  entrypoint, pinned dependencies, local build scripts and MockVM tests. It is a
  public counter; it does not hold funds or provide an ownership-transfer system.
- Durable AI proposals, side-by-side saved/proposed source, apply/discard, and
  revision conflict detection. Custom contract changes always require review.
  The web chat also requests review for managed frontend edits. Legacy API
  callers can still request automatic managed-frontend edits.
- Saved versions, restoration, source ZIP export and project JSON import. Import
  creates a new project and does not claim an existing deployment.
- Source diagnostics (paths, size, file count, JSON format) and the existing
  frontend preview error observations, displayed separately from compilation.
- An account-scoped API using the existing session and origin/CSRF gates.

A contract workspace can save incomplete source while it is being edited.
Source checks **do not** compile AssemblyScript, resolve imports, execute tests
or simulate a chain. The hosted compiler, language server, integrated terminal,
GitHub synchronization and custom contract deployment are not implemented in
this foundation. The editor is currently a text editor with IDE navigation;
Monaco/CodeMirror and language-aware completion are a subsequent editor upgrade.

Managed app projects retain their existing fixed-template deployment and
sandboxed frontend previews. Custom contract projects are explicitly rejected by
preview, managed publish and wallet-prepare routes, with another guard in the
publishing worker. Editing custom source cannot change the platform's bundled
WASM or bypass its signer allowlist. Source export contains no platform key.

The counter can be built today outside the web service: export ZIP, enter
`source/`, then run the commands in its README. Its local compiler dependencies
are not installed into the production web server by this change.

## Next: an isolated build and test runner

Implement this as a separate service or a permissioned Core execution adapter.
The production Express process must not execute workspace scripts, import user
modules, run `npm install`, or receive a container-host socket.

A job request contains an immutable project ID, revision, source hash, operation
(`compile` or `test`) and a reviewed toolchain/image digest. The runner receives
only that bounded source snapshot. It never receives the web environment,
OpenAI keys, deployer WIF, signer token, production state, or another user's files.

Use disposable workers with a non-root UID, read-only toolchain, no external
network, no host mounts, resource/time/output limits, and per-job writable
scratch space. For hostile multi-tenant source, choose a hardened runtime or
microVM boundary rather than treating an ordinary subprocess as a sandbox.
Dependency resolution must be a separate controlled stage; compilation must use
pinned, preinstalled packages. User package scripts and build configuration are
untrusted code, even if the AI wrote them.

Persist job state and bounded logs in the web database. Store artifacts outside
the serving origin, keyed by source hash and toolchain digest. Return structured
compiler diagnostics, test results, WASM hash and ABI hash. A job interrupted by
a restart must resume or fail visibly without marking unexecuted checks passed.
The UI should open the failing file/line and let KAI propose a repair against the
same source revision. Logs are untrusted observations, never agent instructions.

Acceptance: a real compile succeeds; a compile error points to source; a failing
MockVM test stays failed; runaway jobs time out; traversal, cross-account access,
network access and host reads fail; changing source makes the old artifact stale.

## Then: local chain and testnet deployment

Add an isolated local Koinos environment for transaction/authorization/storage
behavior that unit tests do not cover. Distinguish MockVM unit tests, local-chain
simulation, testnet receipts and canonical finality in both UI and agent tools.
Keep an operation log with actual results, not simulated success messages.

Deployment must consume the exact successful build artifact and source hash the
user reviewed. Display the chain ID, contract address, payer, authority overrides,
resource ceiling and upgrade policy before wallet approval. Recheck artifact
identity before signing and after confirmation. Custom contracts need their own
reviewed deployment path; do not extend the existing platform signer to accept
arbitrary bytecode.

Only Kondor and KOIN Vault are supported product wallets. Check actual support
for the selected chain; a wallet connection is not proof it can sign on that
network. Keep keys out of the model, browser source, compiler and logs. Persist
signed transaction IDs and wait for canonical successful receipts before showing
a deployment as complete. Contract ownership/upgrade authority must be explicit
per template; do not promise universal ownership transfer for arbitrary code.

Acceptance: create → edit → compile → test → review → wallet-sign on the selected
testnet → confirm exact WASM/ABI → call methods → inspect state and logs. Cancelled
signing, wrong-chain wallets, reverted transactions, restarts and stale artifacts
must not produce a false successful deployment.

## Full IDE capabilities after the core loop

| Capability | Implementation direction |
| --- | --- |
| Rich editing | Monaco or CodeMirror, source tabs, search/replace, AssemblyScript language service, inline diagnostics and structured diffs |
| AI assistance | Project-aware read/edit tools, reviewed patches, compiler/test logs, bounded repair loop; deployment remains a separate explicit action |
| Models | Keep the existing OpenAI adapter initially; introduce a provider interface for the documented KAI Core gateway, with explicit privacy/spending/fallback policy |
| Frontend + contract | Connect a frontend to a specific reviewed ABI and deployment; retain generated-code isolation and trusted wallet review outside the preview |
| GitHub | Repository-scoped authorization, import, branches, commits and pull requests; conflict handling and source provenance |
| Templates | Versioned contracts and frameworks with build/test coverage; language support follows verified toolchain integrations |
| Deployment history | Per-chain source/artifact/ABI hashes, transaction IDs, ownership policy, verified addresses, receipts and release state |
| Mainnet launch | Explicit launch selection and KOIN payment, idempotent payment/deploy records, successful receipt checks, then launch the reviewed artifact |
| Hosting | Existing `/apps/<slug>` workflow plus versioned frontend artifacts bound to the chosen contract/network |
| Documentation | Koinos SDK/API references, examples, onboarding and contextual explanations; keep reference versions tied to the toolchain |

Mainnet launch and KOIN billing remain planned work. Testnet-first development
is the default direction; payment must not silently select a new chain or build.

## Current source/API contract

`template: "contract"` uses up to 64 text files and 300 KB total content, with
canonical relative paths. Hidden files, path traversal, dependency/build folders,
case collisions and file/directory conflicts are rejected. Existing per-account
project and version-history limits remain. At most one pending proposal is
retained per project; applying consumes a normal saved revision and discarding
removes the proposal. A new AI request is blocked until review is resolved.

- `POST /build/api/projects`: creates a managed app or `contract` workspace.
- `PUT /build/api/projects/:id/files`: saves a complete source snapshot using an
  exact current revision. Contract text may be incomplete while editing.
- `POST /build/api/projects/:id/check`: checks supplied editor contents without
  executing them; returns diagnostics and `compiled: false`.
- `POST /build/api/projects/:id/messages`: queues an AI job; contract jobs always
  create a proposal when source changes. `review: true` opts managed apps in.
- `GET /build/api/projects/:id`: includes the pending proposal, its base source
  and proposed source for review.
- `POST /build/api/projects/:id/proposals/:proposalId`: applies or discards a
  proposal. Apply checks the current revision against the proposal's base.
- Existing version restoration and exports apply to both project types.

## Verification

Run `node --test scripts/probe-builder-ide.js` and the existing builder probes.
The IDE probe exercises real HTTP/session routes and the actual client scripts
in a DOM environment: files, save, source checks, AI proposal, review and apply,
export/import, account isolation, stale proposals and deployment refusal. AI
responses are fixtures; no paid API call or chain transaction is made.

Copy `templates/builder/contract` to a temporary directory and run `npm ci
--ignore-scripts`, `npm test`, and `npm run build` there. Keep generated outputs
and dependencies outside the template directory; every template file is included
in new workspaces. Visual browser review and an end-to-end configured OpenAI
check are required before promotion to production.

References: [Koinos AssemblyScript SDK](https://docs.koinos.io/developers/as-sdk/),
[Koinos contract guide](https://docs.koinos.io/developers/guides/calculator/).
