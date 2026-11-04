# Reward progress isolation and RPC diagnostics

The prepaid runtime processes older payouts before daily reward cycles. A
retryable RPC error while confirming an older payout previously ended the
whole pass, preventing the current day from opening and saved availability
from progressing. Standalone contract and epoch reads can succeed while the
long-running service fails elsewhere in that pass.

In prepaid mode only, a retryable `koin_rpc_unavailable` from the payout
runner is now recorded and the independently verified daily reward cycle and
collection stages continue. Prepaid usage settlement still runs first. Contract,
manifest, signing and financial validation failures still stop processing;
the legacy combined settlement runner retains its original failure gate.
Claim reconciliation continues through its existing durable journal and
irreversible observer. No transaction is marked paid by this update.

The operator status now reports `processingStage`, `processingStartedAt`, and
the stage of each failure. RPC failures include bounded, sanitized endpoint
origins, methods, failure categories, numeric HTTP/RPC codes, known network
codes, and queue counts. Request parameters, transaction signatures, raw
upstream messages, and URL query strings are excluded.

`lastRewardSuccess` in `/health` and `/operator/status` means the daily reward
cycle and collection pass completed. It does not prove every epoch is final
or that a particular provider was paid. `lastSettlementSuccess` in `/health`
and `lastSuccess` in operator status retain their full-pass meaning and do
not advance when the payout stage throws.

## Installation

Use system Node 22+ and a clean checkout of this commit descended from
`b6490e74db28908b96ab7e223846843c02d3c1f9`, with locked production dependencies
installed. Run `sudo node deploy/koin-mainnet/update-reward-progress.js`.
The installer accepts only that observed prior release or an idempotent
repeat of the target, verifies the seven-file source scope and service
identity, and runs isolated regression tests before staging the new code.

Before shutdown it reads authenticated loopback status until a freshly
completed pass is observed, for up to three minutes. This reduces the chance
of interrupting a long RPC pass; a clean process exit is still mandatory.
If no boundary is observed, the old process remains running and its unit is
unchanged. Configuration and financial state are never restored from backup.
If the old process exits unsuccessfully during shutdown, the upgrade aborts.
When the old unit and configuration are unchanged and no main process remains,
the installer restarts the old release and verifies its health, including when
systemd reports `failed` instead of `inactive`. An already failed service must
be started and its health verified before beginning an update.
If activation or health checks fail, rollback restores only the previous code
and retains current accounts, credits, keys, quotes and transaction journals.

## Verification

After installation, inspect both health timestamps and authenticated operator
status. Confirm the current epoch opens and the older epoch advances through
the existing root review and finality rules. If errors continue, use the stage
and RPC details to identify the actual failing request in the running process.
This update does not establish the cause of all remaining RPC failures, fix an
inaccessible fallback, or guarantee payout recovery.

Do not reset claim states, signing fences or attempt counters, resend saved
transactions manually, or treat an empty transaction lookup as proof of failure.
