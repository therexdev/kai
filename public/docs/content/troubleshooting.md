# Troubleshooting

## "My model isn't showing on the network"

Open the Earn tab and read the **Serving models** row — it names the exact rule holding each model back:

- `needs X GB RAM — this machine reports Y GB` — the model is too big for this machine to serve comfortably. Download a smaller one (Koinos Fast serves on a 4 GB Pi).
- `private import — never advertised` — models you imported yourself stay private by design; only catalog models earn.
- Nothing listed at all? You may be on an old version — update the app.

## Pi: updating

```
cd kaiapp
git checkout -- package-lock.json   # if a pull complains about local changes
git pull origin claude/koinos-ai-takeover-co25fw
npm install
```

Then restart Core. Your wallet, chats and settings live in `~/.koinos-ai` and survive updates.

## Earning drops out on Windows

Windows standby pauses earning; the app reconnects on wake and shows how many times it happened. For 24/7 serving: Settings → System → Power → set Sleep to **Never** while plugged in.

## "Privacy is set to Local-Only…"

That's the privacy system working. Local-Only means nothing leaves this machine, which also disables web search, network AI, earning and chain reads. Change it in Settings → Privacy.

## A send failed for mana

Mana recharges over ~5 days and is spent by transactions. Keep some KOIN in the wallet; wait or send a smaller amount.

## Where things live

- App data, wallet, chats: `~/.koinos-ai`
- Network status, live: [koinosai.com/network](https://koinosai.com/network)
- Release downloads: [GitHub releases](https://github.com/therexdev/kaiapp/releases/latest)

## Reporting a bug

Use the feedback box in the app (Earn tab) — it lands directly with the team, with your app version attached. The more specific the report, the faster the fix; "what you did, what you expected, what happened" is the perfect shape.
