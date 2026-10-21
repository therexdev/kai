# USD credits activation review — October 21, 2026 (UTC)

This records the next activation work after the operator's read-only report at
`2026-10-21T03:04:57.955873+00:00`. It is a review document, not permission to
transfer KOIN or a claim that the service is ready.

## What the server report establishes

The checked legacy service is running at `28ee1a81b24c3aad5b55190cfbd7890d4077b763`.
Its local journal contains one signed transaction and reward steps marked
`needs_review` (five) and `queued` (15). Those are local states, not verified
blockchain failures. Preserve the service, original balances and journals.

At the known separate USD paths, the service, configuration, account environment
and journals are missing, and its endpoints are unavailable. This explains why
publishing the desktop alone has not enabled Buy credits. The legacy service's
Master-match result is not a verification of the new purchase destination.
The report did not verify chain balances, contract code, pricing or finality.

Subsequent operator preparation succeeded at backend revision
`885187be608a17e1aef41fb7679db56a8ff1d63b`: both email and Google settings are
configured in `/root/kai-prepaid-inputs/account-auth.json`. The helper reported
`configurationOnly: true`, `signInVerified: false` and `serviceChanged: false`.
This step is complete. Do not repeat it or ask the operator to disclose its
contents. New-origin email delivery and Google callback acceptance still need
the installed service.

Preparation and installation of the separate product do not require clearing
the legacy signing record. Its eventual reconciliation remains a separate
obligation, and must be finished before public launch.

## Product decisions already fixed

- 1,000 nontransferable service credits equal $1. Purchased credits have no
  expiry and are nonrefundable. They are separate from AI token counts.
- Purchase KOIN goes in full to Master
  `15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T`.
- A separate 10,000 KOIN seed funds rewards. The daily ceiling is 5% of the
  uncommitted pool, with 70% availability and 30% completed-work weighting.
- Reward review is one day plus chain finality. Observe three closed reward
  days and actual payouts before the limited cohort; no seven-day requirement
  is introduced here.
- Buyer flow: sign in, see credits, Buy credits, approve one KOIN purchase,
  use normal Chat. Provider flow: Share AI capacity, guided checks, ONLINE/Off.
- Use public accounts on the separate prepaid service. The proposed hostname
  is `credits.koinosai.com`, proxying to loopback port 3109; DNS/TLS still need
  verification. The current desktop remains Test 201.1 until verified new
  deployment pins justify another app publication.

## Approved model prices and remaining commercial settings

The [all-model pricing review](MODEL_PRICING_REVIEW.md) supersedes the Fast-only
$0.10/$0.30-per-million proposal. It covers all 15 existing public model aliases,
with owner-approved input/output rates from $0.01/$0.04 for Fast to $0.08/$0.32 for the
32B tier. The runtime and desktop now have source support for multiple models. Commercial
approval and source implementation do not complete live activation. Full catalog
configuration, metering, per-model qualification and desktop selection are
required before calling the product multi-model ready.

| Setting | Proposal | USD atoms in configuration |
| --- | --- | --- |
| Model-specific rates | [Complete 15-model schedule](model-rates.proposal.json) | Explicit per-model integer rates |
| Daily free allowance per verified account | 7.5 credits ($0.0075) | `750000` |
| Daily network free ceiling | 300 credits ($0.30) | `30000000` |
| Daily origin free ceiling | 22.5 credits ($0.0225) | `2250000` |

Free concurrency is one request per account. Free usage is consumed before
purchased credits. The unchanged proposed budget now buys more usage at the lower
model tariffs: 187,500 output-only Fast tokens, before input charges and shared
caps. It is not a fixed AI-token entitlement. The network ceiling permits 40 full
allowances; the origin ceiling permits three. Free-eligible models and
reverse-proxy origin grouping still require explicit policy. With 1,000 input
and 250 output tokens, proposed Fast usage costs 0.02 credits.

The approved reward-seed amount does not authorize an unspecified extra role
budget. Engineering must present fresh contract destinations, proposed per-role
funding, the buyer test ceiling and the aggregate cap together. Mainnet dry-run
Mana measurements must fit that approved cap before deployment. No old
1,000-KOIN pilot limit or fixture receipt establishes the new budget.

