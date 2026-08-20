# Run a Koinos node

The **Run Koinos Node** switch at the bottom of the Earn tab reveals the full node stack: a real Koinos mainnet node with funding, burning, block production and automatic reward returns — using the same wallet as the rest of the app.

## Requirements

- An **x86-64 machine** with Docker (the guided setup installs it on Windows), roughly 32 GB free disk and 8 GB+ RAM.
- Raspberry Pi / ARM machines can't run the node yet — but the **wallet works everywhere** (see the Wallet page). Remote-node support for Pi is planned.

## Turning it on

1. Open **Earn** and flip the **Run Koinos Node** switch.
2. Seven new entries appear in the sidebar: **Node dashboard, Wallet, Fund node, Burn KOIN → VHP, Node, Reward returns, Node settings**.
3. Start at **Node dashboard** — it shows node status and sync progress against the public chain head, so "connected" and "connected but 40,000 blocks behind" look different.

## The screens, briefly

- **Wallet** — balances and sends for KOIN and VHP, plus the ETH-side funding assets (ETH, USDT, vKOIN) used by Fund.
- **Fund node** — on-ramp: buy or bridge into KOIN to capitalize the node.
- **Burn KOIN → VHP** — become a block producer. Burning credits **your own address only**; it is deliberately not a transfer.
- **Node** — lifecycle: download the snapshot (verified against a published SHA-256), start, stop, logs.
- **Reward returns** — block-production rewards, with optional automatic re-burn to keep producing.

## Money rules (identical everywhere in the app)

- Anything that moves value **to someone else** requires your wallet password on that exact action.
- Burning and producer-key registration sign but move nothing away — still deliberate, still confirmed by you.
- An unlocked wallet is never treated as "a human said yes".
