# Native tool qualification and private continuation — Android 0.5.2

This phase adds protocol 2 for the managed AkashML route. The phone still owns discovery, exact approvals and execution. The service never executes a connector tool. Text/legacy JSON requests continue unchanged.

## Deployment order

1. Confirm the active release with `systemctl show kai-koin-prepaid.service -p WorkingDirectory --value`.
2. This updater requires the prior native transport release `bc1fca8328cdd463023c472ba3ee5ca84d9c6580`. If the server is still on `cac28b9ca7b3ac3f098593607dcba896e5d63acf`, finish the prior update from its clean pinned checkout first. The previous missing `koilib` error is resolved by installing that checkout's locked dependencies with `npm ci --include=dev --ignore-scripts --no-audit --no-fund`, before `/usr/bin/node deploy/koin-mainnet/update-native-tools.js`. Do not run the old updater from this new revision.
3. In a clean checkout of the reviewed phase-two revision, run `npm ci --include=dev --ignore-scripts --no-audit --no-fund`, then `/usr/bin/node deploy/koin-mainnet/update-native-qualification.js` with system Node 22+ as root. The updater rejects other source/base states before downtime, runs regression probes, drains and snapshots the stopped service, and retains financial data/configuration. It neither restores old financial data nor enables models.
4. Confirm `/health` contains `nativeToolTransportVersion: 2` and `nativeQualificationVersion: 2`. These mean transport is installed, not that any model is qualified.
5. Install Android 0.5.2. Older clients that try native requests without `native_protocol: 2` receive an explicit update error; ordinary text requests still work. Refresh Account after enabling a qualified route.

## Operator qualification (explicit supplier spend)

Use the existing protected supplier credential source. Never paste keys into commands, logs, APKs or this repository. Configure an absolute `KAI_NATIVE_QUALIFICATION_FILE` in a private directory readable by the service, for example `/etc/kai-koin-prepaid/native-qualification.json`. The JSON file must be a regular unlinked file with mode 0600 and owned/readable by the service identity. Run the probe under that identity with the existing protected environment. The directory must permit creating/renaming that file.

For each intended model, explicitly run:

```sh
/usr/bin/node deploy/koin-mainnet/check-native-tools.js akash-gpt-oss-120b --probe --max-output 4096
```

This makes at most **two** supplier inference calls with up to 4,096 output tokens each. Input limits use the same conservative quote calculation as production. It does not spend a customer account's KAI credit balance, but supplier API usage is billable. There is no automatic retry or token increase. The synthetic tool is a local nonce fixture; no email, document, spreadsheet, network tool or customer prompt is used.

Qualification requires exactly one schema-valid call, a matching tool result, a final answer containing a nonce known only through that result, consistent bounded usage for both turns, and replay of any supported private continuation field through the production native serializer. Evidence contains usage and contract identifiers, never raw reasoning or credentials. A failed requalification removes the previous evidence for that model. A lock prevents concurrent qualification writers; investigate an abandoned lock before removing it.

After reviewing successful evidence, include only those model IDs in `KAI_NATIVE_TOOL_MODELS` in the protected service environment, and restart normally. An allowlist alone no longer enables anything. Evidence expires after seven days, and changes to the adapter code, supplier credential, model/rate policy or signed record disable it. Requalification is an explicit billable action, not a background job. Removing the allowlist entry or evidence revokes native admission immediately.

The probe exercises the actual supplier endpoint with native request/reply and usage contracts. The regression suite exercises local gateway streaming, signed receipts, credit settlement, idempotency and replay rejection with fake supplier responses. These are distinct evidence: a successful supplier probe is not a physical-phone or live Sheets/email acceptance test. Record a real phone research-to-document/readback scenario separately before declaring production readiness.

## Continuation and privacy contract

Supported string `reasoning_content`/`reasoning` fields accompanying a tool call are sealed with AES-256-GCM. The key is purpose-derived from the configured supplier credential; associated data binds the deployment domain, credit owner, upstream model and exact assistant content/call IDs/arguments. Tampering, rotation, wrong scope and expiry fail before the next supplier POST. Envelopes expire after 30 days; they never authorize a tool action. Unsupported provider-private structures fail qualification instead of being silently dropped.

The opaque `kai_replay` envelope participates in the existing quote/idempotency commitment and signed response hash. The gateway strips it before dispatch and restores only authenticated provider fields. No plaintext reasoning appears in the external completion. Android stores it in SQLCipher, associates it with its local account/model route, preserves it through approval and saved-task resumes, and omits it from reports, exports, summaries and context retrieval. Switching route discards reusable provider wire; actual effect receipts remain.

## Remaining gates

Production installation, operator qualification, physical Android persistence/audio/lifecycle, and actual connected-service writes require recorded results. No general OpenAI Responses/Anthropic signature replay contract is implemented by this managed OpenAI-compatible transport. The wider budget, source assurance, voice and product roadmap remains separate.
