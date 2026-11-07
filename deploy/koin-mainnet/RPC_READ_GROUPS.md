# Cancel abandoned blockchain read groups

The November 7 operator output showed intermittent `ETIMEDOUT` failures at both
configured RPCs, queues of up to 15 requests, and successful processing between
failures. The running process was not permanently wedged. The November 7 epoch
was submitted at 16:04 UTC. A later VPS curl sample reached Cloudflare promptly:
`api.koinosai.com` returned HTTP 502 while `api.koinos.io` returned the pinned
mainnet chain ID. Normal and IPv4-only requests behaved the same in that sample.

This code update fixes a separate, reproducible source of unnecessary queue
pressure. Failed parallel verification reads could leave their siblings running.
In particular, the free-allowance observer discarded its controller and cleared
its deadline after an early rejection, allowing subsequent checks to overlap
the abandoned work. Read groups now cancel and drain their siblings, and nested
scopes preserve parent cancellation.

Endpoint order, concurrency, request deadlines, bytecode and chain pins, coherent
snapshot checks, exact transaction recovery, and financial policies are unchanged.
The update does not repair the public API origin or backfill unrecorded earning
intervals. It does not change the desktop's previous-day estimate display.

## Install

Use the clean reviewed `fix/rpc-read-group-recovery` checkout descended from the
observed installed release `989d2aaa22562b9dacb2bdec31d4ca0af29aafa1`:

```bash
npm ci --omit=dev --ignore-scripts
node deploy/koin-mainnet/update-rpc-read-groups.js
```

The updater runs isolated regressions and verifies the pinned contracts through
the existing endpoints before stopping production. It waits for an idle reward
processing boundary, requires a clean stop, installs code, and checks both
loopback and public health for `rpcReadGroupVersion: 1`. A failed activation
restores code only; configuration, keys and current financial journals remain
in place. The previous update's lock is also held to prevent overlapping changes.

## Verify recovery

`rpcReadGroupVersion: 1` proves the code is active. A fresh serving heartbeat or
completed reward pass alone does not prove that every epoch or payout advanced.
Check authenticated operator status for current-day `open_epoch` completion,
dated cycle steps, payout progress and recent RPC failures; then confirm the
affected provider's dated earnings. Reconcile any missing eligible intervals
from retained evidence separately, without fabricating availability.

## Diagnose the public API origin

On the computer hosting Master KAI Koinos Node, open **Node API** and inspect
**Endpoint status**. The displayed Cloudflare service URL is the actual local
listener; do not assume a default port.

- Stopped: inspect the Core/plugin API lifecycle and saved API settings.
- Listening with RPC not ready: inspect the configured private node RPC.
- Listening with RPC ready but public HTTP 502: inspect the Cloudflare Tunnel
  service and its target on that same computer.

Quitting Core stops the plugin API even if Docker containers remain running.
Use the RPC readiness endpoint (`/healthz/rpc`) to distinguish blockchain RPC
availability from incomplete producer/history indexing.
