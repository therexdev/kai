# Run a Koinos node

The Earn tab's **Run Koinos Node** switch reveals the full node stack: a real Koinos mainnet node with funding, burning, block production and automatic reward returns — using the same wallet the rest of the app uses.

## Requirements

- **x86-64 machine** with Docker (the guided setup installs it on Windows), ~32 GB free disk, 8 GB+ RAM.
- Raspberry Pi / ARM machines can't run the node yet — but the **wallet works everywhere** (see the Wallet page), and remote-node support for Pi is planned.

## The screens

- **Dashboard** — node status, sync progress against the public chain head.
- **Wallet** — balances and sends for KOIN, VHP, plus the ETH-side funding assets.
- **Fund** — on-ramp into the node: buy or bridge into KOIN.
- **Burn** — convert KOIN into VHP to become a block producer. Burning credits **your own address only** — it is not a transfer.
- **Node** — the node lifecycle: download snapshot, start, stop, logs.
- **Returns** — block-production rewards, with optional automatic re-burn.

## Money rules (identical everywhere in the app)

- Anything that moves value **to someone else** requires your wallet password on that call.
- Burning and producer-key registration sign but move nothing away — still deliberate, still confirmed by you.
- An unlocked wallet is never treated as "a human said yes".
