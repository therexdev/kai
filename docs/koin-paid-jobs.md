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
| `lib/koin-network/funded-session.js` | Read-only custody/session evidence tied to a subsequently irreversible observed block |
| `lib/koin-network/funded-reservations.js` | Durable funded rehearsal holds, atomic signed settlement outbox and bounded sponsorship journal |
| `lib/koin-network/settlement-outbox.js` | Strict validation of the exact pre-signed operation, deployment, verifier/sponsor, nonce and resource limit |
| `lib/koin-network/settlement-recovery.js` | Read-only recovery decisions; exact-envelope retry or next-intent preparation after finality |
| `lib/koin-network/rehearsal-submitter.js` | Bounded injected submission driver for staged settlements and automatic reward claims |
| `lib/koin-network/reward-claims.js` | Signed manifests, irreversible reward observation and durable sponsored claim recovery |
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
| `/koin/shadow/jobs/funding-observe` | Operator secret, configured observer | Capture pinned chain/session/custody state; does not create a grant |
| `/koin/shadow/jobs/funding-verify` | Operator secret, configured observer | Check observed block finality and unchanged current session state |
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

### Durable funded reservation rehearsal

`FundedReservations` now connects `FundedSessionObserver` to a separate SQLite
ledger. It requires explicit deployment pins and the matching `Meter` policy.
It cannot import synthetic grants or accept funding evidence from a request
body. `reserve` and `markDispatched` call the trusted observer themselves and
require freshly rechecked, irreversible evidence for the correct contract,
owner, session and tariff policy. Evidence older than five seconds is refused
at the database write. Fresh observation IDs must be obtained again after a
restart; existing holds remain durable.

Only quotes issued by this ledger's configured meter can be reserved. Consumer
signatures use `KAI-KOIN-FUNDED-RESERVATION-REHEARSAL-V1`, binding the chain,
contract, bytecode, policy, domain, action, session, job and quote hash. Existing
shadow approvals and reserve signatures cannot authorize cancellation. Prompt
text is never persisted: the ledger stores quoted counts/commitments, signatures
and financial evidence. The test-only byte tokenizer is not a production tariff.

Reservations use `BEGIN IMMEDIATE` with WAL and `synchronous=FULL`, checking
per-job limits, total outstanding holds and remaining job slots together.
Repeated identical requests return the existing hold; changing a job's terms
is refused. Signed cancellation releases an undispatched hold. Once marked
dispatched, no cancellation, timeout or restart releases it automatically.
`markDispatched` records an accounting transition only and sends no job.

Any change to the session's on-chain remaining amount, nonce, owner, limits or
expiry after adoption persistently freezes that session for reconciliation.
The freeze commits before the operation returns an error. This intentionally
does not guess which local job a chain charge represents or reset a balance.
Only exact-charge reconciliation described below can clear a freeze and advance
the recorded chain balance. There is no administrative balance reset, transfer
or broadcast path. Status is the last verified accounting snapshot, not a live balance.

All processes serving a deployment must share one operator-owned database.
Independent databases/hosts are **not** coordinated; cross-host ownership and
failover fencing remain activation gates. The ledger is not wired to public
routes, live workers, the desktop signer or a settlement keeper. Every returned
reservation is `funded-rehearsal` with `paymentsEnabled: false`. No fund movement
occurs. The existing consumer harness still uses the separate shadow protocol;
its signature must not be reused as funded approval.

Run `node scripts/probe-koin-funded-reservations.js`. Tests use the real observer
against ABI-serialized fixture RPC responses and cover duplicate requests,
competing database writers, forged prices, signed cancellations, dispatch-time
revocation, abrupt process exit, deployment identity and persistent freezes.

### Accepted charges and funded reconciliation

The funded rehearsal now supports the accounting sequence `dispatched →
verified → prepared → submitted → settled`. Dispatch records a random attempt
and result deadline. `complete` verifies a provider signature with the distinct
`KAI-KOIN-FUNDED-RESULT-REHEARSAL-V1` domain, requires the configured in-process
acceptance policy, and recounts output with the pinned meter. Only accepted
usage reduces the maximum hold to the actual charge. Prompt/output text is not
persisted. A signature alone cannot override rejection or a missed deadline.

