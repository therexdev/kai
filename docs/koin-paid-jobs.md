# KOIN paid-job development engine

Status: **shadow only; payments disabled**. The master review branch now has
an opt-in scheduler/worker flow and a real Qwen tokenizer adapter. It does not
change the running production scheduler, current billing or any payout. The
existing availability shadow router remains independent.

## Implemented

| Module | Responsibility |
| --- | --- |
| `lib/koin-network/metering.js` | Pinned tariff/tokenizer registry, exact integer quotes, domain-bound request/result signatures |
| `lib/koin-network/job-ledger.js` | SQLite reservations, job state, synthetic grant limits, persistent settlement intents |
| `lib/koin-network/finality.js` | Read-only transaction inclusion, receipt and irreversible-chain verification |
| `lib/koin-network/settlement-monitor.js` | Encodes the Test credits ABI; reconciles the exact pending intent against a pinned contract |
| `lib/koin-network/tokenizer.js` | Hash-verified local Hugging Face tokenizer and Jinja chat template, checked against reference vectors |
| `lib/koin-network/work-router.js` | Operator-controlled experiment routes, qualified worker dispatch and bound receipts |
| `lib/koin-network/consumer-review.js` | In-process customer review harness, exact signed approval, retry and session revocation |
| `lib/koin-network/job-protocol.js` | Shared Test/master quote and receipt validation; canonical copy in `kaiapp/core/lib/koin-network` |
| `scripts/probe-koin-paid-jobs.js` | Financial invariants, multiple writers, abrupt exit, replay and fork recovery tests |

The operator-only HTTP routes and canonical scheduler hook require an explicit
in-process `koinWork` configuration. Production `server.js` does not configure
it. Test workers separately opt in with `KAI_KOIN_SHADOW_JOBS=1`; ordinary workers
remain opted out. There is no wallet key or transaction submitter in this engine.
`importSimulationGrant` creates explicit synthetic test authority, not a claim
of on-chain funding. Every quote,
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
character estimate, token-price fallback or default production tariff is accepted.
The real adapter loads the pinned Qwen2.5-1.5B-Instruct tokenizer, configuration
and chat template from local files. Its manifest binds the app's Koinos Fast
GGUF hash. Seven vectors cover multilingual text, Unicode, special tokens,
whitespace and rendered conversations, independently generated with Python
tokenizers 0.22.1 and Jinja2 3.1.6. This verifies tokenization, not compute cost
or inference quality. Byte-count tokenizers remain test fixtures only.

Wire quotes are schema 2 and additionally commit to the rendered prompt and
exact input token-ID hash. The Test worker compares those IDs with its local
llama.cpp `/tokenize` result before computing anything. A mismatch refuses the
job. It uses `/completion` with the committed raw prompt so the runtime cannot
apply a second chat template; `n_predict` is the quoted maximum. The deadline
and Stop cancel tokenization/generation. Only managed local llama.cpp is
supported for this path; Ollama and remote runtime fallbacks are refused.
Output charges count visible returned text re-tokenized by the master, not
provider-reported generation counts or hidden/EOS tokens.

Only literal system/user/assistant messages are supported at this stage. Tool
calls, images, hidden reasoning tokens and other formats require explicit
metering rules before admission. Persisted records contain hashes, signatures
and counts, not plaintext prompts or responses. These records are still private
operational data: hashes are not anonymization or a reason to publish them.

The metering adapter and master challenge verdict are trusted in-process code.
Model/tokenizer pins supplied by a worker are not accepted as proof that it ran
those weights. Independent model qualification and challenge calibration remain
separate activation gates.

## Running an isolated shadow experiment

Install the approved tokenizer pack explicitly:

```sh
node scripts/verify-koin-tokenizer.js /absolute/operator-owned/tokenizer-directory
```

The script downloads only the two files at the manifest's immutable Hugging Face
revision, verifies their bytes and runs the reference vectors. Startup itself
does no downloading. CI runs the same verifier. Never load a manifest or artifact
directory supplied by a remote request.

