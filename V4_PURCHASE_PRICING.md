# Revision 2 purchase-price validation

This is a read-only quote source, not a contract deployment or permission to spend funds. No runtime pricing configuration has been installed and no live quote is claimed. Missing, invalid or stale evidence pauses new purchases without disabling consumption of existing credits.

The approved Ethereum v4 pool and token ordering are pinned in `purchase-price.js`. `v4-history-reader.js` reads every canonical block in the configured averaging window through archive JSON-RPC, including `StateView.getSlot0` and actual two-direction v4 Quoter simulations. Calls use EIP-1898 block hashes with `requireCanonical: true`; the finalized anchor is rechecked by number. There is no v3 `observe()` call and no dashboard spot-price fallback. Addresses and interfaces were checked against the [official deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments), [StateView interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IStateView.sol), and [v4 Quoter interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol).

`v4-price-validation.js` calculates an arithmetic time-weighted price in integer fixed-point units. It requires a full contiguous parent-linked history, bounds every block's deviation from the average, and checks active liquidity plus executable buy and sell depth throughout the window, including the actual 1% fee. USDT/USD is read from an explicitly configured Chainlink-compatible feed at the same canonical anchor; incomplete, negative, stale or depegged rounds fail validation.

`v4-purchase-oracle.js` requires two reviewed HTTPS archive hosts whose complete observations agree. Warm-up runs independently of settlement and existing-credit use. Every read rechecks the canonical anchor and the selected reference rule (including fresh signed parity evidence in schema 1). A failed refresh clears the quote cache. Quote expiry cannot outlive the earliest underlying evidence, and the signed purchase quote uses that remaining lifetime.

Both schemas return a conservative `maxPurchaseKoinAtoms` calculated from the configured minimum executable USDT probe and the highest unrounded pool price in the window/reference ratio, so it fits every checked block. The quote price remains the time-weighted average. The runtime checks the native purchase amount against the depth bound **before signing**. `maxPurchaseUsdAtoms` is the credited USD value of that native ceiling at the final integer quote rate. Upward native-atom rounding cannot exceed the checked depth. This is a raw notional ceiling, not an advertised USD pack size: choose a probe larger than the supported packs to leave rounding/depeg headroom. It is not an aggregate sales limit.

## Configuration and trust decisions

The optional backend runtime schema-1 `purchasePricing` object has exactly these fields:

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

### Explicit merchant exchange reference (schema 2)

This separately selected commercial convention prices each native KOIN at one vKOIN's validated market value. It does not assert that vKOIN is redeemable for native KOIN, backed by reserves, or worth the same in another market. The merchant accepts that divergence risk. No bridge transaction is part of the native-KOIN credit purchase.

The exact configuration fields are `schema: 2`, `rpcUrls`, `usdtFeed`, `policy`, and `reference`. The market policy has all schema-1 fields except `maxParityAgeMs`, `maxParityDeviationBps` and `paritySource`. Market identity, finality, full-window history, two-source agreement, bid/ask depth, USDT conversion and expiry checks are retained. No parity signer, file, signature or synthetic evidence is accepted in this mode.

The exact `reference` fields are:

```json
{
  "kind": "merchant-exchange-reference",
  "nativeChainId": "<exact canonical native chain ID>",
  "nativeToken": "<exact native KOIN contract address>",
  "wrappedChainId": 1,
  "wrappedToken": "0xa50ad3a559A10f384a5bB2e27516f63E0B937b1A",
  "wrappedPerNativeAtoms": "100000000"
}
```

The native identity must match the deployment. `referenceHash()` domain-separates a deterministic commitment to that convention, the exact policy and market pins. Diagnostic quote provenance labels it `merchant:vkoin-exchange-reference` and `redemptionVerified: false`. It is a policy commitment, never a bridge evidence hash.

The [review proposal](deploy/koin-mainnet/pricing.merchant-reference.proposal.json) is explicitly unapproved and is not a deployable runtime. Existing schema-1 configurations remain schema 1; an unavailable attestation never selects schema 2. There is no default activation. The installer preserves schema-2 configuration bytes and validates native identity without creating an attestation file. Existing credit use remains independent of both modes.

The diagnostic provenance is not all included in the existing signed purchase ABI. The signed quote still binds the actual amount/rate/account/deployment/runtime-version/expiry; its version is `runtime.version`, not the independently selected `purchasePricing.policy.version`. A durable source-evidence record linked to each issued quote and customer Price details are separate remaining work.

