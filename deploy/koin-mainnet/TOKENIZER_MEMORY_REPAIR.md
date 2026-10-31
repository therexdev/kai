# Tokenizer startup memory repair

The Liquid catalog deployment exhausted the server's approximately 1 GiB V8
heap while parsing tokenizers, before HTTP port 3109 could open. systemd restarted
the failing process repeatedly and the public proxy returned HTML HTTP 502 pages.
The desktop application reported these pages as invalid JSON.

The runtime now uses one catalog-scoped tokenizer loader. The 16 approved model
aliases use 10 distinct combinations of tokenizer, configuration and template
hashes. Identical combinations share their vocabulary and merge tables. Every
installed file is still opened safely and hash checked, and each model's own
reference vectors are still checked. Model identities, catalog commitments,
prices, qualification policies and saved financial records are unchanged.

## Recovery

From a clean checkout of the reviewed repair commit, with dependencies installed,
run as root using the system Node 22+ executable:

```sh
node deploy/koin-mainnet/repair-tokenizer-memory.js
```

The repair accepts the failed/restarting Liquid release `87a7bd8` and its merge
`4b26b73`. It rejects unrelated source changes or unexpected systemd overrides.
It prepares a new immutable release directory, stops the old restart loop, then
runs the actual runtime meter against all installed tokenizer packs as the service
user with `--max-old-space-size=768`. This preflight is read-only: it does not open
account databases, signing keys or journals. Only after it passes is the systemd
unit switched to the repaired code. The service keeps its existing heap settings.

The repair checks loopback and public HTTPS health, wallet/provider capabilities,
and the exact original and extended catalog commitments. It never rewrites or
restores runtime configuration, private keys, credits, rewards, account databases
or qualification evidence. A protected backup contains the previous systemd unit.

If preflight fails, the original unit remains unchanged and the failing service
stays stopped. If health fails after starting, the forward-compatible code and all
current records remain in place for diagnosis; the old crash loop is not restored.
An exact repeat after successful installation checks health without restarting.

## Validation

Regression probes cover sharing with separate model identities, per-model vector
validation on cache hits, changed/missing/symlinked artifacts, different configs,
and separate runtime cache lifetimes. Recovery probes cover the previous ABRT
exit status, memory preflight ordering/failure, health failure, concurrent changes,
configuration preservation, source scope and idempotence.

The actual 16-model catalog includes 437 reference vectors. It was exercised with
all pinned tokenizer packs under a 768 MiB V8 heap limit, including a fresh local
runtime and HTTP health/catalog responses. These local checks do not substitute
for the installer's public health checks against the production deployment.
