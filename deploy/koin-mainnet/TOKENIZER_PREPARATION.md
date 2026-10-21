# Model tokenizer preparation

The approved price catalog contains 15 public model aliases. A price entry is
separate from admission to paid inference. Each admitted package needs exact
tokenizer/template pins and a freshly qualified provider with that package.

The preparation inventory is
[`lib/koin-network/tokenizers/candidates/index.json`](../../lib/koin-network/tokenizers/candidates/index.json).
Ten packs have passed independent Python tokenizers 0.22.1/Jinja2 3.1.6 reference
vectors against the JavaScript adapter: the existing Fast pack and nine new
candidates. The candidates cover Smart, Mistral 7B, Qwen Coder 7B, Qwen 14B,
Phi-4, Mistral Small 24B, Qwen 32B, Qwen Coder 32B and DeepSeek R1 32B.

The two Llama and three Gemma packages have public GGUF tokenizer metadata, but
their upstream standalone tokenizer files require accepted terms/authentication.
Faithful reconstruction from the public GGUF metadata has not been verified.
They remain in the full commercial catalog with this preparation blocker. No
alternate tokenizer or invented calibration is substituted.

## Preparation tools

These are operator/build tools, not steps customers need to perform.

1. `node scripts/verify-koin-tokenizer.js DIRECTORY MANIFEST.json` downloads only
   the two manifest-pinned artifacts from the exact repository revision, checks
   hashes and reference vectors, and reports preparation status. Existing
   mismatched files are preserved and rejected. Runtime startup does not fetch
   artifacts. The original one-argument Fast command remains supported.
2. `node scripts/verify-koin-runtime-tokenizer.js DIRECTORY MANIFEST.json
   http://127.0.0.1:PORT MODEL.gguf` hashes the local GGUF and compares every
   reference vector's exact token IDs with the running local llama.cpp server.
   It performs no completion, payment or provider admission. A local file hash
   does not independently establish which weights the server loaded; the report
   retains that limitation, and provider/runtime identity checks remain required.
3. `node scripts/calibrate-koin-tariff.js DIRECTORY EVIDENCE.json MANIFEST.json`
   recounts measured usage for any prepared model. Its existing sample-count,
   cost, latency and duplicate-measurement checks remain in force. It cannot
   activate a rate or guarantee rewards. Omitting the manifest preserves the
   original Fast command.
4. For a new package, `node scripts/prepare-koin-tokenizer.js DIRECTORY
   SOURCE.json REFERENCES.json OUTPUT.json` verifies a source descriptor and
   independently produced reference vectors against the exact public catalog
   model hash. It creates a candidate manifest exclusively and never replaces
   an existing output. The source descriptor contains `model`, `repository`,
   `revision`, `tokenizerHash`, `configHash`, `templateHash` and `reference`.
   Include multilingual text and a multi-turn message vector. Each message
   vector has a prompt hash, exact token-ID hash and count; date-dependent
   templates also require an explicit timestamp in `at`.
5. `node scripts/evaluate-koin-qualification.js --endpoint
   http://127.0.0.1:PORT --model-file ABS_GGUF --output ABS_NEW_JSON
   --model APPROVED_ALIAS --suite ABS_SUITE_JSON` measures an explicit candidate
   suite against a local runtime. It binds the approved package and exact model,
   tokenizer and template hashes. Non-Fast models require their own suite; the
   existing no-model-flag Fast invocation remains supported. `--manifest
   ABS_MANIFEST_JSON` selects an explicit candidate when needed. Reports remain
   unsigned candidate evidence and do not create provider eligibility or claim
   loaded-runtime verification. The bounded 32 GiB file limit covers the current
   approved packages.

Schema-2 deployment configuration installs each configured pack under
`tokenizer/<model-alias>/`. Legacy configuration retains its flat tokenizer
directory. Artifact byte limits are explicit: 64 MB tokenizer JSON, 2 MB config
JSON and 2 MB manifest. No remote code is loaded.

## Deterministic dated templates

Mistral Small 24B's upstream template includes the current date. Reading the
server clock while recounting a saved request could change its prompt at UTC
midnight. The adapter therefore resolves its `strftime_now('%Y-%m-%d')` call
from the request's existing, hash-bound `quote.at` timestamp. The parsed
identifier is redirected to a bounded UTC-date helper; the upstream template
bytes and their hash are preserved. Missing timestamps, unsupported formats
and collisions with the reserved helper name fail closed.

Input counting, quoting, dispatch and recovery pass the same saved timestamp.
Literal text and non-dated templates retain their existing interpretation.
Tests cover a quote created before midnight and dispatched after a second
quote on the next UTC date; its original prompt commitment remains identical.

## What the evidence does and does not establish

Independent reference vectors check the JavaScript implementation against
separate Python implementations. Local runtime checks compare exact token IDs,
not merely counts. Every normal network job also rechecks the quoted prompt's
exact token IDs in the provider runtime before inference proceeds.

These checks do not establish model quality, latency, hardware costs or readiness
of an offline provider. No new candidate is marked production-approved by the
preparation tools. Keep the exact package/model hash, complete tariff policy,
runtime identity and fresh signed qualification as separate admission checks.
