# Earn — serve the network

Your machine serves its downloaded models to the network and gets paid in KAI for verified work, settled every 15-minute epoch.

## Setting up (first time, ~2 minutes)

1. Click **Earn** in the sidebar.
2. **Create your earning account**: type a password twice and click create. This makes your wallet — a real Koinos address.
3. **Write down the backup code** the app shows once. It IS the wallet; anyone with it has your funds, and without it a lost disk means lost earnings.
4. The scheduler field is pre-filled with `https://koinosai.com/scheduler`. Leave it.
5. Click **Start Earning**.

**You should see** the status dot turn green with "Online — earning", and "last contact" ticking every few seconds.

![The Earn tab, set up and ready — stats grid, Start Earning, and the wallet card below](img/earn.png)

## Reading the stats

- **Serving models** — which models this machine offers the network, and — when one is held back — the exact rule that held it, for example `needs 8 GB RAM — this machine reports 3 GB`. If nothing fits, download **Koinos Fast**; it serves on a 4 GB Pi.
- **Jobs completed / Receipts accepted** — work the scheduler verified and credited.
- **This epoch** — pending jobs and the live KAI estimate for the current 15-minute epoch.
- **KAI balance** — settled earnings, updated after each epoch closes.

## How pay works (alpha)

- Each epoch, useful work divides a network-wide bootstrap pool; paid demand mints on top. Equal work earns equal pay.
- The scheduler continuously spot-checks every worker with verification challenges and mystery chats. Honest machines never notice; dishonest output isn't paid.
- Measured speed and reliability feed routing: faster, steadier machines receive more paid work over time. New machines get seeded fairly while they build a record.

## Reputation

Every worker accrues reputation from network age, reliability, verification history and real paid demand served. It's visible in the app's **Network** tab and publicly at [koinosai.com/network](https://koinosai.com/network). Informational today; anti-gaming gates arm later, with notice.

## Keep it earning

- Set your OS to never sleep while plugged in — standby pauses earning. The app reconnects on wake and tells you how many times it happened.
- Stopping is instant: no job runs after you press **Stop Earning**.
- The wallet stays unlocked for serving; anything that MOVES money still demands your password every time.
