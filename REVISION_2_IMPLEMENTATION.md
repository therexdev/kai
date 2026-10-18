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
the changes do not automatically renew eligibility. Automated proof renewal,
advanced-mode budgets, and the remaining desktop redesign are unfinished.

Fresh contract deployment/funding/credentials and live financial operations
remain outside this task's authorization. Three closed reward days versus seven
telemetry days must be resolved before claiming acceptance.

### Prototype-backed network overview continuation

Added authenticated `/koin/prepaid/network` observations for the secondary Network page. Counts come from actual provider readiness and queued/delivered ledger state. Duplicate connections count once; future heartbeats and expired qualification never imply readiness. Provider labels are pseudonyms; prompts and wallet addresses are omitted. Observations expire within 15 seconds or earlier qualification expiry. Recent activity includes verified partial replies as delivered work, without claiming a payout. Full backend probes: 345 passed. No deployment or service mutation was performed.

### V4 pricing continuation

Implemented an archive-history reader, integer time-weighted/depth/deviation validator, canonical anchor checks, two-source agreement, a configured USDT/USD oracle reader, and domain-separated signed wrapped/native redemption attestations. Pricing warm-up runs separately from settlement. Missing/invalid pricing configuration or evidence fails only new quotes; quote expiry is bounded by evidence. There is no v3 observe or spot fallback. Dry configuration tooling creates no credentials and performs no RPC or financial action. Full backend suite: 357 passed. See V4_PURCHASE_PRICING.md for trust boundaries and unchosen policy. No mainnet quote, live deployment, funding or transfer was performed.

Public USD admission now rejects missing or legacy billing modes before the old token allowance can run. The HTTP signup/streaming probe exercises this scheduler boundary. Full KOIN suite: 359 passed, zero failures. No production activation or live transaction was performed.

Capped sponsorship continuation: 375 backend and cutover-preparation tests pass; matching desktop contracts build, 38 AssemblyScript tests and 12 built-WASM entry-point probes pass. These are isolated tests. Sponsor ceilings use explicit freePolicy values in new deployment plans; no default commercial budget is installed. Existing zero-cap contract responses normalize added zero fields so earlier signed funding policy hashes remain unchanged.

### Guided qualification continuation

Automatic qualification is optional and inactive without an explicit reviewed policy. Configuration requires the reviewed evidence hash, exact accepted benchmark answers, pass count, latency limit, model pin and reward weight. Fresh per-attempt signed results run through the approved tokenizer/model path; they never enter customer billing or earnings. Durable evidence survives restart, expires after 24 hours and renews before expiry. A failed or in-progress renewal cannot advertise ONLINE. Changed device identity, replayed results and future-dated readiness evidence are rejected. The earlier October 16 qualification and reward epoch 20742 were not renewed or changed.

Local backend validation after this continuation: 368 KOIN tests pass, including the real HTTP scheduler poll/result boundary, restart/renewal, forged answers and repeated result submission. These are fixture checks, not model-quality or two-computer acceptance. The earlier 7/10 benchmark artifact and approved pass/latency criteria remain required; no criteria have been silently weakened. No runtime policy was installed and no production service changed.

Multiple linked wallets now require an explicit `creditWallet` selection for spending and the host lease. The server verifies membership; a walletless free request retains the same verified-account allowance. No balances are combined or moved. Recovery continues to use the original account-bound job owner. Full backend/cutover validation: 380 tests, 380 pass, zero failures. These remain isolated/local tests.
