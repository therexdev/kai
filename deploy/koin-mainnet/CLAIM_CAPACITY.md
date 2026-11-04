# Provider payout sponsorship capacity

The pilot's claim sponsor had a 500,000,000 RC daily reservation allowance and
a 100,000,000 RC ceiling per transaction: five new claim reservations per UTC
day. On November 4, 2026 the sponsor held 10 KOIN. One confirmed claim used
83,422,722 RC (0.83422722 Mana); this is one observation, not a guaranteed future
price. Koinos Mana regenerates at 20% of the KOIN balance per day.

## Planning tiers

One payout per provider per day, at the full existing one-Mana transaction
ceiling, plus 25% reservation headroom. Five days of that allowance covers the
regeneration period. These are funding estimates, not measured throughput.

| Providers/day | Daily claim reservations | Daily RC allowance | Sponsor KOIN target |
| ---: | ---: | ---: | ---: |
| 100 | 125 | 12,500,000,000 | 625 |
| 500 | 625 | 62,500,000,000 | 3,125 |
| 1,000 | 1,250 | 125,000,000,000 | 6,250 |

Initial operating target: 100 providers/day. With the observed 10 KOIN sponsor
balance, the top-up is 615 KOIN. Re-read the balance before a later transfer;
the configuration command reports the current shortfall in eight-decimal atoms.
Send native KOIN to the dedicated **claims sponsor** shown in that report.
The command never transfers tokens or loads private keys. KOIN remains in the
sponsor wallet and supplies Mana; it is not deposited into the reward pool.

At the currently sampled cost, the 100-provider estimate would be about 521.4
KOIN including 25% headroom. We use 625 instead, covering the full signed ceiling.
Actual resource prices and Merkle proof depth can change. If a larger proof
exceeds the current transaction ceiling, this allowance alone will not fix it.

## Install and configure

Use the clean reviewed commit based on `6cac5a0f2e5ce37959351d186f66da9a9618fb69`.

```bash
node deploy/koin-mainnet/update-claim-capacity.js
node deploy/koin-mainnet/configure-claim-capacity.js --plan 100
node deploy/koin-mainnet/configure-claim-capacity.js --apply 100
```

The installer changes code only, checks a clean shutdown and both loopback and
public HTTPS health, and retains current journals during code recovery. It does
not configure a larger budget. The explicit apply command atomically writes
`/etc/kai-koin-prepaid/claim-sponsorship.json`, root-owned and group-readable. It
binds the allowance to the exact original claim ledger identity. Each new claim
reservation reads it, so setting the allowance needs no additional restart.
No existing identity, reservation, signature, transaction, recipient or reward
allocation is rewritten. Nonce, Mana, retry, custody, review and finality checks
still apply. Settlement and lifecycle budgets remain at their configured values.

Missing authorization uses the original ledger budget. Malformed, writable,
wrong-owner or wrong-ledger authorization is rejected. A code rollback ignores
the extra configuration file and returns to the original conservative budget.
Operator status exposes `claimSponsorship`, including reserved amounts and
remaining full reservations. An applied allowance is not proof of payment or
proof of adequate funding.

## Scaling boundaries

The current claims engine has one unresolved sponsor nonce at a time and waits
for irreversible evidence before proceeding. It also bounds a manifest to 1,024
allocations and the pending queue to 1,024 claims. The 500/1,000-provider tiers
are financial estimates, **not supported throughput claims**. Measure completion
rate and backlog before admitting that volume; larger deployments need a
reviewed batching or sponsor-sharding design and larger queue capacity.

The reward pool is separate. Its daily allocation is drawn from the existing
pool policy; adding providers divides that allocation among more participants.
Maintaining any chosen per-provider reward requires a separate pool-funding
decision. This update makes no promise of a fixed earning rate and changes no
reward amounts, contract settings, free-credit grants or account permissions.

Sources: https://docs.koinos.io/overview/mana/ and
https://docs.koinos.io/developers/rc-limits/.