`prepare` freezes the exact charge, provider, receipt hash, dispatch time,
policy and next session nonce. Only one unresolved settlement per session may
be prepared. `settlementOperation` encodes that stored intent using the generated
credits ABI; it does not create or sign a transaction. `recordTransaction` binds
one transaction ID permanently before any future submitter broadcasts it.
Unknown transactions cannot be replaced automatically with a new nonce or ID.

`reconcile` asks the trusted observer to verify the exact contract operation,
successful receipt and canonical irreversible inclusion. It then requires a
fresh, separately observed reconciliation snapshot at or after the transaction
height. The session nonce must advance by one, its remaining balance must fall
by exactly the stored charge, and its remaining job count must fall by one.
Only then does one database transaction release the hold, advance local chain
accounting and retain finality evidence. Repeated reconciliation is idempotent.
Unexpected deltas persist a freeze; unknown, reversible, reverted and mismatched
transactions retain the hold. Failed database writes roll back both changes.

Observations explicitly distinguish `admission` (default) from `reconciliation`.
The latter can inspect expired, revoked, exhausted or paused sessions, since
earlier accepted work may already have settled. Reconciliation evidence is
rejected by reservation/dispatch admission. An account release or extra charge
that changes more than the single expected delta still requires a separate
recovery procedure; no residual balance is assumed or discarded.

This ledger remains a rehearsal. The later sections describe its opt-in account
and worker integration and the isolated submission/claim driver; no live
transaction signer or keeper is connected. Fixture tests
exercise exact ABI operations, transaction commitments, restart, duplicate
confirmation, revocation/expiry, unknown transactions and write rollback.

### Funded-session evidence

`FundedSessionObserver` is a read-only component. An operator can provide an
instance as `koinWork.fundingObserver`; production does not configure it.
Construction requires a trusted provider and explicit chain ID, credits address
and WASM hash, KOIN token address, verifier address, tariff policy hash and policy
version. It uses the generated credits ABI for `config`, `get_session` and
`balances`, checks contract metadata and refuses extra authority flags.

Ordinary Koinos `chain.read_contract` accepts contract ID, entry point and args;
it has no block-selector field. Therefore a current read alone is not an
irreversible-state proof. `observe({id, owner})` sandwiches the reads between
matching head IDs/heights/timestamps on one coherent RPC node and privately
retains the snapshot. `verify(observationId)` waits until that observed height
is irreversible and resolves the block against the head that supplied LIB.
It then repeats the pinned reads. Changed session/custody/configuration state
requires a new observation; revocation, pause, exhaustion, expiry, insufficient
backing, stale heads, wrong chains or changed bytecode are rejected.

Successful evidence reports remaining funds, per-job limit, remaining jobs,
nonce, expiry, state hash and block references. It **always** reports
`paymentsEnabled: false` and `spendingAuthorized: false`. It never imports a
chain balance into a simulation grant, dispatches work, signs or broadcasts.
Finalized custody evidence alone does not solve concurrent reservation ownership,
consumer authentication, dispatch-time revalidation or settlement submission.
Those remain required before paid work is enabled.

The observer trusts the configured RPC node; it is not a cryptographic light
client or a guarantee against a dishonest or incoherent load-balanced provider.
Reads retry if the head moves. The head must be within two minutes of the local
clock (at most one minute ahead). At most 32 private observations are retained,
with a default 15-minute lifetime. A restart requires observing again, never
reconstructing authority from client-supplied evidence. No snapshots are accepted
from HTTP callers. This iteration is tested with ABI-serialized fixture RPC
responses and scheduler HTTP requests, not deployed/funded contracts.

