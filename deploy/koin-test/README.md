# Foundation Test deployment

This is a separate, invitation-only payment backend. Use the desktop `test`
channel and `claude/koin-shadow-integration` backend branch. The existing live
network, prices, profile, wallet, models and production service stay in use.
Only the explicit **Test payments** panel uses these contracts and this backend.
There is no provider Claim action: the backend pays finalized rewards automatically.

## Deployment inputs

The repository does not contain a deployed Test hostname, funded role keys or
an owner's public wallet address. Supply these before deployment:

| Input | Purpose |
| --- | --- |
| Owner wallet public address | Binds the desktop manifest and private invitation |
| Dedicated HTTPS hostname ending in `/scheduler` | Separates Test requests from the live backend |
| Explicit test tariff and session caps | Bounds charges and spending approvals |
| Transaction/day resource caps and deployment RC cap | Bounds test-wallet resource use |
| Foundation testnet KOIN | Funds fresh custody and runtime role addresses |
| Reviewed provider benchmark | Enables actual inference for the pinned model |

All amounts are integer strings in 8-decimal test KOIN atoms. RC limits are native
resource credits. The example deliberately has no invented prices or RC limits.
Use measured Test results when selecting them. Do not provide private keys in chat.

## Prepare and deploy custody

Use Node 22+, the reviewed backend checkout and custody WASM built from the exact
desktop commit in `lib/koin-network/SOURCE.json`. On an operator-controlled machine:

```bash
npm ci --ignore-scripts
cp deploy/koin-test/settings.example.json /absolute/private/settings.json
# Fill the public address, Test hostname and explicit limits in settings.json.
node deploy/koin-test/setup.js prepare --dir /absolute/private/koin-test-bootstrap --settings /absolute/private/settings.json --wasm-dir /absolute/kaiapp/contracts/koin-network/build/release
```

`prepare` verifies the Foundation chain and native token, creates fresh role keys,
and writes a public `plan.json` plus its hash. It does not sign or broadcast.
Review the exact plan and fund its fresh testnet role addresses. Custody upload
and initialization use the credits/rewards roles; the runtime uses verifier,
settlement, lifecycle and claims roles. Funding these addresses does not fund
the reward pool: use **Fund Test rewards** after installation for that.

```bash
node deploy/koin-test/setup.js deploy --dir /absolute/private/koin-test-bootstrap --wasm-dir /absolute/kaiapp/contracts/koin-network/build/release --approve EXACT_PLAN_HASH
node deploy/koin-test/setup.js tokenizer --dir /absolute/private/koin-test-bootstrap
```

The deploy journal persists the original transaction before submission. A timeout
does not authorize a fresh signature. Repeat the same command to reconcile or
resend the exact saved envelope within its attempt limit. A missing original
signature is a recovery hold; do not delete the journal to continue.

Keep `offline-keys.json` offline. The service needs only `runtime-keys.json` with
the four constrained Test roles. The owner's `owner-access.json` is a private
30-day invitation, not a wallet key. Never publish either file as a release asset.

## Install the separate backend

Copy the private bootstrap directory securely to the Test host. From a clean,
reviewed backend checkout on that host, with a system Node 22+ installation:

```bash
sudo bash deploy/koin-test/install.sh /absolute/private/koin-test-bootstrap
sudo systemctl status kai-koin-test.service
```

The installer creates `kai-koin-test.service`, code under `/opt/kai-koin-test`,
configuration under `/etc/kai-koin-test`, and state under `/var/lib/kai-koin-test`.
It binds only `127.0.0.1:3107`. Add the separate HTTPS virtual host printed by the
installer to the reverse proxy, validate its configuration, then reload it.
Check `/health` over that exact HTTPS hostname. Do not route this service through
the live scheduler hostname. The installer does not change `koinos.service` or
the production checkout/environment.

`/operator/status` requires the separate `x-operator-secret` header. Read the
secret locally without echoing it into logs. It reports signing holds, pending
settlements, reward cycles, metered token charges, per-request revenue splits,
native RC usage grouped by payer/day, and bounded errors. An empty reward day
commits zero entitlements and releases its budget after the same review/finality
checks. A healthy process alone does not
prove successful contract verification: check `lastSuccess` and the error list.

## Enable a reviewed Test provider

Use the calibration procedure in `docs/koin-paid-jobs.md` with actual model
outputs, latency and measured costs. Tokenizer vectors verify accounting, not
answer quality or profitability. `qualifications.json` is an operator-controlled
array with at most 64 entries. Each reviewed record contains:

