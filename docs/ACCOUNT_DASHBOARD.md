> Updated workspace navigation and shared sign-in are described in [ACCOUNT_WORKSPACE.md](ACCOUNT_WORKSPACE.md). The release below describes the previous dashboard.

# One account dashboard and dedicated login

`/login` is the public email/Google/passkey entry. Verified sessions open `/account`, which contains overview, chat, credits and billing, API keys, usage, wallets, device approvals and security in the existing sidebar layout. `/platform` remains a redirect alias and `/platform/docs` remains public. Existing API paths and credentials are unchanged.

`/link?code=...` preserves the device code through login and opens Devices; approval always requires the user to press Approve. Login return paths accept only account sections and validated device codes. Google still uses the existing registered callback and lands on `/account`; a short-lived, same-tab return hint restores the requested section without holding credentials. Expired or external destinations are ignored. If browser storage is unavailable, Google lands at the dashboard overview.

Account settings call the existing account APIs independently of credit/RPC availability. Signed-in profile, wallet proofs, session revocation, passkeys and device approval retain their existing authorization. This is a UI consolidation, not a migration of the separate old website database. Existing website/node/builder identities, connected services, wallets and grants must remain accessible through the website's compatibility routes. Do not merge identities or move balances based on matching email addresses.

## Activation

Run from the reviewed clean checkout after `npm ci --include=dev --ignore-scripts`:

```
/usr/bin/node deploy/koin-mainnet/update-account-ui.js
```

This accepts the deployed web API release `697ff9721e55c76487f21eae484c60f2f653fb5e` as its base. It reuses the existing clean-drain, stopped-state backup, writer checks and resumable forward-only updater. It does not change environment values, accounts, balances, reward storage, payment journals or RPC settings. It refuses an unexpected active version or unrelated source changes. Health must report both `webApiVersion: 1` and `accountUiVersion: 1`. The companion website change can deploy first: its new redirects activate only after health confirms both capabilities.

## Verification

`node --test scripts/probe-account-dashboard.js scripts/probe-credit-gateway.js scripts/probe-credit-platform-dom.js scripts/probe-credit-account-web.js scripts/probe-accounts.js deploy/koin-mainnet/update-web-api.test.js`

`node tests/credit-platform.browser.cjs` exercises email login using fixture mail, sidebar navigation, signed fixture chat, API-key creation/revocation, device approval, account settings and desktop/mobile layouts. All identities and balances are isolated. Set `KAI_TEST_CHROMIUM` only when using a preinstalled local Chromium binary. Real email delivery, Google consent, passkey hardware and Kondor mainnet payments still require the corresponding live account or wallet.
