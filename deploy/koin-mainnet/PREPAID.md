# Separate prepaid deployment

This replaces the customer business model. It is not an in-place upgrade of refundable custody. The new service is `kai-koin-prepaid.service`, with separate `/etc`, `/var/lib`, `/opt` directories and loopback port 3109. The existing pilot remains available to reconcile old funds and signed transactions. No updater exception or retry-fence reset is needed to install the separate service.

The current product is USD-denominated: 1,000 credits = $1. All purchase KOIN goes to Master Node `15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T`; no usage-time 60/25/15 transfer applies. `prepaid-v1` remains readable with its original KOIN units for existing accounts.

The new settings example fixes the intended reward seed at **10,000 KOIN**, leaves the total ceiling unset, and requires explicit operational Mana budgets and **USD** tariffs. The total ceiling must cover the seed, buyer test purchase and role funding. The 5% daily budget is based on uncommitted pool KOIN, is prorated on a partial first UTC day, and retains the current 70% availability / 30% work allocation. A full first day budgets 500 KOIN. Payouts follow the existing review/finality process.

**Revision 2 pricing requires live configuration:** `purchase-price.js` now uses the implemented Ethereum Uniswap v4 vKOIN/USDT adapter when reviewed `purchasePricing` settings are present. It needs two independent archive RPC hosts, the pinned USDT/USD feed, the reviewed depth/freshness/deviation policy, and a fresh signed wrapped/native parity attestation. `usd-price.js` remains only for legacy diagnostics/tests; fresh CoinGecko/CoinPaprika data must not silently reactivate purchases. The pinned market is recorded in `purchase-price.js`. Do not use v3 `observe()` or a dashboard spot cache. Unavailable or expired evidence pauses new purchase quotes; existing credit consumption, already-signed purchase finality and settlement remain independent. Explicit fixture prices remain available only on isolated rehearsal chains. Passing source tests does not establish that these live prerequisites are configured.

## Reviewable preparation

1. Require passing desktop Test checks, contract tests, backend regressions, and the isolated native-chain prepaid test at the exact source revisions. The native test includes purchase, finality, credit import, normal desktop chat, signed provider response, lost settlement response, restart, and conservation of original custody.
2. Copy `settings.prepaid-usd.example.json` into a private bootstrap location and fill the owner, intended HTTPS scheduler, pricing, and exact KOIN/Mana funding ceilings. For the normal sign-in product, explicitly add `settings.accountMode: "public"`, the reviewed `freePolicy`, `purchasePricing`, and provider `qualificationPolicy` before generating the plan. Keep the private settings and any credential-bearing archive URLs out of logs and source control. Do not infer permission to fund fresh roles from permission to publish code.
3. Run `prepare.js` with a **new** absolute private bootstrap directory and the reviewed desktop contract build directory. `mode: mainnet-prepaid-usd-plan` selects `prepaid-usd.wasm`, generates new contract/role identities, verifies mainnet identity through two RPCs, and writes a reviewable budget. It signs and broadcasts nothing.
4. Review that exact plan. `setup.js configure --dir ... --approve <plan hash>` produces runtime configuration. Invitation mode also creates private invitations; public mode deliberately does not. Securely back up the generated keys; offline admin and contract keys never go in the service directory.
5. After the precise role-funding budget and deployment transactions have been approved, use the existing `check-funding`, `tokenizer`, and `deploy` commands. Deployment is journaled and uses the exact new code hashes. The on-chain prepaid product marker must verify before a desktop manifest is exported.
6. Prepare the private account credentials below, then run `install-prepaid.sh` from the reviewed, clean backend commit. Configure the new HTTPS hostname to proxy to `127.0.0.1:3109`; verify `/health` shows `product: prepaid-usd-v1` and `/auth/methods` exposes a working account-creation method. This installer refuses to replace an existing prepaid service and never reconfigures the legacy service.
7. Add the exact deployed rewards contract to the independent Master app's saved daily recipients. Retain the reviewed production reburn and Mana reserve settings; determine the recipient percentage from that budget. The Master app closes cycles daily at its configured UTC hour and requires its own local wallet-password authorization. Purchase deposits are not automatically counted as block-production profits. Ordinary native KOIN transfers replenish the pool; no credit purchase/refund call is needed. Seed the pool with the separately approved 10,000 KOIN transaction and verify irreversible receipt.
8. Connect the verified new deployment in Test. Public mode uses normal verified sign-in at the new service origin and does not require invitation import. Invitation mode retains its private manifest/invitation flow. Existing pilot account files and unresolved wallet transactions remain preserved; connecting the new service does not move the old KOIN balance.

