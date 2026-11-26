# Native tools: qualify and activate multiple models

This extends the existing GPT-OSS-only activation helper to any explicit subset of the six managed routes. It does not change the installed inference code, replay protocol, pricing or accounting journals. Qualification runs the existing installed two-request synthetic tool/replay probe separately for each selected model. It never connects to Gmail, Docs, Sheets or another user tool.

## Run on the existing scheduler host

Use the complete source checkout containing this update, outside the installed release. Both helpers select the installed `WorkingDirectory` from these reviewed releases:

- `/opt/kai-koin-prepaid/releases/65c1d21b85705cd26acc63bd1eedaf5af4ef6400` — native qualification/replay protocol 2.
- `/opt/kai-koin-prepaid/releases/a7cf99f42cc853255d295cba19ccb609cd884ba6` — the same native implementation plus the $1,000 credit purchase limit.

The native adapter, qualification contract, probe, model policy and drain implementation were compared between these revisions and are unchanged. Qualification executes the selected release's probe; activation reads its qualification module, validates its unit without changing the release path, and uses its deployment locks and health checks. On the purchase-limit release, health must still confirm the $1,000 limit. No code updater or rollback is needed.

Unknown releases, changed service identities or a different release appearing during the operation stop for review. Qualification rechecks the selected identity before each model. Keep the existing protected key-file configuration; do not edit the allowlisted release paths to bypass a stop.

As root, from this checkout:

```sh
/usr/bin/node deploy/koin-mainnet/qualify-native-models.js --models all --max-output 2048
```

This allows at most 12 supplier requests, each capped at 2,048 output tokens (up to 24,576 output tokens plus input charges). Each model receives one probe; failed routes are not automatically retried at a larger budget. The installed probe removes old evidence for a route before requalification and writes new signed evidence only after success. Qualification expires after seven days. A probe is transport conformance, not evidence that the model reliably completes full document/email workflows.

The last JSON row lists `passed` and `failed`. Activate an explicit comma-separated list copied from `passed`:

```sh
/usr/bin/node deploy/koin-mainnet/activate-qualified-native.js --enable-models '<passing model IDs>'
```

Existing allowlisted models are preserved and also rechecked. If an existing route no longer qualifies, activation stops for review. Do not bypass qualification, edit accounting journals, rerun the code updater, or force-kill the service. Activation backs up the exact private configuration, changes only managed native settings, waits for a normal exit when required, starts the same installed release and checks loaded configuration and health. Rerunning resumes an interrupted clean transition without another supplier probe.

The legacy `--enable-gpt-oss` flag still works. Unknown IDs, duplicate IDs, duplicate config keys, unexpected key sources, changed service identity, invalid/expired evidence, concurrent edits and unclean process exits fail closed.

## Validation and remaining checks

21 operator-helper tests and 12 native transport/qualification tests pass on Node 22.23.2, matching the operator's runtime. Coverage includes both reviewed releases, purchase-limit health/locks, selected-release probe paths, mid-operation release changes, mixed successful/failed qualification, all six routes, preservation of existing settings, expired evidence, concurrency and clean restart. Supplier calls and systemd operations are mocked. These suites run in the Node 22/24 CI matrix. No live supplier qualification or production activation was performed from the development workspace.

After activation, refresh the Android model list. Check each passing model using a synthetic research → document → email → sheet → edit chat, reviewing exact write cards and checking the returned service objects. Include an interrupted/resumed attempt. Retain a new all-chat report; transport success alone does not establish task quality or delivery.
