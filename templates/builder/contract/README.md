A Koinos AssemblyScript source workspace. The public counter demonstrates
persistent state, protobuf inputs/results, entrypoints and MockVM tests.
Anyone may increment it. It has no token, payment or ownership-transfer logic.

## Build and test locally

Export ZIP, extract it, and open a terminal in the `source` directory. Use
Node.js 22. Review the source and scripts before running them:

```sh
npm ci --ignore-scripts
npm test
npm run build
```

`build/contract.wasm` and `build/contract.abi.json` are local outputs. The web
workspace stores source and reviews AI edits; its Check files action validates
paths, size and JSON only. The hosted compiler, local chain, test runner and
custom wallet deployment are not connected yet. A source check is not a build,
a test run or an audit. The frontend preview belongs to managed app projects.

`npm run generate` regenerates protobuf types, entrypoint constants and ABI.
When adding methods, update the method definitions in `scripts/generate.js`,
protobuf schema, implementation, entrypoint dispatch, and tests together.
Do not edit generated `assembly/proto/counter.ts` or `assembly/entries.ts`.

Deployment should be tested on the intended testnet first. The initial upload
uses normal contract-key authority (no authorization overrides). The managed
App v1 signer must not be used to upload these custom artifacts. Never put a
wallet WIF, API key or credential in a source file. The intended wallets are
Kondor and KOIN Vault, subject to support for the selected chain.

Koinos SDK documentation: https://docs.koinos.io/developers/as-sdk/
