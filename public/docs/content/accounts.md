# Accounts & sign-in

A Koinos AI **account** links you — one person — to your wallets and devices, so balances, claims and settings follow you across machines. Live now at [koinosai.com/account](https://koinosai.com/account).

## Ways to sign in

- **Passkey** (recommended) — your device's fingerprint, face unlock or PIN. Nothing to remember, nothing typed, nothing reusable if a server ever leaked.
- **Email code** — a 6-digit code mailed to you, valid 10 minutes, five attempts.
- **Google** — the standard "Continue with Google"; only your email address is requested.

### First sign-in, step by step

1. Open **koinosai.com/account** in any browser.
2. Pick a method. With email: type your address, click **Send code**, fetch the 6-digit code from your inbox, type it, done.
3. Once signed in, click **Add a passkey to this account** — next time it's one touch.

## Connecting the app to your account (device link)

The app never opens a login form. It shows a short code instead:

1. In the app: **Account → Sign in**. It displays a code like `ABCD-1234`.
2. On any browser where you're signed in, open **koinosai.com/link**, type the code, click **Approve device**.
3. **You should see** the app sign itself in within a few seconds.

## Linking wallets

From the app: **Account → Link this wallet**. The app proves ownership by signing with the wallet's own key — the key never leaves your machine, and the proof can't be replayed elsewhere. Your account page lists every linked wallet; a wallet belongs to one account at a time (unlink before moving it).

## Security notes

- Sign out per browser from the account page; review sign-in methods and passkeys there too.
- The server stores no passwords and no secrets — only public keys and one-way hashes.
- The in-app Account panel is rolling out in an upcoming build; the web side above is live now.
