# Reward runtime reliability, version 3

This code-only release follows `d44918441a328a1391a1d4df9dbe9bde00c9c3ad` (runtime version 2). It separates local earning refresh from financial RPC waits, prioritizes current-day opening after saved nonce recovery, rotates historical work, reduces repeated qualification/history/allocation processing, and schedules bounded RPC reads by purpose.

Funded proposals, finalizations, claims and closed-day work now use evidence bound to the exact intent, with irreversible epoch/account state and fresh current custody checks. Unrelated deposits or other accounts' claims need not leave the entire pool unchanged. New and saved openings retain their full evidence checks. Exact transaction recovery, nonce ownership, signatures, resource limits and financial policy remain enforced.

The release preserves the existing JSON shadow ledger and financial databases. It does not activate a new storage backend or change closed intervals, signed manifests or previously recorded payments. Qualification version history is not activated: safe rollback through an older writer cannot reconstruct an intermediate retirement that writer did not preserve. The separate transactional-store and qualification-history migration remains a prerequisite for the next capacity stage.

See [reliability operations and capacity gates](../../docs/koin-reliability-operations.md) and the [local benchmark guide](../../scripts/benchmarks/README.md). These changes are not a certification of 1,000-provider capacity.

## Installation

From the exact reviewed descendant of `d44918441a328a1391a1d4df9dbe9bde00c9c3ad`, with system Node 22 or newer:

```bash
node deploy/koin-mainnet/update-reward-runtime.js
```

The updater accepts only the exact reviewed changed paths. Before transitioning the process it runs isolated tests serially, stages a separate code release, verifies pinned contracts through read-only RPC requests, and checks the existing service/configuration identity. It does not edit, restore or remove account, payment, reward, quote or shadow journals, wallet keys, configuration or policy.

It avoids the history-heavy `/operator/status` endpoint. It signals only the verified main PID with SIGTERM; it never sends SIGKILL or uses `systemctl stop`. The application drains startup, existing HTTP requests, financial processing and local availability work before closing journals. The updater bounds its wait and refuses activation if that clean exit has not occurred.

Replacement requires unchanged configuration/unit, unchanged `ExecMainPID` and `NRestarts`, and `ActiveState=inactive`, `MainPID=0`, `ExecMainCode=1`, `ExecMainStatus=0`, `Result=success`. A default SIGTERM exit (`ExecMainCode=2`, `ExecMainStatus=15`) is insufficient. A changed process, restart, timeout or unsuccessful drain stops the update; a surviving process receives no further signal.

If activation checks fail, code-only rollback requires the new process to pass those same graceful-exit checks. It never restores older financial records. Concurrent configuration/unit changes stop automatic recovery. The external systemd stop deadline still applies to a manual `systemctl stop`; this guarded updater avoids starting that stop job.

## Verification

The updater requires `rewardRuntimeVersion: 3` on loopback and public health and authenticates to `/operator/progress`. It prints separate serving, availability, reward and settlement timestamps; current epoch/budget/interval progress; bounded errors; runtime pressure; and the last lifecycle decisions.

`GET /health` remains a serving/capability signal. `GET /health/earnings` returns 200 for healthy current funded tracking or 503 with fixed diagnostic reason codes. It uses bounded local state, not financial scans or live RPC requests. It does not prove individual eligibility or completed payouts, and a chain-finality wait is not grounds to automatically restart a financial writer.

A code activation may succeed while earnings health still reports a missing funded day or stale intervals; the updater reports that distinction. After activation, verify that repeated observations show fresh availability passes and advancing current-day intervals. Separately confirm older epoch roots, affected provider allocations and exact payout transactions. Do not infer payment from `lastRewardSuccess` alone.

From the checkout, inspect progress without changing state:

```bash
node -e 'require("./deploy/koin-mainnet/update-reward-runtime").progress().catch(e => { console.error(e.message); process.exitCode=1; })'
```

## Read-only pending-transaction inspection

```bash
node deploy/koin-mainnet/diagnose-reward-opening.js
```

This separate process reads deployment configuration and a bounded view of the cycle database in read-only mode. It checks each configured RPC independently, preserving chain and contract pins, and validates saved lifecycle transactions against their exact operations and irreversible inclusion. It does not load wallet keys, sign, submit, reconcile or rewrite state.

An empty transaction lookup can mean a missing node index. It is not proof that a transaction failed or permission to replace its saved envelope. Existing recovery fences remain in place.

## Release boundaries

The active JSON ledger still rewrites historical data for accepted presence; large-scale operation requires a durable outbox and transactional hot-data store with proven migration and rollback. The per-model qualification run cap and the single claim-sponsor nonce also remain capacity limits. Independent always-on RPC origins, representative hardware tests, a day-boundary soak and failure/recovery drills are required before raising supported network size.
