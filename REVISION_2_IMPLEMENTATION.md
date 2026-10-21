# Revision 2 implementation checkpoint

This branch is not a deployed or complete product. It starts from
`codex/koin-mainnet-pilot` at `fc67f72d7e712b5cc79691da5f042d8f56240777`.
Production services, old custody contracts, old signed transactions, and reward
epoch 20742 have not been changed.

Implemented: optional public verified accounts; durable daily free-credit caps;
atomic free-first and purchased accounting; Free only and maximum-paid limits;
signed incremental streaming with encrypted prefix recovery; exact claimant-aware
purchase confirmation and a unique confirmed transaction index. The original
purchase table is retained. Existing purchased credits do not depend on price
quotes or another purchase's confirmation.

Free policy has no defaults. `accountDaily`, `networkDaily`, and `originDaily`
are USD atoms, not historical AI tokens. `accountConcurrent`, `eligibleModels`,
and `version` must also be explicit. Public accounts use the existing verified
account service; sessions and credentials are not written to credit journals.
Reverse-proxy clients conservatively share an origin budget until a separately
trusted origin adapter is configured; untrusted forwarding headers are ignored.

Sponsored usage now settles through one combined USD receipt, with the paid
portion debited separately and the sponsored portion recorded under explicit
contract account/day and network/day ceilings. Zero disables sponsorship.
New free admission requires fresh matching contract ceilings and positive
uncommitted reward funding. Purchased usage stays independent. Only finalized
sponsored USD work enters the fixed reward pool. No fake purchase or customer
balance is created. Earlier mixed receipts already settled under the paid-only
implementation remain blocked for explicit recovery; their signed intent is never
rewritten. Do not activate until independent review and real acceptance complete.

The approved Uniswap v4 market is pinned. Its archive adapter validates canonical
finalized histories, time-weighted prices, executable depth, deviation, configured
USDT/USD rounds and signed wrapped/native parity evidence. Reviewed policies and
live archive acceptance remain unavailable; no ticker or invented-price fallback
exists. See V4_PURCHASE_PRICING.md. Exact USD packs round native atoms upward and
return the actual signed credit amount.
USD tariffs, the free budget comparable to historical 25,000 AI tokens/day,
and Master allocation remain commercial decisions. No live entitlement is set.

Local validation: all 344 `scripts/probe-koin-*.js` tests passed, including a real
loopback verified signup and HTTP streaming/cancellation. Tests use fixture
budgets and signatures; they are not mainnet deployment, two-computer earning
acceptance, or delayed payout verification. This executor uses Node 24.19.0;
deployment declares Node 22. Existing provider qualification expired October 16;
the changes do not automatically renew eligibility. That historical checkpoint preceded the qualification and run-budget continuations below.

Fresh contract deployment/funding and live financial operations require the
exact reviewed plan. The approved Revision 2 acceptance period is three closed
reward days with payouts; the earlier seven-day uncertainty is superseded.

### Prototype-backed network overview continuation

Added authenticated `/koin/prepaid/network` observations for the secondary Network page. Counts come from actual provider readiness and queued/delivered ledger state. Duplicate connections count once; future heartbeats and expired qualification never imply readiness. Provider labels are pseudonyms; prompts and wallet addresses are omitted. Observations expire within 15 seconds or earlier qualification expiry. Recent activity includes verified partial replies as delivered work, without claiming a payout. Full backend probes: 345 passed. No deployment or service mutation was performed.

### V4 pricing continuation

Implemented an archive-history reader, integer time-weighted/depth/deviation validator, canonical anchor checks, two-source agreement, a configured USDT/USD oracle reader, and domain-separated signed wrapped/native redemption attestations. Pricing warm-up runs separately from settlement. Missing/invalid pricing configuration or evidence fails only new quotes; quote expiry is bounded by evidence. There is no v3 observe or spot fallback. Dry configuration tooling creates no credentials and performs no RPC or financial action. Full backend suite: 357 passed. See V4_PURCHASE_PRICING.md for trust boundaries and unchosen policy. No mainnet quote, live deployment, funding or transfer was performed.

Public USD admission now rejects missing or legacy billing modes before the old token allowance can run. The HTTP signup/streaming probe exercises this scheduler boundary. Full KOIN suite: 359 passed, zero failures. No production activation or live transaction was performed.

Capped sponsorship continuation: 375 backend and cutover-preparation tests pass; matching desktop contracts build, 38 AssemblyScript tests and 12 built-WASM entry-point probes pass. These are isolated tests. Sponsor ceilings use explicit freePolicy values in new deployment plans; no default commercial budget is installed. Existing zero-cap contract responses normalize added zero fields so earlier signed funding policy hashes remain unchanged.

### Guided qualification continuation

