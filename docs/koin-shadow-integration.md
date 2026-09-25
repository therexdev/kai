# KOIN shadow integration

This branch adds shadow-only master adapters for the approved KOIN transition.
The availability router is disabled by default. A separate paid-job development
engine now implements reservations, metering, receipt verification and read-only
settlement reconciliation. There is no KOIN signer, broadcaster, contract
deployment or payout change.

Enable only on an explicitly selected instance with `KAI_KOIN_SHADOW=1`,
`KAI_KOIN_AUDIENCE=https://your-host/scheduler` (the exact client base URL,
without trailing slash), and the existing `KAI_OPERATOR_SECRET`.

The desktop receives `koinShadow: true` at worker registration and in legacy
balance reads. It sends signed `/koin/presence` reports only while serving.
Collection requires an operator-qualified capacity slot; downloaded models and
self-reported tokens never qualify for KOIN rewards by themselves.

The files listed in `lib/koin-network/SOURCE.json` are copied from
`therexdev/kaiapp/core/lib/koin-network`; the manifest records their content
hashes and source commit. Port fixes for those files from that source and update
the hashes together. The paid-job engine and probes are master-owned modules.
The complete approved plan,
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

See [koin-paid-jobs.md](koin-paid-jobs.md) for the new shadow job engine,
its tested recovery behavior, and the remaining integration work. It has no
public routes and does not feed synthetic charges into reward allocations.

`node scripts/probe-koin-shadow.js` tests protocol signatures, full-minute
coverage, restarts, operator controls and the actual Scheduler mount. Existing
probes continue to verify legacy behavior. Do not merge this review branch as
an implied live activation: the production branch is automatically deployed.
