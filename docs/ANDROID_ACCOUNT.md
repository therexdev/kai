# Android account and KOIN Vault support

The independent Android app signs into the AI credit account at https://credits.koinosai.com using the existing device-code flow. Browser email/Google authentication stays on the service. No API key is created or embedded. This is the credit account linked from the website; older legacy website accounts are separate.

Android sends its encrypted device session as a Bearer credential to `/platform/api/overview` and `/platform/api/chat`. The server resolves current account and wallet ownership on each request. These are the same credit ledger and model catalog as the website. Users choose the wallet balance and whether purchased credits may be spent. The catalog now includes each tariff's context limit; the UI must distinguish credit units from token counts. `/health` advertises `nativeAccountVersion:1`; authenticated overview advertises `features.koinVault:1`.

## KOIN Vault

The account dashboard supports Connect KOIN Vault and owner-paid purchases. `/platform/api/vault/connect` creates a relay session bound to the signed-in account; the database stores only its secret hash. Status is independently verified against the fixed KOIN Vault origin and paired website origin before linking an address. An arbitrary client-posted address is never accepted. Unlinking prevents the old pairing from re-linking a wallet.

A purchase quote binds account, wallet, exact operations and expiry. The request endpoint consumes it before making the non-idempotent wallet request. Repeated reads return the same request ID; an uncertain request remains blocked for reconciliation. The wallet uses its own mana (`mana: wallet`) to preserve the existing exact owner-paid chain verification. Submission status is not credit confirmation: the existing purchase observer checks irreversible chain inclusion and exact payment evidence before crediting. There are no changes to prices, payment contracts, settlement or reward logic.

The user opens KOIN Vault to approve connection/payment and returns manually; the wallet has no automatic return callback. Browser pairing state is in sessionStorage, scoped by account ID. Keep the page open through a purchase. Pending transaction IDs continue to use the existing purchase recovery form. No keys, private keys or passkeys are sent to Android.

## Deployment

This change is based on the reviewed premium integration at `ed35690b0a4d681aa4dd1f2972c95d7a5de724eb`. The updater **requires that release to be installed first** and refuses other bases. It must not be run over an unrelated active release. From the clean, pinned checkout, with system Node 22+ on the existing server:

```
npm ci --include=dev --ignore-scripts
/usr/bin/node deploy/koin-mainnet/update-android-account.js
curl --fail --silent --show-error https://credits.koinosai.com/health
```

The updater reuses existing clean shutdown, SQLite snapshot, lease checks and forward recovery. Preserve the service's account database, configuration and payment journals. Confirm `nativeAccountVersion:1` and test the same account on phone and browser. If a newer premium release is installed, rebase and review the updater's exact base before deployment; do not bypass the guard.

## Validation

`node --test scripts/probe-credit-vault.js scripts/probe-credit-gateway.js scripts/probe-account-dashboard.js scripts/probe-credit-platform-dom.js` verifies native session sharing/revocation, wallet pairing ownership/origin, unlink behavior, purchase binding, ambiguous-request non-replay, existing browser rendering and credit accounting. Tests use mock wallet/network evidence, not live payments. Live email/Google auth and a user-approved KOIN Vault purchase remain deployment acceptance checks.
