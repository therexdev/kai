# Build KAI plugins with Koinos

[Open Build Koinos](/build) to describe a KAI Core plugin, edit its complete
source and review AI proposals. Plugins and contracts can live in one project
with the same chat, files and version history.

## Choose your starting point

| Starting point | Included functionality | Run it in |
| --- | --- | --- |
| KAI Core plugin | Sandboxed notes UI, plugin storage, shared local AI, five interface languages | KAI Core after local packaging and approval |
| Plugin + Koinos contract | Native plugin UI/service, public testnet counter reader, declared local read service, editable AssemblyScript contract and tests | KAI Core plus a separately built/deployed testnet contract |
| Koinos dApp | Browser frontend, bundled app/guard contract sources and existing guided publishing | Web preview and the existing hosted dApp flow |

The plugin starters are editable source projects. The website does not run
native plugin code, sign packages, install plugins or deploy custom contracts.
The current **Check files** action checks source, JSON, manifest structure and
packaged JavaScript syntax. It does not run Electron, test a model, compile a
contract, verify a package signature or submit a transaction.

## A practical workflow

1. Choose **KAI Core plugin** or **Plugin + Koinos contract** on the builder page.
2. Describe the interface and behavior. Include what stays local, which Core
   services it needs, and any intended on-chain data.
3. Open **Reference** for this guide, the Core author guide and SDK types. KAI's
   `read_plugin_docs` tool can read these versioned references while editing.
4. Ask follow-up questions or refine a pending proposal in chat. Review
   **Changes**, apply the proposal and run **Check files**. The manifest,
   UI, native service, contract, tests and documentation are editable together.
5. **Export source**. Run the included tests and contract build on your computer.
6. Use Core's official packer with your own publisher key. Install the signed
   package in Core, review its permissions and test its actual behavior.
7. For a paired project, deploy the reviewed contract separately to testnet,
   check its ABI against the plugin, then configure its address in the plugin.

Changes to an exported project do not update an installed package or deployed
contract automatically. Keep the plugin version, contract source/build, ABI,
chain ID, address, upgrade authority and actual transaction receipts together
when preparing a release.

## Ideas to build next

These are project concepts for AI-assisted development, not already deployed
features. The included native starter demonstrates the counter reader/service.

| Concept | Plugin responsibilities | On-chain responsibilities |
| --- | --- | --- |
| Community workspace | Local AI summaries, proposals and voting UI | Polls, explicit voting rules and authorization |
| Workflow receipts | Run approved local work and hash selected outputs | Public receipt hashes and timestamps; keep private documents and prompts off chain |
| Referral and developer rewards | Show invitations, submissions and earned rewards | Eligibility, reviewed allocation/claim rules and replay protection |
| Membership tools | Explain balances and personalize the interface | Enforce actual authorization in contract logic; hiding UI alone is not access control |
| Network dashboard | Summarize public contract state with a local model | Read pool, node or application state from a verified network |

Useful requests to KAI:

- “Turn this plugin into a local project assistant. Use Core's model list and
  plugin storage, and keep generated drafts separate until I apply them.”
- “Design a referral rewards plugin with a matching Koinos contract. Add tests
  for duplicate claims and explain the unfinished signing/deployment steps.”
- “Expose only this public contract read as a declared local service that a
  separate native workflow adapter can consume.”
- “Review my manifest, permissions and lifecycle against the Core author guide.
  Remove invented SDK calls and add tests for cancellation and failures.”

## Core API boundaries

Packages use **schema 2 / apiVersion 3**. Native services export `create(api)`
and receive **api.version 1**. The two version numbers serve different purposes.

Sandboxed renderers call `window.kai.call("models.list", {})`,
`window.kai.call("inference.local", {model, prompt, maxTokens})`,
`window.kai.call("storage.get", {key})` and
`window.kai.call("storage.set", {key, value})` with their declared permissions.
They cannot fetch arbitrary URLs, run Node or use the web dApp wallet bridge.
Package HTML, scripts and styles; Core blocks inline scripts and CDN code.

Native services can use documented `api.models`, `api.network`, `api.settings`,
`api.services` and other shared services. Keep feature-specific UI, engines,
dependencies and data inside the plugin. Native code runs with the computer
access held by KAI: its manifest is not an operating-system sandbox. A publisher
signature identifies code ownership and integrity, not a security audit.

