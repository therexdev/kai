# Sponsored wallet approval recovery rehearsal

The pinned desktop coordinator now reserves sponsored transactions by payee,
while the sponsor pays Mana. Optional bridge and KoinDX builders save the owner's
original signature before returning the transaction. They are not installed in
production orchestrators and have not executed live bridge or DEX operations.

The isolated `ProducerVault` adapter reserves the wallet before exposing an
operations-only request. It saves the owner, nonce, chain, expected sponsor,
operations and RC ceiling. Restart, lost delivery, rejection, expiry and
disconnection cannot release that reservation. Wallet session credentials are
never persisted. Recovery reads the original transaction from the pinned chain;
it cannot request another signature or broadcast. Only the matching irreversible
receipt releases the hold, including an explicitly reported revert.

The native harness uses the actual desktop vault/coordinator modules with a
local wallet-protocol fixture. For each funding purpose, a sponsored one-atom
transfer loses its approval response after inclusion. Funding and ordinary sends
must stay blocked across disconnect and restart. Recovery must retain the hold
while reversible, then release it after irreversible confirmation. Exactly one
remote request, owner signature, sponsor signature and submission are required.
The fixture chooses a lower positive RC limit within the saved ceiling, exercising
remote transaction binding. Source hashes and full native receipts are recorded.

This does not contact or test the public Koin Vault backend. Its operations-only
protocol does not guarantee the pinned nonce, sponsor or ceiling; an agreed
backend policy is required before production integration. Missing or mismatched
transactions remain held for reviewed recovery. Shared backup/restore, repair,
cross-host ownership and recovery UI remain deployment prerequisites.

Local verification passed 91 focused tests with two browser tests skipped and
three desktop/master integration tests. Test 157 was verified published with all
release checks successful before this increment.

Existing daily reward review and automatic provider payouts remain required in
the native harness. No provider Claim button, provider signing, real-fund transfer
or production payment activation is added.

## Verified native result

The [2026-09-28 UTC native run](https://github.com/therexdev/kai/actions/runs/36455879893)
passed all **28 checks** at master
`96d4f709036fb95e6ebb983662fdd601ce232d58` and desktop
`9ea9b8071439792875b525b2b52c316233b0a266`. Both external wallet transfers
used exactly one approval request, one owner signature, one sponsor signature
and one submission. Their reservations survived disconnect and restart and
released only after irreversible confirmation. Both existing funding/send
conflict directions and the daily cycle with automatic provider payouts passed.

[Saved results](koin-vault-recovery-results.json) preserve the verified artifact
digest, source hashes, chain and image pins, both sponsored transactions and
receipts, and funding/cycle/claim receipts. The artifact digest was independently
checked before saving, and its desktop source hashes match the pushed checkout.
Both master CI runs passed. Test 158's installer workflow was still running
when these results were recorded; this is separate from publishing the code.

Next: reviewed journal backup/restore and unresolved-request repair, then recovery
controls and backend policy agreement before any production activation.