Construct the existing `Scheduler` with `koinWork: { domain, meter, qualify,
accept }` and an `operatorSecret`. `domain` must be an explicit `shadow:...`
identifier. Build `meter` from `loadTokenizer(directory, manifest)` and an
operator-supplied `Meter` tariff. No rates are shipped: measured prices remain
unconfigured. The synchronous `qualify(address, model, hash, now)` callback must
check current operator-approved benchmark records; `accept({job, messages,
output})` must enforce the independent challenge policy. Both callbacks are
required. The client cannot supply either decision.

| POST route | Access | Effect |
| --- | --- | --- |
| `/koin/shadow/jobs/grant` | Operator secret | Create a synthetic bounded grant |
| `/koin/shadow/jobs/session` | Operator secret | Read synthetic session limits, holds, expiry and revocation |
| `/koin/shadow/jobs/revoke` | Operator secret | Stop new work; retain holds for accepted or uncertain work |
| `/koin/shadow/jobs/quote` | Operator secret | Count and quote literal messages |
| `/koin/shadow/jobs/reserve` | Operator secret plus consumer signature | Reserve the quote; verify original messages; hold transient prompt |
| `/koin/shadow/jobs/status` | Operator secret | Read state and counted usage, never plaintext output |
| `/koin/shadow/jobs/cancel` | Operator secret | Cancel work before result verification |
| `/koin/shadow/jobs/result` | Signed registration token plus bound result signature | Verify assigned provider, challenge, deadline and measured output |

Operator requests use `x-operator-secret`. This secret is for the operator's
test harness, never a desktop customer credential. Worker polling stays at the
existing `/worker/next-job`; dispatch requires capability `koinShadowJobs: 1`,
signed wallet registration, approved model and a successful qualification
callback. A second poll cannot allocate another job while shadow work is active.
Shadow results do not enter legacy receipts, billing, performance or reward
totals. Duplicate identical accepted results return the prior acknowledgment.

The experiment queue holds at most 32 prompt payloads, each bounded by request
and rendered-prompt limits. Plaintext exists only in memory. After a restart,
resubmit the original signed reservation/messages to restore its context;
expired quotes cannot redispatch. Dispatched jobs without recovered challenge
context cannot be accepted and eventually expire. This is deliberately not yet
a production job retry/outbox system. No consumer purchase UI is enabled.

## Reservations and result validation

The `ShadowConsumerReview` harness exercises the consumer side against these
operator-only routes. It requires a pinned shadow domain, owner and tariff policy,
an in-process signing callback and a trusted transport. The transport maps each
short route name to `/koin/shadow/jobs/<name>` and returns its JSON response;
operator credentials must never be bundled into a customer app.

`review(...)` returns an exact eight-decimal simulated KOIN maximum, model,
input/output limits, session availability, per-job limit and expiry. It validates
the request and quote commitments and does not sign. `reject(reviewId)` drops
the pending prompt. Only `approve(reviewId, quoteHash)` invokes the signer,
after refreshing session limits and checking expiry. The signed message is
domain-separated shadow authorization, never a blockchain transaction.
Concurrent approvals cannot invoke the signer twice. A lost acknowledgment
retains the original request for `retry(reviewId)` with the same ID/signature;
it never generates another job or assumes the server released the hold.

`revoke(sessionId)` remains available for exhausted, expired and already-revoked
sessions. The server removes undispatched work on its next sweep but retains
dispatched work until its deadline and preserves verified/uncertain holds.
Revocation is not a refund. Session routes require the operator secret and are
absent when the shadow service is disabled.

This is an isolated integration harness, not a desktop approval UI or funded
session verifier. Pending/uncertain consumer payloads are bounded to 32 and
retained only in process memory. After a consumer restart, the master ledger
still owns the durable holds; automatic consumer retry recovery remains a
separate requirement. Before production, transport authentication must be
consumer-scoped, on-chain funding and revocation must be verified, and the
desktop must connect its private per-request approval/signing boundary. No
operator secret or network-accessible signer may be used to bypass that work.

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

### Offline tariff calibration

