# Wait for coherent reward evidence without blocking unrelated work

A new block or RPC endpoint change during reward reads invalidates that read
window. Previously the observer threw an exception, which could end an entire
runtime pass while checking an older payout. Repeated moving-head errors could
therefore delay daily rewards even while individual RPC calls succeeded.

The observer now returns its existing unverified `changed` state for these
specific read-window changes. Existing claim and cycle gates wait for fresh
evidence on the next tick, and independent stages can continue. Mixed reads
are discarded and never authorize a signature, submission, manifest, or paid
state. There is no immediate retry loop or extra RPC load. An earlier verified
snapshot cannot be returned when its current revalidation is inconsistent.

Chain identity, bytecode, policy, custody, malformed responses, finality and
clock validation errors still throw. A private error type identifies only
observer-detected window changes; matching an arbitrary error message does
not suppress it. Original signed bytes, nonce fences, attempt limits and
irreversible confirmation requirements remain unchanged.

## Installation

Use system Node 22+ and a clean checkout of this commit descended from
`fe1a6b27ea44cafefacb2e506254edc517242b91`, with locked production dependencies
installed. Run `sudo node deploy/koin-mainnet/update-reward-progress.js`.
The installer accepts only that observed prior release or an idempotent
repeat of the target, verifies the five-file source scope and service
identity, and runs isolated regression tests before staging the new code.

Before shutdown it reads authenticated loopback status until the runtime
reports an idle stage, for up to three minutes. A fresh recoverable error
timestamp does not count as idle. A clean process exit is still mandatory.
If no boundary is observed, the old process remains running and its unit is
unchanged. If the old process exits unsuccessfully during shutdown, the
upgrade aborts; when the old unit and configuration are unchanged and no main
process remains, the installer restarts the old release and verifies health.
An already failed service must be started and checked before updating.

Configuration and financial journals are never restored from backup. Startup
and health checks retain the previous code-only rollback behavior and current
accounts, credits, keys, quotes and transaction records.

## Verification

Check the authenticated operator status for cycle progress and unexpected
errors. A normal moving read window can leave a particular claim or epoch
waiting until a coherent snapshot becomes irreversible; the update does not
shorten finality or the root-review hold. Read-only regressions cover movement
during initial capture and revalidation, normal recovery, no signing from mixed
evidence, no duplicate payout after a finalized transaction, continued runtime
progress, and fatal validation errors.

`lastRewardSuccess` means the daily cycle and collection pass completed.
`lastSettlementSuccess` in public health and `lastSuccess` in operator status
mean the full pass returned without a thrown error. Waiting on incomplete
evidence is a normal outcome: these timestamps do not prove that every epoch
is final or that every provider was paid. Check the actual cycle and claim
states before reporting payment completion.
