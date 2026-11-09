# Finalized reward recovery and runtime diagnostics, version 2

This update lets the scheduler finish recording a saved `finalize_root`
transaction after that exact transaction has already been proved successful on
the irreversible chain. Completion proof is scoped to the matching finalized
epoch and root, so unrelated changes in the global pool or paid totals cannot
invalidate that completed result. The observer still checks current custody
invariants, deployment pins, canonical irreversible evidence and a minimum
height at or after the exact transaction's finalized block. This scope cannot
be used to authorize a new action or verify a claim. Opening epochs, proposing
roots, signing new transactions and claim verification retain full evidence.

Both configured RPCs proved the incident's saved finalization transaction at
block 40,915,874, while the scheduler still reported it as unknown. The pool was
stable during the later observation window. These facts do not establish that
pool changes caused this incident; the narrower completion path fixes a
separately verified obstruction without changing payment policy.

The update also reduces repeated qualification work within each provider poll.
Qualification snapshots remain scoped to one poll, and device, ownership and
admission checks continue to run. Existing manifest-verification caches and
completed-day checkpoints remain in place.

The owned RPC transport now sets its per-address connection-attempt window to
1,000 ms instead of inheriting Node's 250 ms default. A native HTTPS regression
reproduces recovery from a 350 ms JavaScript pause with this larger window.
Automatic IPv4/IPv6 selection, endpoint order, concurrency, and the existing
20-second endpoint-attempt and 45-second RPC-call deadlines remain unchanged.
A silent address can delay the next address candidate by up to 750 ms more.
This bounded tradeoff does not prove that JavaScript pauses caused the live VPS
timeouts. Bounded transport-phase and runtime-pressure diagnostics provide the
evidence needed to distinguish those failures.

The authenticated `/operator/progress` endpoint continues to read bounded
in-memory fields and today's shadow-day metadata. It does not enumerate settled
jobs, scan financial journals or recompute account totals. A fresh serving
heartbeat does not establish that rewards or payouts advanced. Diagnostics omit
credentials, signed transaction envelopes, request bodies and provider prompts.

## Installation

Use the reviewed descendant of
`605eb5a6e8654b918d6659952936d1cc9537b751`, with system Node 22 or newer:

```bash
node deploy/koin-mainnet/update-reward-runtime.js
```

The updater accepts only the exact reviewed source paths. Before requesting any
process transition, it runs isolated regression tests one file at a time to limit
additional load on the live server, stages a separate code
release, verifies the pinned contracts with read-only RPC requests, and checks
that the existing unit and configuration have not changed. It never edits,
restores or removes account, payment, reward, quote or shadow journals; wallet
keys, configuration, policy and sponsorship capacity also remain in place.

The full `/operator/status` endpoint reads financial history. This installer
continues to avoid polling that endpoint during the process transition. It
checks the main process identity and requests **only main-process SIGTERM**.
It never sends SIGKILL, runs `systemctl stop`, or creates a stop job with a forced
termination deadline. The application owns draining its active pass.

Code replacement requires all of the following:

- The same unit and configuration remain installed.
- The same `ExecMainPID` and `NRestarts` remain observed through the replacement.
- `ActiveState=inactive`, `MainPID=0`, `ExecMainCode=1`, `ExecMainStatus=0` and
  `Result=success` establish a normal successful process exit.

A default SIGTERM termination (`ExecMainCode=2`, `ExecMainStatus=15`) does not
qualify, even if systemd reports `Result=success`. A changed PID, automatic
restart, unsuccessful drain or timeout aborts the update. A surviving process
receives no additional signal. If the unchanged old code has exited and is
inactive or failed, recovery may start that exact old unit; if it is already
restarting, recovery leaves that transition alone.

If activation checks fail, rollback changes code only and requires the new
process to pass the same graceful-exit checks. It never rewinds current
financial records. Concurrent configuration or unit changes are preserved and
stop automatic recovery. Any prepared release is retained for review when it
cannot safely be reclaimed.

## Verification

The updater requires `rewardRuntimeVersion: 2` on loopback and public health,
then authenticates to `/operator/progress` and prints a bounded summary:

- Current stage and start time, serving timestamp, reward timestamp and
  settlement timestamp.
- Today's epoch, whether its budget/day exist, and its last recorded interval.
- Recent bounded processing errors, RPC transport phases and queue pressure.
- Runtime pressure measurements including event-loop delay/utilization, process
  memory and the number of qualification models.
- The bounded results from the last reward-cycle attempt, including whether
  opening today's epoch was requested and any recorded wait reason.

Code activation alone does not establish reward recovery. Verify that the saved
older finalization reaches `complete`, today's budget and day exist, and
successive observations show advancing reward intervals and timestamps. For the
November 9 incident, the specific checks are epoch `20764` finalization and the
new epoch `20766` budget/day/interval progress. Then confirm the affected
provider's rewards and eventual payout transaction. A current serving heartbeat
or a budget being present does not by itself prove those outcomes.

## Read-only inspection without a service restart

From the reviewed checkout with its dependencies installed, run:

```bash
node deploy/koin-mainnet/diagnose-reward-opening.js
```

This separate process reads deployment configuration and a bounded view of the
existing cycle database in read-only mode. It uses each configured RPC endpoint
independently, preserving the deployment's chain and contract pins. It checks
the saved pending lifecycle transaction against the exact operation and
irreversible chain evidence, along with epoch and lifecycle resource status.
It does not load wallet keys, sign, submit, reconcile or rewrite financial state.

A valid empty transaction lookup on one RPC produces an unknown result and does
not automatically trigger ordinary transport fallback. Independent endpoint
results can therefore reveal a missing transaction index on one node. An
unknown result is not proof of failure or permission to replace the saved
transaction. This helper only reports evidence; existing recovery fences remain
in place.

## Isolated coverage

The installer tests cover normal activation and exact retry, unchanged
configuration/key/journal bytes, failed staging and RPC preflight, rejected
source/override/lock identities, main-process PID/restart changes, default
signal termination, nonzero exit, drain timeout, concurrent configuration
changes at the final signal boundary, changed exited identity at the replacement
boundary, code-only rollback, and failed rollback drain. No installer test
opens a live journal or broadcasts a payment.
