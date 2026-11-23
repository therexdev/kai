# Native tool transport for Android 0.4.31

This patch targets the credits service branch `fix/rpc-adaptive-recovery`, starting at commit `cac28b9ca7b3ac3f098593607dcba896e5d63acf` (same tree as `af24b3e`). It does not target the website's default branch.

The phone owns discovery, account binding, approval, execution and memory. This service transports native function schemas and call IDs to managed inference providers. It never executes connection tools or receives a Composio credential.

## Review and deploy

1. Review and merge the accompanying credits PR into the credits service branch. Deploy that exact revision using the existing credits service rollout. Retain the current state directory, databases, signing/verifier credentials, prices and funding configuration. No data migration or new service is required.
2. Leave `KAI_NATIVE_TOOL_MODELS` unset initially. Existing text clients continue to work, and the model catalog advertises `nativeTools: 0`.
3. On the server, using the existing protected AkashML credential configuration, explicitly run a synthetic probe for each intended model. This consumes one provider inference and never executes a tool:

   ```sh
   node deploy/koin-mainnet/check-native-tools.js akash-llama33-70b --probe
   node deploy/koin-mainnet/check-native-tools.js akash-gpt-oss-120b --probe
   ```

4. Include only passing model IDs in the service environment, for example `KAI_NATIVE_TOOL_MODELS=akash-llama33-70b,akash-gpt-oss-120b`, then restart the existing service. Refresh Account on Android; the authenticated overview must report `nativeTools: 1` for the selected model. A transport error never silently replays a write or changes protocols mid-run.
5. On a test account, request researched project descriptions and source links in one document. Review the exact body and account, approve once, verify readback, and ask for the link again. Confirm one document and no extra creation action. A synthetic transport probe alone does not establish research quality or reliable document completion.

To disable new native turns, remove the allowlist and restart. Existing submitted connection actions remain in the phone's task history; check UNKNOWN outcomes in the connected service before retrying. Native checkpoints require native transport to resume, and must not be reinterpreted as legacy chat text.

## Validation

Run:

```sh
node --test scripts/probe-native-tools.js scripts/probe-managed-inference.js scripts/probe-managed-http.js scripts/probe-credit-gateway.js scripts/probe-inference-diagnostics.js scripts/probe-chat-workspace.js scripts/probe-koin-model-catalog.js scripts/probe-koin-prepaid.js scripts/probe-koin-metered-stream.js
```

48 mock-service tests passed locally. Coverage includes streamed and nonstreamed native replies, schema forwarding, signed receipts, conservative reservation including schemas, capability rejection before paid inference, call/result pairing, idempotent recovery, changed-schema rejection, and existing billing/diagnostic behavior. No live provider or production deployment has been performed for this patch.

Native definitions are committed in an internal `kai_tools` message extension so the existing quote, idempotency hash, encrypted payload and usage receipt cover the entire request. The managed provider removes that extension and sends real OpenAI-compatible `tools` fields upstream. Native output is signed as a versioned structured envelope; only the gateway decodes it into API `tool_calls`. Community-worker text templates remain unchanged and cannot admit native requests.
