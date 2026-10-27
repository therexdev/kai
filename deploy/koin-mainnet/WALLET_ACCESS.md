# Wallet access service update

This update adds versioned wallet-only credit sessions and non-spending provider
device authorization to the **separate prepaid service**. It includes the prior
read-only KOIN price preview and paid-first preference support already reviewed
at `9d4ad205cf06fe54cc1a38f7088e87443eb7e87b`.

The desktop and backend changes must be validated and activated together. A
desktop installer alone cannot enable these server capabilities. Do not describe
the flow as live until the public capability checks and connected app flows pass.

## Installation boundary

Run `node deploy/koin-mainnet/update-wallet-access.js` from the clean, reviewed
backend commit using system Node 22+ as root on the existing scheduler host.
The updater accepts the deployed dependency release `cbdb3a5…`, the reviewed
credit preference release `9d4ad20…`, or an idempotent repeat of its exact target.
It refuses other service identities, overrides, source changes and concurrent
updates. It runs fixture tests before stopping the service, installs immutable
source into `/opt/kai-koin-prepaid/releases/<commit>`, then changes only the
systemd code pointers. The accounts, transactions and device state stay in
`/var/lib/kai-koin-prepaid`.

The updater preserves every byte of `/etc/kai-koin-prepaid`, including the free
credit and model qualification policy, tariffs, private keys and account settings.
It does not fund wallets, submit transactions, deploy contracts, grant free
credits, broaden model admission, change payout ownership, edit Caddy or touch
`koinos.service`.

Health checks require fresh serving on loopback and public HTTPS, plus both:

- `/scheduler/koin/provider/device/capabilities`: wallet-first and delegated
  provider protocol version 1.
- `/auth/wallet-credit/capabilities`: wallet credit protocol version 1 bound to
  the existing service origin, scheduler URL and mainnet chain.

If startup/readiness fails, rollback restores only the previous unit's code
pointers. New account, device, credit usage and payment records are retained.
Unsupported new device activity may need the corrected new service to resume;
rolling back does not erase or replay it. A concurrent operator edit or unclean
shutdown stops automatic replacement and reports the saved previous unit.

## Access and rollout evidence

The repository's existing one-minute deploy timer updates the main website
`koinos.service`; it does **not** update `kai-koin-prepaid.service`. GitHub CI has
no prepaid deployment step. The development session that prepared this update
had repository access and public health access, but no authenticated scheduler
shell or deployment connection. No installation was performed by this script's
creation or by a desktop release.

Before release, record the exact backend commit and public capability results;
verify wallet-only enrollment, retained existing balances, actual free-credit
entitlement, purchase confirmation/recovery, network replies and locked-wallet
provider work. Use the matching tested desktop source and verify its installers
and update feeds. Preserve the server's independent service and custody design.