## Public account service installation

Create a root-owned, mode `0600`, regular JSON file outside the checkout, for example `/root/kai-prepaid-account-auth.json`. The installer rejects symlinks, other owners, group/world access, unknown names, incomplete providers and multiline values. Use the existing mail/OAuth provider credentials through a secure operator handoff; never paste real credentials into a command, chat, issue, or source file.

The JSON may contain only these string fields:

| Provider | Required | Optional |
| --- | --- | --- |
| Email codes | `SMTP_HOST` and a sender (`SMTP_FROM` or `SMTP_USER`) | `SMTP_PORT` (default `587`), `SMTP_SECURE` (`"true"` or `"false"`, default `"false"`), paired `SMTP_USER` and `SMTP_PASS` |
| Google | Both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | None |

At least one complete provider is required for public mode; both may be configured. An unauthenticated SMTP relay requires an explicit `SMTP_FROM`. The installer validates configuration shape, not SMTP delivery or the validity of OAuth credentials. For Google, register **exactly** `<scheduler origin>/auth/google/callback` with the provider. For example, a scheduler at `https://credits.koinosai.com/scheduler` uses `https://credits.koinosai.com/auth/google/callback`.

Once the deployment and installation have been approved, the public-mode invocation is:

```sh
bash deploy/koin-mainnet/install-prepaid.sh /absolute/private/bootstrap-directory /root/kai-prepaid-account-auth.json
```

Invitation mode omits the second argument and requires its existing `invitations.json`. Neither mode creates guessed credentials or an authentication bypass. Validation and private staging finish before creating the new service user or copying installed configuration.

The generated `/etc/kai-koin-prepaid/account.env` is root-owned, mode `0600`, and read by systemd through `EnvironmentFile`. It is never sourced as shell code. The configuration directories are root-owned and not writable by the service. The runtime signing credentials and invitations remain mode `0600` for the service user; non-secret configuration, including the signed parity envelope, is root-owned and readable only by the service group. The service retains `ProtectHome=yes` and a read-only `/etc/kai-koin-prepaid` view.

Public accounts use their own `/var/lib/kai-koin-prepaid/accounts/accounts.sqlite`. An existing website email address can sign in again, but this installation does not reuse the website's database, cookies or sessions. No production account database or old payment journal is copied or modified.

When pricing is configured, the installer verifies the initial parity envelope's signature, identity and freshness, copies its exact bytes to `/etc/kai-koin-prepaid/parity.json`, and rewrites only `purchasePricing.parityFile` in the installed runtime. The original bootstrap and all other pricing pins stay unchanged. The reviewed parity publisher must then refresh this installed file atomically before expiry, preserving root ownership and service-group read access. The installer does not create an attestor, give it signing keys, or promise perpetual validity from a single snapshot. Expired evidence keeps new purchases unavailable without preventing existing credit use.

Before the first buyer test, verify HTTPS `/health`, `/auth/methods`, actual email/Google sign-in at `/account`, wallet linking, configured free-credit behavior, fresh pricing and a qualified online provider. `/auth/methods` reports which methods are configured; a successful real sign-in verifies delivery/provider setup. Then test one approved credit purchase through the normal desktop **Buy credits** flow and wait for confirmed credits before sending chat. Source checks do not perform this live acceptance.

## Existing funds and final acceptance

Reconcile old available and reserved buyer KOIN and any completed paid jobs from their original records. Preserve the old contract's refund rights. A migration must identify the original owner, amount, source transaction/contract, destination account, and a unique conversion receipt. Only verified funding of the destination can become purchased credits. Do not credit the old reserve from a screenshot, erase the legacy ledger, reuse the earlier reward-retry approval, or deploy the new code at the old contract address.

The current owner's 0.1 KOIN is an outstanding migration item, not an already converted purchase. The new service can be tested independently while that legacy obligation remains visible in the operator record. A sponsor-funded replacement would need its own explicit funding authorization and must not also convert the same legacy amount later.

Acceptance is through the actual two computers: provider On → ONLINE; buyer Buy credits → one payment approval → confirmed credits → Chat → answer → one credit debit. Repeat with Stop, provider Off, disconnects, restarts, low balance, and a delayed payout. No reservation, release, settlement, or backend test-panel action belongs in this acceptance flow. Do not promote Alpha/public launch until this passes and the old customer balance is resolved.
