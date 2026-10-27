# Restore earning between model checks

Repeated failed model checks could keep a computer switching models instead of
returning to a model that had already qualified. This update gives qualified
capacity time to serve between failed retries, keeps retries fair, and exposes
bounded qualification counts and failure categories to the desktop app.

The existing model criteria, twelve-case policies, signatures, model pins and
qualification lifetime remain in force. Installing this update does not make a
failing model eligible or create a reward entitlement. A selected model still
needs its own successful qualification before paid work.

## Install on the existing Vultr service

Run the release's command block from the `root@koinos-scheduler` shell. The
release handoff supplies the exact backend commit for `KAI_PROVIDER_RELEASE`.
Use that immutable commit, not a moving branch name. This prepares a fresh
checkout and retains earlier staging and bootstrap directories.

```bash
(
set -euo pipefail
umask 077
: "${KAI_PROVIDER_RELEASE:?Set the exact backend commit from the release instructions}"
[[ "$KAI_PROVIDER_RELEASE" =~ ^[0-9a-f]{40}$ ]]
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_PROVIDER_STAGE=$(mktemp -d /root/kai-provider-update.XXXXXXXX)
git -C "$KAI_PROVIDER_STAGE" init --quiet
git -C "$KAI_PROVIDER_STAGE" fetch --quiet --no-tags --depth=16 https://github.com/therexdev/kai.git "$KAI_PROVIDER_RELEASE" b85363e6c6188fb215e9a98fc8fdaed5869ede75
git -C "$KAI_PROVIDER_STAGE" checkout --quiet --detach "$KAI_PROVIDER_RELEASE"
cd "$KAI_PROVIDER_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_PROVIDER_RELEASE"
git merge-base --is-ancestor b85363e6c6188fb215e9a98fc8fdaed5869ede75 HEAD
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high
node deploy/koin-mainnet/update-provider-qualification.js
)
```

The updater accepts the installed unlimited-purchase backend
`b85363e6c6188fb215e9a98fc8fdaed5869ede75`, or an idempotent repeat of the exact
target. It checks the service identity and allowed source changes, runs isolated
regressions, and prepares the new release and dependencies before briefly
restarting only `kai-koin-prepaid.service`.

Success requires the existing buyer/provider capabilities, a fresh service
heartbeat, `purchaseQuotesUnlimited: true` and
`providerQualificationRecovery: 1` from both loopback and public HTTPS. The new
marker is present only when the active qualifier implements the recovery
behavior; merely replacing the health route cannot satisfy it.

Only the systemd code pointers change. Runtime configuration, qualification
policies, prices, free-credit policy, wallet keys, account balances and all
payment, quote, reward and qualification evidence remain in place. The updater
does not deploy contracts, sign transactions, move funds or import wallets.

If readiness fails, rollback restores the previous code while retaining any
financial and qualification records written after startup. Preparation failure
keeps the existing service running. A completed rollback permits an exact
retry. Concurrent configuration changes or an incomplete shutdown are
preserved and reported instead of being overwritten.

Private code backups are under `/root/kai-provider-qualification-code-*` and
contain the previous service unit and source archive. They do not copy keys or
account databases. Keep existing transaction and qualification journals.

## Use the app

Install the matching Koinos AI Test release and keep earning on. The app can
return to a qualified selected model while other models wait for a bounded
retry. Updated model rows show the available check counts and failure reasons;
installation alone is not evidence that every selected model has qualified.

The updater's health checks establish software activation. Its isolated tests
exercise recovery and data preservation without submitting a production
payment or modifying a customer's provider records.
