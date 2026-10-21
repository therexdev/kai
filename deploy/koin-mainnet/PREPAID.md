# Separate prepaid deployment

This replaces the customer business model. It is not an in-place upgrade of refundable custody. The new service is `kai-koin-prepaid.service`, with separate `/etc`, `/var/lib`, `/opt` directories and loopback port 3109. The existing pilot remains available to reconcile old funds and signed transactions. No updater exception or retry-fence reset is needed to install the separate service.

The current product is USD-denominated: 1,000 credits = $1. All purchase KOIN goes to Master Node `15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T`; no usage-time 60/25/15 transfer applies. `prepaid-v1` remains readable with its original KOIN units for existing accounts.

The new settings example fixes the intended reward seed at **10,000 KOIN**, leaves the total ceiling unset, and requires explicit operational Mana budgets and **USD** tariffs. The total ceiling must cover the seed, buyer test purchase and role funding. The 5% daily budget is based on uncommitted pool KOIN, is prorated on a partial first UTC day, and retains the current 70% availability / 30% work allocation. A full first day budgets 500 KOIN. Payouts follow the existing review/finality process.

**Revision 2 pricing requires live configuration:** `purchase-price.js` uses the Ethereum Uniswap v4 vKOIN/USDT adapter when reviewed `purchasePricing` settings are present. Both schemas require two reviewed archive RPC hosts, the pinned USDT/USD feed, and explicit depth/freshness/deviation bounds. Schema 1 also requires a fresh signed wrapped/native parity attestation. The separate schema-2 merchant exchange-reference option needs explicit commercial review; it makes no bridge-redemption claim and is never selected as a fallback. See `V4_PURCHASE_PRICING.md` at the repository root. `usd-price.js` remains only for legacy diagnostics/tests; ticker data must not silently reactivate purchases. Unavailable or expired evidence pauses new purchase quotes; existing credit consumption, already-signed purchase finality and settlement remain independent. Explicit fixture prices remain isolated-only. Passing source tests does not establish live activation.

**Purchase authorization is explicit:** new public USD settings require `purchaseQuoteBudget` with `schema: 1`, `dailyQuoteAuthorizationUsdAtoms` and `accountDailyQuoteAuthorizationUsdAtoms`. Both are positive canonical USD-1e-8 strings, with the account amount no greater than the global amount; there is no default. This limits issued quote authorizations per UTC day, not executed on-chain sales. Unbought and expired offers still count. Exact unexpired retries reuse the saved quote; a new intentional purchase sends a fresh `intentId`. The separate private quote journal stores the signed quote and complete sanitized pricing evidence. Preserve its directory and external recovery anchor alongside the service state. The exported desktop manifest also pins `pricingPolicyHash`; public installation rejects a different runtime price policy. These controls do not lock existing purchased credits or block reconciliation. See the pricing document for accounting semantics and remaining origin/Sybil acceptance checks.

## Reviewable preparation

1. Require passing desktop Test checks, contract tests, backend regressions, and the isolated native-chain prepaid test at the exact source revisions. The native test includes purchase, finality, credit import, normal desktop chat, signed provider response, lost settlement response, restart, and conservation of original custody.
2. Copy `settings.prepaid-usd.models.example.json` into a private bootstrap location and fill the owner, intended HTTPS scheduler, pricing, and exact KOIN/Mana funding ceilings. For the normal sign-in product, explicitly add `settings.accountMode: "public"`, the reviewed `freePolicy`, `purchasePricing`, and reviewed per-model `qualificationPolicies` before generating the plan. The 15-model example contains approved USD prices and immutable package hashes. All 15 entries include exact reference-verified tokenizer manifests and pins; the two Llama and three Gemma packs are deterministically derived from pinned public GGUF metadata and checked against native token IDs. Reference vectors do not verify the loaded GGUF runtime. Complete per-model runtime calibration and qualification before admission; do not use this example as a ready deployment. Select admitted entries explicitly in `settings.models`; no missing entry silently becomes Fast. The old single-model example remains only for legacy plan compatibility. Keep the private settings and any credential-bearing archive URLs out of logs and source control. Do not infer permission to fund fresh roles from permission to publish code.
3. Run `prepare.js` with a **new** absolute private bootstrap directory and the reviewed desktop contract build directory. `mode: mainnet-prepaid-usd-plan` selects `prepaid-usd.wasm`, generates new contract/role identities, verifies mainnet identity through two RPCs, and writes a reviewable budget. It signs and broadcasts nothing.
4. Review that exact plan. `setup.js configure --dir ... --approve <plan hash>` produces runtime configuration. Invitation mode also creates private invitations; public mode deliberately does not. Securely back up the generated keys; offline admin and contract keys never go in the service directory.
5. After the precise role-funding budget and deployment transactions have been approved, use the existing `check-funding`, `tokenizer`, and `deploy` commands. Deployment is journaled and uses the exact new code hashes. The on-chain prepaid product marker must verify before a desktop manifest is exported.
6. Prepare the private account credentials below, then run `install-prepaid.sh` from the reviewed, clean backend commit. Configure the new HTTPS hostname to proxy to `127.0.0.1:3109`; verify `/health` shows `product: prepaid-usd-v1` and `/auth/methods` exposes a working account-creation method. This installer refuses to replace an existing prepaid service and never reconfigures the legacy service.
7. Add the exact deployed rewards contract to the independent Master app's saved daily recipients. Retain the reviewed production reburn and Mana reserve settings; determine the recipient percentage from that budget. The Master app closes cycles daily at its configured UTC hour and requires its own local wallet-password authorization. Purchase deposits are not automatically counted as block-production profits. Ordinary native KOIN transfers replenish the pool; no credit purchase/refund call is needed. Seed the pool with the separately approved 10,000 KOIN transaction and verify irreversible receipt.
8. Connect the verified new deployment in Test. Public mode uses normal verified sign-in at the new service origin and does not require invitation import. Invitation mode retains its private manifest/invitation flow. Existing pilot account files and unresolved wallet transactions remain preserved; connecting the new service does not move the old KOIN balance.

