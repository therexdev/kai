# Reward runtime progress and bounded manifest verification

This code-only update addresses repeated verification of unchanged signed reward
manifests and repeated work for already checkpointed reward days. It also adds
an authenticated, lightweight `/operator/progress` endpoint. A successful
`/health` serving heartbeat does not establish that rewards or payouts advanced.

The progress endpoint reads bounded in-memory fields and today's shadow-day
metadata. It does not enumerate settled jobs, scan financial journals or
recompute account totals. The existing operator credential is required. Error
output excludes raw transaction envelopes and credentials.

## Installation

Use the reviewed descendant of
`45277dd1a63d54d773e472b891520ce4a12ffe67`, with system Node 22 or newer:

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

The previous `/operator/status` endpoint may be slow because it reads financial
history. This installer therefore bootstraps without polling that endpoint. It
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

The updater requires `rewardRuntimeVersion: 1` on loopback and public health,
then authenticates to `/operator/progress` and prints a bounded summary:

- Current stage and start time, serving timestamp, reward timestamp and
  settlement timestamp.
- Today's epoch, whether its budget/day exist, and its last recorded interval.
- Recent bounded processing errors and safe RPC queue/transport diagnostics.

These checks establish that code activation and monitoring work. They do not
prove a particular payout occurred. Observe another advancing reward pass,
check today's budget and interval progress, and confirm the affected provider's
rewards and eventual transaction status. A current-day budget being present
also does not by itself establish the state of an older payout.

## Isolated coverage

The installer tests cover normal activation and exact retry, unchanged
configuration/key/journal bytes, failed staging and RPC preflight, rejected
source/override/lock identities, main-process PID/restart changes, default
signal termination, nonzero exit, drain timeout, concurrent configuration
changes at the final signal boundary, changed exited identity at the replacement
boundary, code-only rollback, and failed rollback drain. No installer test
opens a live journal or broadcasts a payment.
