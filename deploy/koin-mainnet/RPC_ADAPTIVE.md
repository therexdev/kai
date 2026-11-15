# Scheduler RPC load and recovery

The payment backlog was cleared by claim resource recovery. This release addresses
the separate intermittent HTTP 429/503 responses observed while the scheduler
reads the public RPC endpoints. A successful localhost/public comparison proves
those routes worked at that moment; it does not identify which component caused
an earlier rejection.

## Behavior

- Overlapping reads in one trusted read group share an in-flight chain-ID probe
  on the same provider and endpoint. Completed probes are never cached. Each
  balance, nonce, head, contract and confirmation read still executes separately.
  Different owners/providers/endpoints and transaction simulations do not share.
- Cancelling a subscriber does not cancel a sibling's pin. Cancelling the final
  subscriber aborts the probe; its scheduler slot remains occupied until physical
  transport closure. Groups retain their existing cancellation, queue bounds,
  fairness, chain checks and endpoint-generation snapshot checks.
- HTTP 429/503 still starts the shared endpoint cooldown and honors bounded
  `Retry-After`. Each new throttle incident also slows physical request starts
  from the normal 50 ms spacing to 200 ms, then doubles up to 1,000 ms.
  Concurrent errors from the same incident do not multiply that slowdown.
- One full pin-plus-operation recovery probe must succeed. That success keeps
  the slower pace. Each subsequent recovery step requires at least 20 successful
  operations and 30 seconds; spacing then decreases by 20%, down to 50 ms.
  All providers in the process share endpoint pacing. Independent clients of
  the public gateway still consume its capacity.
- Operator RPC diagnostics include `requestIntervalMs` and, when recognized,
  `gatewayReason`: `rate_limit`, `busy`, `node_not_ready`, `node_unavailable`,
  `cancelled`, or `metadata_unavailable`. These classify exact existing Master
  Node gateway JSON errors; they are not proof of the underlying cause.
  Unknown proxy errors remain generic HTTP failures. Only JSON error bodies
  up to 8 KiB and 200 ms are inspected. Raw messages, bodies and signatures are
  never retained. Truncated errors preserve their HTTP status and cooldown.

Transaction broadcasts retain one attempt with no automatic retry/failover.
This update does not change claim RC limits, nonce rules, finality, payment state,
or public gateway limits. No Windows Master Node plugin update is required.
Pacing state is process-local and restarts at its normal rate after a restart.
The change reduces avoidable scheduler load; it cannot eliminate an upstream
outage or contention from other public clients.

## Install on the Linux scheduler

The updater requires the active claim recovery release
`13901fd6c623375b0957fc5e600c3633e6ba2aeb`, system Node 22+, and the existing
verified SQLite activation. Run these commands as root on `koinos-scheduler`,
not in Windows PowerShell. Pin the checkout to the reviewed commit supplied
with this release before running the updater.

```bash
cd /root
git clone --branch fix/rpc-adaptive-recovery --single-branch https://github.com/therexdev/kai.git kai-rpc-adaptive-fix
cd kai-rpc-adaptive-fix
npm ci --omit=dev --ignore-scripts
node deploy/koin-mainnet/update-rpc-adaptive.js
```

The installer verifies the exact allowed source changes, regression suite,
module loading and pinned RPC contracts before downtime. It gracefully drains
the service, verifies a clean exit and released writer leases, then activates
the staged code. Configuration, secrets, payment journals and recovery anchors
remain in place. Both local and public health must report `rpcReliabilityVersion:
1`, existing claim recovery capabilities and fresh earnings readiness.

An interrupted installation resumes by rerunning the updater from the same
checkout. Preserve its deployment plan. It does not restore older code or data
after the new runtime has started.

## Check the result

```bash
curl -fsS https://credits.koinosai.com/health
sudo python3 - <<'PY'
import json
import urllib.request
from pathlib import Path

secret = Path('/etc/kai-koin-prepaid/operator-secret').read_text().strip()
def get(endpoint):
    request = urllib.request.Request(
        'http://127.0.0.1:3109/operator/' + endpoint,
        headers={'x-operator-secret': secret})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)

status, progress = get('status'), get('progress')
print(json.dumps({'claimQueue': status.get('claimQueue'),
                  'recentErrors': progress.get('errors', [])[-5:]}, indent=2))
PY
```

Compare error timestamps with deployment time: old errors can remain in the
recent-history list. Check that earnings observations stay fresh and new claims
continue to finalize. The existing empty claim queue is evidence of cleared
backlog, not proof that all future RPC calls will succeed. If new failures remain,
the new category helps decide whether to investigate gateway contention, node
readiness, or the HTTPS route.
