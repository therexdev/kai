# Network AI & billing

Your app can rent bigger brains from the network: pick a **network model class** in the chat composer (needs Local-First or Network privacy mode).

## Model classes & pricing

Network AI bills like any modern AI API — by input and output tokens, per model class — and settles in KAI underneath. Current classes and rates are always live at [koinosai.com/scheduler/pricing](https://koinosai.com/scheduler/pricing). The ladder mirrors the local catalog: fast, balanced, smart, and the large specialist classes.

## The free tier

Every wallet gets a daily free token allowance, refreshed each epoch day, with a network-wide daily ceiling behind it. When the free tier is exhausted the app says so plainly and pauses gracefully — it never silently starts billing.

## Adding funds

Earn tab → **Add funds** converts your earned KAI into prepaid usage at the current reference price. Serving the network can cover your own usage — that's the loop the whole system is built around.

## The price oracle

The KAI reference price comes from a live median-of-sources oracle with hard breakers: a floor, a ceiling, and a maximum move per epoch. Status is public on the pricing endpoint — `live`, `anchor`, or `stale-hold`, never a silent jump.

## Privacy

Network requests carry your prompt to the worker that serves it, signed by your wallet. `Local-Only` mode makes all of this physically impossible — the app will not open a network path, full stop.
