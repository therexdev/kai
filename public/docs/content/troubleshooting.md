# Troubleshooting

## "My model isn't showing on the network"

Open **Earn** and read the **Serving models** row — it names the exact rule holding each model back:

- `needs X GB RAM — this machine reports Y GB` — the model is too big for this machine to serve comfortably. Download a smaller one; **Koinos Fast serves on a 4 GB Pi**.
- `private import — never advertised` — models you imported yourself stay private by design; only catalog models earn.
- Row missing entirely? You're on an old version — update the app.

## Pi: updating

```
cd kaiapp
git checkout -- package-lock.json
git pull origin claude/koinos-ai-takeover-co25fw
npm install
```

Then restart Core (`npm run core`). The first command only matters when the pull complains about local changes — the lockfile drift is disposable. Your wallet, chats and settings live in `~/.koinos-ai` and survive every update.

## Earning drops out on Windows

Windows standby pauses earning; the app reconnects on wake and shows how many times it happened. For 24/7 serving: Windows Settings → System → Power & battery → set Sleep to **Never** while plugged in.

## "Privacy is set to Local-Only…"

That's the privacy system working as designed: Local-Only means nothing leaves this machine, which also disables web search, network AI, earning, email/calendar and chain reads. Change it under **Local API → Network & privacy**.

## A send failed for mana

Mana recharges over ~5 days and scales with your KOIN balance. Keep some KOIN in the wallet; wait or send a smaller amount.

## The Earn tab says my balance is temporarily unavailable

The app reads balances from the network only when allowed and reachable; it retries on its own. If it persists, check your privacy mode and connection — the app never shows a stale number as if it were fresh.

## Where things live

- App data, wallet, chats: `~/.koinos-ai`
- Live network status: [koinosai.com/network](https://koinosai.com/network)
- Downloads: [GitHub releases](https://github.com/therexdev/kaiapp/releases/latest)

## Reporting a bug

Use **Send feedback** at the bottom of the sidebar — it lands directly with the team, app version attached. The perfect report is three lines: what you did, what you expected, what happened.
