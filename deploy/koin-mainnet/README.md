# Mainnet pilot and Alpha KAI cutover

Owner direction, 2026-10-08: use real mainnet KOIN in the **Test app first**, then
promote the tested release to Alpha. At Alpha cutover, stop new legacy testnet KAI
earnings and preserve the evidence for a later **10 earned KAI : 1 mainnet KOIN**
distribution. Legacy KAI continues during the Test pilot.

## Current implementation status

The Test desktop and dedicated payment backend accept an explicit `mainnet-pilot`
manifest with pinned mainnet chain/native-token identity. Mainnet sessions,
worker receipts and reward certificates use separate signature domains. Native
approvals disclose real KOIN; installing Test alone does not activate payments.
Role signing, transaction retries and reward claims retain durable recovery
journals. Mainnet workers require the exact imported deployment and explicit opt-in.

No mainnet contract has been deployed, no hostname configured, and no wallet
funded by this code change. The Alpha drain/cutoff and read-only earned-KAI export
are available separately; a draft earnings export cannot send a distribution.

## Inputs needed from the owner

| Input | Why it is needed |
| --- | --- |
| Mainnet buyer public address and second provider public address | The buyer cannot serve its own paid request |
| Dedicated Test hostname and server IP/access | Configure DNS, HTTPS and an isolated payment service |
| Maximum total initial KOIN funding | Bound aggregate role funding, buyer credits and the reward pool |
| Confirmed prices and per-session/request limits | Make each approval concrete; RC caps also require measured transaction costs |

`test-payments.koinosai.com` is a proposed hostname, not an existing deployment.
Do not send private keys, WIFs or seed phrases in chat. The role keys below are
created on the operator's machine; transfer runtime secrets only through the
server's secret-management workflow. The eventual distribution budget is
separate from the pilot budget and is determined by the final reviewed snapshot.

## Review the mainnet bootstrap

Use Node 22+ and custody WASM built from the exact reviewed desktop commit.
Fill `settings.example.json` in a private operator-controlled directory. Funding
amounts are strings in KOIN atoms (100,000,000 atoms = 1 KOIN); RC is a different
resource quantity. Nulls intentionally require an explicit value.

```bash
node deploy/koin-mainnet/prepare.js /absolute/private/mainnet-bootstrap /absolute/private/mainnet-settings.json /absolute/kaiapp/contracts/koin-network/build/release
```

This command checks two distinct HTTPS RPC hosts against the pinned mainnet
chain/native-token identity and matching native bytecode. It hashes the custody
WASM, generates nine fresh role wallets and writes a hashed public plan plus
`offline-keys.json` (mode 0600, directory 0700). It neither signs nor broadcasts.
It refuses to overwrite an existing bootstrap directory. Back up the private
keys offline before continuing. `runtimeReady: false` is intentional: this is
not an importable desktop manifest or an installable service configuration.

