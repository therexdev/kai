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

Run as root on the credit VPS using system Node 22 or newer. The updater accepts
the reviewed RPC read-group releases `45277dd1a63d54d773e472b891520ce4a12ffe67`
and `7fcc44bf6554986c91e488e76da8b791e23456c4`. It refuses an unexpected service
version, storage path, dirty checkout or concurrent update before stopping it.

```bash
cd /root
git clone --branch fix/credit-stream-keepalive --single-branch https://github.com/therexdev/kai.git kai-credit-stream-update
cd kai-credit-stream-update
npm ci --omit=dev --ignore-scripts
node deploy/koin-mainnet/update-credit-stream.js
```

The code-only updater runs isolated tests, verifies the existing pinned RPC
contracts, waits for the reward-processing boundary and requires a clean stop.
It preserves configuration, keys and all current financial journals. Failed
activation restores the previous code while retaining current journal writes.
Both loopback and public HTTPS must report `streamKeepaliveVersion: 1` before
the updater reports success.

```bash
curl -fsS https://credits.koinosai.com/health
```

Then install Core 0.7.26 or newer using Settings → Application updates and
restart. Workflows 0.3.11 and existing imports need no changes. Finish or cancel
active runs before either restart. A capability check proves the code is
active; verify the article run separately to confirm live provider performance.
