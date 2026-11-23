# Managed AkashML network inference

Owner authorization: six hosted text models use ordinary KAI network model
selection and the existing daily-free and purchased USD-credit balances. Price
is supplier cost plus 25%, except Qwen 3.6 35B A3B and Kimi K3.1 Pro at 15%.

| Model | Input USD / 1M | Output USD / 1M |
| --- | ---: | ---: |
| GPT OSS 120B | 0.04625 | 0.23375 |
| Llama 3.3 70B | 0.25 | 0.65 |
| Qwen 3.8 27B | 0.28125 | 2.475 |
| GLM 5.3 | 0.2375 | 5.5 |
| Qwen 3.6 35B A3B | 0.115 | 1.035 |
| Kimi K3.1 Pro | 2.0125 | 11.5 |

These maxima are pinned in `lib/koin-network/managed-models.json`. Supplier
pricing is read from the authenticated `/v1/models` API. A model with missing,
unknown, increased prices or a per-request fee is unavailable. Lower rates,
cached-input rates and supported promotional discounts get the same markup.
Use live account rates to verify these pins before activation; public pages
alone do not establish the actual billed rate. All monetary math uses integers
and one final USD-atom ceiling. 1,000 KAI credits = $1.

## Billing and rewards

The API key stays on the backend. Never commit it, put it in desktop builds,
save it in a plugin, or include it in logs. Existing native provider identities,
model pins, tariffs, credit purchases, signing journals and reward histories
remain unchanged. Updated desktop clients negotiate the managed catalog with a
separate pinned header; older clients keep their existing native catalog.

The service reserves a conservative input estimate and the requested completion
budget using the existing atomic free/paid holds and run/API limits. This is a
maximum reservation, not the billed input count. Only upstream-reported input,
cached input and total completion tokens (including reasoning) are charged.
Usage over the reservation, missing usage, cancellation and rejected responses
produce no customer charge. Upstream POSTs are never automatically retried.
Completed replies and exact billing receipts are signed by the deployment's
existing verifier, encrypted in the existing ledger and recoverable by request
ID. Streaming clients currently receive keepalives followed by the verified
complete response; no unmetered text is released before final usage arrives.
Existing text-only input restrictions still apply; this release does not add
image inputs or tool-call schema support.

Each hosted job is tagged `managed.provider=akashml`, `rewardsEligible=false`
and settles locally as `not_required/managed-inference`. Purchased USD credits
are nonrefundable service entitlements: the local ledger remains authoritative
for these debits. No `settle_usage`/`settle_credit_usage`, sponsored KOIN usage,
work points, availability points, reward certificate or provider KOIN payout is
created for managed requests. Receipt and supplier inference references remain in
the encrypted billing database for reconciliation. Managed jobs are never
offered to community workers; the six models do not become desktop Earn models.

## Availability

The API catalog is refreshed every 30 seconds and expires after 60 seconds.
Missing keys, revoked keys, exhausted supplier credit, increased prices, stale
observations and supplier errors remove availability. Listed catalog capacity
is an observation, not an uptime guarantee; run the inference probe below before
activation. Once at least one model is available, public and authenticated
network views count exactly one additional logical provider across its ready
models. It is not inserted into signed worker presence or the community payout
roster. Daily free budgets, origin/account caps and concurrency limits remain
shared with normal network use; there is no new free-credit faucet.
An upstream 401/402/403 suspends the managed provider until the service is
restarted after correcting the key, permissions or supplier credit balance.
Catalog listing alone must not repeatedly readvertise an exhausted account.

## Activation on the existing service

1. Review both backend and `therexdev/kai-core` changes. Ship the matching Core
   build after native release verification. No change is live merely because
   the source or a PR exists.
2. On the existing server, inspect the service's current source revision and
   configuration paths. The supplied forward-only updater is pinned to backend
   base `438b1359d39576bf27325810022058424bbd6e3f` and the existing
   `kai-koin-prepaid.service` deployment. If the actual service uses another
   base, unit or paths, adapt and review that boundary first. Never point the
   original installer at an existing ledger.
3. Install this clean reviewed backend commit using system Node 22+:

   ```sh
   sudo node deploy/koin-mainnet/update-managed-inference.js
   ```

   This reuses the existing clean drain, consistent stopped-service snapshot,
   writer-lease checks and resumable code-update plan. It does not replace
   configuration, restore old data, or enable a secret automatically.
4. Put the AkashML API key in a regular protected file readable only by the
   service account, for example `/etc/kai-koin-prepaid/akashml-api-key`, mode
   `0600`, owned by `kai-koin-prepaid`. Enter its value through the server's
   secret workflow; do not pass the value on a command line or in chat.
5. Add only the path to the existing protected service environment:

   ```text
   KAI_AKASHML_API_KEY_FILE=/etc/kai-koin-prepaid/akashml-api-key
   ```

   Never overwrite the existing environment, credentials or runtime.json.
   `KAI_AKASHML_API_KEY` is also supported for a protected environment manager;
   configuring both sources is rejected.
6. With that environment available, run the read-only supplier catalog check:

   ```sh
   node deploy/koin-mainnet/check-akashml.js
   ```

   Then run `node deploy/koin-mainnet/check-akashml.js --inference` to make six
   small real supplier requests. This spends Akash credits, reports only token
   counts/pass states, and creates no KAI customer or KOIN reward entries.
7. Drain and restart the service through its normal maintenance procedure.
   `/health` must report `managedInferenceVersion:1` and
   `managedProvider.configured:true`; availability is published only after the
   authenticated catalog validates. Check every model with both daily-free
   and purchased credits through the real KAI account. Confirm provider totals
   rise by one, balances debit once, retries recover the same request and no
   managed entry enters settlement, sponsorship or rewards.

## Verification

```sh
node --test scripts/probe-managed-inference.js scripts/probe-managed-http.js
```

The accompanying workflow runs the existing credit, API, model catalog,
streaming and deployment recovery regressions on Node 22 and 24. Mock supplier
tests verify routing and billing; they do not prove a real API key, account
balance, live GPU, production payment or device release.
