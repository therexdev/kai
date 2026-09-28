# Isolated native-transfer rehearsal

The `KOIN isolated transfers` workflow builds the pinned desktop custody contracts
and runs them on a fresh, peerless Koinos Docker network. It uses published upstream
fixture keys, an unpredictable genesis marker, a fixed loopback RPC, and temporary
node state. No wallet settings, deployment credentials or live endpoints are read.

The run covers actual native deposits, usage splits, review holds, sponsored reward
claims, recovery after a lost response, duplicate protection, Mana rejection and
refunds. Reports include full transaction receipts and sponsor resource measurements.
An isolated measurement is not a production Mana budget or permission to activate payments.

The daily-cycle runner now performs budget opening, root proposal and finalization,
then hands the signed manifest to the automatic claim queue. The harness loses a
proposal acknowledgment after inclusion and restarts the journal before recovery.
It also checks that delayed openings cannot open another day and finalization
cannot change the reviewed root. All review deadlines use controlled chain time;
none are shortened in the contracts or application code.

Funding uses an exact native-token allowance and the custody deposit in one
atomic signed transaction, then checks that the allowance is zero. These bundles
are now prepared, validated and submitted through the pinned desktop `KoinChain`
client with fixture-only signatures. The report pins that client's source hash.
A deposit without approval must revert. A deposit prepared before a pause must
roll back its approval and leave both customer and custody balances unchanged;
the desktop submitter itself refuses to broadcast while paused.
Production funding still needs wallet confirmation, durable signed-envelope
recovery and irreversible credit reconciliation wired into the actual wallet
before activation. The isolated harness now uses the desktop's durable funding
journal and finality observer. Both deposit purposes lose their inclusion response,
restart and confirm the saved transaction with one signature and one submission.
A separately staged deposit that reverts after a pause is also recovered from its
irreversible receipt. The report pins the journal and observer source hashes.

The shared wallet nonce adapter now reserves the same owner across funding and
ordinary desktop sends. Each stopped deposit must block a send before signing.
Once funding finalizes, the actual desktop `ChainService` sends one fixture atom;
the harness loses its inclusion response. New deposits and sends must stay blocked
across journal restart until the original send is irreversibly confirmed. The
report pins both the coordinator and desktop chain-service sources and records
the two directions of exclusion. No production wallet installs this adapter.

The desktop `ProducerVault` also runs against a local wallet-protocol fixture.
One sponsored transfer per funding owner loses its approval response after
inclusion. Disconnect and restart must keep funding and sends blocked, without
restoring wallet sessions. Read-only recovery binds both signatures, exact
operations, nonce, sponsor and bounded RC, then waits for irreversible finality.
The report pins both vault module hashes and records one request, owner signature,
sponsor signature and submission per transfer. No public wallet backend is used.

The native-token WASM is an official integration fixture with minting enabled
for bootstrap. Custody contracts have ordinary user privileges. The harness
produces blocks with a published genesis key and advances controlled historical
timestamps across the review period; it does not test public consensus or load.

Requirements: Linux with `sudo nsenter`, Node 22, Docker Compose, the master dependencies, and clean checkouts
of the upstream and desktop commits pinned by `upstream.json` and
`lib/koin-network/SOURCE.json`. Build the desktop contracts first. The workflow gives
the complete repeatable commands and removes only its own Compose project afterward.

For manual execution, use a new disposable directory:

```sh
node scripts/koin-isolated/prepare.js UPSTREAM_CHECKOUT DESKTOP_CHECKOUT NEW_DIRECTORY
docker compose -f NEW_DIRECTORY/compose.json up -d
bash scripts/koin-isolated/run-in-network.sh NEW_DIRECTORY
docker compose -f NEW_DIRECTORY/compose.json down --volumes
```

`report.json` records `passed: true` only after every check completes. A failed run
also writes a report and must not be cited as successful transfer verification.
The runner joins only the RPC container's network namespace, using its loopback
interface. No container publishes a host port or connects to a public network.
