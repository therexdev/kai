# Remove daily purchase quote allowances

This server update removes both the per-account and service-wide daily quote
allowances. Previously, asking for a signed purchase quote counted its dollar
amount toward those allowances even if the buyer cancelled, the quote expired,
or no KOIN was sent. A buyer could therefore be blocked without buying credits.

Existing quote counters are retained as historical records and no longer affect
whether a new quote can be issued. Existing configured `purchaseQuoteBudget`
values remain untouched and are ignored for quote admission. No UTC rollover,
counter reset, database deletion, new account or new wallet is needed.

The update keeps current market-price validation, quote expiry, per-payment
liquidity checks, wallet approval, exact transaction recovery and irreversible
confirmation before crediting a payment. A quote does not itself transfer KOIN
or grant credits.

## Install on the existing Vultr service

Run this from the `root@koinos-scheduler` shell. Set `KAI_QUOTE_RELEASE` to the
exact 40-character backend commit from the release instructions. The final
operator handoff provides that value; do not substitute a moving branch name.
This uses a fresh source directory and preserves the earlier staging and private
bootstrap directories.

```bash
(
set -euo pipefail
umask 077
: "${KAI_QUOTE_RELEASE:?Set the exact backend commit from the release instructions}"
[[ "$KAI_QUOTE_RELEASE" =~ ^[0-9a-f]{40}$ ]]
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_QUOTE_STAGE=$(mktemp -d /root/kai-quote-update.XXXXXXXX)
git -C "$KAI_QUOTE_STAGE" init --quiet
git -C "$KAI_QUOTE_STAGE" fetch --quiet --no-tags --depth=16 https://github.com/therexdev/kai.git "$KAI_QUOTE_RELEASE" a8edc3bd6d21c40cebe175f7ead36844900b2b7c
git -C "$KAI_QUOTE_STAGE" checkout --quiet --detach "$KAI_QUOTE_RELEASE"
cd "$KAI_QUOTE_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_QUOTE_RELEASE"
git merge-base --is-ancestor a8edc3bd6d21c40cebe175f7ead36844900b2b7c HEAD
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high
node deploy/koin-mainnet/update-purchase-quotes.js
)
```

The updater accepts the installed wallet-access backend
`a8edc3bd6d21c40cebe175f7ead36844900b2b7c` or an idempotent repeat of its exact
target. It verifies the service identity and isolated regressions, prepares the
release and dependencies, then briefly restarts only `kai-koin-prepaid.service`.
It requires a current heartbeat, the existing buyer/provider capabilities and
`purchaseQuotesUnlimited: true` from both loopback and public HTTPS before
printing success.

The updater changes only the systemd code pointers. Runtime configuration,
prices, free-credit policy, provider qualification, wallet keys, account
balances and all payment, reward and quote journals stay in place. There is no
contract deployment, funding transfer or wallet import. If health fails, it
restores the previous code while keeping any financial records written since
startup. Preparation failure leaves the existing service running; a completed
rollback permits an exact retry. Concurrent operator edits or an incomplete
shutdown are preserved and reported for recovery instead of being overwritten.

Private code backups are under `/root/kai-purchase-quotes-code-*`; they contain
the previous service unit and source archive, not copies of account databases
or private keys. Do not delete payment or quote journals to clear an allowance.

## Use the app

**Koinos AI Test `0.54.13-test.223.1` already supports this server update.** No
additional app install is needed. After the server update succeeds, return to
Buy credits and click **Try purchase again** (or **Buy credits**). Enter the
amount, review the current KOIN price and approve the payment normally. Repeated
price checks, cancelled purchase reviews and expired offers cannot consume a
daily buying allowance.

The health check proves activation of the updated software. The isolated tests
cover real HTTP quote issuance and simulated payment finality without spending
customer funds. A new production payment still requires the buyer's explicit
wallet approval.
