# Independent free-credit availability checks

The 30-second sponsorship observation used to be refreshed inside the settlement
loop, after payment reconciliation. Slow chain reads, payout retries or a failed
settlement could therefore make every account temporarily lose its displayed free
allowance despite a funded pool.

The service now refreshes the same pinned contract policy and pool checks on a
separate read-only loop every five seconds. Requests are coalesced, bounded to
15 seconds and cancelled on shutdown. Proof age still begins when the read starts;
late reads never extend it. Transport failures retain only the unexpired portion
of the prior proof. Failed policy, pause or funding checks revoke eligibility.
The free-credit limits, identities, spending rules and payment journals are unchanged.

The app repository's `docs/FREE_CREDIT_STABILITY_RELEASE.md` provides the exact
immutable release and complete server command. Run `node deploy/koin-mainnet/update-free-allowance.js`
from that pinned checkout with system Node 22+ as root. It accepts only the exact
previous model-readiness or daily-summary release, preserves configuration and
journals, tests before stopping, and restores code if health verification fails.
It also includes daily reward reporting, so the earlier summary update is not
required as a separate step.

Success reports **Free allowance refresh and daily reward summaries installed and
verified on loopback and HTTPS**. Health exposes `freeAllowanceRefreshVersion: 1`.
That marker confirms the new refresh implementation, not unlimited free usage or
guaranteed funding. Genuine RPC, funding or policy failures still pause free usage.