## Engineering work and its limits

| Work | Evidence required before activation |
| --- | --- |
| Exact contract source | Desktop `da0713a3ea6d7bb2ee13ccbf96e389f1bb83b4dc`, matching backend ABI/provenance hashes, contract tests and isolated native-chain run |
| Public authentication | Protected reuse of only existing SMTP/Google settings; actual new-origin sign-in and callback/delivery verification |
| Exchange pricing | Two capable independent archive sources; actual finalized history, executable depth, USDT/USD freshness and justified policy bounds |
| Wrapped/native reference | Select the explicit merchant-reference proposal below, or finish the schema-1 bridge evidence collector and publisher; never fabricate an attestation |
| All-model credit support | Complete 15-model rate catalog, matching signed policy, per-package metering, selected-model desktop flow and cross-model debit/recovery acceptance |
| Provider qualification | Per-model candidate suites, measured intended-model results, reviewed admission policy and fresh signed checks for each provider/model pair |
| Free credits | Approved model/account/network/origin policy plus matching funded contract sponsorship |
| Funding and Master replenishment | Exact seed/role transfers and daily recipient allocation, preserving existing production reburn and Mana retention |

The source audit found that the native rehearsal had still pinned an older
desktop commit with incompatible ABIs. The updated provenance check verifies
the desktop commit, clean tracked files, shared-file hashes and all four ABIs
before the disposable chain can start. At backend revision `885187b`, full CI
and all 45 native-chain checks passed, including signed desktop streaming,
duplicate-prefix protection and lost-response recovery. That run used invitation
accounts and controlled model output. The next harness adds public-account HTTP
verification, wallet linking and free-first usage with native sponsorship;
its results must be recorded separately, never inferred from the earlier run.
At `41f1e3b880a2bacbfdef7bfc27eec90ec69d2b15`, full CI and all 48 isolated
native checks passed, including the public-account/free-first fixtures. These
controlled outputs do not establish actual model quality or multi-model readiness.

Pricing and qualification have working mechanisms, but their production
evidence is unfinished engineering. There is no automatic Vortex evidence
publisher in this source. The previous October 15 benchmark expired October 16;
its 7/10 score does not establish a new public admission threshold. A digest
field by itself is not proof that an underlying review artifact was verified.

The added read-only pricing preflight and candidate-model evaluator collect
evidence without activating service policy. A candidate suite's pass count is
not an ONLINE qualification. Successful source tests are not live acceptance.

The first [public-endpoint measurement](observations/2026-10-21-pricing-capability.json)
completed matching five-minute histories (25 blocks), both-direction $1 depth
probes and USDT/USD reads through PublicNode and dRPC. Their finalized anchor
was about 17 minutes old. The diagnostic remains **incomplete** because parity
evidence is missing. Its deliberately minimal liquidity bound is only a
capability measurement; do not install this input as a production policy.
One successful run does not prove sustained reliability or independent upstream
infrastructure. It does show that paid archive credentials are not yet a
demonstrated prerequisite to further read-only engineering checks.

Exact current build outputs (all 12 built-WASM probes passed):

| Contract | Bytes | SHA-256 |
| --- | --- | --- |
| `prepaid-usd.wasm` | 44,657 | `e87d504fa312b8a5c6d3a45f31d191cbc2577d3fa91c6d5750d0f2a80c7ea24d` |
| `rewards.wasm` | 42,592 | `883bcdfb87cfdf1ad4529468bc890db194c077e4ea0523d948c24bb572524a9e` |

## Recommended pricing decision

The [explicit proposal](pricing.merchant-reference.proposal.json) selects a
merchant exchange-reference rule: value each native KOIN at one vKOIN's validated
Uniswap v4 market price, converted from USDT to USD. This is a commercial price
convention; it does not claim that a bridge is redeemable or fully backed.
Customers pay native KOIN directly to Master and receive service credits.
Neither customer nor merchant makes a bridge transaction as part of that purchase.

This avoids operating a second signing key and renewable bridge attestation
publisher. The merchant accepts the risk that the vKOIN reference diverges from
native KOIN's realizable value. The existing schema-1 signed-parity path remains
unchanged and never silently falls back to this option. Explicit schema 2 and
the native chain/token identity are required; production policy approval is
still outstanding.

