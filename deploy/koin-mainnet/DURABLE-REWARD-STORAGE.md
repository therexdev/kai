# Durable reward storage and worker runtime

Runtime version 4 selects the verified SQLite shadow store only after the offline
activation marker and downgrade sentinel agree. Unactivated installations retain
the compatible JSON implementation. Use the reviewed storage installer for the
transition; checking out this branch alone does not activate storage. This release
does not establish a supported provider count or promise uninterrupted operation.

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

## SQLite storage in a dedicated worker

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

Synchronous SQLite work runs inside a dedicated worker thread. The request thread
keeps only bounded current-day totals, active qualifications and latest presence.
Historical reads, interval allocation, manifest evidence and checkpoints stay in
the worker. Replies apply committed projection changes before resolving callers.
An expired or unavailable projection produces unavailable earnings, never a false
zero estimate; existing signed pending rewards remain visible.

The worker admits at most 64 requests and 8 MiB of queued payloads, with a 4 MiB
per-request limit. Its coordinator admits at most 128 operations and 8 MiB. These
are admission bounds, not supported provider counts. Overflow rejects before a
new source write. Worker loss invalidates projections and does not automatically
retry an uncertain write or spawn a competing worker. Shutdown drains admitted
operations and waits for the actual worker exit before closing source journals.

## Ordered presence delivery

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

Activation changes the provider database identity to outbox version 2 so older
binaries reject it. Every active source and sink open requires an exclusive writer,
including against another instance in the same process. One coordinator serializes
source acceptance, replay, qualification changes and interval closure. It drains
committed source events before every mutation and acknowledges source receipts only
after durable sink commit and projection publication. Wallet-signed legacy reports
have their own atomic receipts in the sink; exact retries retain acceptance time.

Qualification refreshes retire and replace their records in one transaction, so
a heartbeat-triggered tick cannot see a partially refreshed set. Each tick is
bounded to eight intervals and reserves progress for the current day while older
days catch up. Per-day interval order and the allocation policy remain unchanged.
Startup seals saved manifests and retires obsolete readiness records before replay,
and completes this barrier before opening the HTTP listener.

## Activation and operational checks

See [REWARD_STORAGE_ACTIVATION.md](REWARD_STORAGE_ACTIVATION.md) for the exact
release installer and offline phases. Preparation validates every saved manifest,
source hash, evidence hash, allocation and semantic index while writers are stopped.
The original JSON remains as a read-only backup. The live legacy path becomes an
unsupported-schema sentinel before the active marker is written; it is never
removed or replaced with a blank ledger.

After installation, verify both loopback and public health report runtime version
4 and `rewardStorage: {schema: 1, mode: "sqlite-shadow", ready: true}`. Earnings
health must become ready and current interval counts must continue advancing.
Use the lightweight operator progress command for reward-cycle observations;
local `paid` or `complete` journal states alone are not independent chain proof.

Qualification-history changes remain disabled. The prior current-only records
cannot reconstruct intermediate retirement or renewal events. This migration
preserves that limitation instead of inventing historical eligibility.

Before expanding the network, measure sustained traffic, UTC day rollover,
catch-up, RPC outages, restart recovery, memory and disk growth on the intended
host. Local saturation and fault tests establish specific behaviors, not production
capacity or an uptime guarantee. The separate RPC node/tunnel remains another
component to monitor; scheduler storage changes do not make that path redundant.

## Recovery limitation

The existing `JournalSet` guard is unchanged. It commits a data database and its
separate recovery anchor in two steps. An interruption between those commits can
leave durable data with a mismatched anchor; reopening then fails closed and
requires reviewed recovery. This runtime does not claim automatic recovery
from that case, and it never advances or clears the witness to bypass the guard.
Restoring an old data copy is not an authorized way to rewind reward history.
