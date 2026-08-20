# Accounts & sign-in

> Rolling out now — this section describes the account system as it lands.

A Koinos AI **account** links one person to their wallets and devices, so your balance, claims and settings follow you.

## Ways to sign in (at koinosai.com/account)

- **Passkey** — your device's fingerprint, face unlock or PIN. Strongest and simplest; nothing to remember, nothing sent anywhere.
- **Email code** — a 6-digit code mailed to you, valid 10 minutes.
- **Google** — standard "Continue with Google"; only your email address is requested.

## Connecting the app to your account

The app never opens a login form. Instead it shows a short **device code**:

1. In the app: Account → Sign in. It displays a code like `ABCD-1234`.
2. On any signed-in browser, open `koinosai.com/link`, type the code, approve.
3. The app signs itself in within a few seconds.

## Linking wallets

From the app: Account → **Link this wallet**. The app proves ownership by signing with the wallet's own key — the key never leaves your machine. Your account page then shows every linked wallet. A wallet can belong to one account at a time; unlink it before moving it.

## Security notes

- Sessions can be signed out per browser; sign-in methods can be added or reviewed on your account page.
- The server stores no passwords and no secrets — only public keys and one-way hashes.