## Model catalogs and tokenizer installation

New multi-model USD settings use `models: [{ tariff, tokenizer }]` instead of
`tariff`. The two formats cannot be mixed. Every entry contains its full version-1
text tariff and pinned tokenizer manifest. Mainnet preparation verifies model
aliases, package hashes and input/output USD rates against the approved 15-model
schedule. Missing manifests, duplicate aliases, changed hashes/rates and
unpriced free/qualification models fail before generating keys. Price approval
does not establish tokenizer accuracy or provider qualification.

The example retains all 15 models with exact checked-in reference manifests,
verified against the manifest file hashes in
`lib/koin-network/tokenizers/candidates/index.json`; no tokenizer or template
pin has been guessed. The five Llama/Gemma packs use bounded pinned public GGUF
metadata and 145 native reference checks. A reference-prepared entry is not runtime-calibrated,
provider-qualified or activated. Actual GGUF token counts, rendered prompts,
model behavior and latency still need verification. The example supplies no
invented qualification policy, operational funding or deployment authority.

Configuration produces runtime schema 2 and a commitment to the entire sorted
model catalog. `setup.js tokenizer` installs each checked pack under
`tokenizer/<model-alias>/`; schema 1 keeps its original flat tokenizer directory
and signed policy. The installer copies every selected pack, checks exact hashes,
and rejects symlinked pack directories. It never substitutes a missing pack with
Fast. The desktop manifest initially selects Fast if admitted, otherwise the
first admitted model; its policy pin commits every admitted model, and the normal
model picker determines subsequent requests.

An existing bootstrap is immutable. Adding a model is a reviewed policy change,
not permission to regenerate keys, replace deployment journals or rewrite saved
requests. Offline catalog models remain unavailable until calibrated artifacts
and current provider qualification exist. Use normal chat acceptance for each
available admitted model before describing it as ready.

## Public account service installation

First check whether the existing website already has usable sign-in credentials. On its host, from the reviewed backend checkout, run this read-only command as root:

```sh
node deploy/koin-mainnet/prepare-account-auth.js
```

It queries only `koinos.service`'s active process identity, reads a bounded copy of that process's environment in memory, and prints email/Google readiness and missing field names. It never prints credential values, sends mail, opens an account database, or changes a service. The source repository documents `/opt/koinos/kai.env` as the production EnvironmentFile; reading the effective process environment avoids guessing its quoting or missing systemd overrides. A check does not create any directories or files.

To prepare the reviewed inputs using those existing credentials:

```sh
node deploy/koin-mainnet/prepare-account-auth.js --prepare
```

This exclusively creates `/root/kai-prepaid-inputs/account-auth.json`, mode `0600`, in a private directory. It does not create the future bootstrap directory, generate keys, deploy contracts, or install the service. Only complete usable email/Google providers are copied; the status still identifies incomplete providers. The production SMTP port/TLS behavior is preserved explicitly, including implicit TLS on port 465 and existing `true`, `yes`, or `1` values. The source process must remain the same throughout preparation. A repeated `--prepare` succeeds with `alreadyPrepared: true` only when the existing protected file contains exactly the same selected credentials; it makes no write. Changed or unsafe files are never overwritten. Rerun without `--prepare` for a read-only status report. An alternate private path can be selected with `--output /absolute/private/account-auth.json`; all ancestors must be trusted real directories (root-owned sticky temporary directories are allowed), and the final parent must remain private.

