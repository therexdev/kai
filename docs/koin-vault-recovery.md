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
release checks successful before this increment. Native results for the new
adapter will be recorded separately after the pinned workflow completes.

Existing daily reward review and automatic provider payouts remain required in
the native harness. No provider Claim button, provider signing, real-fund transfer
or production payment activation is added.
