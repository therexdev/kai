# Scheduler payout recovery

The September 2026 stalled-balance incident was a server settlement failure:
accepted work was preserved, while individual claims failed with Koinos code
104 (`insufficient pending account resources`). Every root and claim reserved
600,000,000 RC. Koinos counts pending reservations through the irreversibility
window, so sequential transactions can exhaust capacity even after inclusion.

The website now starts recovery through `startAutoOps`, as does a standalone
scheduler through `listen`. Previously only the standalone boot hook ran, and
it skipped every epoch with any recorded settlement result, including failures.

## Payout behavior

- Simulate each root/claim with `broadcast:false`. Reserve measured RC plus
  25% and 10,000 RC, capped at the prior 600,000,000 ceiling and available MANA.
  Estimation failure, invalid receipts, or reverts do not trigger broadcasting.
- Re-sign the adjusted transaction header; checkpoint its final ID before
  broadcasting. Storage failure withholds payment submission.
- Check the existing root and each worker's on-chain `claimed` bit. A root
  conflict is blocked for operator investigation. Claims already paid are
  reconciled without submitting another payment.
- Wait up to 20 seconds for the expected chain state. Submission alone is not
  payment confirmation. Unknown submissions remain pending for 10 minutes;
  after that a fresh chain-state check allows retry. The contract's epoch +
  worker claim guard also prevents double minting.
- Serialize payouts and sponsored deposit submissions on the same operator
  signer. Stop a payout burst on error. Each epoch attempt sends at most 12
  transactions and stops starting claims after its 90-second work budget.
- Persist progress after each claim. Retry pending epochs with 1–15 minute
  backoff. Partial failures and epochs stranded before submission are included.
- Every minute, run one non-overlapping recovery pass: read at most 100 epoch
  summaries and attempt at most two eligible epochs, with a 120-second pass
  budget checked between epochs. Cursor pagination reaches older epochs beyond
  the public UI's latest-200 window. RPC requests time out at 12 seconds.
  Time budgets do not interrupt a transaction already in progress.

Existing reward amounts, roots, proofs, receipts, token contract, network,
operator key, and recipient addresses are unchanged. More testnet KOIN gives
MANA headroom but does not replace recovery. Old rewards are paid gradually;
there is no fixed promise about backlog completion time.

## Observe deployment and recovery

`GET /api/health` includes `payouts`: version, enabled, automaticRecovery,
running, lastRunAt, lastEpoch, lastStatus. Version 1 identifies this repair.
No keys or privileged operations are exposed.

`GET /scheduler/claims?address=ADDRESS&limit=100` includes per-claim status,
transaction IDs, errors, plus epoch status and nextRetryAt. `confirmed` means
the claim bit was read on chain. `complete` means the root and all claim bits
were verified. `blocked` means a conflicting on-chain root needs attention.
`GET /scheduler/balance?address=ADDRESS` still reports the on-chain balance;
its pending estimate covers only the current open epoch, not the old backlog.

The authenticated `/scheduler/operator/settle` retry uses the same serialized,
checkpointed path. Routine recovery needs no user private key or desktop update.

## Verification

Run `node scripts/probe-payout-recovery.js`, the existing settlement-integrity,
epoch-resume, claims, and durable-store probes, and the full CI probe suite.
All payout tests use offline fixtures and an unfunded deterministic test signer.
There are no testnet transfers in the test suite.
