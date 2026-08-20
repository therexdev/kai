# Wallet — KOIN & VHP on mainnet

Your earning account doubles as a real Koinos mainnet wallet. The **Wallet** card sits at the bottom of the Earn tab and works on every machine — Windows, Linux, Raspberry Pi, browser — with no node.

![The Wallet card — receive address, balances on demand, and the send form](img/earn-wallet.png)

## Receive

1. Open **Earn** and scroll to **Wallet — send & receive on Koinos mainnet**.
2. Click **Copy address** and share it. Any KOIN or VHP sent to that address on mainnet is yours.

## Check balances

Click **Show balances**. The app reads KOIN, VHP and mana from the chain at that moment — nothing polls in the background, by design.

## Send (read once before your first send)

1. Pick the token — **KOIN** or **VHP**.
2. Paste the recipient's address and enter the amount.
3. Type your **wallet password**. It's required on every send, even though the wallet is unlocked — unlocked is for earning, never for moving money.
4. Click **Send**. The first click only ARMS: the app repeats exactly what's about to happen — amount, token, recipient, and a MAINNET warning.
5. Click **Send** again to confirm. Editing any field in between disarms it.

> This is real value on a public chain. A transfer cannot be undone. Check the recipient address character by character.

**You should see** "Sent. Transaction …" with the transaction id. Balances update once the block settles.

## Mana

Every transaction spends mana, which recharges over about five days and scales with your KOIN balance. Keep a little KOIN in the wallet so sends always have fuel. If a send is refused for mana, wait a bit or send less.

## Backup & restore

- **Show backup code** (Earn tab, password required) reveals your key. Store it somewhere safe and offline.
- **Restore from backup code** on the Earn tab's lock screen brings the same wallet to any machine.
