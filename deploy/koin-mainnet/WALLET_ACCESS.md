# Complete wallet, earning and credit service update

This is the matching server update for wallet-only credit access, earning with
the wallet locked, automatic price previews, the paid-first preference, and
sharing the configured model catalog. Run it on **koinos-scheduler**, then update
the desktop app. No contract deployment or wallet import is part of this update.

## Run the released update

From Windows PowerShell, connect to the existing server:

```powershell
ssh root@45.76.255.224
```

Use the exact backend commit printed in the matching desktop release's update
instructions. Set `KAI_RELEASE_COMMIT` to that full 40-character SHA, then run
the following block at the `root@koinos-scheduler` prompt. It uses a new source
directory; the earlier staging directory and all bootstrap keys remain intact.

```bash
(
set -euo pipefail
umask 077
: "${KAI_RELEASE_COMMIT:?Set the exact backend commit from the release instructions}"
[[ "$KAI_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_UPDATE_STAGE=$(mktemp -d /root/kai-wallet-update.XXXXXXXX)
git -C "$KAI_UPDATE_STAGE" init --quiet
git -C "$KAI_UPDATE_STAGE" fetch --quiet --no-tags --depth=64 https://github.com/therexdev/kai.git "$KAI_RELEASE_COMMIT" 9d4ad205cf06fe54cc1a38f7088e87443eb7e87b
git -C "$KAI_UPDATE_STAGE" checkout --quiet --detach "$KAI_RELEASE_COMMIT"
cd "$KAI_UPDATE_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_RELEASE_COMMIT"
git merge-base --is-ancestor 9d4ad205cf06fe54cc1a38f7088e87443eb7e87b HEAD
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high
node deploy/koin-mainnet/update-wallet-access.js
)
```

The complete release instructions substitute the exact SHA, so the final user
command has no placeholder or moving branch name. Password entry belongs to SSH;
never put passwords, wallet keys or the operator credential in these commands.

Successful installation prints the exact installed commit and verifies both
public capabilities and all 15 running model qualification policies. Its JSON
readiness report separates software installation from reward funding, current
Mana, sponsorship availability and saved payout states. A nonempty `blockers`
list is an actual operating condition to address, not a request to repeat a
purchase. Update failures exit nonzero and do not print success.

## What this changes

- Credit access accepts wallet ownership instead of requiring email/password
  signup. Existing linked accounts and balances retain their identities.
- Provider devices receive narrowly scoped, non-spending authority. They can
  qualify and serve assigned work after the reward wallet is locked.
- All 15 exact configured model packages receive the reviewed twelve-case
  qualification criteria. The existing Smart policy is preserved exactly. Every
  device/model must independently pass twelve fresh signed answers before it is
  eligible; installation itself creates no qualification or reward entitlement.
- Existing USD price previews and paid-first support are installed together.

## What the updater preserves

The updater accepts the last reported dependency release `cbdb3a5…`, the reviewed
credit preference release `9d4ad20…`, the prior wallet candidate `11474a9…`, or an
idempotent repeat of its exact target. Unknown service versions, overrides,
unrelated source changes and concurrent operator edits stop before replacement.

It validates the separate `kai-koin-prepaid.service`, runs fixture tests before
stopping it, prepares dependencies in a temporary directory, and installs source
under `/opt/kai-koin-prepaid/releases/<commit>`. Its only runtime configuration
change is the reviewed `qualificationPolicies` catalog. Prices, free-credit
budgets and eligibility list, reward budgets, RPC settings, account settings,
private keys and other configuration files remain unchanged. Original ownership
and permissions are retained.

Accounts, credit usage, device authorizations and payment/reward journals remain
in `/var/lib/kai-koin-prepaid`. No database is copied back during rollback. If
startup or required capability/policy verification fails, the updater restores
only the previous service code pointers and model policy after a clean shutdown.
New financial records remain in place. An incomplete shutdown or concurrent edit
is preserved and reported with the backup location. A completed rollback keeps
the prepared source in the private backup and permits an exact retry.

Backups are under `/root/kai-wallet-code-*`: previous service unit, previous and
next runtime configuration, public model review, source archive and readiness
report. They are private. The update does not edit Caddy, touch `koinos.service`
or the separate Master producer application, deploy contracts, transfer KOIN,
fund a reward pool, change payout ownership or grant credits.

## Readiness and first use

The post-install check uses read-only, time-bounded RPC calls. It verifies pinned
contracts, reads reward-pool liquid balance and liabilities, compares existing
free-credit policy with on-chain sponsor ceilings, and reads available Mana for
the settlement, lifecycle and claims sponsor addresses. Each address is printed
beside its actual observed Mana. The configured transaction ceiling is a
conservative readiness comparison, not a claim that every transaction costs that
amount.

Payout counts and the latest transaction IDs come from a read-only view of the
existing reward journal after matching its deployment identity. `confirmed`
means the service previously recorded irreversible payment; `chainRechecked`
is false because this install check does not re-prove each historical payout.
Current wallet transactions remain available in the app. An empty or funded
reward pool is reported honestly; updating code does not fund it.

After the server reports installed, update **Koinos AI Test**:

1. Provider: open Earn, authorize this device once, then start earning. Leave
   all compatible installed models selected or choose a subset. Qualification
   runs automatically; no chat is needed to begin. Lock the wallet after device
   authorization and check that fresh network status reaches ONLINE.
2. Buyer: open Credits and use Connect wallet, enter a dollar amount, review the
   displayed KOIN estimate, then Buy credits and approve the exact payment.
   Use Network chat after confirmation. Free credits remain first by default.
3. Pi: use the same wallet flow. If protected key storage is unavailable, the
   explicit temporary option permits free-credit chat and device earning for
   that app session. It does not claim persistence or manufacture free credits.

The updater verifies software activation; actual model performance, a new
production purchase/reply and physical Pi behavior are the user's acceptance
tests. Existing financial finality and reward epoch rules remain in force.