```json
{
  "address": "PROVIDER_PUBLIC_ADDRESS",
  "capacityId": "REVIEWED_CAPACITY_ID",
  "model": "koinos-fast",
  "modelHash": "PIN_FROM_RUNTIME_TOKENIZER",
  "benchmarkHash": "SHA256_OF_REVIEWED_BENCHMARK_EVIDENCE",
  "modelWeight": "REVIEWED_INTEGER_WEIGHT",
  "coverageBps": 10000,
  "expires": 0
}
```

Set expiry to a reviewed timestamp no more than 24 hours ahead. Install it as
`/etc/kai-koin-test/qualifications.json`, owned by `kai-koin-test`, mode `0600`.
Renew only after review; do not fabricate benchmark evidence. The runtime reads
the file on each qualification check. A buyer cannot serve its own paid request,
so use a second invited wallet/installation for the provider. Create that wallet's
owner-bound files on the operator machine after custody deployment:

```bash
node deploy/koin-test/setup.js invite --dir /absolute/private/koin-test-bootstrap --owner PROVIDER_PUBLIC_ADDRESS
```

Transfer the updated `invitations.json` securely to the Test host and install it
as `/etc/kai-koin-test/invitations.json`, owned by `kai-koin-test`, mode `0600`.
Replace it atomically; the runtime rereads it for each authorization. Transfer
only the two files in `invites/PROVIDER_PUBLIC_ADDRESS` to that participant.
Repeating the command recovers the same invitation; it does not reset a wallet's
installation binding. Disable a participant by changing its server-side
invitation's `enabled` field to `false`. No email or message is sent by this tool.
Keep the first invitations limited to your own test wallets; alpha follows your
acceptance testing.

Start **Test worker** explicitly in the provider's Test app after importing that
provider's owner-bound manifest and separate invitation. It uses the actual
installed model/runtime and accepts only funded Test jobs. It is not enabled on
restart. Qualification expiry blocks new work; already dispatched work retains
its accounting hold.

## Owner testing sequence

1. Install the published Test build. Import `desktop-manifest.json` and private
   `owner-access.json` through the native file pickers. Verify the displayed
   wallet, chain, backend, contracts, model and limits.
2. Fund your wallet with testnet KOIN. Purchase a small Test credit balance and
   check irreversible confirmation. Fund the Test reward pool separately.
3. Reserve a bounded session and approve its spending terms. Send a prompt to
   the qualified second provider; inspect the verified token counts and charge.
4. Confirm the backend settles that same request once. Close/reopen the app and
   retry an interrupted request using its original prompt and request ID. Use
   **Check pending request** to recover confirmed cancellation or settlement
   before starting another request. Unknown/dispatched work keeps its hold.
5. Test Stop, offline mode, locked wallet, expired/revoked invitation, provider
   disconnect, delayed finality and backend restart. Pending is not paid.
6. Revoke the session. After its settlement window, release the unspent reserve
   and refund available credits. Confirm native balances and contract liabilities.
7. Let a real reward day end and the full 24-hour root review pass. Check automatic
   payout status and the provider's native wallet balance. No Claim is required.
8. Record actual answer quality, latency, failed requests, token costs, native RC,
   provider income and support/recovery issues before inviting alpha users.

The deployment pins one Test wallet to one installation. Copying a profile to a
second installation does not authorize its signing. Migration and key rotation
need drained queues and reviewed state transfer; this release supplies no reset
button that bypasses unresolved transactions.

## Recovery and operational limits

Desktop **Back up payment history** snapshots both journals with a separate
generation witness. Only the latest unchanged backup can be restored on its
bound host. An old backup cannot erase a later uncertain signature. A consuming
transaction can repair a nonce hold only after its original canonical irreversible
proof and native review; it never marks the original payment successful.

For backend backups, stop `kai-koin-test.service`, copy the entire Test state and
its adjacent recovery-anchor files together, protect the backup, then restart.
Do not restore an older backend signing/host journal or replace current anchors
to unlock signing. Contract upgrade, role rotation, host migration and recovery
after loss of both state and its witnesses require a separate reviewed procedure.

The current runtime uses reviewed short-lived model qualification and verified
token accounting. It does not automatically certify semantic answer quality,
calibrate electricity/hosting cost, execute mining/burn policy, or manufacture
seven days of real observations. The native CI worker is a deterministic fixture.
Public KoinVault Test compatibility still requires a supported external-wallet
endpoint; the isolated recovery fixture is not a deployed KoinVault service.

Keep rollout owner-only until those applicable checks and the owner acceptance
sequence pass. Alpha invitations and production merges are separate rollout steps.
