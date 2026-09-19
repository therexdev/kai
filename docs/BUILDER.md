# KAI Build at /build

KAI Build is integrated into the existing Koinos AI website and account system.
It creates, edits, versions, previews, publishes, exports and transfers Koinos
apps. The initial contract engine supports public records, author edits,
wallet-authored polls and one vote per wallet. Its frontend is fully editable
through the OpenAI tool loop or the file editor.

This release is a template-based beta. It does **not** execute arbitrary server
code or compile user-written contracts on the production host. Custom token,
DeFi and arbitrary AssemblyScript contracts require a later isolated compiler
and contract review workflow. Neither a syntax check nor AI generation is an
audit. No claim of one-person-one-vote is made.

## Enable on the existing Vultr host

After the website commit is deployed, run in the server's SSH terminal:

```bash
sudo bash /opt/koinos/kai/deploy/builder/install.sh
```

The installer prompts privately for a **dedicated testnet deployer WIF** and an
OpenAI API key. It does not print them. It creates the shared signer token and
key-encryption key, copies only the signer runtime and bundled contract to a
root-owned directory, and configures separate systemd services. A rerun keeps
existing environment files and encryption keys. It does not alter the current
KAI settlement wallet. Do not run it with the settlement or main producer WIF.

Existing `.env` values are NOT read by the installer. If OPENAI_API_KEY is already
in the web service's environment, leave its key prompt blank. Otherwise provide
a valid project key; the source never includes a key. The API project should
have a spending budget configured by its operator.

The server must expose the complete Koinos JSON-RPC surface, including
`transaction_store.get_transactions_by_id`, contract metadata, chain reads,
submission and canonical block queries. Default: Foundation testnet. Its
gateway lacks `chain.invoke_system_call`; the adapter instead reads its system
metadata contract at `1GERisQC8e4bcsHmgU1mVGUJCwCJ3ioz7C`, bound to the exact
Foundation chain ID. This read-only path was checked against the live testnet. Public
users spend their own wallet mana for app interactions; the platform sponsors
initial deployment, managed releases and ownership proposals only.

If first deployment reports insufficient mana, fund the dedicated **testnet**
address with test KOIN, then retry the saved publishing request. No KOIN is
transferred by the builder's signing endpoint. The current bundled app contract
does not call token contracts.

## Configuration

| Web service variable | Meaning |
| --- | --- |
| KAI_BUILD_OPENAI_API_KEY | OpenAI key; falls back to OPENAI_API_KEY |
| KAI_BUILD_MODEL | Responses model, default gpt-5.6 |
| KAI_BUILD_SIGNER_URL | Private signer endpoint, normally http://127.0.0.1:3091 |
| KAI_BUILD_SIGNER_TOKEN | Shared secret used only between web and signer |
| KAI_BUILD_RPC_URL / KAI_BUILD_CHAIN_ID / KAI_BUILD_NETWORK | Explicit RPC and chain configuration; match the signer |
| KAI_BUILD_DAILY_JOBS / KAI_BUILD_GLOBAL_DAILY_JOBS | Per-account / global editing jobs per rolling day; installer sets 5 / 25 |
| KAI_STATE_DIR | Existing website state root; builder data is in builder/projects.sqlite |

| Signer-only variable | Meaning |
| --- | --- |
| KAI_BUILD_DEPLOYER_WIF | Dedicated platform controller / mana sponsor |
| KAI_BUILD_KEY_ENCRYPTION_KEY | Stable 64-hex-character AES-256-GCM key |
| KAI_BUILD_SIGNER_STATE_DIR | Defaults to /var/lib/kai-build-signer |
| KAI_BUILD_DEPLOY_RC_LIMIT | Signer transaction ceiling in 1e-8 units; default 2000000000 (20 mana) |
| KAI_BUILD_DAILY_MANA | Rolling daily sum of reserved maximum mana; default 20000000000 |
| KAI_BUILD_MAINNET_ENABLED | Must explicitly be true for mainnet, detected by label or known chain ID |

Visitor wallet requests use a separate `KAI_BUILD_RC_LIMIT`, default 200000000
(2 mana). Deployment needs a larger ceiling because it uploads app and guard
WASM. The daily signer budget reserves the full ceiling per new transaction,
not just the amount ultimately used. No token transfer occurs.

The WIF and encryption key belong **only** in `/etc/kai-build-signer.env`.
OpenAI and the web process never receive them. The web process can request only
bundled-template deployment, source-hash publication, and ownership proposal.
This is still a privileged control plane: compromise of the web process can
request actions on platform-managed apps within the signer limits. The separate
signer prevents direct key extraction and arbitrary transaction signing; it
does not make a compromised platform trustworthy. Wallet-owned apps require
their owner's signature and are refused by the managed signing path.

