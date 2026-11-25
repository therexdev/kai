# Credit purchases up to $1,000

The merchant-reference service previously treated its 10-USDT price-validation
probe as a purchase ceiling. Conversion, time weighting and rounding could put
that ceiling just below $10, so both $10 and $40 were rejected. Merchant credit
sales now allow selected USD packs through $1,000. The minimum market-depth
checks, two archive sources, canonical history, USDT checks, quote expiry,
signatures and durable quote journal still apply. The new cap does not claim
$1,000 of executable exchange liquidity and does not introduce a daily limit.

KAI Core also needs the matching purchase-limit update: its old 100-KOIN
deposit guard otherwise blocks larger credit purchases. That update applies
the $1,000 limit at the verified quote rate and leaves reward funding and
other native-denominated limits intact. It does not change the price-policy
pin, existing profile, saved payment, wallet, or credit balance.

## Server update

Use a clean checkout of `fix/credit-purchase-limit-1000` from `therexdev/kai`
on the scheduler, with system Node 22 or newer:

```bash
git clone --single-branch --branch fix/credit-purchase-limit-1000 https://github.com/therexdev/kai.git /root/kai-purchase-limit-update
cd /root/kai-purchase-limit-update
/usr/bin/node deploy/koin-mainnet/update-purchase-limit.js
curl -fsS https://credits.koinosai.com/health
```

The updater requires the installed native-qualification release
`65c1d21b85705cd26acc63bd1eedaf5af4ef6400`. If another release is active, it
stops before replacing it. Do not reset production to satisfy that check;
prepare the update against the actual installed release instead.

It reuses the tested drain, stopped-state snapshot, single-writer, financial
state preservation, source validation, and restart/health checks. Runtime
configuration, credentials, and journals are not rewritten. Successful health
reports `creditPurchaseLimitVersion: 1` and `maxCreditPurchaseUsd: "1000"`.

After deploying the server and installing a verified matching Core release,
check $40 and $1,000 previews and the $1,000.01 rejection. Reviewing a preview
does not authorize a payment. The user must approve the native wallet dialog
to purchase. Local and loopback tests use synthetic wallets and chain data;
they do not establish live payment finality or Windows installer verification.
