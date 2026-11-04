# Scheduler RPC pressure repair

The Master Node public RPC admits four simultaneous upstream calls and 30
requests per second. Reward snapshots issue roughly ten reads together, and
each pinned read also checks chain identity. The live endpoint returned HTTP
503 with `RPC busy; retry later` during that burst. Its configured fallback
returned HTTP 403. A working head query therefore did not establish that the
reward loop could complete.

The pinned provider now shares a FIFO budget for each endpoint across every
provider instance in the process: two HTTP requests at once, starts at least
50 ms apart, and at most 128 waiting requests. A slot covers response-body
consumption. Waiting counts against the existing attempt deadline; cancelled
or expired work is removed before it can send. Endpoint chain pinning,
coherent reward snapshots, fallback selection, exact signed bytes, transaction
attempt ceilings and irreversible confirmation checks are unchanged.

## Installation

Use a clean checkout of this repair commit and system Node 22. Install its
locked production dependencies with `npm ci --omit=dev --ignore-scripts`, then
run `sudo node deploy/koin-mainnet/update-rpc-pressure.js` from that checkout.

The installer accepts the observed release
`ecc989bfdf2c78e224ec00e633c432ec154b60e0`, or an idempotent repeat of the target.
It checks the exact source scope and service identity, runs isolated tests,
stages a separate release, and restarts the service after a clean shutdown.
Configuration, keys and live financial journals are retained. If startup or
service health fails it restores the old code only; current journals are
never rolled back. Unexpected local edits or service overrides stop the update.

## Recovery verification

Service health is not evidence of completed reward processing. After the
update, check `/health` and confirm `lastSettlementSuccess` advances. Check the
authenticated `/operator/status` for progressing epoch steps and recent
errors. Saved estimates only become payable after the original root-review,
finalization and claim process. Do not clear journals or reset retry counters.

The inaccessible fallback RPC is still a separate availability issue. The
queue prevents this scheduler's own bursts from exceeding the primary's
limits; it cannot guarantee capacity during unrelated external traffic.
