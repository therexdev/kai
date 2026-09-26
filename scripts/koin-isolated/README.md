# Isolated native-transfer rehearsal

The `KOIN isolated transfers` workflow builds the pinned desktop custody contracts
and runs them on a fresh, peerless Koinos Docker network. It uses published upstream
fixture keys, an unpredictable genesis marker, a fixed loopback RPC, and temporary
node state. No wallet settings, deployment credentials or live endpoints are read.

The run covers actual native deposits, usage splits, review holds, sponsored reward
claims, recovery after a lost response, duplicate protection, Mana rejection and
refunds. Reports include full transaction receipts and sponsor resource measurements.
An isolated measurement is not a production Mana budget or permission to activate payments.

Funding uses an exact native-token allowance and the custody deposit in one
atomic signed transaction, then checks that the allowance is zero. A deposit
without approval must revert. Production funding review/signing still needs to
validate this complete two-operation bundle before activation.

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
