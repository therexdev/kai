# Recover reward claims rejected for insufficient RC

A saved claim signed with `rc_limit: 100000000` can fail even while its sponsor
has sufficient Mana. Retrying the same signed bytes retains the same limit.
After three attempts, the unresolved sponsor nonce holds subsequent claims in
`queued`. The sponsorship sidecar's daily reservation allowance is independent
of both the account's actual Mana and each transaction's RC limit.

This update estimates new reward claims with `broadcast: false`, verifies the
exact simulation receipt, and signs a limit of the measured cost plus 25%
(rounded up). It retains the original configured limit as a floor. The new
ceiling is 1,000,000,000 RC (10 Mana), bounded by the original configured daily
limit. An already higher configured transaction limit remains supported. The
original ledger identity, daily allowance and sponsorship sidecar do not change.
If the bounded simulation or its headroom does not fit, the claim remains fenced
and the operator error explains the failure; no unbounded increase occurs.

For an existing `needs_review / attempt_limit` claim whose last saved submission
specifically reports `insufficient rc`, recovery first re-simulates that exact
old transaction and requires the same typed rejection. A generic timeout,
missing transaction lookup, pending transaction, or a now-successful simulation
does not authorize replacement. It checks the pinned deployment, sponsor Mana,
and original next nonce before signing revisions. Every revision preserves the
chain, nonce, payer, recipient, amounts, proof and operation. All signed candidates
are retained and checked for irreversible inclusion, including the old envelope
and the simulation envelope. Finalized contract `claimed` evidence is still
required before reporting a payment.

The original three attempts and Mana reservations remain in history. One
resource recovery is allowed per claim, with a new bounded attempt history and
a separate reservation for its replacement. Old reservations are not refunded.
After staging, retries use the exact saved envelope. Signing drafts, estimates
and recovery authorization survive restart through the existing signing journal
and recovery anchor. A nonce change, RPC outage, depleted Mana, or malformed
simulation receipt blocks further signing/broadcast. A finalized revert still
requires review. Expected claim resource waits are logged without suppressing
independently verified daily reward cycles; malformed receipts and financial
validation failures retain their existing processing gate. Lifecycle and
settlement transaction limits are unchanged.

## Install on the scheduler

Run as root with system Node 22 or newer. The updater requires the installed
credit stream release `392aab1db2e867b5eb995fdabcac8e8fbef8b1cf` and verified
SQLite reward activation. It checks a clean checkout, allowed source changes,
regression tests and pinned RPC contracts before draining the service. It
preserves configuration, private keys, journals and recovery anchors in place.
The running application performs recovery after startup; the installer never
edits a production payment row or clears an attempt counter.

```bash
cd /root
git clone --branch fix/claim-resource-recovery --single-branch https://github.com/therexdev/kai.git kai-claim-resource-fix
cd kai-claim-resource-fix
npm ci --omit=dev --ignore-scripts
node deploy/koin-mainnet/update-claim-resources.js
```

An interrupted update resumes by rerunning the final command from the same
checkout. Preserve its deployment plan. Do not restore an old database or switch
back to older code after resource recovery has started: older code does not
understand the retained replacement history.

## Verify the live result

Both local and public health must report `claimResourceRecoveryVersion: 1`.
The updater also checks existing stream, RPC, SQLite and earnings readiness.
That proves activation, not that a payout has finalized.

```bash
curl -fsS https://credits.koinosai.com/health
sudo python3 - <<'PY'
import json
import sqlite3
import urllib.request
from pathlib import Path

secret = Path('/etc/kai-koin-prepaid/operator-secret').read_text().strip()
request = urllib.request.Request('http://127.0.0.1:3109/operator/status',
    headers={'x-operator-secret': secret})
with urllib.request.urlopen(request, timeout=60) as response:
    status = json.load(response)
print(json.dumps({'claimQueue': status.get('claimQueue'),
                  'claimSponsorship': status.get('claimSponsorship')}, indent=2))

file = Path('/var/lib/kai-koin-prepaid/claims/reward-claims.sqlite')
with sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
    db.execute('PRAGMA query_only=ON')
    row = db.execute('SELECT data FROM claims WHERE id=?',
        ('2f4fca9ea75c25d476d3f46b6220eea5941530bdc531d6311413fdb3c12977fd',)).fetchone()
    if row:
        claim = json.loads(row[0])
        outbox = claim.get('outbox') or {}
        print(json.dumps({'claimId': claim['id'], 'state': claim['state'],
            'reason': claim.get('reason'), 'finality': claim.get('finality'),
            'currentTxId': (outbox.get('transaction') or {}).get('id'),
            'rcLimit': outbox.get('rcLimit'), 'attempts': outbox.get('attempts'),
            'previousAttempts': sum(x['attempts'] for x in claim.get('resourceHistory', []))}, indent=2))
PY
```

For the reported incident, expect the old three attempts to remain visible,
followed by a higher-limit transaction, irreversible finality and `paid`.
`paid_elsewhere` requires separately verified claim evidence. Then confirm the
pending queue decreases. An empty queue alone is not a replacement for examining
the original claim's finality. If it remains blocked, inspect `/operator/progress`
errors; `lastSuccess` or HTTP 200 alone does not establish payment.

`claimQueue.resourceCeiling` reports the active claim ceiling and
`claimQueue.blockingClaim` identifies the claim holding the nonce. The legacy
`claimSponsorship.maxRcPerTransaction` and `remainingFullReservations` fields
continue to describe the original ledger policy; actual reservations use each
saved transaction's limit. Diagnostics contain no private keys or signed envelopes.
