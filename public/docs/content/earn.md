# Earn — serve the network

Flip **Start Earning** in the Earn tab and your machine serves its downloaded models to the network. Real usage, real work receipts, settled in KAI every 15-minute epoch.

## What you'll see

- **Serving models** — which models this machine offers, and — when one is held back — the exact reason (for example `needs 8 GB RAM — this machine reports 3 GB`). If it says a model doesn't fit, download a smaller one; Koinos Fast fits a 4 GB Pi.
- **Jobs completed / receipts accepted** — the work the scheduler verified.
- **This epoch** — pending jobs and the KAI estimate for the current epoch.
- **KAI balance** — your settled earnings.

## How pay works (alpha)

- Every epoch, useful work divides a network-wide bootstrap pool. Paid demand mints on top of that — equal work, equal pay.
- The scheduler continuously spot-checks workers with verification challenges and mystery chats. Honest machines never notice; dishonest output doesn't get paid.
- Your machine's measured speed and reliability feed routing: faster, steadier machines get more paid work.

## Reputation

Every worker builds reputation from age on the network, reliability, verification history and real paid demand served. It's visible in the app's Network tab and on [koinosai.com/network](https://koinosai.com/network). Today it's informational; anti-gaming gates arm later, with notice.

## Keep it serving

- Set your OS sleep to **Never** while plugged in — standby pauses earning (the app reconnects on wake and tells you it happened).
- The wallet stays unlocked for earning; the password is still required for anything that MOVES money.
