# Network account entry

This website change points the desktop and mobile Account navigation to `/platform` and adds an entry card on the existing `/account` page. The fixed redirect leads to `https://credits.koinosai.com/platform`; `/platform/docs` leads to that service's API documentation. No session cookies, device codes, or incoming query parameters are forwarded.

Deploy after the separate `codex/web-accounts-api` backend change is installed, `KAI_WEB_API_ENABLED=1` is configured on the existing prepaid service, and the live account/chat/purchase smoke tests pass. Do not merge this website entry before that service is enabled. The existing website/node/builder account data and routes remain in place. The new network account uses the mainnet credit service identity and ledger; this does not merge legacy accounts or balances.

The inference API base is `https://credits.koinosai.com/v1`. Keep `api.koinosai.com` as the blockchain RPC. The homepage still prioritizes installing Core, downloading models and sharing compute.

Validation: `node --test tests/web-account-entry.test.js tests/beta-launch.test.js`.
