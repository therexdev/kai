# Daily reward-cycle rehearsal

`RewardCycle` and `RewardCycleRunner` connect the three daily contract actions
to the existing automatic claim queue: open the UTC day's budget, propose a
verifier-signed reward root after the day closes, and finalize that exact root
after its full 24-hour hold. Each transition requires a stable, pinned RPC
snapshot confirmed on the irreversible chain. A transport acknowledgment or
reversible inclusion cannot advance a step or authorize a payout.

This is an isolated rehearsal component. Nothing in `server.js`, scheduler
routes, desktop signing or production configuration installs it. There is no
timer, key loader, public write endpoint or built-in broadcast transport. The
disposable-chain harness supplies published fixture identities and its isolated
loopback provider. Live KOIN payments remain disabled.

## Interfaces and authority

`RewardCycle(directory, { mode: "isolated-rehearsal", target, policy,
budgetPolicy, observer, clock })` stores `reward-cycle.sqlite` with WAL and FULL
synchronization. `target` is the exact `reward-manifest.js` deployment schema;
`observer` must be a matching `RewardObserver`. `budgetPolicy` contains exactly
`dailyBps` and `availabilityBps`, pinned to both contract configurations. `policy`
has the same verifier/payer, transaction/day RC ceilings, attempt cap and retry
delay fields as the settlement outbox. Its verifier must match the root verifier,
and its payer must be a separate lifecycle account, distinct from custody and
the claim sponsor. Every lifecycle instance for these pins must share the DB.

`queueDay()` defaults to the current UTC day. It admits at most 32 incomplete
days. `importManifest(envelope)` verifies the existing signed rehearsal manifest,
regenerates its Merkle-sum tree, and irreversibly binds one manifest to that day
in the local journal. An operator cannot silently replace a cancelled root's
manifest through reimport. A manifest authenticates its issuer; it does not
prove model availability or independently reconcile paid work. Production
ingestion must supply approved availability evidence and reconciled charges.

`advance(epoch)` returns a bounded decision for the first unfinished step.
`stage(epoch, method, transaction)` accepts only its exact signed operation,
chain, resource ceiling and signatures. Open/finalize require the lifecycle
payer's signature. Propose additionally requires the pinned verifier's signature,
with no `payee` header: the lifecycle payer owns the nonce, preserving the
settlement verifier's independent nonce sequence. Neither funding, policy
changes, cancellations, withdrawals nor arbitrary contract calls are supported.

`RewardCycleRunner({ mode: "isolated-rehearsal", cycle, claims, prepare,
submit, timeoutMs })` requires explicit trusted callbacks. `prepare` signs and
returns bytes; it must not broadcast. `submit` receives only a durably staged
envelope after the attempt/Mana reservation commits. `tick()` admits the current
day and visits up to four incomplete days (configurable from 1 to 16).
`tick({ openCurrentDay: false })` services admitted days only. Callback timeouts
are bounded from 50 to 30,000 ms; the default is 5,000 ms.

The runner automatically imports finalized manifests into `RewardClaims` when
configured. Claim import is idempotent, and its handoff marker commits afterward.
A crash between the two databases repeats the same import. It does not require
another signature, discard entitlements or duplicate payouts. Existing sponsored
claim submission remains responsible for transferring tokens to fixed providers.

## Recovery and contract protections

- Commit a signing fence before calling the signer. A lost signing response
  requires recovery of the original envelope; restart never silently signs again.
- Persist the exact signed envelope before broadcasting. Retry only identical
  bytes, retain the nonce while finality is uncertain, enforce cooldown/attempt
  limits, and reserve the full RC ceiling once per envelope per UTC day.
- Require both the exact transaction's irreversible receipt and sufficiently
  recent irreversible contract state. A manual/external action may satisfy an
  unsigned step. It cannot release an already-outstanding transaction's nonce.
- Pause, changed pins/policy, root replacement/cancellation, expired epochs,
  missing state, damaged journals and backwards clocks prevent new signing.
  Reverted/exhausted transactions stay in review; later proven success can
  still resolve their existing envelope.
- `open_epoch` now requires the intended `Request.epoch` to equal the chain day.
  A delayed signed opening cannot create a different day's budget. A missed
  admitted day stops for review instead of being silently reassigned.
- `finalize_root` requires the reviewed `Request.root`, including its hash and
  both category totals. It cannot finalize a different replacement root. The
  contract still independently enforces its current full review deadline.

These contract requirements change prototype call semantics without changing
the generated ABI: old opening/finalization drafts must not be reused. Existing
production contracts have not been deployed or upgraded by this work.

Cross-host fencing, rollback-resistant backups, key rotation, reviewed nonce
repair, empty/missing-manifest day expiry and production evidence ingestion
remain required. This conservative queue can stop behind a day needing review.
It is not an audit, a production capacity benchmark or permission to fund/deploy.

Run `node --test scripts/probe-koin-reward-cycle.js` for isolated fixture tests.
The [disposable-node workflow](../scripts/koin-isolated/README.md) exercises this
same runner through actual opening, proposal, finalization and automatic claims,
including lost proposal acknowledgment/restart and the contract timing guards.
