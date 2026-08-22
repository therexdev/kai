# Koinos AI on the web

Chat and Docs in a browser, signed in to the same account the desktop app uses. Live at [koinosai.com/app](https://koinosai.com/app).

It exists for the machine that cannot run models — a work laptop, a Chromebook, a borrowed desktop, a phone. Answers still come from the Koinos Network: real machines run the model, and you pay per token in KAI, exactly as you do from the app.

## What you need first

Two separate things, and it is worth being clear about which is which.

1. **A spending grant.** Permission for the website to draw from one of your wallets, up to a cap, until a date you choose.
2. **KAI on the network to draw against.** The grant is permission, not funds. Your wallet needs a balance — from the Earn tab, or from running a node — the same as the desktop app. Everyone also gets a small free allowance each day.

Without the first, the web app shows you a door and nothing else. Without the second, a request is refused before it runs, rather than quietly running up a bill nobody can pay.

## Authorising web access

A browser holds no key, and it never will. So the authorisation is signed on the machine that *does* hold your wallet:

1. In the desktop app, open **Settings → Koinos AI account**.
2. Make sure this wallet is linked to your account (**Link this wallet**, if the button is showing).
3. Under **Use Koinos AI on the web**, set a cap and a duration, then click **Authorise**. The app asks you to confirm the exact figure before it signs anything.
4. **You should see** the block change to a summary — authorised, used so far, left, expiry — with an **Open the web app** link.

That signature names the wallet, the account, the cap and the expiry. Changing any of those terms would need a new signature, which is the whole point: the website cannot raise its own limit.

## Using it

Open [koinosai.com/app](https://koinosai.com/app) in a browser where you are signed in to your account. If you are not, it sends you to the sign-in page and brings you back.

**Chat** — ask, and the answer streams in as the model generates it. Conversations are kept on the server against your account, so the tab you left open on another machine has the same history. Each chat names itself from the first thing you said.

**Docs** — write, then select a passage and ask about it: *tighten this*, *what am I missing?*, *continue from here*. The answer appears in a panel below with three buttons — **Insert at cursor**, **Replace selection**, **Dismiss**.

The model never edits the document by itself. That is deliberate: an assistant that rewrites your file the instant it finishes generating is one that can quietly destroy an hour of work. Insert and Replace go through the editor normally, so **Ctrl+Z** undoes them like anything else you typed.

**Tasks** — a prompt on a schedule: hourly, daily, weekly. These run on the server, so they run whether or not you have a window open. Each task names the grant it draws on when you create it, and pauses by itself the moment that grant is revoked, expires, or runs out — it will not quietly find another wallet to pay with. **Run now** takes exactly the same path a scheduled run takes, so it is a real rehearsal rather than a lookalike.

The shortest schedule is one hour. That is a limit for the wallet's sake, not the server's: a five-minute task is a spend loop with a friendly name.

**Wallet** — what the site may spend, what it has spent, and what is left, including grants that have expired or been revoked.

## Ending web access

Two ways, both immediate:

- In the desktop app: **Settings → Koinos AI account → End web access**.
- On [koinosai.com/account](https://koinosai.com/account): revoke the grant.

Revoking stops the next request. Anything already spent stays spent — there is nothing to reverse, because the work was really done by someone's machine.

Signing out **everywhere** (from your account page) also revokes spending grants, not just sessions. Signing out on one browser does not.

## What the website can and cannot do

**Can:** spend up to the cap you set, from the wallet you named, until the date you set, on model usage at the network's published rates.

**Cannot:** hold your key, sign anything as you, raise its own cap, extend its own expiry, move KOIN or VHP, or touch a wallet you did not name.

## Troubleshooting

**"Connect a wallet to begin"** — no live grant on this account. Authorise one from the desktop app (above). If you just did, reload the page.

**"Insufficient balance"** — the grant is fine; the wallet has nothing to draw on. Add KAI in the app's Earn tab, or start earning.

**"No providers are serving …"** — nobody is running that model class right now. Try again shortly, or pick a different class. The [network page](https://koinosai.com/network) shows what is online.

**Signed out unexpectedly** — sessions expire, and revoking sessions from your account page ends them immediately. Sign in again at [koinosai.com/account](https://koinosai.com/account).

## What is not here yet

Compare, Tools, Agent mode, Teams, voice, images and local models are **desktop only**. They depend on either your own hardware or the app's local tool layer, neither of which a browser has.

Web tasks cannot use tools or the web search the desktop ones can, for the same reason — a scheduled prompt gets the model and nothing else, for now.
