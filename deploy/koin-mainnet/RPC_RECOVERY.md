# Recovering stalled scheduler RPC requests

On November 5, a fresh process on the VPS verified the deployment in 863 ms,
while the running scheduler reported both endpoints at two active requests and
repeated chain-id timeouts. Public reward progress had stopped on November 4
at 17:09:18 UTC. These observations suggest process-local transport starvation;
they do not identify the underlying fetch/socket fault conclusively.

The prior provider races a deadline against fetch and body consumption. If
either promise fails to settle after cancellation, its endpoint slot remains
occupied. An isolated reproduction with two such requests leaves every later
call queued, even after all caller deadlines have expired.

The default pinned provider now uses an owned HTTPS request per slot, with no
shared fetch pool or reusable connection. Abort destroys the request and
response; completion waits for request close before releasing the slot. The
response size is bounded while streaming. Error bodies are closed immediately,
redirects are refused, and TLS verification remains enabled. The existing
two-request endpoint concurrency, start spacing, deadlines, chain pins, safe-read
fallback and single-attempt broadcast rules remain in force. A timed-out
broadcast still has an uncertain outcome; durable journals and on-chain
reconciliation continue to own retries.

Real local HTTPS tests cover repeated header/body stalls, queued cancellation,
uncertain broadcasts, truncated/oversized bodies, unfinished error bodies,
fallback, chain mismatch, redirect refusal and untrusted TLS rejection. They
check that the same process resumes reads and never exceeds its two slots.
No test uses a live financial journal or broadcasts a live transaction.

Install the reviewed descendant of `2e9ede15259cb838c3dfbc9cfacf28d7258e439c`:

```bash
node deploy/koin-mainnet/update-rpc-recovery.js
```

The updater runs regressions and read-only contract verification through the new
transport before stopping the service. It waits for an idle processing boundary,
requires a clean stop, changes code only and verifies `rpcTransportVersion: 1`
on both loopback and public health. Configuration, claim capacity, keys, saved
transactions and all financial journals stay in place, including code recovery.

Installation readiness is not evidence of reward recovery. Check operator
`lastRewardSuccess`, its age and `recentErrors` after activation. Observe another
advancing reward pass several minutes later, check cycle/payout progress, and
confirm the tester's earnings screen. Neither the serving `lastSuccess`
heartbeat nor an empty pending-signature list proves that rewards are current.

Node request lifecycle reference:
https://nodejs.org/download/release/latest-v22.x/docs/api/http.html#requestdestroyerror
