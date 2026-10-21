# USD credits activation review — October 21, 2026

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

## One commercial policy to review

These are proposed initial **Koinos Fast** settings, not installed prices or a
claim of profitability:

| Setting | Proposal | USD atoms in configuration |
| --- | --- | --- |
| Input usage per million AI tokens | $0.10 | `10000000` |
| Output usage per million AI tokens | $0.30 | `30000000` |
| Daily free allowance per verified account | 7.5 credits ($0.0075) | `750000` |
| Daily network free ceiling | 300 credits ($0.30) | `30000000` |
| Daily origin free ceiling | 22.5 credits ($0.0225) | `2250000` |

Free concurrency is one request per account. At the higher output tariff, the
account allowance covers 25,000 AI tokens, subject to the shared budgets; it is
not 25,000 service credits. Free usage is consumed before purchased credits.
The network ceiling permits 40 full allowances; the origin ceiling permits
three. Reverse-proxy origin grouping needs explicit acceptance before a wider
cohort. One example with 1,000 input and 250 output tokens costs 0.175 credits.

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
| Wrapped/native reference | Explicit trust policy, verified deployed bridge evidence and an operational evidence publisher; a signed assertion alone does not establish redemption availability |
| Provider qualification | Unambiguous candidate suite, measured intended-model results, reviewed admission policy and fresh signed provider checks |
| Free credits | Approved model/account/network/origin policy plus matching funded contract sponsorship |
| Funding and Master replenishment | Exact seed/role transfers and daily recipient allocation, preserving existing production reburn and Mana retention |

The source audit found that the native rehearsal had still pinned an older
desktop commit with incompatible ABIs. The updated provenance check verifies
the desktop commit, clean tracked files, shared-file hashes and all four ABIs
before the disposable chain can start. Current contract builds and contract
probes are separate evidence from a native-chain run. The existing native
harness covers paid invitation-mode purchase/chat/recovery; it is not a claim
that public signup, daily free credits or normal desktop streaming has passed.

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

## Operator preparation now

From the reviewed backend revision, run:

```sh
node deploy/koin-mainnet/prepare-account-auth.js --prepare
```

The helper prepares only `/root/kai-prepaid-inputs/account-auth.json` from the
active `koinos.service` process, with private permissions and credential-free
status output. See [PREPAID.md](PREPAID.md) for its exact behavior. A server that
uses another production service name must be identified explicitly; the helper
does not search arbitrary process environments. Keep the future
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
4. Use normal Chat and verify one measured debit. Test Stop, partial answer,
   restart, insufficient balance, provider Off and unavailable purchase prices.
   Pricing or reward delays must not freeze already purchased credit use.
5. Use genuinely independent buyer/provider accounts for work-reward acceptance;
   account-wide self-work exclusion also covers linked wallets.
6. Verify the seed and daily Master replenishment, then three closed reward days
   with correct claims/payouts. Resolve the preserved legacy balance separately.

The first complete two-computer acceptance, including free credits, must pass
before representing the new credit product as usable.