`node scripts/calibrate-koin-tariff.js TOKENIZER_DIRECTORY EVIDENCE.json` writes
a shadow-only report to stdout. This reads the pinned Qwen pack locally and
never contacts a scheduler, installs prices, qualifies workers or submits funds.
Keep the input private: it contains benchmark prompts and outputs. Reports omit
those texts. The evidence hash binds sanitized measurements, not raw transcripts.

The evidence object contains `tariff` (the exact Meter tariff schema), `samples`,
and optional `minimumSamples` (default 20), `providerCostCoverageBps` (10000),
`workCapBps` (8000), `rewardRevenueBps` (6000). Each sample requires a unique
SHA-256 `id`, the tariff's `modelHash`, `tokenizerHash`, `templateHash`, positive
`elapsedMs`, positive integer-string `costAtoms`, and boolean `accepted`.
Accepted samples additionally require literal `messages`, `output`, and
`maxOutput`. Counts are recomputed locally; supplied token counts are ignored.
Accepted jobs must fit the proposed context/output/deadline limits. Failed jobs
contribute costs but zero revenue. Duplicate IDs and mismatched pins are refused.

Operators must measure costs consistently, including electricity and allocated
hardware/hosting costs, and document the timestamp and KOIN conversion assumptions
separately. Costs and acceptance verdicts are operator assertions, not proofs.
Use representative hardware, prompt lengths, cold starts and failure cases;
twenty accepted examples alone do not establish representative performance.

The report compares total costs with revenue under the proposed tariff and
calculates a conservative candidate keeping the proposed input/output rate ratio.
Required revenue covers cost under both the work-reward cap and the reward
replenishment fraction. Availability subsidies are deliberately excluded.
Integer rounding and uint64 bounds are enforced. The candidate is a planning
estimate: work rewards remain limited by the daily pool, and competing providers
can change actual payouts. It never guarantees cost recovery. With no accepted
samples there is no candidate. All reports keep `productionApproved: false`;
prices, service thresholds and live activation still require separate review.

Run `node scripts/probe-koin-calibration.js` for the offline accounting checks.

- Measure hardware costs, model tariffs and SLA/challenge rules; extend the
  reference/pinned-tokenizer coverage beyond Koinos Fast. The implemented Qwen
  adapter verifies artifacts and token IDs, but supplies no production prices.
- Verify funded grants, balances, revocations and policy from finalized chain
  state; coordinate session ownership across verifier replicas. The current
  synthetic grant API must never become remote spending authorization.
- Implement reviewed consumer quote acceptance and funded-session controls in
  the desktop UI. The worker/scheduler shadow protocol is connected, but existing
  `jobId|output` signatures and provider-reported usage remain ineligible for
  KOIN charges. Add durable delivery/retry without persisting private plaintext.
- Add the restricted settlement keeper, sponsored Mana budget, durable signed
  transaction outbox, explicit reverted/expired-intent repair and backup recovery.
  The transaction ID must be recorded before a future submitter broadcasts it.
- Publish signed reward manifests only from reconciled real paid charges.
  Add retention, rate/admission limits and load testing before service exposure.
- Complete isolated-chain transfer/resource testing and contract review,
  seven-day real shadow validation, deployment pins and the owner's concrete
  funding/deployment review. Existing mainnet balances and reburn policy remain
  unchanged.

Run `node scripts/probe-koin-paid-jobs.js` and
`node scripts/probe-koin-work-flow.js` on Node 22. The normal CI probe glob
includes both automatically, while the separate tokenizer verification step
checks real pinned files. HTTP/financial tests use local SQLite, deterministic
test tokenizers and fixture RPC responses. Test app worker tests exercise the
local runtime boundary and signed receipt loop. These are not production
measurements or a live-chain contract audit.

Primary implementation references:
[Node SQLite](https://nodejs.org/docs/latest-v22.x/api/sqlite.html),
[Koinos finality](https://docs.koinos.io/exchanges/finality/), and the installed
`koilib` 9.3 provider/transaction implementation. The monitor trusts its pinned
RPC service; it is not a cryptographic light client.
