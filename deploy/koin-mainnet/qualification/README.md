# Fast qualification evidence preparation

`fast-candidate-v1.json` is an **unapproved measurement candidate**, not a public
admission policy. It contains twelve fixed, unambiguous instruction, arithmetic,
extraction, context and format cases with explicit accepted answers. The color
case names the traditional painting RYB model so RGB and RYB are not confused.
The candidate supplies no pass threshold, latency threshold, reward weight or
review-evidence hash. A historical 7/10 benchmark does not approve this suite.

## Local candidate measurements

Run the evaluator on the provider computer against its currently running local
inference endpoint. Use the actual current port and the installed Fast GGUF path;
an old log's port may belong to a different process now. The command needs Node
22 or newer and the repository files, but no npm packages, account, wallet key,
service login or funding. It is engineering calibration tooling, not a replacement
for the app's guided Share AI capacity flow.

```text
node scripts/evaluate-koin-qualification.js --endpoint http://127.0.0.1:PORT --model-file ABSOLUTE_GGUF_PATH --output ABSOLUTE_NEW_REPORT_PATH
```

The output's parent directory must already exist. Quote paths containing spaces.
`--runtime-model NAME` selects the local server's model name when it differs from
`koinos-fast`. Optional `--passes 1..3` repeats the fixed suite; the default is one
pass. Optional `--timeout-ms 1000..120000` bounds each inference; the default is
120,000 ms. One pass makes twelve serial requests, with no automatic retries.

Before inference, the evaluator hashes the actual model file and requires the
pinned Fast SHA-256. Requests go only to an explicitly supplied HTTP loopback IP
and port (`127.0.0.1` or `[::1]`); redirects, remote hosts and URL credentials are
rejected. Each response is capped while it is read. A transport error, timeout or
malformed answer stops the run after that attempt and records incomplete evidence.
Wrong answers remain failed cases; a length-truncated answer cannot pass.

The new mode-0600 JSON report contains the exact candidate and its file hash,
model-file hash and size, requested runtime name, outputs and their hashes,
per-case elapsed times, completion status and pass count. Existing files are never
overwritten. Standard output contains only the report location, hash and totals.
Exit status is 0 for a complete measurement, 2 for a saved incomplete measurement,
and 1 when preparation/report creation fails. A zero exit status does not mean the
model passed a public admission threshold.

Important limits:

- Hashing the GGUF on disk does **not** prove that the separate running process
  loaded that file. The report explicitly marks loaded-runtime identity unverified.
- The local OpenAI-compatible chat endpoint applies its own chat template. This
  measurement does **not** exercise the network worker's raw committed prompt,
  tokenizer comparison, managed model lease, signature or metering path.
- Runtime caching and warm-up can affect latency. Review per-call results; do not
  treat one aggregate time or the best repeat as a calibrated service promise.
- The report is unsigned, contains only this fixed suite's prompts/answers, and
  creates no provider eligibility, paid usage, rewards or service configuration.
- This small suite is not a broad capability or security certification. Select
  admission criteria only after actual measurements and a documented review.

Before enabling automatic admission, engineering still needs to review the suite
and model results, propose thresholds/weight, retain the review artifact, and run
fresh signed checks through the actual app/network path. The current runtime
`reviewedEvidenceHash` remains an operator-supplied commitment; this evaluator
does not turn an arbitrary hash into review or populate that field automatically.

## Signature binding in new qualification archives

New accepted automatic-qualification results retain all fields used by the
provider's signature: the exact deployment target, qualification-policy hash,
challenge ID, attempt ID, quote hash and output hash. They are stored alongside
the existing signature, case identifier and timing. The completed archive also
retains the target. The existing 4 MB recovery-state cap remains unchanged.

`lib/koin-network/qualification-evidence.js` exports `verifyResult(result,
{ address, policyHash, target })`. It normalizes and checks the expected deployment
and policy, reconstructs the protocol signature hash, and checks the provider
signature. Changed attempt, quote or output commitments fail verification.

This is **signature binding**, not replay of answer quality: raw outputs and full
rendered prompts are not added to persistent provider state. The server's existing
case score remains an operator assertion. The separate local candidate report
retains its fixed-suite outputs for review, but is not provider-signed evidence.

Existing records are loaded without rewriting their hashes or adding invented
fields. A result without the new material returns `state: unavailable`, including
old completed results and deadline cases with no signed answer. An in-flight old
run may finish with mixed old/new result formats; verify each result and never
describe such an archive as fully re-verifiable.

Focused validation:

```bash
node --test scripts/probe-koin-qualification-evaluation.js scripts/probe-koin-automatic-qualification.js
```

These tests use fake model bytes and local fixture inference responses. They do
not establish real Fast-model quality, current provider availability or production
acceptance.