Mainnet chain ID reference: [Koinos offline signing](https://docs.koinos.io/exchanges/offline-signing/).
RPC/resource references: [Koilib](https://docs.koinos.io/exchanges/koilib/) and
[Mana](https://docs.koinos.io/exchanges/mana/).

## Configure and deploy the separate mainnet pilot

The owner approved a maximum **1,000 KOIN** initial pilot budget. Set
`funding.maxTotalKoinAtoms` to `"100000000000"` in the private settings. The plan
rejects buyer credits + reward pool + all role balances above this ceiling.
This is an initial funding-plan check, not an on-chain global deposit limit;
record actual transfers against the reviewed plan and do not add unplanned funds.
Choose prices and allocations explicitly; deployment and runtime Mana limits must
be sufficient for measured costs. Do not substitute KOIN balances for RC units.

After backing up keys, use the printed bootstrap hash:

```bash
node deploy/koin-mainnet/setup.js configure --dir /absolute/private/mainnet-bootstrap --approve BOOTSTRAP_HASH
node deploy/koin-mainnet/setup.js tokenizer --dir /absolute/private/mainnet-bootstrap
```

`configure` is read-only on-chain. It produces a second immutable
`deployment-plan.json` and its hash, public runtime configuration, four runtime
role keys and a private owner invitation. It verifies the original budget,
WASM hashes, role keys and two-RPC native token pins again. Keep the custody/admin
keys offline; never copy `offline-keys.json` to the running service's config tree.

Review the exact deployment plan and resource limits. Fund only its fresh role
addresses, then run:

```bash
node deploy/koin-mainnet/setup.js check-funding --dir /absolute/private/mainnet-bootstrap
node deploy/koin-mainnet/setup.js deploy --dir /absolute/private/mainnet-bootstrap --wasm-dir /absolute/kaiapp/contracts/koin-network/build/release --approve DEPLOYMENT_PLAN_HASH
```

The second command signs and broadcasts **real mainnet contract deployment**.
The journal records each original signature before submission, waits for
irreversible upload/initialization, and verifies the deployed contracts. If a
response is lost, rerun the same command and same plan; do not delete its journal,
change the plan or regenerate keys. Each new mainnet signature checks available
Mana. The public desktop manifest is written only after verification.

On the server, from a clean checkout of the reviewed backend commit:

```bash
bash deploy/koin-mainnet/preflight.sh
sudo bash deploy/koin-mainnet/install.sh /absolute/private/mainnet-bootstrap
```

The installer creates `kai-koin-mainnet-pilot.service`, listening on loopback
port 3108, with a separate user, configuration and persistent state. It does not
modify the existing scheduler or reverse proxy. Configure the confirmed hostname
as an A record to the selected server. Add a dedicated Caddy virtual host:

```caddyfile
YOUR_CONFIRMED_TEST_HOST {
  reverse_proxy 127.0.0.1:3108
}
```

Validate Caddy's full config before reloading. Verify HTTPS `/health` reports
`mode: mainnet-pilot`, the pinned chain ID and `mainnetPaymentsEnabled: true`.
The configured scheduler URL ends in `/scheduler`. Keep port 3108 private.

Generate a separate provider invitation with `setup.js invite --dir ... --owner
PROVIDER_PUBLIC_ADDRESS`. Install the reviewed updated invitation list securely;
the installer refuses silently replacing an existing list. Transfer only that
participant's public manifest and private invitation to their Test desktop.
The buyer cannot serve its own paid request. Provider qualification still needs
a valid reviewed model benchmark and current availability evidence; an invitation
alone does not qualify hardware or create reward entitlement. This server hosts
the scheduler/tokenizer; inference runs on the provider's desktop.

Import the verified manifest and invitation into the matching-wallet Test app,
start with a small reviewed credit deposit and reward-pool deposit, then test a
session, served request, final settlement, complete daily reward/review period,
automatic payout, refund and restart recovery. The deployed policy is 5% daily
reward-pool budget, 70% availability / 30% work, and an 80% provider work cap;
review these existing contract parameters before deploying. Preserve transaction
IDs, finality evidence and the exact Test installer before Alpha promotion.

## Alpha cutoff, only after the mainnet Test pilot passes

The transition is operator-authenticated and is never triggered by deploying
this code or installing a Test release. The existing operator secret remains in
its local secret store. The endpoint is `/scheduler/operator/legacy-rewards`.

1. Back up the complete authoritative legacy scheduler state. Announce the
   intended cutoff separately through the normal release process.
2. POST `{"action":"drain"}` using the existing `x-operator-secret` header.
   It persists `legacy-reward-drain.json`, stops new legacy admission, seeds and
   dispatch (including parked polls). Already-dispatched work may finish.
   New legacy deposits and consumption also stop. The funded payment service
   is separate. There is no automatic resume after a restart.
3. Wait until pending jobs and consumer requests finish or expire. Repeating
   the drain request reports counts. Do not restart while draining in-flight
   work. Legacy auto-close pauses; call the existing `/scheduler/epoch/close`
   once drained to persist the final epoch. This endpoint refuses a final close
   while jobs or consumers remain in flight. Record the returned epoch and root.
4. POST `{"action":"cutoff","finalEpoch":FINAL_EPOCH,"finalRoot":"FINAL_ROOT"}`.
   The server requires the latest durable closed epoch and no unfinished
   accounting. It records `legacy-reward-cutoff.json` with its UTC timestamp.
   The same request is idempotent; a different final root/epoch is rejected.
5. Confirm the cutoff on the running backend, then promote the exact tested
   mainnet build to Alpha and point it at the intended mainnet service. Preserve
   both marker files in backups and all future deployments; do not roll back
   to a backend revision that ignores them. Do not restore older state to resume
   earning after announcing a final snapshot.
6. Recover any outstanding payouts for epochs at or before the cutoff. These
   are previously earned KAI; they are not new accrual. Recovery stays available.
   Snapshot the legacy chain at a recorded irreversible block after reconciliation.
   Keep block ID/height, chain ID, KAI contract and exact wallet balances.

A corrupt/mismatched cutoff prevents startup. It must never silently reopen
earning. The marker freezes this app's legacy earning service, not unrelated
on-chain activity or transfers between token holders.

## Export earned KAI exactly

Use a consistent backup of the authoritative store after final close. For
SQLite, use a SQLite backup or stop the service and copy the database with its
WAL; do not copy a running database file alone. Preserve all historical epochs,
not just the latest-200 UI/backup window. Snapshot exports must not use stale
JSON views when a SQLite authority exists.

```bash
node scripts/kai-earned-snapshot.js --backup /absolute/consistent-backup --store sqlite --first-epoch FIRST_EPOCH --final-epoch FINAL_EPOCH --out /absolute/new-snapshot-directory
```

Use `--store json` only for an authoritative JSON store. An optional
`--chain-balances /absolute/chain-balances.json` accepts:

```json
{
  "chainId": "ACTUAL_LEGACY_CHAIN_ID",
  "contract": "ACTUAL_KAI_CONTRACT",
  "blockId": "0x1220_FOLLOWED_BY_64_HEX_DIGITS",
  "blockHeight": "ACTUAL_IRREVERSIBLE_HEIGHT",
  "balances": {"PUBLIC_ADDRESS": "EXACT_KAI_ATOMS"}
}
```

The exporter never queries/signs/broadcasts transactions. It validates each
epoch's root and exact accounting, records evidence hashes, and refuses open,
duplicate or malformed epochs. New epochs record `earnedAtoms` directly;
historical earnings are reconstructed as net award + exact spend - debt.
Floating-point `earnedKai` displays are not used for entitlement arithmetic.

The output records gross earned KAI, net awards, spend, debt, separately supplied
on-chain balances, proposed KOIN and conversion dust. It proposes
`floor(earnedKaiAtoms / 10)` KOIN atoms per wallet and preserves the remainder.
Transfers do not create earnings for the receiving address. Missing records
cannot be reconstructed from current token supply or current balances.

The export is always a **draft** with `payoutEnabled: false`. Before a final
allocation, confirm complete history against independent backups, clarify
whether gross earnings include KAI already spent and treasury/royalty categories,
reconcile the chain snapshot and unresolved legacy payouts, and confirm recipient
wallet control. Hash and approve the exact final allocation and total funding
before adding a separately journaled distribution workflow. Do not collect keys
from recipients or automatically send to substituted destination addresses.

## Verification

```bash
node --test scripts/probe-mainnet-cutover-prep.js
node scripts/probe-epoch-resume.js
node scripts/probe-payout-recovery.js
node scripts/probe-durable-store.js
node scripts/probe-koin-test-deployment.js
node scripts/probe-koin-funded-work.js
node scripts/probe-koin-reward-cycle.js
```

These checks cover preparation/accounting/restart behavior, not a mainnet
contract audit, real hardware economics or a completed mainnet deployment.
