# Mainnet pilot and Alpha KAI cutover

Owner direction, 2026-10-08: use real mainnet KOIN in the **Test app first**, then
promote the tested release to Alpha. At Alpha cutover, stop new legacy testnet KAI
earnings and preserve the evidence for a later **10 earned KAI : 1 mainnet KOIN**
distribution. Legacy KAI continues during the Test pilot.

## Current implementation status

This change prepares an operator-machine bootstrap, a durable legacy reward
drain/cutoff, and a read-only earned-KAI export. It **does not enable mainnet
payments**. The existing Test app and payment service still reject mainnet.
No mainnet contract has been deployed, no hostname configured, and no wallet
funded by this change. A draft earnings export cannot send a distribution.

Before runtime activation, implement and verify explicit mainnet modes throughout
the native payment dialogs, funding/session approvals, worker capabilities and
job signatures, backend routing, reward certificates, deployment journal and
status UI. Do not relabel a Foundation testnet manifest or remove one network
check to force the old rehearsal protocol onto mainnet. Mainnet certificates
must not accept an old rehearsal signature; the app must disclose real KOIN.

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

After mainnet runtime support is implemented, review the exact deployment
transactions and their measured resource requirements, fund only the reviewed
fresh addresses, deploy custody, and verify irreversible initialization/code/roles.
Configure the dedicated host and HTTPS service, then run a small real purchase,
session, served request, settlement, reward payout and refund/recovery cycle.
Preserve the exact Test release and evidence before Alpha promotion.

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
```

These checks cover preparation/accounting/restart behavior, not a mainnet
contract audit, real hardware economics or a completed mainnet deployment.
