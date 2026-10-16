# Recurring owner-pilot reward stalls

The October 15 one-time recovery finalized a single saved transaction. It did
not establish why that transaction's earlier submissions failed: the runner
discarded their errors. Another unresolved signing record subsequently blocked
the session-approval updater. Its identity has not yet been read from the VPS.

Reproduced defects and fixes:

- Reward capture compared a timestamp taken before RPC reads with a timestamp
  taken after them. Normal elapsed time could report a backwards clock. Verified
  evidence also carried the start time and could arrive older than the ledger's
  five-second freshness gate. Use completion timestamps while retaining actual
  rollback, snapshot age, irreversibility and unchanged-state checks.
- Independent reward reads were serial. Run them together, require the same
  surrounding head, finish with the closing head read, and reject RPC endpoint
  changes throughout verification. Chain, bytecode, authority, custody and reward
  policy checks remain mandatory.
- The five-second runner timeout did not cancel runtime verification or HTTP.
  Pass cancellation through a bounded transport and check it before broadcast.
  Each HTTP call makes one attempt; durable journals remain the only retry owner.
  Runtime preparation/submission now has a 30-second bound. An HTTP response is
  never irreversible confirmation.
- Save sanitized reward submission outcomes in the existing cycle or claim record.
  Original signed bytes, nonces, three-attempt ceilings, daily Mana reservations
  and journal identities are unchanged. Check lifecycle and payout sponsor nonce and available Mana
  before consuming another broadcast attempt; resource outages wait without
  burning the attempt budget.

The compatible updater may carry an already exhausted reward cycle or provider payout through a
code update only when the signing and reward records agree, hashes and original
signatures validate, the configured sponsor and operation match, and the
record is still `needs_review / attempt_limit` at exactly three attempts. Payouts
also require the original signed manifest and exact committed entitlement. It
backs up stopped state and verifies those same bytes and counters after startup.
It does not authorize a fourth send. All unfinished paid chat holds, incomplete
signatures and other unresolved transaction states still block installation.
Rollback restores code only, never payment journals. Qualification is preserved.

An exhausted transaction still unknown to the chain remains under review. The
updater reports its ID and read-only status from both configured RPCs after the
fix is installed. Any additional retry would require separate review of that
actual transaction; this change does not claim to have recovered it.

Validation includes real elapsed-time and cancellation regressions, preserved
exhausted envelopes across restart, low-Mana waiting without extra attempts,
rollout/rollback fixtures, all KOIN probes on Node 22, and the isolated chain
workflow. No mainnet transaction is submitted by these validation workflows.