The review input proposes a five-minute finalized price window, 30-minute anchor
age ceiling, one-minute quote lifetime, 5% within-window price deviation, 2%
fee-adjusted depth deviation, 1% USDT/USD deviation, and a 24-hour USDT age ceiling.
Its active-liquidity floor is `1000000000000`, below the earlier observed
`2462531766982`; both directions must also execute the proposed 10-USDT probe.
These are review bounds, not economic guarantees or proof of sustained uptime.
The 24-hour stablecoin bound can cause purchase pauses near feed heartbeat and
finality boundaries. It has not been silently relaxed.

A subsequent [live read-only observation](observations/2026-10-21-merchant-reference.json)
passed the proposed schema-2 checks with matching archive histories and 10-USDT
buy/sell simulations. It remains unsigned, unapproved and unusable as a payment
quote. All 39 focused pricing/installer probes passed, including schema-1
regressions, native identity, precision-sensitive depth and a varying-price
window. This does not complete sustained-operation or installed-app acceptance.

The first commercial test pack is proposed at $1 (1,000 credits); no fixed KOIN
amount is invented. A quote's native amount must fit the checked executable
notional before signing, including upward rounding. This is a per-purchase
ceiling, not an aggregate daily sales cap. New price failures affect purchases
only; existing credits remain usable.

Price diagnostics include source blocks, reference/policy hashes and the depth
ceiling. The current signed purchase ABI commits to the amount, rate, account,
contract identity, runtime policy version and expiry, but does not include the full
diagnostic provenance. A durable mapping to the complete price evidence and
customer-facing Price details remain acceptance work; do not claim they already
exist from the diagnostic output.

## Operator preparation status

Auth preparation is complete; no further login-preparation command is needed.
See [PREPAID.md](PREPAID.md) for its exact scope. Keep the future
`/root/kai-prepaid-usd-bootstrap` path absent until final plan preparation.

Do not run `setup.js deploy`, install a service or fund a generated address
from this review document. The next financial review must contain the actual
hashed deployment plan, complete budget and verified code identities.

## Acceptance after deployment

1. Provider computer: enable sharing, pass current guided checks, show ONLINE;
   turning Off or losing model/freshness must remove eligibility.
2. Buyer computer: sign in, see free allowance, send normal Chat. Verify free
   consumption without a KOIN reserve or backend test-panel action.
3. Buy credits with one exact approved KOIN payment; finality increases the
   account balance once, including after a lost response or restart.
4. Select each admitted available model in normal Chat and verify its measured
   debit at its own rate; verify unavailable models cannot silently become Fast.
   Test Stop, partial answer,
   restart, insufficient balance, provider Off and unavailable purchase prices.
   Pricing or reward delays must not freeze already purchased credit use.
5. Use genuinely independent buyer/provider accounts for work-reward acceptance;
   account-wide self-work exclusion also covers linked wallets.
6. Verify the seed and daily Master replenishment, then three closed reward days
   with correct claims/payouts. Resolve the preserved legacy balance separately.

The first complete two-computer acceptance, including free credits, must pass
before representing the new credit product as usable.


## Approved pricing implementation checkpoint

The owner approved the full model-price plan on October 20 (America/Chicago).
Source now supports explicit multi-model deployment, full catalog commitments,
per-model qualification/readiness, normal desktop model selection, and recovery
using the saved approved tariff catalog. Unavailable models reject a new request
before allocating credit; recovery of a delivered answer does not require the
provider or current catalog to be online.

Ten model tokenizer packs have passed 79 independent reference vectors. Five
Llama/Gemma sources remain unfinished. Reference vectors establish tokenizer
agreement; actual loaded GGUF calibration and quality/latency checks remain
required per admitted model. The full 15-model example preserves these gaps
instead of silently narrowing the product to Fast. See
[TOKENIZER_PREPARATION.md](TOKENIZER_PREPARATION.md).

The isolated native USD harness now covers two distinct tariffs with controlled
Fast-tokenizer fixture aliases; it makes no second-model quality claim. Current
CI and installer outcomes must be checked at the final source revision before
calling this change released. Live credit-service deployment, actual model
admission and the two-computer acceptance are still outstanding.
