# Native route qualification phase — validation

Validated on 2026-11-24 against base `bc1fca8328cdd463023c472ba3ee5ca84d9c6580` with Node 22.23.5.

## Automated evidence

All 140 tests in `update-native-qualification.PROBES` passed, with zero failures, cancellations or skips. The gate includes native request/response serialization, local HTTP streaming, signed response receipts, credit settlement and idempotency, replay tampering/account/model/key/expiry rejection, protected qualification evidence, the two-request synthetic probe, existing billing/recovery checks, and forward-only updater safeguards.

Reproduce from a clean checkout after `npm ci --include=dev --ignore-scripts --no-audit --no-fund`:

```sh
node -e 'require("node:child_process").execFileSync(process.execPath,["--test","--test-concurrency=2",...require("./deploy/koin-mainnet/update-native-qualification").PROBES],{stdio:"inherit"})'
```

The regression fixtures make no real supplier calls and execute no connected-service writes. In particular, a tampered continuation receives a non-retryable error before supplier dispatch; a failed probe makes no automatic retry and cannot silently increase its output limit.

## Release limits

Production installation and actual supplier qualification have not been performed in this implementation session. No model is newly enabled by these changes. Native admission requires both a protected, signed, current evidence record and an operator allowlist entry. Health version fields show installed transport only.

The updater accepts only the preceding native transport base. The active server release still needs confirmation; the previously reported missing dependency must be resolved in the preceding pinned checkout if that update is incomplete. Follow `deploy/koin-mainnet/NATIVE_TOOLS_PHASE2.md` for the staged rollout and bounded qualification command.

Android 0.5.2 implements the companion protocol. Physical-device persistence/restart, microphone/lifecycle behavior, and live research-to-document/email acceptance are separate gates. The managed OpenAI-compatible continuation envelope does not implement general OpenAI Responses or Anthropic signature replay.
