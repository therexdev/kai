# Keep network replies connected during model preparation

The credit server sends an immediate SSE comment and another every 15 seconds
while waiting for model output. Clients opt in with
`X-KAI-Credit-Stream: keepalive-v1`. Core 0.7.26 understands these comments;
earlier clients retain their existing stream format. Comments contain no model
output, usage or payment receipt and cannot debit credits. Request deadlines,
signed receipt verification and provider eligibility still apply.

Core 0.7.26 also reports interrupted response bodies clearly. After a dropped
connection it checks the same request ID once for a completed, signed answer.
It never submits another generation as part of that automatic recovery, and a
partial reply cannot complete a workflow step.

## Update the credit server

Run as root on the credit VPS using system Node 22 or newer. This release builds
on the installed RPC-backoff and SQLite reward runtime
`f25c7d8ddb1aee29ea3a26082d9864b766a67f3b`. It refuses an unexpected service
version, missing SQLite activation, dirty checkout or concurrent update before
stopping it. It does not migrate storage or restore older reward code.

```bash
cd /root
git clone --branch fix/credit-stream-keepalive --single-branch https://github.com/therexdev/kai.git kai-credit-stream-update
cd kai-credit-stream-update
npm ci --omit=dev --ignore-scripts
node deploy/koin-mainnet/update-credit-stream.js
```

The code-only updater runs the existing storage, reward and RPC regressions plus
stream tests, verifies the pinned RPC contracts, drains the running service and
verifies its clean exit and both storage writer leases. Configuration, keys,
SQLite databases, recovery anchors and all financial journals stay in place.
The update records a durable deployment plan and resumes the same release after
an interruption, without rolling back code or databases. Both loopback and
public HTTPS must report `streamKeepaliveVersion: 1`, the existing RPC-backoff
capability and ready SQLite/earnings processing before it reports success.

```bash
curl -fsS https://credits.koinosai.com/health
```

Then install Core 0.7.26 or newer using Settings → Application updates and
restart. Workflows 0.3.11 and existing imports need no changes. Finish or cancel
active runs before either restart. A capability check proves the code is
active; verify the article run separately to confirm live provider performance.
