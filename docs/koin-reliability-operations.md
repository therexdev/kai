# KAI scheduler reliability and capacity

This release reduces demonstrated CPU, RPC queue and reward-finality stalls. It does not certify an arbitrary provider count or remove every external dependency. In particular, the active shadow ledger still writes its complete JSON history for accepted presence, and claim transactions share one sponsor nonce.

## Failure mechanisms and changes

| Observed mechanism | Change | Remaining boundary |
| --- | --- | --- |
| Qualification polling repeatedly traverses the same model records | A synchronous, invalidated read view removes repeated validation within one poll | Every new poll and authorization check still uses current evidence |
| Every earning minute scans retained presence samples | Binary lookup selects the exact original evidence window | Historical evidence and allocation rules remain unchanged |
| Every wallet estimate allocates the entire current day again | Exact per-interval totals are cached and shared | Cache is rebuilt from authoritative intervals after restart |
| Financial RPC waits delay local earning refresh | A separate local timer refreshes qualification and closes already-funded minutes | It cannot manufacture funding or credit missing presence |
| Old epochs repeatedly occupy the first processing slots | Saved transaction recovery first, today's unsigned opening next, rotating historical work | An unresolved saved transaction still owns its lifecycle nonce |
| Unrelated pool activity invalidates funded reward observations | Intent-specific immutable evidence plus fresh current custody checks | New and saved openings retain their full-evidence path |
| Background reads fill the shared RPC queue | Bounded class/owner scheduling and 16 queue places reserved for availability | Two stalled active sockets still wait for their existing deadlines |
| Shutdown can interrupt initial verification or the first pass | Signal handling is installed before startup waits; journals close after work drains | The external service manager's stop deadline still applies to a manual stop |

## Operating signals

`GET /health` remains the existing serving/capability check. It is not proof that earnings or payouts are advancing.

`GET /health/earnings` is a bounded local check returning 200 when current funded earning tracking is healthy, otherwise 503 with fixed reason codes. It checks current-day funding, a local processing pass within 30 seconds, and closed-minute progress after the first-minute evidence grace. It does not perform chain requests or scan financial history. A healthy response does not prove any individual provider's eligibility or payment.

Authenticated `GET /operator/progress` reports runtime version 3, separate serving/availability/reward/settlement timestamps, the current epoch, processing stage, bounded errors and event-loop telemetry. Keep the operator secret private. `cycle_reversible` means the observation is waiting for chain irreversibility; it does not itself prove that a transaction was broadcast.

Alert on prolonged missing funded epochs, stale earning intervals, sustained event-loop delay, repeated transport failures, increasing pending reward ages, disk pressure, and a stopped process. Do not restart the financial process automatically merely because a chain observation is reversible. A restart does not repair a missing irreversible proof.

## Production topology

Use two independently hosted, always-on, keyless Koinos RPC nodes/gateways with independent storage and ingress. A desktop application and its tunnel connector are one failure domain; a tunnel marked healthy does not prove its local RPC origin is usable. Hosting both endpoints behind the same desktop or the same failing gateway does not provide independent recovery.

Keep the financial scheduler a single durable writer until a reviewed leader-election and signer-ownership design exists. Do not run two active copies against copied journals or the same signing keys. Separate serving and indexing workloads from the financial writer as their storage and coordination interfaces become available. Backfills must have their own resource budget.

For each RPC host, verify the configured chain ID and contract hashes, advancing head and irreversible height, and exact historical blocks, transaction bytes and receipts needed by pending journals. Exercise the real JSON-RPC methods, not just an HTTP health page. Keep per-endpoint timeouts and queues bounded; never automatically retry a broadcast with a newly constructed transaction.

## Capacity acceptance

The reproducible local harness is documented in `scripts/benchmarks/README.md`. Its 100/500/1,000-provider matrix distinguishes offered providers from admitted providers and reports work that missed its deadline. These development-container results are not VPS capacity measurements and exclude authentication, inference and real network latency.

Current admission has a 256-run-record limit per model and a 10,000 active shadow-capacity limit. Sixteen selected models per provider reach these limits before a fully admitted 1,000-provider cohort. Raising constants without changing storage and proving resource bounds is not a capacity solution.

Before increasing admission, run the same workload on representative hardware with production-sized history, real signed requests and measured client cadence. Complete at least a 24-hour soak spanning the UTC reward boundary and repeat with one RPC endpoint unavailable, a slow endpoint, process termination, full recovery and a backup restore in an isolated environment. Require:

- offered/admitted/completed work and all missed deadlines reported;
- bounded queues and memory throughout the run;
- current earning intervals advancing within their evidence grace;
- no lost or duplicate presence, interval, transaction or claim records after restart;
- exact allocation and manifest equality against the existing policy;
- successful original-envelope recovery without another signature or unauthorized nonce reuse.

Choose and record the provider count only after these checks. The default benchmark's nominal five-second cases locate bottlenecks; they are not a soak test.

## Storage migration gate

High-volume operation requires a transactional hot-data store and append-only historical evidence, rather than rewriting the entire reward history for each presence report. Delegated-device replay acceptance and reward-presence delivery need a durable outbox: commit the signed report and replay position together, apply it idempotently to the shadow store, then acknowledge delivery. An exact committed retry must recover delivery; a changed payload with the same identity must be rejected.

Migration must retain original JSON and signed manifest bytes; compare per-epoch evidence hashes and exact allocations; validate ordering without silently repairing records; and test termination before/after import, outbox apply, acknowledgement and activation. A durable activation marker must prevent a missing new database from silently reopening stale JSON. Rollback after new-store writes requires a reader that understands those writes. Do not restore an old financial journal to roll back code.

This release keeps JSON schema 1 and its existing live records. Qualification version history is not activated: an older writer can retire and renew a qualification between saves without leaving enough evidence to reconstruct that interval after a downgrade. A staged compatible writer and activation policy are required before the new history algorithm is enabled. Until then, qualification renewal can still affect a minute that has not yet closed. Existing closed intervals and manifests are unchanged. The optional transactional-store work is not activated by this release.

## Deployment and recovery

Use the guarded `deploy/koin-mainnet/update-reward-runtime.js` from the reviewed commit. It accepts only the expected predecessor and file set, runs serial tests on the installed Node runtime, requests a clean main-process drain, verifies identity/configuration/service guards, and checks the lightweight progress response. An incomplete drain refuses activation; it does not kill the process or reset journals.

After activation, verify runtime version 3, fresh availability progress and advancing current-day intervals. Separately verify older epoch roots and claims on chain; a recent reward-pass timestamp alone is not payment confirmation. Preserve transaction IDs and exact saved envelopes for any unresolved submission. Never manually change `unknown` to `complete` or clear a nonce fence to make a dashboard look healthy.