## Read-only live capability preflight

`node scripts/preflight-koin-purchase-pricing.js /absolute/private/proposal-or-runtime.json`

This separate command makes read-only Ethereum RPC calls through the **same `V4HistoryReader` used by runtime**. It does not sign, submit transactions, access wallet keys, install configuration, grant credits or activate purchases. Supply real reviewed endpoints through a private file; the example and fixture addresses in tests are not live services.

The input can be an existing runtime document or a proposal containing `purchasePricing` with the exact fields above. `parityFile` and `paritySigner` may be omitted for capability diagnostics. If provided, also include `deployment.chainId` and `deployment.token` to bind the signed envelope to the intended native deployment. Other runtime fields are ignored: this is **not** a full deployment validator. The proposed `policy` remains mandatory, without guessed defaults, and is never changed by the tool.

The input must be an absolute regular JSON file, no symlink, at most 64 KiB, owned by the invoking operator with no group/world access on Unix. Store endpoint credentials there, never in CLI arguments. The optional signed parity envelope is a bounded regular file (8 KiB maximum); its installed root/service read permissions are accepted because it contains no signing key. Windows does not expose Unix owner/mode checks; protect the input with an operator-only filesystem ACL.

The bounded JSON report is written to stdout; the tool creates no files. Save it with an operator-private output redirect if needed. Output uses provider numbers in input order and never includes endpoint URLs, raw remote errors, credentials, source labels or local input paths. `policyHash`, `marketSourcesHash`, `sourceCodeHash` and `toolCodeHash` are SHA-256 commitments to recursively key-sorted JSON (or the identified source bytes). The source commitment covers the exact endpoint strings, feed and pinned market/contracts without printing those strings. Per-observation hashes commit to the actual history and USDT observations. No full block history is emitted or persisted by this command.

For each provider the report records:

- Mainnet connectivity, finalized-anchor read, complete history/depth reads, USDT round and final canonical recheck, with stage durations.
- The measured finalized-anchor age **before** history validation. A proposed age limit that cannot accommodate real finalized-chain lag therefore produces a useful measurement, not a fabricated fresh quote.
- Successful history summaries: block count/window, maximum block gap, minimum observed active liquidity, depth probe size, maximum price deviation and both-direction fee-adjusted depth deviations. Basis-point measurements round up conservatively.
- Successful USDT round age, price in 1e8 USD units, deviation and freshness comparisons.

These comparisons distinguish readable data from data inside the proposed bounds. Both providers must return the same complete history and stablecoin observations for `marketEvidence.state: matching`. Independent hosts do not themselves prove independent operators. Repeated measurements are needed to select and review operating thresholds; a single passing sample does not approve a commercial policy or establish long-term availability.

In schema 1, missing or invalid parity leaves `state: incomplete`, even if the market reads succeed. A supplied envelope is checked using the existing signature/freshness verifier; the report still states `underlyingEvidenceVerified: false`, `redemptionVerified: false` and `publisherVerified: false`. **The repository does not yet supply the Vortex evidence collector or recurring attestation publisher.** A signature verifies the configured attestor's assertion, not bridge backing or redemption liveness. A valid signature must not be described as completion of that missing work.

Matching archives plus either the selected schema-1 parity envelope or explicit schema-2 reference reach the corresponding runtime validator. Schema 2 additionally requires `deployment.chainId` and `deployment.token`; the report states `commercialPolicyApproved: false` and `bridgeRedemptionVerified: false`. A pass produces `state: observations-valid` and an **unsigned diagnostic** quote with its expiry, size ceiling and hash; `purchasesEnabled` and `usableForPurchase` remain false. Exit status is 0 for this complete diagnostic observation and 1 for missing, rejected or unavailable evidence. The invocation is bounded to 70 seconds overall (each RPC at most 8 seconds; existing history collection at most 60 seconds), with no automatic retries or spot fallback.

Missing configuration produces an actionable `input-required` JSON report without network access. Invalid or unreadable secret-bearing files and remote failures use fixed error codes rather than echoing their contents.

## Validation scope

Local probes cover canonical loopback archive reads, every-block bid/ask depth, integer decimal conversion, history gaps and forks, anchor reorganization, wrong network, stale evidence, stablecoin depeg, parity signatures and expiry, independent-source disagreement, cache invalidation and shutdown. They do not establish mainnet liquidity, bridge solvency, a commercial tariff, or two-computer/payout acceptance.