Automatic qualification is optional and inactive without an explicit reviewed policy. Configuration requires the reviewed evidence hash, exact accepted benchmark answers, pass count, latency limit, model pin and reward weight. Fresh per-attempt signed results run through the approved tokenizer/model path; they never enter customer billing or earnings. Durable evidence survives restart, expires after 24 hours and renews before expiry. A failed or in-progress renewal cannot advertise ONLINE. Changed device identity, replayed results and future-dated readiness evidence are rejected. The earlier October 16 qualification and reward epoch 20742 were not renewed or changed.

Local backend validation after this continuation: 368 KOIN tests pass, including the real HTTP scheduler poll/result boundary, restart/renewal, forged answers and repeated result submission. These are fixture checks, not model-quality or two-computer acceptance. Fresh intended-model measurements and reviewed pass/latency criteria remain required; the expired 7/10 artifact is historical evidence only. No criteria have been silently weakened, no runtime policy was installed and no production service changed.

Multiple linked wallets now require an explicit `creditWallet` selection for spending and the host lease. The server verifies membership; a walletless free request retains the same verified-account allowance. No balances are combined or moved. Recovery continues to use the original account-bound job owner. Full backend/cutover validation: 380 tests, 380 pass, zero failures. These remain isolated/local tests.

### Total run budgets and public earnings

Research/Agents/Teams now use account-bound immutable run approvals in the same SQLite transaction/recovery domain as the credit ledger. A total ceiling covers concurrent model holds and verified delivered usage, including streaming partials, retries and free/paid allocation. Stop cancels unfinished calls without charging them and retains delivered intermediate results; repeated requests and restart never create a second debit. Model, wallet and Free only cannot change mid-run. Public capabilities advertise only supported USD account routes. Local tool execution remains subject to existing desktop permissions.

The authenticated provider status response now supplies its observation time for public account earnings. Payout epoch strings and unresolved review states are preserved; no old reward is reset or submitted.

This is source implementation, not production activation. The reviewed pricing/commercial configuration, benchmark quality/latency criteria, independent financial review, fresh authorized deployment/funding, real two-computer acceptance and three closed reward days with payouts remain outstanding. No production services or live financial operations were changed.

### October 21 operator-report follow-up

The server report confirms only the legacy product at the checked paths. The
new USD service/configuration is missing; one old signed record remains a
separate reconciliation obligation. See
[the concrete activation review](deploy/koin-mainnet/ACTIVATION_REVIEW.md).

Fixed the stale native-rehearsal source pin and added commit/shared-hash/ABI
validation. Built the exact Test 201.1 contracts; all 12 WASM probes passed.
Added protected, idempotent existing-provider auth preparation, a read-only
pricing preflight, and a candidate-only local model evaluator. Future provider
archives retain the fields needed to reverify their result signatures; legacy
archives remain readable without being called independently verifiable.

All 73 focused activation/source/pricing/qualification tests passed locally.
The first live public-endpoint capability run returned matching five-minute
market history, depth and USDT/USD evidence, but remains incomplete without
trusted parity evidence. There is still no bridge evidence publisher or real
new-model qualification policy. No customer account, service configuration,
contract, wallet signature or KOIN transfer was changed by this work.

### Auth preparation completed; explicit exchange-reference option

The operator successfully prepared the protected SMTP/Google input from the
active server process at revision `885187b`. Both providers are configured;
new-origin sign-in is not yet verified and no service changed. That revision's
full CI and all 45 isolated native-chain checks passed.

The next source revision adds an explicitly selected schema-2 merchant
exchange-reference policy. It uses the validated vKOIN market as the commercial
rate for native KOIN without claiming bridge redemption, creating a parity key,
or silently replacing schema 1. The review proposal and commercial risks are in
the activation review. It is unapproved and not installed. Both schemas now
enforce executable native purchase size before signing, using unrounded price
arithmetic so integer-rate rounding cannot authorize excessive notional.

The native USD harness now adds public email verification, signed wallet linking,
free credit visibility, free-first streaming and exact sponsored settlement after
restart. Its emails and model outputs are controlled fixtures; live signup,
provider qualification, real two-computer use and funding remain outstanding.

### All-model pricing correction — October 21

The legacy scheduler already allows and provisionally prices 15 public model
classes; 11 were advertised online around 04:03 UTC. The new prepaid config,
qualification/readiness and desktop selection still assume Fast. That is an
implementation gap, not a requirement to launch a Fast-only product.

[The complete pricing and implementation review](deploy/koin-mainnet/MODEL_PRICING_REVIEW.md)
and its [machine-readable proposal](deploy/koin-mainnet/model-rates.proposal.json)
cover every non-development desktop catalog alias, pinned to Test 201.1 package
hashes. They retain 1,000 credits/$1 and propose lower per-model usage prices.
They supersede the prior Fast-only commercial tariff proposal, without activating
rates or changing live records. The review identifies multi-tariff config,
per-package calibrated metering, per-model qualification and matching desktop
signed-policy work required before multi-model acceptance.

The preceding source revision `41f1e3b` passed full CI and 48 isolated native
checks. Those checks used controlled model output and do not close this gap.
