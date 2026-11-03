# Build on Koinos: AI-assisted IDE

The product stays at `/build`, inside Koinos AI. A guided dApp launch is one
workflow inside the IDE. Guided chat and manual editing use the same project,
source revisions, contracts, tests and deployment history. Opening the IDE must
never fork or recreate the app. The development workflow is:

**Create contract → edit and review → compile → test locally → deploy to testnet
→ refine → explicitly launch on mainnet.**

The web workspace coordinates projects, source, AI assistance and development
jobs. KAI Core integration should use documented shared service APIs for models,
permissions, controlled execution and signing. Feature UI, templates and workflow
logic belong to Build Koinos; this change does not add them to Core or depend on
a desktop installation.

## Implemented in this foundation

- Guided voting, board and blank-app creation now produces a full project:
  the frontend plus editable app/guard contracts, schemas, ABI references,
  portable unit tests and pinned build scripts in `contract/`.
- Existing frontend-only projects can use **Open full project**. This adds the
  current template sources in a new revision of the same project, preserving
  its ID, slug, contract addresses, live release, source history and data.
- **Check & preview** runs source checks and opens the sample frontend preview.
  Users can continue in chat and deploy unchanged template contracts without
  opening source files. It is deliberately not labelled a contract test run.
- A new `contract` project type with nested source files, a file explorer, filter,
  create/rename/delete, line numbers, indentation and save shortcut.
- An AssemblyScript counter starter with protobuf schema, explicit Koinos
  entrypoint, pinned dependencies, local build scripts and MockVM tests. It is a
  public counter; it does not hold funds or provide an ownership-transfer system.
- Durable AI proposals, side-by-side saved/proposed source, apply/discard, and
  revision conflict detection. Full-project and standalone contract AI edits
  always require review. Legacy frontend-only API callers can still request
  automatic frontend edits.
- Chat continues while a proposal is pending. Questions leave it intact and
  refinements start from its proposed files. Only Apply creates a saved version.
  A failed refinement preserves the prior proposal; a successful replacement
  rotates its ID so another browser tab cannot apply an outdated review.
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

Guided projects retain their existing deployment and sandboxed frontend preview.
The server pins the contract-source snapshot and app/guard WASM hashes when a
full project is created or attached. Unchanged contract sources can use the
current deploy workflow; frontend edits continue to publish on the same address.
Contract-folder changes pause managed publishing until a custom build/deploy
path is connected. Source checks and sample preview remain available, with a
clear indication that edited contracts have not run.

Deleting every contract file cannot remove this requirement: the source binding
is persisted on the project, outside user-editable files. Import ignores any
claimed provenance and compares against the server's own template snapshot.
Project creation/attachment does not assert that an older on-chain deployment
matches these current sources; existing metadata/guard checks verify that
separately before publication. A bundled WASM change invalidates publishing for
older bound projects rather than silently substituting code.

Standalone contract-only projects still have no frontend preview or managed
deployment. Both managed publish and owner-wallet publish preparation enforce
source eligibility; the publishing worker checks it again. Editing source cannot
change the platform's bundled WASM or signer allowlist. Changed-contract exports
contain all editable source, but no substitute template WASM or deployable site.
Unchanged full-project exports include the existing standalone site and matching
bundled artifacts, plus the actual editable source and tests. No export contains
a platform key.

Both project paths can be built outside the web service: export ZIP and run the
README commands in `source/contract/` for a guided project, or `source/` for a
contract-only project. These dependencies are not installed into the production
web server. The guided bundle includes the existing 28 MockVM tests and builds
app/guard WASM and ABI matching the platform artifacts byte for byte.

## KAI Core plugin projects

The workspace also supports `plugin` and `plugin-chain` source projects. These
share the editor, revisions, reviewed AI proposals, checks and import/export.
Plugin source supports packaged HTML/CSS and JS, a schema-2/API-3 manifest,
offline localization and tests. The paired starter includes a native read-only
chain adapter, a declared local read service and the existing counter contract
toolchain. Its chain ID is checked before reading. It does not sign custom
transactions, execute plugin code in the web server, or use managed deployment.

The Reference tab and `read_plugin_docs` tool read a versioned Core author-guide
and API snapshot from server-controlled files. The public
[plugin builder guide](../public/docs/content/plugin-builder.md) describes
concepts, runtime choices, actual capabilities, local packaging and installation.
Plugin checks report source/manifest/JavaScript syntax only; tests and signature
verification are separate. Use the matching Core package verifier to validate
starters at development time. The official packer and publisher key remain on
the author's computer, outside AI source and platform credentials.

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
case collisions and file/directory conflicts are rejected. Guided full projects
keep the four frontend files (300 KB) and a contract folder (300 KB), with at most 64 total files and an 800 KB serialized envelope.
Existing per-account project and version-history limits remain. At most one
pending proposal is retained per project; applying consumes a normal saved revision and discarding
removes the proposal. A new AI request is blocked until review is resolved.

- `POST /build/api/projects`: creates a managed app or `contract` workspace.
- `PUT /build/api/projects/:id/files`: saves a complete source snapshot using an
  exact current revision. Contract text may be incomplete while editing.
- `POST /build/api/projects/:id/check`: checks supplied editor contents without
  executing them; returns diagnostics and `compiled: false`.
- `POST /build/api/projects/:id/messages`: queues an AI job; contract jobs always
  create a proposal when source changes, as do full guided projects.
  `review: true` opts older frontend-only apps in.
- `GET /build/api/projects/:id`: includes source/deployment eligibility, the
  pending proposal, its base source and proposed source for review.
- `POST /build/api/projects/:id/workspace`: attaches contract sources to an
  older frontend-only project using an exact current revision. It changes no
  on-chain state and does not change the project ID or current live release.
- `POST /build/api/projects/:id/proposals/:proposalId`: applies or discards a
  proposal. Apply checks the current revision against the proposal's base.
- Existing version restoration and exports apply to both project types.

## Verification

Run `node --test scripts/probe-builder-ide.js scripts/probe-builder-guided.js`
and the existing builder probes.
The IDE probe exercises real HTTP/session routes and the actual client scripts
in a DOM environment: files, save, source checks, AI proposal, review and apply,
export/import, account isolation, stale proposals and deployment refusal. AI
responses are fixtures; no paid API call or chain transaction is made. The
guided probes cover same-project source attachment, preserved live state,
source/bytecode binding, frontend-only publishing, refusal before signer access,
source import/export, and combined AI frontend/contract proposals.

Copy `templates/builder/contract` to a temporary directory and run `npm ci
--ignore-scripts`, `npm test`, and `npm run build` there. Keep generated outputs
and dependencies outside the template directory; every template file is included
in new workspaces. Visual browser review and an end-to-end configured OpenAI
check are required before promotion to production.

References: [Koinos AssemblyScript SDK](https://docs.koinos.io/developers/as-sdk/),
[Koinos contract guide](https://docs.koinos.io/developers/guides/calculator/).
