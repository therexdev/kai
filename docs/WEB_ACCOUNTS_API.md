# Website accounts and network API

This adds a hosted consumer dashboard and OpenAI-compatible text Chat Completions gateway to the existing USD prepaid service. Users sign in with its existing email/Google/passkey account service, receive the existing daily sponsored allowance, link a wallet with Kondor for purchases, and create scoped API keys. No running desktop or customer-hosted relay is needed.

## Source and rollout

Prepared on `fix/rpc-adaptive-recovery` at `9c0776e55c4512149e015695bc7f2e8e35b8f753`, including the deployed adaptive RPC, claim recovery, stream keepalive and SQLite reward fixes. The website runs a separate production branch. Never replace that website with this scheduler branch or downgrade the current live scheduler to an older mainnet-pilot commit. Reconcile any newer production fixes before rollout.

The feature is opt-in: `KAI_WEB_API_ENABLED=1` in the existing prepaid service environment. It requires `accountMode: public`, `prepaid-usd-v1`, the current account database, configured email/Google authentication, and the existing free policy/sponsorship. Preserve the existing state/config directories, encryption keys, recovery anchors, payment journals and reward data. This change does not migrate accounts or transfer balances between the legacy website and the credit service, alter the allowance/prices, fund sponsorship, deploy contracts, or sign customer transfers.

The updater takes a private tar snapshot of the complete state directory after verifying the service has stopped cleanly, including SQLite sidecars and recovery anchors. It never restores that snapshot automatically. With `--enable`, it also backs up the account environment privately and sets only `KAI_WEB_API_ENABLED=1`, preserving all other entries, ownership and permissions. Two small account tables, one ledger JSON field and its index are additive. The environment switch can disable the public API/portal without revoking or rewriting existing credit records. Revoked API keys remain revoked when re-enabled. Unfinished work follows the existing restart recovery behavior.

1. Run the tests below with Node 22 (the repository runtime), and review this exact backend revision.
2. From a clean checkout of this exact branch with dependencies installed (`npm ci --include=dev --ignore-scripts`), run `sudo /usr/bin/node deploy/koin-mainnet/update-web-api.js --enable`. It accepts only the reviewed source diff over the installed adaptive RPC release, runs its own regression suite, stages code, drains the active writer, preserves all journals, and verifies readiness before completing. It resumes the same plan after interruption; it never restores old payment data. Do not install a fresh service or create another account database.
3. Confirm `/auth/methods` reports the intended available signup methods, then open `https://credits.koinosai.com/platform`. Unauthenticated visitors go to `/account?next=/platform`.
4. Test a fresh verified account and the existing account: daily balance, supported model request, one key, streaming, revocation, and usage reconciliation. Verify `/health` reports `webApiVersion: 1` while `rpcReliabilityVersion: 1` and all existing reward/storage readiness checks remain healthy. Check that the same linked wallet in Core shows the same purchased balance. Conduct one explicitly budgeted live payment and inference smoke test before public launch.
5. Merge the separate website entry change only after this portal works. `/platform` on koinosai.com redirects to the credit service without forwarding cookies or query strings. `api.koinosai.com` remains the blockchain RPC; the inference base is `https://credits.koinosai.com/v1`.

This branch has isolated tests, not a claim of deployment or real-wallet validation. A functioning mail/OAuth configuration, a live independent provider, a real Kondor signing smoke test, and production activation cannot be demonstrated by fixture tests. Existing origin and network free-credit ceilings may need an explicitly funded capacity decision as web traffic grows. All visitors behind the current proxy share its conservative origin budget; this patch does not trust client-supplied forwarded IPs.

Browser visual QA is outstanding: the shared managed preview was already occupied, and this task did not replace it. DOM integration checks exercise the real local account gateway for balances and API-key actions. The Node 22 account/API regression set passed 41 tests. The rollout recovery suite also covers opt-in environment preservation and stopped-service snapshots. An older deployment probe now injects its fixture at the native transport boundary, with scheduling covered separately by the RPC suites. Public endpoints remain disabled until activation.

## Behavior and boundaries

- Account management is session-authenticated. API keys are random 256-bit secrets, shown once, stored only as SHA-256 hashes, scoped to named permissions and a specific wallet or walletless allowance, and expire in 1–365 days. The default lifetime is 90 days. Creation needs an explicit positive daily credit ceiling; no unlimited key default.
- Keys are never accepted as general account sessions or raw scheduler credentials. A private in-process symbol supplies a resolver to the existing prepaid router. Account existence, wallet ownership, key expiry, revocation, and scope are rechecked during work. Headers/JSON cannot supply that resolver.
- One verified account retains one existing daily grant across web, API keys and linked wallets. Keys cannot mint grants, combine wallet balances, sign KOIN transfers, or manage other keys. `billing:purchase` prepares unsigned transactions and verifies finalized purchases only.
- Key usage ceilings are enforced in the same durable transaction as the existing free/paid reservation. Limits cover total inference usage (free plus paid), outstanding holds and still-running older-day requests. Completed admissions count on their UTC admission day. An account-wide durable minute bucket prevents creating keys to multiply the gateway rate allowance.
- The adapter preserves existing metering, provider signature verification, ownership exclusion, settlement and encrypted-response recovery. OpenAI responses contain standard text-completion fields and a small `kai` cost extension; they do not disclose internal signatures/receipts. Streaming translates cumulative verified prefixes to deltas and opts into existing keepalive comments.
- Idempotency IDs are scoped to the verified account, API key, wallet and caller key. Completed requests replay under the original reservation, subject to the existing answer retention. A changed body is rejected. Retry after cancellation is not automatic.
- Supported: model listing, text Chat Completions, streaming, balances, usage, quoted KOIN purchases, payment confirmation. Unsupported parameters are rejected explicitly. This does not provide Responses API, tools/functions, images/audio, embeddings, external web search, card payments, or automated replenishment.
- The portal defaults to free-only. Enabling paid use spends the selected wallet's existing balance after free allowance. A sign-in with multiple wallets starts with walletless free use until a wallet is selected. Website legacy identities are not silently merged by email with the prepaid database.

## Validation

```sh
node --test scripts/probe-credit-gateway.js scripts/probe-credit-platform-dom.js scripts/probe-credit-account-web.js scripts/probe-koin-prepaid.js scripts/probe-koin-free-credits.js scripts/probe-koin-public-stream.js scripts/probe-koin-credit-stream.js scripts/probe-wallet-credit-router.js scripts/probe-koin-device-free-router.js scripts/probe-purchase-quotes-http.js
```

`scripts/helpers/credit-gateway-fixture.js` creates temporary identities, mail, signed fixture-provider responses, a deterministic quote signer and injected chain confirmation evidence. It never contacts an RPC or spends real funds. Tests exercise the mounted HTTP paths and existing prepaid ledger, not a separate fake billing implementation. No production credentials are needed. The repository CI also runs every `scripts/probe-*.js`.

The public endpoint and SDK examples are at `/platform/docs`.
