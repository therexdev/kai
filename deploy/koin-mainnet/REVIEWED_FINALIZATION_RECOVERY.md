# October 15 owner-pilot rewards recovery

The provider-status updater correctly stopped before changing or restarting the
service: the signing journal contained a signed, unresolved `finalize_root`
transaction for reward epoch 20739. The corresponding lifecycle step was
`needs_review / attempt_limit` after three submissions. No paid chat jobs were
pending in the supplied operator status. The runtime retry handler did not retain
the original submission rejection, so its historical cause is not established.

The owner ran a read-only investigation on October 15, 2026. Both configured RPCs,
`api.koinosblocks.com` and `api.koinos.io`, reported nonce 14 for lifecycle owner
`17f9wpFZgJLkYgZuS3KZCMjuKPLf4nhxjU`. The saved transaction uses nonce 15 and RC
limit 100000000. Both reported available RC 178131190 and a successful nonbroadcast
simulation using 52027608 RC. This is evidence that the SAME saved transaction can
currently execute; it does not prove any earlier attempt was included.

The reviewed transaction is:

`0x12204e2f644ddd52dca6cc2f3a68d6c901e0d12e3cd1854f39f2fa13a9edfedc4b1b`

`recover-reviewed-finalization.js` is a one-time operator recovery helper. Running
it with `--approve-retry=<that exact transaction ID>` approves at most one additional
broadcast of those existing signed bytes. It cannot load private keys, create new
signatures, change the nonce or resource limit, alter the reward root, reset retry
counters, mark journals finalized, or restart the service. Only the existing
service reconciles its journals through its normal confirmation checks.

Before sending it validates the deployed service revision, deployment pins,
signing/cycle record hashes and bindings, exact signed transaction identity and
signer, the existing current-day lifecycle resource reservation and daily ceiling,
fresh node heads, both nodes' chain/deployment pins, nonce, available Mana, dry-run
receipts, and transaction finality. A pending, reversible, or finalized lookup is
monitored instead of retried; a reverted lookup stops recovery. The extra retry
review expires at 2026-10-16 00:00 UTC (October 15, 7 p.m. Chicago).

An exclusive, fsynced intent is committed under the existing private state tree
BEFORE submission. A lost response, crash, partial intent, or second process cannot
authorize a second extra submission. Subsequent invocations only monitor the same
transaction. Never remove that intent to obtain another retry. This intent records
the extra operator-approved attempt separately; the original counters and payment
journals remain intact. A successful node response alone is not completion.

Recovery succeeds only after both RPCs prove irreversible success, the service's
signing row is finalized, the lifecycle step is complete, there are no unresolved
signatures or unfinished chat holds, and the active service has a fresh successful
processing heartbeat. A bounded wait that cannot prove those conditions exits
without running the updater. Pending records and the retry intent are preserved.

After successful recovery, run the previously reviewed provider updater from
commit e99f1f35320864f31187418dd6264d83f562ebd4. Its existing drain, backup, version,
configuration, restart and health gates remain unchanged. Recovery does not renew
provider qualification; the provider update will report that separately.

Validation: `node scripts/probe-koin-reviewed-finalization.js` covers exact-byte
retry, durable intent ordering, repeated/concurrent execution, lost responses,
partial intents, expiry, inclusion races, finality refusal, changed records,
dry-run receipt/resource limits, and private storage. These are local fixtures;
actual mainnet recovery still requires the owner's server execution.