Use the **actual package verifier's permission list** when preparing a package.
Some descriptive names in SDK type/documentation snapshots are not accepted
manifest permissions. An unfamiliar permission does not create a new API.

Both starters follow `window.kai.locale.get/onChange` on Core **0.7.17+**.
Translate interface labels and statuses with packaged dictionaries for `en`,
`es`, `pt-BR`, `fr` and `de`. Preserve user text, code, addresses and model output.
Set the minimum Core version in a catalog entry, not an extra manifest field.

## Contracts and wallet operations

The paired starter contains a public counter with no funds or ownership system.
It checks the configured chain ID before `chain.read_contract`, decodes
`get_count` and displays the observation. A successful read alone does not
verify bytecode, ownership or upgrade policy. Changing the schema or method
requires updating the plugin's ABI, decoder and tests.

**Core's `wallet.authorize` is for documented credit operations. It is not a
generic contract signer.** Custom contract writes require a separately reviewed
Kondor/KOIN Vault integration or a documented installed wallet service. Verify
actual network support, show the exact transaction and resource limit, obtain
approval, preserve the submitted ID and wait for confirmed successful receipts.
No such custom signing adapter is shipped in these starters. Never put WIFs,
publisher keys or API secrets in project source or AI prompts.

The platform's existing managed signer only handles its approved bundled dApp
contracts. A plugin source project cannot use that signer to deploy arbitrary
code. Custom builds, local-chain simulation and hosted custom deployments remain
future IDE work.

## Connect plugins through declared services

The native starter declares `<plugin-id>.counter` in `provides` and exposes only
the `read` method. Its consumer must be a local native plugin with
`services.call` and that exact service name in `consumes`:

```js
const result = await api.services.call(
  "builder.your-plugin.your-id.counter", "read", {}, { signal }
);
```

Replace the example service name with the one in your exported manifest.
The provider rejects remote/rented contexts and unknown methods. A local
service declaration does not automatically add an action to Workflows; that
requires an explicit consumer adapter. Keep remote agents away from private
accounts, Brain data and the native SDK.

## Local tests, packaging and installation

After extracting your export, run from its `source/` directory:

```sh
node --test tests/*.test.cjs
```

For a paired contract, from `source/contract/`:

```sh
npm ci --ignore-scripts
npm test
npm run build
```

From a clone of [kai-core](https://github.com/therexdev/kai-core), use an
Ed25519 publisher key stored outside your project:

```sh
node scripts/core/pack-plugin.js /path/to/source/plugin /private/publisher-private-key.pem /path/to/my-plugin-1.0.0.kaiplugin
```

The packer validates the manifest and signed package and refuses to overwrite
an existing output. Install through **Plugins → Install 3rd Party Plugins**.
Review the publisher fingerprint and capabilities; native plugins require the
full-access notice. Updates must use the same publisher key and a new version.
Bundle dependencies before packaging: Core does not run npm during installation.
Tests with fake Core/RPC interfaces do not prove real-device or live-chain behavior.

## Documentation sources

The Reference tab uses an offline snapshot of the Core author guide and API
types from commit `324c18835bbbba3ff3be1f34a31b09b03fa32167`. It is deliberately
versioned so AI edits refer to an identifiable SDK. Check upstream before adopting
a newer SDK capability. Workspace edits cannot replace the server's reference.

- [Versioned Core author guide](https://github.com/therexdev/kai-core/blob/324c18835bbbba3ff3be1f34a31b09b03fa32167/docs/foundation/PLUGIN_AUTHOR_GUIDE.md)
- [Latest Core author guide](https://github.com/therexdev/kai-core/blob/main/docs/foundation/PLUGIN_AUTHOR_GUIDE.md)
- [Public SDK types](https://github.com/therexdev/kai-core/blob/main/docs/foundation/api-v1.d.ts)
- [Sandboxed example](https://github.com/therexdev/kai-core/tree/main/examples/sandboxed-notes)
- [Native service example](https://github.com/therexdev/kai-core/tree/main/examples/native-counter)
- [Koinos AssemblyScript SDK](https://docs.koinos.io/developers/as-sdk/)
