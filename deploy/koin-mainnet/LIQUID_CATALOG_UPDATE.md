# Liquid LFM3 1.7B additive network catalog

This updater is for `kai-koin-prepaid.service` running release `daf2dc4cb19c84412f00d8552b348ebb4a8e0bd8` from `/opt/kai-koin-prepaid/releases`, with the established systemd unit, configuration and state paths. It does not deploy the Hostinger website or any on-chain contract.

Review hash: `9417b1e84ce414f26c32efd9f734fbdff8b84901dbb8bb998930a56914520267`.

Base account/provider policy: `9a4d812014a210d0d9fa083c479c0c0d82341ece2bde33b596ea8bb3826b9089`.

Extended catalog policy: `a5fb8224fa391c538270f68fcc4d682fce0741a2cb90fd0885041bbc80def0de`.

## Installation

Use a clean checkout of the exact reviewed commit linked in the release instructions, containing the installed base in its Git history. With system Node 22+ as root, from that checkout:

```sh
npm ci --ignore-scripts
node deploy/koin-mainnet/update-liquid-catalog.js --approve 9417b1e84ce414f26c32efd9f734fbdff8b84901dbb8bb998930a56914520267
systemctl is-active kai-koin-prepaid.service
```

The updater verifies source scope, the installed release, unit restrictions and exact old configuration. It downloads only the pinned 16 MB GGUF metadata prefix, derives the tokenizer, checks its hashes and all ten native reference vectors, and runs regression probes before stopping the old service. Tokenizer files use the existing service configuration group. It stages a new immutable code release, backs up the private unit/configuration and a stopped consistent state snapshot, adds the catalog extension, and restarts. Loopback and public HTTPS health, device/account targets, all sixteen readiness policy summaries and the exact extended tariff hash must verify. An exact repeat checks health without restarting.

Only `catalogExtension` and the addition of Liquid to an existing `freePolicy.eligibleModels` list change in runtime configuration. The original fifteen tariffs, account/provider policy, price oracle, grants/budgets, wallet keys, account databases, payment history, pending settlements and signed qualification evidence stay in place. No record is reset or re-signed.

## Client compatibility and availability

Core Beta 0.7.13 requests the extended catalog with `x-kai-catalog-policy`. Older apps receive the original fifteen-model schema and hash without that header. New Core also accepts an older scheduler's original catalog. Existing model quotes keep their original commitment. Only Liquid jobs bind to the extended commitment, while their device certificates remain bound to the established provider/account deployment. Unknown commitments and attempts to change an existing tariff are rejected.

Liquid uses the official `lfm3-1.7b` Q4_K_M package, the upstream non-thinking template and 10 input / 40 output credits per million tokens, with 4,096 context and 256 maximum output tokens. Each provider must select/share the model and complete fresh signed randomized readiness checks. Approval never invents an online provider. A customer's own provider remains excluded from network chat.

## Recovery

Before the new service is started, a failed transition restores only the prior code/unit/configuration. It never restores financial databases. Once starting the new code has been attempted, automatic rollback is deliberately disabled: new accepted Liquid jobs may already refer to the new commitment. In that case the updater reports its private backup path and retains the new code and catalog for recovery. Inspect `systemctl status kai-koin-prepaid.service` and the journal, repair the reported startup/reachability issue, and repeat the exact updater after the service is active. Do not replace current databases with the snapshot or rerun a bootstrap installer.

Local native model evidence is in `candidates/liquid-lfm3-1.7b.observation.json`. Core's wallet-first integration exercises signed readiness, real HTTP and the real Worker with controlled inference and chain fixtures; it is not a live payment or performance measurement.
