This project pairs a KAI Core plugin with a Koinos public counter contract.
plugin/ is the installable plugin's source; contract/ contains AssemblyScript,
protobuf, the build toolchain and MockVM tests. Neither has been deployed by
creating this project. The counter holds no funds and anyone may increment it.

## Working integration

The native plugin saves a contract address in its own Core settings. On an
explicit Read counter action it uses api.network.fetch, checks the configured
chain ID and reads get_count. Core's network permission, privacy policy and
cancellation apply. Missing addresses, wrong chains and malformed results fail
visibly. Nothing is fetched on installation or background startup.

The plugin also provides a local service named `<manifest.id>.counter` with a
single `read` method. Another native plugin may declare that exact name in
consumes, request services.call, and use api.services.call(name, "read", {},
{signal}). Remote/rented callers are refused. This does not automatically install
an integration in Workflows or grant another plugin access to private data.

This is native trusted code with KAI's operating-system access. Manifest
permissions describe normal SDK use; they do not confine native code.

## Test and build outside the website

Use Node.js 22. From this exported source directory:

    node --test tests/*.test.cjs
    cd contract
    npm ci --ignore-scripts
    npm test
    npm run build

Contract outputs are contract/build/contract.wasm and contract.abi.json. Deploy
the reviewed counter to the Foundation testnet with your separate development
wallet/tooling. The web IDE has no hosted compiler or custom deployer yet.
Compare the resulting ABI with plugin/chain.json and the decoder in
plugin/service/index.js. A changed schema or method needs corresponding plugin
changes. A successful read does not verify the deployed bytecode or upgrade policy.

Use Core 0.7.17+ for shared localization. From a clone of
https://github.com/therexdev/kai-core, with an existing Ed25519 publisher key:

    node scripts/core/pack-plugin.js /path/to/source/plugin /private/publisher-private-key.pem /path/to/my-plugin-1.0.0.kaiplugin

Install through Plugins → Install 3rd Party Plugins, review the full native
trust notice, then save the deployed contract address inside the plugin.
Keep publisher keys, WIFs and API keys outside this project. Updates use the
same publisher key and a new version. Tests use fixtures; test the signed
package and actual testnet reads in Core before releasing it.

## Adding contract writes

Core wallet.authorize handles documented credit operations, not arbitrary
transactions. A custom write flow needs a reviewed Kondor/KOIN Vault adapter or
a documented installed wallet service, chain and exact artifact checks, explicit
approval, resource limits, idempotent submission and confirmed receipts. That
adapter is not included here. Never pass private keys to the AI or assume that
connecting a wallet authorizes a transaction. Keep the read-only starter usable
until the full write flow is implemented and tested.

Reference: https://koinosai.com/docs/#plugin-builder and the web IDE's Reference tab.
