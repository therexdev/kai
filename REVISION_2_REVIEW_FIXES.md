# Revision 2 internal review follow-up

All seven source-review findings were reproduced in isolated fixtures. No live payments, production services, contract deployments, new credentials or unresolved reward epoch 20742 were touched. These corrections do not constitute independent financial acceptance or solve cross-account collusion.

| Finding | Reproduction | Correction |
| --- | --- | --- |
| Purchase confirmation starvation | 64 unknown claims repeatedly excluded genuine claim 65 after restart. | Durable FIFO confirmation order, rotated atomically before network I/O; new arrivals join behind existing work. Existing pending records are unchanged and never expired. Eight pending claims per verified account supplement the existing wallet cap; retries remain accepted at capacity. |
| Same-account self work | A walletless free request dispatched to its own linked provider; selecting another linked wallet had the same flaw. | Server-derived linked-wallet ownership is stored with the job. Dispatch and metering reject all admission-time/current linked wallets; settlement and reward collection independently reject ineligible work. Older USD jobs without ownership evidence require review. Local computation is unchanged. |
| Settlement queue starvation | 32 definitively reverted rows hid eligible job 33. | Review/reverted/attempt-limit rows are excluded before the bounded active scan. Original review records and global unresolved signing/nonce fences remain. |
| Global reward-day blocker | A newer-day needs-review obligation prevented an older reconciled epoch from sealing. | Require an irreversible state observation made after the epoch boundary and reconcile all included work against that exact on-chain total. Unexplained old work still blocks signing. Future/unsent obligations cannot backdate into an irreversible closed chain day. Existing signed manifests remain immutable. |
| Midnight sponsorship mismatch | 100 atoms consumed before midnight left a fresh 100 available after midnight even though the first 100 still needed settlement-day capacity. | Carry prior-day holds/unsettled usage and grants settled today against the same configured limits. Before sponsored preparation, reconcile known finalized chain-day usage and check explicit contract account/network caps. Excess backlog waits with its original amount/ID; no intentional cap-revert, new budget or expiration. Purchased credits remain usable. |
| Heartbeat arrival-order bias | A at 61 seconds sealed the minute before B at 62; a timer could seal it empty. | Close only strictly after a 45-second evidence grace, matching the existing heartbeat-gap bound. Catch up at most 120 intervals per pass. Persisted intervals and sealed days are immutable. Permuted arrival, early timer, day-end and restart produce identical valid coverage. |
| Desktop correction registration | Original purchase finalized during correction simulation; restart sync registered only the losing superseded correction. | Prefer the verified finality transaction ID; a superseded correction cannot replace the original registration. No signing, broadcast or expired-quote permission is added. |

## Conservative recovery behavior

The sponsorship headroom check refuses unknown/unreconciled on-chain spend and old finality evidence without an established block timestamp. Such historical evidence needs read-only re-observation/review before it can establish spare daily capacity; it is not silently assigned a day or discarded. Existing signed transactions and nonce fences retain their identity. Already consumed customer credits are not re-debited by settlement or review handling.

The ownership check covers account-linked wallets, not collusion between separate accounts or unverifiable historical ownership. The backend verifier still supplies the account-level attestation; contracts cannot independently discover off-chain account links. Commercial configuration, reviewed benchmark/pricing policy, independent financial review, fresh authorized deployment/funding and real two-computer/delayed-payout acceptance remain pending. Three closed reward days versus seven telemetry days is still unresolved.

## Verification

Failing-before logs are retained in this executor under `/tmp/kai-purchase-starvation-before.log`, `/tmp/kai-self-work-before.log`, `/tmp/kai-settlement-starvation-before.log`, `/tmp/kai-epoch-blocker-before.log`, `/tmp/kai-rollover-before.log`, `/tmp/kai-availability-order-before.log` and `/tmp/kai-correction-original-before.log`. These paths are not cross-executor file guarantees. Durable regression tests are committed in the repositories. Final full-suite counts and release evidence are reported with the fix commits.

Final local validation: backend 398 passed, zero failed/skipped; desktop 1,334 passed, zero failed, five skipped. Desktop full tests used the documented external-network isolation preload with loopback/browser checks enabled. Changed JavaScript syntax and whitespace checks passed. These are local/fixture checks, not live two-computer or payout acceptance.

## Bounded post-fix recovery review

Three additional residuals were reproduced and corrected before activation:

- Thirty-two sponsored `capacity_wait` rows hid paid row 33 on every pass. A durable FIFO settlement queue now rotates inspected rows before network reads, including waits/errors. The 32-inspection bound, unresolved nonce fence and original obligations remain. Queue migration seeds existing rows without rewriting jobs. Restart/repeated-tick regression reaches the paid candidate while preserving all 33 obligations and customer balances.
- A first heartbeat after a >180-second outage pruned only that returning provider's historical samples before catch-up. Evidence needed by any unclosed interval is now retained, including the predecessor boundary; sealed/closed intervals remain immutable. A/B arrival permutations at 300 seconds, restart and UTC rollover retain identical earned coverage and award nothing for the outage.
- Desktop sync could register a losing Mana correction before discovering the original winner, exhausting the last admission slot. Sync now reconciles and reloads durable finality before selecting an ID. The backend additionally verifies registration candidates server-side: an already-finalized, correctly attributed payment can be credited atomically without consuming pending-claim capacity. This recovers winners even if older candidate claims filled the cap. Unknown/outage candidates retain the existing bounded queue; no client-supplied proof or amount is accepted. Cross-wallet rejection, repeat/restart exact-once and preservation of all old pending claims are tested.

Failing-before logs: `/tmp/kai-capacity-wait-before.log`, `/tmp/kai-outage-before.log`, `/tmp/kai-sync-discovery-before.log`. These are local fixtures, not live financial operations. Production activation and independent review remain pending.

Post-fix backend validation: 401 tests passed on Node 22, zero failed/skipped, including purchase recovery, settlement queue migration/restarts, public HTTP usage, availability fairness and cutover preparation. Syntax and whitespace checks passed.
