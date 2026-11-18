# Network account entry

This website change points the desktop and mobile Account navigation to `/platform` and adds an entry card on the existing `/account` page. The fixed redirect leads to `https://credits.koinosai.com/platform`; `/platform/docs` leads to that service's API documentation. No session cookies, device codes, or incoming query parameters are forwarded.

Deploy after the separate `codex/web-accounts-api` backend change is installed, `KAI_WEB_API_ENABLED=1` is configured on the existing prepaid service, and the live account/chat/purchase smoke tests pass. Do not merge this website entry before that service is enabled. The existing website/node/builder account data and routes remain in place. The new network account uses the mainnet credit service identity and ledger; this does not merge legacy accounts or balances.

The inference API base is `https://credits.koinosai.com/v1`. Keep `api.koinosai.com` as the blockchain RPC. The homepage still prioritizes installing Core, downloading models and sharing compute.

Validation: `node --test tests/web-account-entry.test.js tests/beta-launch.test.js`.


## Dedicated login and account sidebar

The public navigation now says **Log in**, including a visible mobile-header link. `/login` opens the credit service login and `/account` opens its unified dashboard only after `/health` advertises `accountUiVersion: 1`. The website caches this capability for 20 seconds and keeps the last successful capability on transient failures. Before activation, it keeps the currently deployed destinations, so website rollout can precede the VPS update without exposing missing routes.

The previous website database remains intact. Existing node, builder and legacy workspace gates go through `/website-login` and back to their original tool; a short-lived HttpOnly return cookie preserves Google's existing callback. It carries only an allowlisted local path, never a session token. `/account/website` retains management of older website sessions, grants and wallet links. This compatibility surface is labeled Website access and uses the same sidebar design as the node dashboard. These historical identities are not automatically merged into the network-credit account.

Validate with `node --test tests/web-account-entry.test.js tests/account-login-navigation.test.js tests/beta-launch.test.js`. Deploy the account dashboard backend using its reviewed `update-account-ui.js` command. The website will then switch Login and Account to the new pages automatically; no second website deployment is needed.
