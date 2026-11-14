# Kondor Foundation testnet compatibility patch

This is a wallet-side source patch for Kondor, prepared alongside KAI PR #71. It is not an official Kondor release and it does not update anyone's installed browser extension.

## Confirmed failure

On 2026-09-21 the KAI live app prepared a complete unsigned transaction with its payer present and Foundation chain ID `EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==`.

The Chrome-distributed Kondor 1.3.0 extension lists Mainnet and Harbinger, with Harbinger chain ID `EiBncD4pKRIQWco_WRqo5Q-xnXR7JuO3PtZv983mKdKHSQ==`. Its signing component looks up the transaction chain, constructs a provider from that network, and only then assigns the payer. Foundation lookup fails first; a subsequent signing attempt builds with an empty payer and throws exactly `payer is undefined`. This was reproduced with the live unsigned draft and Kondor's signing component. The Mainnet control initializes the same payer correctly.

Chrome release SHA-256: `6ea0c11dcfc5a6376a91f5f0fe74e289f57e21def10b57847de03f1e0af3b9c0`.

Sources:

- [Kondor network definitions](https://github.com/joticajulian/kondor/blob/83c45617ecc23c7c74d63878fc0a0189be28d196/src/ts/storage.ts)
- [Kondor signing component](https://github.com/joticajulian/kondor/blob/83c45617ecc23c7c74d63878fc0a0189be28d196/src/popup/views/2-SignSendTransaction.vue)
- [Foundation testnet chain details](https://github.com/koinos/koinos-testnet)

## Patch

Base: `joticajulian/kondor` commit `83c45617ecc23c7c74d63878fc0a0189be28d196` (MIT licensed).

The patch adds Foundation as a distinct supported network, including migration for existing saved network lists, its KOIN/VHP token entries and an explicit network selector. It preserves Mainnet/Harbinger identities and user RPC overrides.

Foundation does not have the nickname, free-mana or mana-meter contracts used by those older networks. Signing and token transfers therefore use the selected payer and reviewed mana limit without those optional services. The popup can decode the supplied dApp ABI without attempting Foundation's unavailable metadata RPC. Unsupported chain IDs and missing payers produce explicit errors before approval.

It changes no key storage, encryption, account import, signing algorithm or transaction authorization checks.

## Apply and verify

From a checkout of the pinned Kondor commit, apply `kondor-foundation.patch` with `git apply`. Then run the repository's normal dependency install and build:

```sh
yarn install --frozen-lockfile
yarn build:ts
node scripts/probe-foundation.cjs
yarn build:webpack
yarn build:vue
```

The regression probe exercises the real signing component methods and koilib: saved-network migration, token configuration, ABI operation review, payer initialization, transaction ID preservation, signature recovery and the native token-transfer path. RPC submission and confirmation in that probe are fixtures; it never sends funds or broadcasts a transaction.

## Verified results

- The probe passes with Kondor's locked dependencies and the browser Serializer used by its real sandbox page.
- The exact unsigned draft from the live community-voting app decodes both operations, retains its payer and rebuilds with its original transaction ID. That draft was not signed or submitted.
- The probe's separate ephemeral fixture produces a recoverable signature and preserves the transaction ID. No user keys are involved.
- TypeScript, background/content-script Webpack and production Vue builds pass. Existing asset-size, CSS-order and unused-variable warnings remain.
- KAI's separate publishing/bridge fix is merged and deployed in [PR #71](https://github.com/therexdev/kai/pull/71). All 63 builder tests and CI pass. Publishing remains pending with automatic checks of the same transaction until finality; it no longer requires a manual retry because of the old two-minute timeout.

A user-controlled wallet approval and an on-chain transaction with the patched extension have not been verified. KAI's website deployment cannot add a network inside an installed extension.

## Unofficial testnet preview

`preview-only.patch`, applied **after** `kondor-foundation.patch`, makes a separately named `Kondor Foundation Preview (Unofficial)` extension, version `1.3.0.1`. Its configured networks contain **only Foundation**, selected by default. This overlay is for isolated testing, not for replacing the official wallet or changing its existing accounts.

Both patches and the compiled preview are included in the accompanying ZIP. To rebuild the preview, apply both patches to the pinned upstream commit, install the unchanged lockfile and run the same production build commands above, setting `VUE_APP_ENV=production`. Run the multi-network regression probe before applying the preview-only overlay.

To use the compiled preview:

1. Create a separate Chrome profile without another Kondor extension, so only one wallet receives the dApp's messages.
2. Extract the ZIP. In Chrome's extensions page, enable Developer mode, choose **Load unpacked**, and select its `extension` folder.
3. Create a fresh test wallet in the preview and fund its displayed address with testnet KOIN. Keep existing Mainnet accounts in the official extension; no existing recovery phrase is needed for this test.
4. Open https://koinosai.com/apps/community-voting-d7777b4f in that profile, connect Kondor, and submit a feature request. The wallet should show Foundation, the payer, and both operations for review before signing.

This preview is not an official Kondor release and has not been exercised through a real browser approval or live broadcast. No transaction was sent and no funds were transferred while producing it. Source changes do not alter key storage, encryption or the signing algorithm. For regular users, an official wallet release containing Foundation network support is still needed.
