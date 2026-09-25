# KOIN paid-job development engine

Status: **shadow only; payments disabled**. This is the next implementation
after Test `0.54.12-test.141.1`, in the master review branch. It does not change
the running scheduler, Test installer, current billing or any payout. The
existing availability shadow router remains independent.

## Implemented

| Module | Responsibility |
| --- | --- |
| `lib/koin-network/metering.js` | Pinned tariff/tokenizer registry, exact integer quotes, domain-bound request/result signatures |
| `lib/koin-network/job-ledger.js` | SQLite reservations, job state, synthetic grant limits, persistent settlement intents |
| `lib/koin-network/finality.js` | Read-only transaction inclusion, receipt and irreversible-chain verification |
| `lib/koin-network/settlement-monitor.js` | Encodes the Test credits ABI; reconciles the exact pending intent against a pinned contract |
| `scripts/probe-koin-paid-jobs.js` | Financial invariants, multiple writers, abrupt exit, replay and fork recovery tests |

There is no HTTP endpoint, environment flag, wallet key, transaction submitter
or scheduler dispatch hook for this engine. `importSimulationGrant` creates
explicit synthetic test authority, not a claim of on-chain funding. Every quote,
intent, receipt and status remains marked `shadow`; request/result signature
domains also explicitly say SHADOW. There is no path from these simulated
charges to the daily paid-work reward pool.

## Metering and quotes

An in-process adapter must independently count the complete rendered prompt
and observed output, using the approved model, tokenizer and chat-template
hashes. All three pins must match its tariff entry. Each quote commits to the
model/version, pins, exact request hash, maximum output, atom-denominated rates,
maximum charge, context limit, total response deadline and five-minute expiry.
The complete tariff registry has a deterministic policy hash bound into the
simulation grant. A changed policy cannot spend an existing grant.

For input count `I`, output count `O` and per-million atom rates `Ri`, `Ro`:

`charge = ceil((I * Ri + O * Ro) / 1,000,000)`

All currency arithmetic uses bounded uint64 integers. No provider usage count,
character estimate, token-price fallback or default production model is accepted.
The only included tokenizer is a **test fixture** in the probe, using UTF-8 byte
counts to make verification deterministic. It is not a real model tokenizer and
must never price user work. Production adapter calibration is still required.

Only literal system/user/assistant messages are supported at this stage. Tool
calls, images, hidden reasoning tokens and other formats require explicit
metering rules before admission. Persisted records contain hashes, signatures
and counts, not plaintext prompts or responses. These records are still private
operational data: hashes are not anonymization or a reason to publish them.

The metering adapter and master challenge verdict are trusted in-process code.
Model/tokenizer pins supplied by a worker are not accepted as proof that it ran
those weights. Independent model qualification and challenge calibration remain
separate activation gates.

## Reservations and result validation

1. Create a quote using the configured adapter. The consumer signs a hash binding
   the shadow domain, session, unique job ID and exact quote.
2. Atomically reserve the maximum charge and a job slot with `BEGIN IMMEDIATE`.
   Existing settled spend plus all active holds must fit the session total;
   each hold also fits the per-job limit. Duplicate identical requests return
   the existing record. Reusing an ID with different terms is rejected.
3. Persist the assigned provider, dispatch timestamp, result deadline and random
   attempt ID before returning work. Expired/revoked grants and self-serving
   providers cannot dispatch. The maximum output must be enforced by the future
   worker dispatch adapter; this engine also rejects results above that ceiling.
4. Verify a provider signature over the domain, job, attempt, quote and exact
   output hash. The master must independently accept the SLA/challenge result.
   Recount output with the pinned adapter and reduce the hold to actual charge.
5. Freeze an ABI-compatible settlement intent containing the receipt hash,
   provider, policy hash, charge and dispatch time. Only one unresolved session
   nonce is prepared at once; subsequent jobs wait for reconciliation.

The states are `reserved`, `dispatched`, `verified`, `prepared`, `submitted`,
`settled`, and `cancelled`. Cancellation wins only before verification. Later
disconnects cannot release verified or possibly charged work. A revoked session
blocks new dispatch while allowing earlier dispatches within its shortened
settlement deadline; revoking again never extends that deadline.

The SQLite database uses WAL, `synchronous=FULL`, a write lock, private file
permissions and an immutable domain identity. Independent processes use the
same transactional checks, so concurrent reservations cannot both spend the
same remaining amount. Startup refuses a missing/conflicting identity or corrupt
database; it does not silently begin with an empty financial ledger.

## Settlement and recovery

The settlement monitor binds its chain ID, credits address and bytecode hash
to the ledger permanently. It encodes the exact stored charge using the copied
generated credits ABI and checks the pinned contract metadata/authority flags.
It never takes an expected contract call from a worker or caller's HTTP body.

For a recorded transaction it verifies the chain, transaction ID commitment,
single exact contract operation, containing block, chain-reported irreversible
height, canonical block at that height and transaction receipt. Looking up an
old block by ID or waiting for SDK inclusion alone does not prove finality.
Only successful irreversible execution advances the simulated spend and nonce.
The evidence is retained with the record. Reconciliation is idempotent.

Unknown/mempool/reversible/forked/reverted transactions retain their holds. RPC
errors or changed bytecode also leave state untouched. Recovery does not invent
a replacement transaction or assume that a timed-out submission never executed.
It expires only undispatched quotes and dispatches whose result deadline passed.
Verified and uncertain work remains reserved for explicit reconciliation.

`confirmSimulation` is the internal fixture completion primitive used by the
read-only monitor and tests. It is not a live settlement proof or a public API.
Production must replace simulation grant import with finalized funded-session
verification and control all ledger mutations behind the trusted service boundary.

## Remaining integration and activation gates

- Calibrate real local tokenizers, chat templates, model tariffs and SLA/challenge
  rules; ensure the adapter verifies its actual artifacts rather than merely
  declaring matching pins. No production prices are supplied here.
- Verify funded grants, balances, revocations and policy from finalized chain
  state; coordinate session ownership across verifier replicas. The current
  synthetic grant API must never become remote spending authorization.
- Implement reviewed client quote acceptance and the new bound provider receipt
  protocol, then connect durable dispatch to the canonical scheduler. Existing
  `jobId|output` signatures and provider-reported usage are not sufficient.
- Add the restricted settlement keeper, sponsored Mana budget, durable signed
  transaction outbox, explicit reverted/expired-intent repair and backup recovery.
  The transaction ID must be recorded before a future submitter broadcasts it.
- Publish signed reward manifests only from reconciled real paid charges.
  Add retention, rate/admission limits and load testing before service exposure.
- Complete isolated-chain transfer/resource testing and contract review,
  seven-day real shadow validation, deployment pins and the owner's concrete
  funding/deployment review. Existing mainnet balances and reburn policy remain
  unchanged.

Run `node scripts/probe-koin-paid-jobs.js` on Node 22. The normal CI probe glob
includes it automatically. Tests use local SQLite, synthetic tokenizers and
fixture RPC responses; they are not a claim of production measurements or a
live-chain contract audit.

Primary implementation references:
[Node SQLite](https://nodejs.org/docs/latest-v22.x/api/sqlite.html),
[Koinos finality](https://docs.koinos.io/exchanges/finality/), and the installed
`koilib` 9.3 provider/transaction implementation. The monitor trusts its pinned
RPC service; it is not a cryptographic light client.
