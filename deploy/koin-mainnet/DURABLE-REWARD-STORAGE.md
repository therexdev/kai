# Durable reward storage: staged foundation

This work prepares the next storage backend. It does **not** activate a storage
migration or establish a supported provider count. The running runtime continues
to use `KoinShadow` and its existing JSON ledger. No runtime configuration in this
branch selects `ShadowStore` or enables the provider presence outbox.

The immediate operational tool is the standalone read-only preflight:

```bash
node --max-old-space-size=64 deploy/koin-mainnet/diagnose-reward-storage.js
```

It can also run after copying that single file outside the checkout. It uses Node
built-ins, never loads the runtime or signing keys, does not restart the service,
and does not activate a migration. Node 22 with `node:sqlite` is required for the
isolated database summary; unavailable checks are reported explicitly.

## What the preflight establishes

- CPU count, load, available memory, allocated swap and disk/inode headroom.
- A short host-wide sample of CPU activity and swap-in/swap-out counters, plus
  Linux CPU, memory and I/O pressure. This sample includes the diagnostic's own
  work. No observed paging is only a statement about that sample.
- Bounded local/public runtime and earnings health projections.
- Fixed state-file metadata and a streamed SHA-256 of the legacy shadow file,
  with size/deadline limits and concurrent-change detection. It does not parse the
  history or certify its schema/completeness while the scheduler is running.
- Bounded cycle and claim state projections in a heap-capped, deadline-limited
  read-only child. Saved transaction states are not independent payment proof.

A clean result is a diagnostic baseline, not migration approval. A short health
check or a process with no restarts is not a capacity or availability guarantee.

## Compatible changes to the existing backend

The runtime uses explicit presence/qualification readers, a batch startup seal
operation, and an evidence-hash/allocation interface. Existing manifest evidence
keeps its `{budget,intervals,work}` field order and existing allocation policy.
Already-sealed startup state no longer causes an unconditional history rewrite.
Active-qualification reads avoid cloning expired history for local refreshes.
These changes do not remove JSON serialization from presence handling.

## Candidate SQLite backend

`lib/koin-network/shadow-store.js` stores budgets, immutable closed intervals,
work, qualifications, presence samples, exact availability totals and consumed
event receipts in indexed tables. Allocation continues to use the existing
policy. Manifest evidence hashing and allocation can stream closed intervals.
Archived samples and consumed-event receipts remain on disk. Disk growth and a
reviewed retention/archive policy still need measurement; free space today does
not establish long-term capacity. Streaming allocation still retains the policy's
wallet/job sets and one decoded interval at a time.

The offline `ShadowStore.migrateLegacy()` API creates a new, unactivated candidate
and preserves a copy of the source. It verifies source identity, closed evidence
hashes and both existing allocation bases before returning a descriptor. It never
modifies the live source file. A normal open requires an activation marker bound
to the candidate, directory, deployment identity and migration verification.
Staging access is explicit. Missing or mismatched storage fails closed.
The offline source-size limit bounds input bytes, not expanded JavaScript heap.

This uses synchronous SQLite APIs. It must not be wired into live HTTP handling
as a presumed latency fix. Worker isolation with bounded queue admission, failure
reporting and shutdown handling remains a release requirement.

## Candidate delegated presence outbox

`ProviderDevices` defaults to its current behavior. Explicit outbox mode commits
the authenticated report, replay watermark and ordered event in the same source
database transaction. Events retain the original server acceptance time and the
trusted acceptance-time eligibility decision. Pending reports are globally
bounded; admission fails before advancing the replay watermark when full.

The consumer must durably apply or explicitly skip an event and save its receipt
atomically before calling `ackPresenceEvents`. Exact committed retries recover
the existing receipt; they never create a new timestamp or presence observation.
Pending events and the latest receipt per authorization are retained. An older
delivered report is replay-rejected after a newer report has replaced its receipt.

Activation changes the provider database identity so an older binary rejects it.
Activation refuses another live writer, including another instance in the same
process. An existing HTTP router does not consume this outbox; enabling it before
the ordered consumer exists is unsupported.

## Gates before production activation

1. Drain all writers and verify a consistent source and recovery point. Run the
   offline comparison with adequate memory headroom, including saved manifests.
2. Reconcile saved manifest seals before replay or interval closure. Preserve
   every closed interval, allocation and signed manifest.
3. Add the ordered consumer and enforce a closure barrier: a minute cannot close
   past committed source events that have not yet been durably applied or skipped.
   Keep acceptance time and eligibility unchanged during recovery.
   Serialize source acceptance, draining and closure under the reviewed writer
   lifecycle; an empty queue check alone cannot fence another process accepting a
   report. Legacy wallet-signed reports also need durable retry receipts before
   their route is migrated.
4. Finish bounded worker integration and every synchronous reader/shutdown path.
   Test saturation, worker death, disk failure and restart replay end to end.
5. Enforce the downgrade boundary. After verified staging, preserve the source
   backup and atomically replace the legacy JSON path with an unsupported-schema
   sentinel, fsync its directory, and require agreement with the active marker.
   Removing the JSON file is unsafe: old code treats absence as a blank ledger.
   Marker creation alone cannot prevent an old binary writing stale JSON.
6. Keep qualification-history changes disabled until a separately verified
   history-aware writer boundary. Prior current-only records cannot reconstruct
   intermediate retirement/renewal events.
7. Measure sustained traffic, rollover, catch-up, RPC failure and recovery on the
   intended host. Synthetic component tests do not establish network capacity.

The existing updater's exact release allowlist has **not** been expanded for this
foundation. Do not use it to install this branch or activate these stores.

## Recovery limitation

The existing `JournalSet` guard is unchanged. It commits a data database and its
separate recovery anchor in two steps. An interruption between those commits can
leave durable data with a mismatched anchor; reopening then fails closed and
requires reviewed recovery. This foundation does not claim automatic recovery
from that case, and it never advances or clears the witness to bypass the guard.
Restoring an old data copy is not an authorized way to rewind reward history.