Run `node scripts/probe-koin-funded-session.js`. RPC field reference:
[Koinos chain RPC definitions](https://pkg.go.dev/github.com/koinos/koinos-proto-golang/v2@v2.6.0/koinos/rpc/chain#ReadContractRequest).

### Existing account-grant chat rehearsal

`Scheduler({ accounts, koinWork: { ...existingWorkConfig, consumerBindings } })`
can expose an explicitly selected synthetic session through the existing
`POST /consume/chat/completions` route. `server.js` does not activate this
configuration. Each binding has exactly these fields:

```js
{
  accountId, grantId, // existing AccountService account and signed spend grant
  session,           // operator-created simulation session ID (SHA-256 hex)
  model: "koinos-fast", version: 1, maxOutput: 16
}
```

Use a deliberately configured isolated service. Bindings are limited to 32,
unique per account/grant and per simulation session. They pin one Meter tariff
and an output ceiling. The session separately bounds per-job amount, total
amount, job count and expiry. The account must still own a live grant and its
linked wallet must own that session. Reordering config fields across restart
does not change the binding; changing its values invalidates old authority.

Requests supply `billing: "koin-shadow"`, `sessionToken`, `grantId`, a unique
SHA-256 `requestId`, literal `messages`, `model` (`auto` or the bound model),
optional `max_tokens` within the binding and optional boolean `stream`. The
server creates the exact quote and reserves against the synthetic session.
Existing wallet signatures and `trustedAccountId` in JSON are not accepted as
substitute authentication. No operator secret or per-message signature is
required. Durable jobs record delegated account/grant authority, never a
server-forged consumer signature. The old USD grant is used only for identity
and current authorization state; neither its balance nor KOIN funds are spent.

Opted-in workers receive the existing committed shadow job and return its
signed result. The master independently meters and accepts it, then returns the
answer with quote, receipt, usage, `costUsd: 0` and `paymentsEnabled: false`.
`stream: true` uses the existing scheduler SSE envelope after verification;
generation itself is buffered. Normal requests without `billing` use the
existing network and pricing path. Unknown billing modes fail closed.

Replies are account-scoped and held in memory for at most five minutes and 32
results. Prompt/output plaintext is not persisted by this bridge. Reusing a
request ID with the same grant and terms retrieves its result without another
reservation or dispatch. A changed prompt/cap or different owner is refused.
Concurrent duplicates are refused; cancelled requests stay cancelled. After a
restart/eviction an accepted job reports that its answer is unavailable and
keeps its hold, rather than running again. An exact signed worker retry can
restore its transient result. Durable encrypted delivery is not implemented.

Revocation, unlinking, grant expiry, sign-out, disconnect and timeout stop
pending delivery. Revoked grants cannot admit queued work or accept newly
arriving results. Only unaccepted reservations are released; accepted or
uncertain jobs keep their hold. The default HTTP wait is three minutes, bounded
to five; admission is limited to 32 waiting jobs. General rate limits, ledger
retention and deployment hardening remain pre-exposure work.

Desktop developer opt-in is `KAI_KOIN_SHADOW_CONSUMER_URL`, which must match its
configured scheduler. It reads the existing account session and linked-wallet
grant privately, refuses redirects, validates returned commitments and labels
the reply as a rehearsal with no KOIN spent. Local-Only and Stop cancel requests;
errors never fall back to a separately billed legacy request. The native review
preview is illustrative, not a mandatory per-prompt step in this session flow.

Run `node scripts/probe-koin-grant-chat.js`. With both checkouts installed, run
`node scripts/verify-koin-desktop.js ../kaiapp` for real desktop Core, account
routes, master and desktop Worker over local HTTP with fixture inference.
These tests establish protocol integration, not live service activation,
production pricing, measured provider performance or funded authorization.

### Funded sessions with one account-bound approval

`FundedReservations` now supports `reviewDelegation`, `authorizeDelegation`,
`reserveDelegated`, `delegationStatus` and `revokeDelegation`, using the existing
AccountService. The owner signs the canonical `session-delegation.js` certificate
once. It binds deployment pins, session/owner, account/grant, model/version,
output ceiling, lifetime amount, per-request cap, request count and expiry.
Review returns the canonical tariff registry (at most 64 entries). The desktop
checks its policy commitment before displaying input/output prices per million
tokens, so those displayed prices cannot silently differ from the pinned policy.
Its signature domain explicitly names funded **rehearsal** and is never live
payment, a chain transaction or legacy USD authority.

Admission and dispatch still require fresh, irreversible funding evidence from
the pinned observer. The certificate cannot exceed that funded session's limits.
Each session has one durable certificate in the same SQLite database as its
holds. A second certificate cannot reset the budget. Reservations check current
linked-wallet/grant authority, both caps and job counts in the same transaction.
Settled charges remain in the lifetime cap after reconciliation/restart. Multiple
processes must share the database; cross-host fencing remains unimplemented.

Revocation permanently records a tombstone and cancels only undispatched holds.
Dispatched/verified/submitted holds keep their liability; work authorized before
revocation may still complete and reconcile. Replaying the old certificate stays
revoked. Historical status/revocation is account-scoped and remains available
after grant revocation/unlinking. Revocation does not refund or revoke anything
on-chain. Starting again requires a new funded session and a fresh approval.

An isolated `Scheduler` may explicitly configure
`koinFundedSessions: { observer, target, meter, accept, clock }`, alongside
`accounts`. `target` is the funded ledger's pinned chain, credits, bytecode,
policy and shadow domain. Production `server.js` still does not enable this.
The following POST routes are relative to the scheduler URL; all require an
existing `sessionToken` in the body and return `paymentsEnabled: false`:

| Route under `/koin/funded/rehearsal/` | Additional body fields | Effect |
| --- | --- | --- |
| `observe` | `grantId`, `session` | Read that linked wallet's session; retain private funding observation |
| `review` | `grantId`, `observationId`, `proposal` | Verify finality and return exact unsigned certificate terms |
| `authorize` | `grantId`, `observationId`, `terms`, `signature` | Verify owner signature and register one bounded delegation |
| `status` | `id` | Return only this account's delegation and last accounted budget |
| `revoke` | `id` | Stop new use and release only undispatched holds |

`proposal` has exactly `model`, `version`, `maxOutput`, `amount`, `perJob`,
`maxJobs`, `expires`. Amounts are decimal atom strings; expiry is UTC epoch
milliseconds. Review may return `state: "reversible"`; retry the same observation
after finality. Observations expire and do not survive restart. Funded chat uses
the separate opt-in work integration below; there is no settlement broadcast
endpoint.

The desktop's opt-in native controls use
`KAI_KOIN_FUNDED_REHEARSAL_CONFIG`; see its `docs/koin-network/STATUS.md` for the
exact configuration schema. Terms come from pinned main-process configuration,
not renderer arguments. The wallet signs only after native confirmation. The
certificate is saved before transmission, without tokens or private keys.
Lost acknowledgments recover by querying the same delegation first, then
resending identical signed terms only if it was not registered. This preserves
one approval per session, with no per-message signing requirement.

Run `node scripts/probe-koin-session-delegation.js`, the existing funded probes,
and `node scripts/verify-koin-desktop.js ../kaiapp`. Coverage includes altered
terms, signatures/deployments/accounts, cumulative limits, concurrent writers,
revocation/replay, expiry, settled-charge accounting and desktop recovery.
Funding RPC and inference remain fixtures. The funded chat integration below
is tested with the same accounts and ledger. A restricted settlement keeper
remains subsequent work before any real-payment activation.

### Funded rehearsal chat, workers and unsigned settlement preparation

Set `koinFundedSessions.work: { qualify, waitMs }` on the isolated Scheduler and
supply `accept` as an independent acceptance policy. Neither callback is
provided by a consumer or worker. `qualify(address, model, modelHash, now)` must
return true both at dispatch and acceptance. The acceptance callback receives
the ledger job, original messages and output. Production `server.js` has no
activation switch for this work router.

Normal `/consume/chat/completions` accepts `billing: "koin-funded-rehearsal"`,
`sessionToken`, `grantId`, `delegationId`, `observationId`, `requestId`, literal
`messages`, optional `model`, `max_tokens` and `stream`. No request signature or
certificate is needed after the session approval. The authenticated account
must own the certificate. Each new reservation and dispatch rechecks the
linked grant, approved scope, fresh irreversible funding and SQLite caps.
Repeated IDs cannot change intent or create another hold. Simultaneous requests
for the same ID return a conflict while the first is running.

Only signed workers advertising `koinFundedRehearsalJobs: 1` receive
`koin-funded-rehearsal-chat` jobs through the existing worker poll. Desktop
opt-in is `KAI_KOIN_FUNDED_REHEARSAL_JOBS=1`, separate from synthetic jobs.
Jobs contain public target/session IDs and the committed prompt/quote, never
account tokens or delegation signatures. The public model hash and local
llama.cpp input token IDs must match. The result signature uses
`KAI-KOIN-FUNDED-RESULT-REHEARSAL-V1`. The worker posts to
`/koin/funded/rehearsal/result` using its existing worker token. Legacy result
signatures and client-reported token counts are insufficient.

The master verifies the assigned provider, signature, deadline, qualification,
acceptance and independently counted tokens. The desktop also checks the
approved tariff-policy proof, request, signed output and usage arithmetic before
delivery. Responses are buffered, including SSE delivery. Accepted jobs call
`prepare()` to persist an unsigned settlement intent; a previous unresolved
nonce leaves later jobs verified/waiting. No transaction is constructed,
signed or broadcast by this integration. `settlementOperation()` remains an
in-process inspection method for the future restricted keeper.

Stop/disconnect can release only queued work. Dispatched work retains its
liability through timeout, revocation and restart, and never requeues
automatically. Prompts and answers are memory-only, capped at 32 each; accepted
answers expire after five minutes. Identical accepted worker-result replay
can restore an answer after eviction/restart without changing its receipt or
charge. Unaccepted output cannot be verified after losing its challenge context.
Durable encrypted answer delivery and automatic desktop retry UI remain open.
Callers preserve `koin_request_id`; errors never fall back to legacy billing.
The Electron configuration selects the saved session privately; missing or
invalid approval fails closed. Local-Only and Stop retain their egress boundary.

Run `node scripts/probe-koin-funded-work.js` and the cross-repository check
alongside the funded ledger and delegation probes. These cover account
isolation, concurrent polls/duplicate intent, changed funding, revocation,
Stop before/after dispatch, wrong signature domains, acceptance failure and
restart/replay. The cross-repository check drives real desktop Core/account
routes and the Worker with fixture inference and read-only fixture chain RPC.
All responses remain `paymentsEnabled: false`; no real funds are used.

### Durable settlement outbox and recovery decisions

An isolated funded ledger may now take `settlementPolicy` with exactly
`verifier`, `payer`, `maxRcPerTransaction`, `maxRcPerDay`, `maxAttempts` and
`minRetryMs`. Both resource ceilings are positive decimal strings. The verifier
must match the observer's pinned contract role. The payer is the designated
sponsor. This immutable local policy is stored with the deployment identity;
reopening without it, or with changed values, fails closed. Production has no
outbox configuration, signer, submitter or background recovery loop.

`stageSettlement({id, transaction, observationId})` accepts an already-signed
transaction only after fresh irreversible **reconciliation** evidence confirms
that the prepared charge remains eligible. It validates the exact chain,
credits call/ABI arguments, operation commitment, canonical transaction nonce,
resource limit and signatures. Separate payer/verifier roles require both
signatures with the verifier as payee; a single role requires its one signature.
Extra operations, headers, signer substitutions and altered amounts are refused.
There is no key loader or signing method in the outbox.

The full signed envelope and its transaction ID are committed atomically with
the hold in the **same SQLite transaction**, using WAL and FULL synchronous mode.
`submitted` means potentially submitted, never confirmed paid. A lost response,
restart, fork or retry cannot replace the saved envelope, advance its nonce,
re-sign it or release the charge. Legacy ID-only recording is rejected when the
outbox policy is enabled. Only one verifier transaction can remain unresolved;
its permanent nonce history prevents reuse or backwards movement. All processes
must share this database; cross-host failover fencing remains a launch gate.

`SettlementRecovery.step({id, observationId})` checks the exact transaction via
the pinned read-only observer and returns one of these decisions:

| Decision | Effect |
| --- | --- |
| `submit_exact_transaction` | Return the stored envelope after durable attempt/Mana checkpoints; the caller must not replace it |
| `wait` | Pending/reversible transaction, cooldown or daily sponsorship cap; retain its hold |
| `review` | Finalized revert or exhausted retry allowance; retain the envelope, nonce and hold |
| `done` | Exact successful finality and matching session delta; clear the hold once and prepare the next waiting intent if eligible |

The helper **does not submit the returned transaction**. Only the offline probe
driver simulates submissions in this increment, using deterministic fixture
signers and fixture RPC. No signing key, transport or public HTTP route is
connected to the live master, desktop signer or worker. Installing Test does
not activate this path or any payment.

Each distinct transaction reserves its entire signed `rc_limit` against that
UTC day's configured sponsorship ceiling before the first attempt. Repeated
attempts that day share the same reservation because they use the same ID; a
retry on a later day reserves that day's allowance too. No resource refund is
assumed, even after a revert. The maximum attempt count, retry delay and journal
survive restart. A missing journal or damaged saved envelope fails closed.
Actual Mana estimation and sponsor capacity still require deployment tests.

An unknown transaction past its settlement window is never automatically
replaced or refunded: it may already have executed before the deadline. Recovery
continues to permit exact finality/accounting reconciliation. Unexplained
balance/nonce changes freeze new use. A confirmed earlier charge remains
confirmed even when a later accepted charge's window has closed. Reverted or
expired intent replacement, abandoned-job resolution, key rotation, encrypted
backups and cross-host recovery still need a separately reviewed repair path.

Run `node scripts/probe-koin-settlement-outbox.js`. It includes actual process
kill/reopen checkpoints, simultaneous handles, lost acknowledgments, signature
and operation tampering, resource budgets, finality/forks, revocation timing,
unknown-window expiry, damaged storage and next-session-nonce advancement.

### Automatic provider payouts: rehearsal implementation

The owner confirmed automatic sponsored claims as the default user experience.
After daily rewards finalize and the 24-hour review hold ends, the master should
relay valid claims to each provider's committed KOIN wallet and cover Mana.
Providers should not need to click Claim or sign each reward payment. A manual
claim remains a recovery option. The rewards contract already permits any caller
to relay a valid proof while fixing the recipient; it cannot redirect earnings.
The master now has a separate sponsored reward outbox, signed rehearsal reward
manifests and a bounded automatic claim driver. It verifies the finalized root,
fixed-recipient Merkle proof, irreversible claimed state and funded paid-work
caps. Signing fences and full envelopes survive restart; retries preserve the
same transaction and reserve bounded daily Mana. The driver also accepts the
customer settlement outbox's exact-envelope recovery decisions. Both paths use
injected fixture signing/submission; neither shortens the review period or
enables live payments. See [automatic claim rehearsal](koin-automatic-claims.md)
for the interface, tests and remaining production work.

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
- Add exclusive ownership/failover fencing across verifier hosts and reviewed
  recovery for reverted/expired submissions, released balances and unexplained
  charges. Exact successful single-charge reconciliation is implemented; the
  funded rehearsal now dispatches work but never broadcasts, and synthetic
  grants are never spending authority.
- Complete credit purchase/session opening/refund controls and durable delivery
  in the desktop UI. Private one-time session approval/retry/revocation is now
  implemented for funded accounting rehearsal.
  Existing account grants now support normal chat inside synthetic or explicitly
  approved funded-rehearsal session limits, without per-message review. Real
  KOIN spending still needs separate activation and live authority. Existing
  `jobId|output` signatures and provider-reported usage remain ineligible for
  KOIN charges. Add durable delivery/retry without persisting private plaintext.
- Connect production settlement signing/transport and automatic sponsored
  provider claims after review. The durable signed-envelope outbox and bounded
  Mana journal now feed an explicit rehearsal submission driver. Signed reward
  manifests, irreversible claim observation and the automatic claim queue are
  implemented with injected fixture signing/transport; see
  [automatic claim rehearsal](koin-automatic-claims.md). No live keeper is enabled.
  Complete reverted/expired-intent repair, key rotation and backup recovery;
  never broadcast before the full signed envelope and hold binding are durable.
- Publish signed reward manifests only from reconciled real paid charges.
  Add retention, rate/admission limits and load testing before service exposure.
- The first isolated native-transfer/resource run passed all 12 checks; see
  [the saved results](koin-isolated-results.json) and
  [automatic claim verification](koin-automatic-claims.md#verification-and-remaining-activation-work).
  The follow-up [desktop funding run](koin-funding-results.json) passed 14 checks,
  adding actual desktop bundle submission and paused-deposit approval rollback.
  Complete broader proof-size/load and Mana calibration, contract review,
  seven-day real shadow validation, deployment pins and the owner's concrete
  funding/deployment review. The desktop now validates the native allowance
  and custody deposit as one exact transaction bundle and offers an in-process
  review rehearsal; production signing/recovery and credit finality remain
  disconnected. Existing mainnet balances and
  reburn policy remain unchanged.

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
