# Accounts and sign in

There are different kinds of access in KAI Core Beta. Keep them separate:

- **Website account**: website sign-in, approved website devices, linked wallets and existing legacy web grants.
- **Core credit session and wallet**: mainnet credits, purchases and provider authorization in the desktop app.
- **Plugin connections**: accounts and credentials managed by the relevant installed plugin.

Signing into the website does not automatically transfer or merge credit balances, plugin accounts or saved plugin work.

## Website sign in

Open [Account](https://koinosai.com/account). Email codes and Google can create a website account when enabled. A passkey signs into an existing account; first sign in with email or Google, then add a passkey.

Review your signed-in browsers and revoke unused sessions. Sign out everywhere also revokes this website's spending grants; it does not reset Core's purchased credits.

Approve only a device code from a sign-in flow you started. Never enter a wallet private key on the account page.

## Alpha migration

Core's migration tool transfers selected model files and the encrypted Alpha wallet. It does not migrate connected accounts or plugin data. Reconnect integrations through the plugin that owns them. [Transfer guide](https://github.com/therexdev/kai-core/blob/main/docs/TRANSFER_GUIDE.md).
