# Credit price previews and spending priority

This source update is prepared for the prepaid service. Publishing the desktop
installer or this branch does **not** install it on the scheduler server.

The `purchase-price` endpoint returns the current validated USD/KOIN price and
its provenance summary without issuing or signing a purchase quote. Browsing,
editing an amount and periodic previews do not consume quote authorization.
The existing purchase quote and native wallet approval remain required to pay.

`creditPriority: true` advertises support for optional `paidFirst: true` on
estimates, chats and multi-step run approvals. Omission preserves free-first
behavior and legacy request hashes. Reservations and actual partial or complete
usage use the same priority; request recovery cannot change it. Paid-first can
use eligible free credits after purchased credits run out. Free-only task
budgets cannot be combined with paid-first.

Desktop controls check these capabilities. An older service keeps free-first
working and cannot silently ignore a paid-first selection. Automatic previews
do not fall back to repeatedly creating signed quotes on older services.

## Installing the reviewed source

From a clean checkout of the reviewed commit on the scheduler, with its
dependencies installed, the code-only updater is:

```
node deploy/koin-mainnet/update-prepaid-web.js --preferences
```

It accepts the previously deployed `cbdb3a581bf6b1e188379f18b99654a496626142`
service, validates the narrow source change against the later
`5e3403bbe28982315e522602e264f62c72dadf1b` configuration-review source, and
runs credit-priority and price-preview regression checks before stopping it.
It preserves account and payment databases, signing journals, private keys,
prices, limits, qualification policy and all runtime configuration. A failed
health check restores the previous code using the current databases.

No database schema changes are introduced. The rollback regression reopens
queued, delivered and partially streamed paid-first records with the previous
ledger implementation: interrupted work releases unused holds, delivered
amounts keep their recorded paid/free split, and acknowledgement does not bill
again. The previous service does not support paid-first for new calls; an open
paid-first run requires the updated service to continue. Its saved results and
existing charges remain intact. Do not replace code inside a running process.

Successful validation requires the exact source version running in the systemd
unit, a fresh processing heartbeat and reachable account/dashboard HTTPS routes.
After installation the desktop discovers the new capabilities automatically.
