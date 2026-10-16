# Desktop provider status update

The matching Test desktop now uses normal Chat for paid requests and checks provider readiness through authenticated `GET /scheduler/koin/test/status`. This backend revision adds a `providers` field scoped to the invitation's wallets. Existing payout fields and payment routes stay compatible.

ONLINE requires a current reviewed qualification, signed paid-worker capability, advertised approved model, fresh signed ready presence, recent worker contact and a recent successful payment-processing cycle. It does not renew qualification, change rewards, submit transactions or expose operator secrets. Old desktops ignore the additional field; new desktops show checking rather than ONLINE when it is absent.

Run `node scripts/probe-koin-provider-readiness.js` and the existing mainnet session response probe before deployment. Deploy this commit using the existing reviewed `deploy/koin-mainnet/install.sh` path and `/root/kai-mainnet-bootstrap`, after the two pilot apps are stopped and pending work has been reconciled. The installer preserves the existing service configuration and state and refuses different configuration files. Confirm the exact source commit and backup/recovery readiness before restarting the service; a restart can interrupt an answer still held in memory.

After rollout, verify HTTPS health, then open the provider app and confirm authenticated provider status. A provider whose qualification expired must still show renewal required. Obtain fresh qualification evidence through the existing reviewed process before accepting ONLINE. Do not rerun an old date-bound renewal file or extend timestamps merely to make the screen green.

Deployment from the implementation workspace was blocked by unreachable SSH at the known Vultr host. No service restart, qualification change, wallet transfer or real paid inference was performed as part of local validation.

## Owner rollout from the confirmed old service

The owner reported the active service at `79ba574083d716810fa2f0a0cbbabe4d85a9174d` on October 15. The one-time `update-provider-status.js` helper upgrades only that release to the reviewed provider-status commit `07629b24e91f32af8abafc2ebdf0bdca8771e936`. It refuses other service revisions or systemd overrides and does not run the date-bound renewal script.

Save/recover any chat reply and quit both Test desktop apps. On the server, run the checksum-verified helper as root with `--apps-stopped`. It checks both the funded-request ledger and signing journal, including reserved/dispatched work; it also waits out the five-minute retained-reply window. It compares bootstrap/service configuration before changes, downloads the pinned commit and runs its probes, then checks again around shutdown. It backs up configuration, bootstrap files, the service unit and all state while the service is stopped, with root-only permissions, before using the existing installer.

Successful completion verifies the expected working directory and a fresh HTTPS processing heartbeat, then prints qualification expiry without changing it. If deployment or health verification fails, it restores only the old service unit/code and keeps current payment records. It never restores stale journal snapshots. Any rollback failure is reported for operator intervention. The helper does not enable providing on the desktop.

Validation: `node --test scripts/probe-koin-provider-status-update.js` covers busy-work refusal, saved signatures, recent replies, a request admitted during shutdown, unchanged configuration, private backup permissions and code-only rollback preserving newly written transactions.
