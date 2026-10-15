# Desktop provider status update

The matching Test desktop now uses normal Chat for paid requests and checks provider readiness through authenticated `GET /scheduler/koin/test/status`. This backend revision adds a `providers` field scoped to the invitation's wallets. Existing payout fields and payment routes stay compatible.

ONLINE requires a current reviewed qualification, signed paid-worker capability, advertised approved model, fresh signed ready presence, recent worker contact and a recent successful payment-processing cycle. It does not renew qualification, change rewards, submit transactions or expose operator secrets. Old desktops ignore the additional field; new desktops show checking rather than ONLINE when it is absent.

Run `node scripts/probe-koin-provider-readiness.js` and the existing mainnet session response probe before deployment. Deploy this commit using the existing reviewed `deploy/koin-mainnet/install.sh` path and `/root/kai-mainnet-bootstrap`, after the two pilot apps are stopped and pending work has been reconciled. The installer preserves the existing service configuration and state and refuses different configuration files. Confirm the exact source commit and backup/recovery readiness before restarting the service; a restart can interrupt an answer still held in memory.

After rollout, verify HTTPS health, then open the provider app and confirm authenticated provider status. A provider whose qualification expired must still show renewal required. Obtain fresh qualification evidence through the existing reviewed process before accepting ONLINE. Do not rerun an old date-bound renewal file or extend timestamps merely to make the screen green.

Deployment from the implementation workspace was blocked by unreachable SSH at the known Vultr host. No service restart, qualification change, wallet transfer or real paid inference was performed as part of local validation.
