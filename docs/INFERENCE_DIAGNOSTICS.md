# Managed inference error tracking

This release records the failure that was previously replaced with a generic
"No answer was delivered" error. It does not change prompts, context/output
limits, tool selection, approvals, retries, charging or provider eligibility.

## What reaches the Android Report

The existing `model_api_error` report event receives the structured JSON error
from the credit API, including failures inside an HTTP 200 SSE stream:

- `code`: stable `managed_` failure category; `source`: `managed_provider`.
- `request_id`: the KAI request ID, also returned in `x-request-id`.
- `diagnostics`: schema version, failing stage, time and elapsed milliseconds,
  upstream HTTP status, bounded HTTP-error category, message count, request and
  response bytes, reserved input, requested output and allowed context tokens.
- When a JSON response is available: finish reason, content type/length,
  reasoning length, tool-call count and reported input/output/cached/reasoning
  token counts. Invalid or absent numeric values are omitted, not guessed.
- A SHA-256 hash of the upstream request ID permits correlation without exporting
  arbitrary text from a supplier-controlled header. It is not the raw provider ID.

Categories distinguish upstream HTTP rejection, transport, timeout, cancellation,
invalid JSON/response, empty text, unsupported finish reason, unexpected tool
calls, missing/inconsistent/out-of-range usage, dispatch and receipt failures.
A bounded inspection of an HTTP rejection classifies common context, parameter,
chat-template, authentication, quota, rate-limit and filtering errors. `unknown`
means the classifier did not recognize it; the status and stage remain available.
These are observations, not proof that a specific model or component is at fault.

Raw provider bodies, exception messages, prompts, answer/reasoning text, headers,
API keys and credentials are not added to diagnostics. HTTP classification reads
at most 8 KiB for 250 ms. Only explicitly allowed enums, bounded counts and hashed
IDs cross the storage/export boundary. The existing Android report still contains
the conversation and other user-approved chat diagnostic events.

## Persistence and behavior

The first safe failure is attached atomically to the existing managed job record;
cleanup cannot overwrite it. It survives restart and request recovery. The same
request ID still starts at most one upstream generation. Failed undelivered jobs
release their holds using the existing ledger logic; diagnostics cannot modify
ready/charged or delivered jobs. Account ownership checks remain in place.

Non-stream failures return a structured 502 (504 for timeout). A stream already
opened with HTTP 200 carries that status in its JSON error event. Native-provider
and authentication/admission errors retain their existing handling. A process
crash or client disconnect may prevent delivery of an error event; this release
is not a complete server telemetry or crash-reporting system. It cannot reconstruct
provider details discarded by older releases.

## Deployment and retest

`deploy/koin-mainnet/update-inference-diagnostics.js` requires the verified active
workspace release `624506571fece651f33a2ce00b9f136859eebcf6`. Run the new updater from
a clean checkout of this release, with system Node 22+ as root and dependencies
installed with `npm ci --include=dev --ignore-scripts`.

It reuses the existing guarded updater: reviewed file allowlist, tests before
stopping, graceful drain, private stopped-service snapshot, unchanged SQLite
storage and financial journals, and post-activation health verification. Unknown
active releases stop before touching the service. No runtime configuration or
upstream credential changes are required.

This supersedes the original diagnostics release `2bd731d3c216da74cefaf2b063684183a7a2eb64`,
which was based on the older Android-account release. The workspace rollout did
not include that diagnostics change. Both histories are now retained, and the
updater additionally verifies workspace, SSO, device-link and wallet-link
capabilities and shares the workspace deployment lock. Do not run the older
updater over the newer workspace release or bypass its installed-base guard.

After activation, `/health` must include `inferenceDiagnosticsVersion: 1` and
`nativeAccountVersion: 1`. Android 0.4.27 already exports structured server errors;
no new APK is required for these fields. Run a fresh chat test and export Report.
Pair the failing `model_api_error` with its `x-request-id`, preceding request and
action receipt. Successful external actions must not be repeated just because a
later model follow-up failed.

## Validation

`node --test scripts/probe-inference-diagnostics.js` covers synthetic provider
failures, persistent first-cause retention, secret exclusion, unchanged upstream
request bodies, provider availability, billing and duplicate prevention, plus
real authenticated HTTP/SSE transport through the production gateway. Existing
managed-provider, account, gateway, Vault and guarded-deployment probes run with
it through `update-inference-diagnostics.PROBES`. No live customer request or
provider credential is used by these tests.

Compatibility was also checked against the unchanged Android 0.4.27 client in a
JVM MockWebServer test: both an HTTP 502 JSON error and an HTTP 200 SSE error
retained the structured category, stage, usage counts, finish reason and server
request ID through the existing report/redaction pipeline, with no automatic
retry. This is client compatibility testing, not a live phone/provider test.
