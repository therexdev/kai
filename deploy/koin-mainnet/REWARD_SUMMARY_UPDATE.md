# Daily reward reporting update

This is a code-only update from the installed model-readiness release
`4f108fedf9f0e35d33635989d38b5c8c3aa9fa3c`. Use the exact backend commit pinned
in the matching kaiapp `docs/DAILY_REWARD_SUMMARY_RELEASE.md` command.

From that clean checkout, with dependencies installed, run as root using system
Node 22 or newer:

```sh
node deploy/koin-mainnet/update-reward-summary.js
```

The updater verifies the old service identity and permits only the reporting
files and their regression tests. It prepares dependencies before stopping the
service, switches code, then checks loopback and HTTPS health and wallet-access
capabilities. Failure restores the earlier code while retaining current journals.
It preserves runtime configuration, keys, accounts, credits, qualifications,
payment records and reward policy. It never restores old databases. Concurrent
configuration changes or a different installed service version stop the update.

Success reports `Daily reward summaries installed and verified on loopback and
HTTPS`. `/health` then includes `rewardSummaryVersion: 1`. This marker confirms
the reporting code; it does not certify successful settlement or a payment.
An authenticated wallet's status includes its current verified-interval estimate
and signed allocations awaiting review/finalization. Viewing status does not
advance the reward cycle or sign a transaction.

After installing the matching desktop Test release, Earn shows the two totals.
An older backend remains compatible with payout history but cannot supply the
new summary. A stale processing check remains visible rather than becoming a
guaranteed earnings or payout claim.
