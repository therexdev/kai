# KOIN shadow integration

This branch adds the first shadow-only master adapter for the approved KOIN
transition. It is disabled by default and contains no KOIN signer, paid-work
settler, contract deployment or payout change.

Enable only on an explicitly selected instance with `KAI_KOIN_SHADOW=1`,
`KAI_KOIN_AUDIENCE=https://your-host/scheduler` (the exact client base URL,
without trailing slash), and the existing `KAI_OPERATOR_SECRET`.

The desktop receives `koinShadow: true` at worker registration and in legacy
balance reads. It sends signed `/koin/presence` reports only while serving.
Collection requires an operator-qualified capacity slot; downloaded models and
self-reported tokens never qualify for KOIN rewards by themselves.

The shared modules are copied from `therexdev/kaiapp/core/lib/koin-network`.
`lib/koin-network/SOURCE.json` records their content hashes. Port future fixes
from that source and update the hashes together. The complete approved plan,
contract prototypes, activation gates and desktop release notes live there.

## Routes

- `GET /koin/status?address=...`: simulated status, always payments disabled.
- `POST /koin/presence`: domain-bound signed current-model report.
- `POST /koin/shadow/qualify`: operator secret; capacityId, address, model,
  modelHash, benchmarkHash, integer-string modelWeight, coverageBps and expires.
- `POST /koin/shadow/open`: operator secret; explicit simulated balance and
  liabilities in decimal-string KOIN atoms. It neither reads nor moves money.
- `GET /koin/shadow/manifest?epoch=...`: operator secret; closed UTC day
  allocations and their hash. This is not a signed financial commitment.

The ledger is separate under scheduler-data/koin-shadow. Qualifications expire
within one day. Missing observations, model changes and heartbeat gaps do not
receive availability estimates. Work allocations remain zero until the next
implementation supplies verified, finalized paid-work receipts. Challenge-based
reliability, production retention/backup/recovery, finality reconciliation and
real tariffs remain activation gates.

`node scripts/probe-koin-shadow.js` tests protocol signatures, full-minute
coverage, restarts, operator controls and the actual Scheduler mount. Existing
probes continue to verify legacy behavior. Do not merge this review branch as
an implied live activation: the production branch is automatically deployed.
