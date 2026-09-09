# KAI-managed Composio connections

KAI Test can now show the Composio app catalog and hosted sign-in using either the user's project key or the KAI server's project key. Personal mode talks directly to Composio from Electron. Managed mode uses this server and the user's existing KAI account session.

## Enable in the admin page

1. Create a Composio project and obtain its project API key from [Composio settings](https://dashboard.composio.dev/).
2. Ensure the service has a persistent `SESSION_SECRET` and writable persistent `KAI_STATE_DIR`. Preserve that secret across deployments; it protects both sessions and the saved connection setting.
3. Open the site's `/admin` page and find **Composio connections**. Paste the key, check **Enable KAI-managed connections**, and save. The server checks the key against Composio's catalog before saving it. The saved key is encrypted with AES-256-GCM in `connections.json` under the state directory.
4. In KAI Test, sign in to the KAI account under Settings. Choose **Connections → Connection settings → KAI-managed**, then explore apps.

Alternatively, set `COMPOSIO_API_KEY` and `KAI_COMPOSIO_ENABLED=true` in the service environment and restart. Environment values take precedence over the admin form. Never commit a key or put it in desktop configuration. Managed connections are off until explicitly enabled with a key. An unavailable key/decryption failure keeps the service disabled.

If deployed under a different canonical website origin, set `KAI_SITE_ORIGIN` to that HTTPS origin. Admin mutations require a same-origin request in addition to the admin session. Leave the existing KAI account authentication and CSRF settings intact.

## Ownership and transport

- `/connections/status` exposes availability, protocol version, and a project generation marker. It never returns a key or account data.
- `/connections/api/:action` requires a KAI account. The server derives Composio's user ID as `kai:<account id>` from that session. Caller-supplied user IDs are ignored.
- The fixed actions are catalog, toolkit metadata, tools, tool metadata, account listing, hosted sign-in creation, disconnect, and selected tool execution. There is no arbitrary authenticated HTTP proxy.
- Every account action checks ownership at Composio. Account lists are filtered again on the server. Raw OAuth/API credential state is discarded; only account display metadata reaches the desktop.
- Provider requests go only to Composio's documented v3.1 API, with bounded responses, timeouts, no redirects, and per-account rate limits. Tool execution checks the selected account's toolkit and input schema, and passes an explicit version.
- Composio stores/manages provider credentials. In managed mode, the KAI server also handles selected tool inputs and returned data in transit. It does not add them to a server Brain or persist action results. Composio/project logging and retention settings are controlled in Composio.
- The desktop stores action grants and Brain sources locally. It requires review for writes and actions lacking verified read-only behavior. Local-Only blocks all connection traffic. Private Brain data and keys never enter the compute-worker API.

## Rotation and disconnection

Changing the project key changes the generation marker. The desktop requires a refresh and treats the new project as a different set of accounts. Existing connections remain in the old Composio project; they are not silently transferred. Keep the old project key until any necessary accounts have been disconnected there. Disabling managed connections stops future calls, but does not revoke the provider's OAuth authorization. Users can remove provider authorization in the provider's own security settings.

Managed and personal accounts are separate. Changing modes does not remove previously imported Brain notes. The user can delete those sources in Brain when wanted.

## Verification and service costs

Run `node scripts/probe-connections.js`. It exercises real HTTP routes with synthetic upstream responses: admin/session checks, encrypted persistence, disabled mode, user isolation, exact ownership checks, credential stripping, project rotation, and server wiring. CI discovers it with the other `probe-*.js` checks. The shared `lib/composio-client.js` and `lib/composio-reads.json` match their `kaiapp/core/lib/` counterparts; update both repos when the contract changes. The read manifest records exact reviewed toolkit versions and documentation URLs. It never classifies arbitrary actions by their names.

No production Composio key was provided for this implementation. A real provider authorization must be checked after enabling the service. Catalog availability, supported authentication schemes, API quotas, scopes, and charges depend on the selected Composio project and each provider. There is no automatic subscription or billing setup in KAI.

API references: [project authentication](https://docs.composio.dev/reference/authenticating-to-composio), [catalog](https://docs.composio.dev/reference/api-reference/toolkits/getToolkits), [hosted sign-in](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink), [tool execution](https://docs.composio.dev/reference/api-reference/tools).
