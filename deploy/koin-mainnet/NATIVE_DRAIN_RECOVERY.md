# Native update: observed HTTP drain recovery

The 2026-11-24 operator log shows PID 477847 retained on base `bc1fca8328cdd463023c472ba3ee5ca84d9c6580` after SIGTERM, with one established loopback connection from 127.0.0.1:43802 to 127.0.0.1:3109 (node FD 80). The updater retained its phase `draining` plan for target `65c1d21b85705cd26acc63bd1eedaf5af4ef6400`. The public health request subsequently returned HTTP 502.

An open HTTP response can prevent `server.close()` from finishing. This is a plausible blocker, not proof of the request's contents or the financial worker's state. The recovery helper closes only the exact observed connection after verifying the service has already closed its listener. That request's client may see an interrupted response. The helper does not resend or repeat the request.

## Use

Keep the original native qualification checkout pinned and clean. Fetch this recovery commit without checking it out, extract only `recover-native-http-drain.js` to a private temporary file outside the checkout, and run it from the original checkout with `/usr/bin/node <temporary-file> --disconnect-observed-http` as root.

The helper shares the original updater's outer lock. It requires the existing protected plan, exact base/target, original PID and restart count, a closed listener, and the single unchanged socket with empty kernel queues. It fails closed if any observation differs. Empty queues are not interpreted as financial inactivity.

The sole disconnect command is `ss -Knt` filtered to the observed IPv4 source/destination addresses and ports. No process signal, service restart, journal read/write, environment change or plan rewrite is performed. The existing application still owns financial drain and exit. Only a verified normal exit (code 0, same PID, unchanged restart count) allows the helper to return successfully. After 60 seconds it reports a remaining drain and stops without escalation.

After success, rerun the original `update-native-qualification.js` from its unchanged checkout. That updater rechecks source, plan, process exit, writer leases and snapshots before activating code. Do not replace the pending target with this helper's commit.

## Validation and limits

Seven Node core-only tests pass, including wrong PID/release/restart, dirty source, changed/private-plan guards, still-listening service, other/extra/busy sockets, concurrent updater lock, already-clean exit and a non-escalating timeout. Tests simulate the OS commands; the production disconnect has not been executed in the development environment. Source inspection confirms the installed application waits for `serverClosed`, `busy === false`, and `availabilityBusy === false` before closing runtime resources.

This incident helper does not change the general shutdown policy or establish that the pending deployment has completed. Persistent handler/drain improvements should follow a confirmed recovery and request diagnosis.