For a minimal verified operator handoff, only `prepare-account-auth.js` and `account-auth-input.js` from the same reviewed commit are needed together; they require Node builtins and no npm install. Verify both files' provided checksums before running. The generated JSON is bounded to the same 16 KiB limit enforced by the service installer.

Provider readiness here means the configuration passes validation, not that email delivery or Google's new redirect URI has been tested. No existing account IDs, cookies, session secrets, wallet keys, application flags, or database paths are copied. The helper does not modify production environment files or register an OAuth callback. If neither provider is usable, supply the missing provider settings through the operator's secure local credential workflow instead of pasting secrets into chat.

The resulting input must be a root-owned, mode `0600`, regular JSON file outside the checkout. The installer rejects symlinks, other owners, group/world access, unknown names, incomplete providers and multiline values. Never paste real credentials into a command, chat, issue, or source file.

The JSON may contain only these string fields:

| Provider | Required | Optional |
| --- | --- | --- |
| Email codes | `SMTP_HOST` and a sender (`SMTP_FROM` or `SMTP_USER`) | `SMTP_PORT` (default `587`), `SMTP_SECURE` (`"true"` or `"false"`, default `"false"`), paired `SMTP_USER` and `SMTP_PASS` |
| Google | Both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | None |

At least one complete provider is required for public mode; both may be configured. An unauthenticated SMTP relay requires an explicit `SMTP_FROM`. The installer validates configuration shape, not SMTP delivery or the validity of OAuth credentials. For Google, register **exactly** `<scheduler origin>/auth/google/callback` with the provider. For example, a scheduler at `https://credits.koinosai.com/scheduler` uses `https://credits.koinosai.com/auth/google/callback`.

Once the deployment and installation have been approved, the public-mode invocation is:

```sh
bash deploy/koin-mainnet/install-prepaid.sh /absolute/private/bootstrap-directory /root/kai-prepaid-inputs/account-auth.json
```

Invitation mode omits the second argument and requires its existing `invitations.json`. Neither mode creates guessed credentials or an authentication bypass. Validation and private staging finish before creating the new service user or copying installed configuration.

The generated `/etc/kai-koin-prepaid/account.env` is root-owned, mode `0600`, and read by systemd through `EnvironmentFile`. It is never sourced as shell code. The configuration directories are root-owned and not writable by the service. The runtime signing credentials and invitations remain mode `0600` for the service user; non-secret configuration, including the signed parity envelope, is root-owned and readable only by the service group. The service retains `ProtectHome=yes` and a read-only `/etc/kai-koin-prepaid` view.

Public accounts use their own `/var/lib/kai-koin-prepaid/accounts/accounts.sqlite`. An existing website email address can sign in again, but this installation does not reuse the website's database, cookies or sessions. No production account database or old payment journal is copied or modified.

With pricing schema 1, the installer verifies the initial parity envelope's signature, identity and freshness, copies its exact bytes to `/etc/kai-koin-prepaid/parity.json`, and rewrites only `purchasePricing.parityFile` in the installed runtime. The original bootstrap and all other pricing pins stay unchanged. The reviewed parity publisher must then refresh this installed file atomically before expiry. With explicitly reviewed schema 2, the installer verifies the merchant reference matches the native deployment, preserves the complete runtime bytes, and creates no parity file or signing key. Neither mode is enabled by installing the auth input alone.

Before the first buyer test, verify HTTPS `/health`, `/auth/methods`, actual email/Google sign-in at `/account`, wallet linking, configured free-credit behavior, fresh pricing and a qualified online provider. `/auth/methods` reports which methods are configured; a successful real sign-in verifies delivery/provider setup. Then test one approved credit purchase through the normal desktop **Buy credits** flow and wait for confirmed credits before sending chat. Source checks do not perform this live acceptance.

## Existing funds and final acceptance

Reconcile old available and reserved buyer KOIN and any completed paid jobs from their original records. Preserve the old contract's refund rights. A migration must identify the original owner, amount, source transaction/contract, destination account, and a unique conversion receipt. Only verified funding of the destination can become purchased credits. Do not credit the old reserve from a screenshot, erase the legacy ledger, reuse the earlier reward-retry approval, or deploy the new code at the old contract address.

The current owner's 0.1 KOIN is an outstanding migration item, not an already converted purchase. The new service can be tested independently while that legacy obligation remains visible in the operator record. A sponsor-funded replacement would need its own explicit funding authorization and must not also convert the same legacy amount later.

Acceptance is through the actual two computers: provider On → ONLINE; buyer Buy credits → one payment approval → confirmed credits → Chat → answer → one credit debit. Repeat with Stop, provider Off, disconnects, restarts, low balance, and a delayed payout. No reservation, release, settlement, or backend test-panel action belongs in this acceptance flow. Do not promote Alpha/public launch until this passes and the old customer balance is resolved.
