# Revision 2 purchase-price validation

This is a read-only quote source, not a contract deployment or permission to spend funds. No runtime pricing configuration has been installed and no live quote is claimed. Missing, invalid or stale evidence pauses new purchases without disabling consumption of existing credits.

The approved Ethereum v4 pool and token ordering are pinned in `purchase-price.js`. `v4-history-reader.js` reads every canonical block in the configured averaging window through archive JSON-RPC, including `StateView.getSlot0` and actual two-direction v4 Quoter simulations. Calls use EIP-1898 block hashes with `requireCanonical: true`; the finalized anchor is rechecked by number. There is no v3 `observe()` call and no dashboard spot-price fallback. Addresses and interfaces were checked against the [official deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments), [StateView interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IStateView.sol), and [v4 Quoter interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol).

`v4-price-validation.js` calculates an arithmetic time-weighted price in integer fixed-point units. It requires a full contiguous parent-linked history, bounds every block's deviation from the average, and checks active liquidity plus executable buy and sell depth throughout the window, including the actual 1% fee. USDT/USD is read from an explicitly configured Chainlink-compatible feed at the same canonical anchor; incomplete, negative, stale or depegged rounds fail validation.

`v4-purchase-oracle.js` requires two reviewed HTTPS archive hosts whose complete observations agree. Warm-up runs independently of settlement and existing-credit use. Every read rechecks the canonical anchor and signed parity evidence. A failed refresh clears the quote cache. Quote expiry cannot outlive the earliest underlying evidence, and the signed purchase quote uses that remaining lifetime.

## Configuration and trust decisions

The optional backend runtime `purchasePricing` object has exactly these fields:

- `schema: 1`
- `rpcUrls`: two independently reviewed HTTPS archive endpoints on distinct hosts. Provider independence remains an operator responsibility; different hostnames alone do not prove it.
- `usdtFeed`: the reviewed lowercase Ethereum USDT/USD feed address. There is no guessed/default feed.
- `paritySigner`: the public Koinos address of the approved parity attestor. This code creates no credential.
- `parityFile`: absolute path to a bounded regular JSON attestation file.
- `policy`: explicit `version`, `windowSeconds`, `maxBlockGapSeconds`, `maxPriceAgeMs`, `maxQuoteMs`, `maxDeviationBps`, `maxSlippageBps`, `maxUsdtAgeMs`, `maxUsdtDeviationBps`, `maxParityAgeMs`, `maxParityDeviationBps`, `minLiquidity`, `minProbeUsdtAtoms`, `usdtSource`, and `paritySource`.

The USDT source is exactly `ethereum:chainlink:<usdtFeed>`. No launch thresholds, archive-provider selection, stablecoin-feed selection, or parity-attestor policy is invented by this implementation. The synthetic values in tests are not deployment policy. Finality lag and actual archive/Quoter support must be measured before approving production thresholds.

The parity file is `{statement, signature}`. The statement is domain-separated and bound to the native chain ID and native token contract, Ethereum chain 1 and the pinned vKOIN token, an explicit wrapped-units-per-native-unit ratio at 1e8 precision, observation time, validity limit, configured source, `state: verified`, `redemption: available`, and the hash of reviewed evidence. `parityHash()` specifies the canonical signed field order. The signature is canonical base64 using the existing Koinos signing protocol.

This attestation is a trust boundary: it records an approved reviewer's fresh redemption evidence; it does not automatically establish bridge solvency, availability or fee parity. The evidence behind its hash must establish those conditions. No signature or default 1:1 assumption is supplied by the app. Paused redemption, altered evidence, another chain/token, missing signatures, expiry or unacceptable ratio deviation rejects the quote.

Run `node scripts/validate-koin-purchase-pricing.js <runtime-config.json>` for dry schema and attestation-signature validation. It does not access the network, sign, deploy, fund, or enable purchases. A valid dry result is not live quote acceptance.

## Validation scope

Local probes cover canonical loopback archive reads, every-block bid/ask depth, integer decimal conversion, history gaps and forks, anchor reorganization, wrong network, stale evidence, stablecoin depeg, parity signatures and expiry, independent-source disagreement, cache invalidation and shutdown. They do not establish mainnet liquidity, bridge solvency, a commercial tariff, or two-computer/payout acceptance.