The website starts without these new credentials. It serves saved projects,
manual editing, sandboxed previews and exports; AI editing and publishing show
their configuration requirement and fail closed. Configuration presence is
not a claim that an OpenAI key or RPC has been validated.

## Ownership and releases

Every app gets a fresh random bootstrap key/address. Keys are AES-GCM encrypted
in the signer DB. Initial upload enables **all three authority overrides** and
initializes the owner in the same transaction. Initialization verifies a real
signature from the bootstrap address. After initialization every authority
type delegates to the current owner; the original bootstrap key no longer
authorizes uploads, spending from the address, or transaction application.

Transfer is two-step: the current owner proposes an address, then that address
accepts with its wallet. A proposal alone does not transfer control. Future
frontend publication requires the new owner to sign `set_release` for the exact
source hash. The site waits for canonical-chain finality before switching the
live revision. Users can sign with Kondor or KOIN Vault, or download/import signed
JSON for Kondor. The transaction, payer, chain, resource limit and operations must remain
unchanged. Wallet requests expire after 30 minutes. Kondor's free-mana rewriting
must be disabled. KOIN Vault uses its own approval and broadcast API; the builder
validates the on-chain transaction against the reviewed payer, chain, nonce,
guard and app operations. A Vault submission ID is persisted separately and
ownership/publication still require canonical finality. It never passes smart
account signatures through Kondor's recovered-address check.

The live `https://koinvault.app` service currently runs on **mainnet**. The
wallet chooser shows both wallets, but refuses Vault pairing/signing for a
**testnet** project with a clear network message. Kondor can be configured for
the builder's Foundation testnet. A mainnet KOIN Vault account cannot sign a
testnet action; enabling testnet Vault requires a separately configured wallet
service. There is no automatic network switch in its connection API.

Hosted source files remain associated with the creator's Koinos AI account.
On-chain transfer does not transfer that account or the hosting service. A
different recipient can export/self-host the app and control it independently.
Project JSON import creates a fresh project; it does not claim an existing
contract. The ZIP includes a standalone static site that connects directly to
public RPC, Kondor and KOIN Vault (on mainnet), editable source, the WASM/ABI and contract source.

Restoring source creates a new draft version. Existing public data is retained.
The v1 UI publishes frontend changes and release commitments; it does not
replace the contract WASM. A contract owner using other tools can replace code,
but must deliberately preserve the authorization and storage model.

Every wallet transaction first calls a separate immutable guard that checks the
app bytecode hash and all three authority flags within the same transaction.
Owner actions also pin the expected owner or pending recipient before any
application authorization can run.
This blocks a transferred owner from replacing app code and then soliciting a
platform or visitor signature through the builder. Off-chain metadata checks
alone would leave a race between the check and execution. Replaced contracts
remain under their owner's control, but wallet actions through this builder
and its exported bridge stop until supported explicitly.

## Isolation and durability

- Every private project operation is account scoped and reuses the existing
  session/CSRF gate. Opaque-origin mutation requests are refused.
- `/apps/<slug>` is a trusted public shell. Generated HTML is served inside an
  iframe with `sandbox="allow-scripts"` and an HTTP CSP that also enforces the
  sandbox. No same-origin privilege, external scripts, fetch, frames, popups,
  form submission or top-level navigation is granted to generated code.
- The parent bridge handles only fixed reads and app actions. Wallet requests
  are reviewed in trusted UI outside the generated frame. Preview state is
  explicitly labelled sample data and never signs or writes to the chain.
- Source is stored as immutable SQLite revisions, limited to four text files,
  300 KB per version, 200 versions per project and 15 MB history per account.
  Twenty projects per account. Jobs have daily quotas and a bounded model loop.
- Jobs run independently of the browser. Leases survive server restarts; one
  job is active across processes. AI attempts may incur repeated API usage
  after an interruption. The last saved revision is retained on failure.
- Signer transactions are persisted **before** broadcasting. Retrying a saved
  job reuses the same transaction and app key; finality lookup includes old
  blocks. It never fabricates a successful deployment from a submission alone.
- SQLite WAL files are part of live state. Use SQLite's backup API or stop the
  relevant service while copying its DB; do not copy only a live `.sqlite`
  file. Back up the web builder DB, signer DB and signer encryption key together.
  Existing scheduler backups do not include the new builder databases.

The root-owned signer copy is intentionally not auto-updated by the website's
git-pull timer. Rerun the reviewed installer to update signer code. Changing the
signer encryption key without migrating encrypted rows loses access to their
bootstrap keys. Owner authorization does not depend on those bootstrap keys
once initialization is complete.

