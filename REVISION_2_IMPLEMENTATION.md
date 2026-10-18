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

Sponsored usage is recorded separately and excluded from purchased contract
settlement. Its contract settlement and provider reward inclusion remain to be
implemented; do not activate free service as a paid-provider launch yet. No fake
purchase or wallet balance is created for a daily grant.

The approved Uniswap v4 market is pinned, but its reorg-aware observation and
validated quotation adapter remains unfinished. The purchase-only guard stays
unavailable; it never falls back to the old ticker feed or an invented price.
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