## Verification and launch gate

```bash
node --test scripts/probe-builder.js
node scripts/probe-app.js
npm ci --prefix contracts/build-app --ignore-scripts
npm test --prefix contracts/build-app
npm run build --prefix contracts/build-app
```

The tests use real cryptographic signatures and Koinos MockVM for contract
behavior, plus mock OpenAI/RPC responses for orchestration. They do not spend
funds or call a paid model. Browser inspection and live testnet validation must
be completed on a reachable configured deployment before enabling mainnet.

Test the full loop on testnet: create a voting project, edit it through OpenAI,
publish, create a poll with a community wallet, vote from a different wallet,
publish a frontend update, transfer to the creator, publish through their
signature, and verify a managed release is refused. Also interrupt a publishing
request, restart the web service and use Retry saved publishing request.

For mainnet, pin the real chain ID in **both** service env files, use the
corresponding dedicated wallet and RPC, and set `KAI_BUILD_MAINNET_ENABLED=true`
in the signer env only after that testnet loop passes. Existing projects are
network bound; switching the server network does not migrate them. Use a
separate state directory for a separate network or keep the beta deployment
on testnet until a deliberate migration is implemented.

## Publishing diagnostics and saved retries

### Full deployment return-buffer fix

The SDK defaults to a 1 KB syscall response buffer. Reading the entire transaction
during initialization returned more than 65 KB because deployment includes both
WASM uploads and the ABI. The contract now reads only transaction ID and signatures,
and sets a 32 KB buffer for allowed arguments and stored records. CI enforces the
real host's return-buffer boundary (the SDK mock otherwise silently truncates),
reproduces the exact failure using the previous binary, then initializes the fixed
binary from a complete signed deployment. Large records and result pages are also
covered.

After deploying the website, rerun the signer installer below and retry the saved
publishing request. The signer recognizes only the exact old buffer-bug bytecode
on Foundation testnet. It requires either a canonically reverted transaction or
the same deterministic buffer error from a non-broadcast simulation, plus an
undeployed app address. It archives the rejected operation, preserves the app
address/key and saved job, and prepares corrected uploads. Uncertain, included,
successful or changed deployments are preserved without replacement. Archived
operations still count toward the deployment mana allowance. This can recover a
job that already has an archive from the earlier no-op startup bug.

The signer now returns submission failures and bounded contract logs immediately.
A node rejection, a reverted submission receipt, or an uncertain HTTP response
must not be presented as “waiting for finality.” The saved transaction and app
key are retained; retry checks that transaction before any rebroadcast. Included
transactions are polled without rebroadcast, and canonical finality remains
required before the frontend becomes public. Errors include the transaction ID.

After this website update, rerun the existing installer on the server:

```bash
sudo bash /opt/koinos/kai/deploy/builder/install.sh
```

This preserves the existing environment and databases. The website requires
publishing protocol 2 so an older signer cannot silently repeat the timeout loop.
The service journal also records bounded publishing errors without keys or raw
transaction payloads. These diagnostics do not by themselves resolve a rejected
transaction; use the reported node reason to correct its underlying cause.

CI executes the shipped WASM through `_start`, initializes and reads app state,
and runs guard hash validation. This uses the SDK mock VM and does not substitute
for successful deployment and canonical confirmation on the configured network.

## September 2026 startup fix and saved deployment recovery

The first beta WASM artifacts exported `main` but did not call it from `_start`.
An upload could succeed while all app and guard calls returned empty results.
Both entry files now invoke `main()`. A probe executes the **compiled WASM**
startup path so class-level MockVM tests cannot miss this regression again.

After deploying this update, rerun:

```bash
sudo bash /opt/koinos/kai/deploy/builder/install.sh
```

The installer preserves the existing deployer key, encryption key and databases.
The web worker checks the signer's contract/guard hashes before publication and
shows an explicit service-update error if they differ. Then use **Retry saved
publishing request** on the failed project. The signer recognizes only the exact
old no-op artifact on the Foundation testnet, confirms its original transaction,
archives the old app/key and operation records, and deploys the corrected
contracts to a fresh app address. Other altered contracts and unconfirmed
transactions are not migrated. The abandoned no-op address had no initialized
app records; it is never represented as a working or wallet-owned app.

Generated sources may use only `kai.connect()`, `kai.disconnect()`, `kai.read()`
and `kai.call()`. The trusted wallet chooser offers Kondor and KOIN Vault.
Validation rejects MetaMask/EVM provider code. Extension-origin startup errors
are excluded from preview diagnostics; ordinary app errors remain visible.
