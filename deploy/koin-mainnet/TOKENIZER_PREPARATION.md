# Model tokenizer preparation

The approved price catalog contains 15 public model aliases. A price entry is
separate from admission to paid inference. Each admitted package needs exact
tokenizer/template pins and a freshly qualified provider with that package.

The preparation inventory is
[`lib/koin-network/tokenizers/candidates/index.json`](../../lib/koin-network/tokenizers/candidates/index.json).
The inventory distinguishes independently prepared references from native
runtime parity. Python/JavaScript agreement alone is insufficient: the original
Fast reference applied Unicode NFC normalization while the approved GGUF engine
preserved the supplied characters. The decomposed-accent regression produced
nine reference tokens versus ten native tokens. The seven Qwen-family packs now
derive byte-preserving tokenization from their exact GGUF metadata and carry new
artifact identities. Existing deployments are not silently repinned or updated.
The converter also retains b10423's explicit `</s>` control-token override;
metadata types alone do not describe that native behavior.

Native comparisons cover reference strings and the twelve rendered baseline
provider-check prompts for each available candidate. Exact token IDs must agree;
a candidate that cannot demonstrate that agreement remains unavailable. These
are preparation checks, not paid admission or model-quality results.
The corrected inventory verifies all 15 models: 427 reference vectors and 180
actual candidate prompts. Generation now checks each prompt against its pinned
native evidence, so JavaScript-only regeneration cannot silently change it.

Mistral 7B's separate correction preserves native SentencePiece space prefixes
around control tokens. Its original system-role-capable chat configuration is
downloaded from a separately pinned immutable source; its exact config and
template hashes remain required. The converter rejects unsupported score ties.

Llama and Gemma upstream standalone files require accepted terms/authentication.
Their candidates instead explicitly identify the public catalog GGUF as their
source. The bounded converter reads its original vocabulary, merges/scores,
special-token IDs and chat template. It reconstructs Llama 3 byte-level BPE and
Gemma 3 score-ranked BPE; it does not substitute a different tokenizer or use
the incompatible Unigram conversion. No gated source was accessed.

## Preparation tools

These are operator/build tools, not steps customers need to perform.

1. `node scripts/verify-koin-tokenizer.js DIRECTORY MANIFEST.json` downloads the
   manifest-pinned artifacts from the exact repository revision, checks hashes
   and reference vectors, and reports preparation status. A manifest with
   `artifactSource.kind = "gguf-metadata-v1"` instead requests one exact bounded
   GGUF byte range, verifies its size/hash and HTTP Content-Range, then derives
   the two artifacts locally and checks their separately pinned hashes. It
   rejects a server that ignores the range and sends the full model. Existing
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
   Derived sources additionally carry the explicit `artifactSource` descriptor;
   generated artifacts are never presented as upstream standalone downloads.
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
JSON and 2 MB manifest. GGUF preparation prefixes are bounded at 16 MB. No remote
code is loaded. The GGUF parser rejects duplicate keys, malformed/truncated
metadata and oversized arrays/strings, preserving literal UTF-8 BOM characters
inside vocabulary tokens.

## Public GGUF source and native evidence

Each derived candidate has a sibling `MODEL.gguf-source.json` proof file. It
records the exact public repository, immutable revision, filename, published
LFS full-file SHA-256/size, downloaded prefix byte count/hash and native tool
identity. Every published full-file SHA-256 matches the approved catalog's
model hash. A published LFS identity plus a verified prefix does not constitute
a locally verified full-model hash; that check remains explicit at deployment.

The reference tool is llama.cpp **b10423**, matching the app runtime catalog.
Its Linux archive SHA-256 is
`664ffbf9134dbc12b2de3281d0404cb8f98a2339580911e5f74035dc320e0e84`;
the extracted `llama-tokenize` SHA-256 is
`5f0c1691b78ced63c8a67c1122ffffa820967094295c6d0f36a8a3880de02ec6`.
The pinned official source explicitly enables `model_params.vocab_only`.
References were run with `--stdin --ids --no-bos --no-escape --offline` against
sparse containers preserving the original GGUF header and declared size.
No full model was downloaded and no inference was performed for these checks.
The original templates were independently rendered with Python Jinja2 3.1.6;
the resulting prompts were then tokenized by that native binary. Reference
hashes bind exact token IDs, not only token counts.

## Deterministic dated templates

Mistral Small 24B and Llama upstream templates include the current date. Reading the
server clock while recounting a saved request could change its prompt at UTC
midnight. The adapter therefore resolves its `strftime_now('%Y-%m-%d')` call
from the request's existing, hash-bound `quote.at` timestamp. Llama's exact
`strftime_now('%d %b %Y')` format is also supported using UTC and a fixed English
month table. The parsed
identifier is redirected to a bounded UTC-date helper; the upstream template
bytes and their hash are preserved. Missing timestamps, unsupported formats
and collisions with the reserved helper name fail closed.

Input counting, quoting, dispatch and recovery pass the same saved timestamp.
Literal text and non-dated templates retain their existing interpretation.
Tests cover a quote created before midnight and dispatched after a second
quote on the next UTC date; its original prompt commitment remains identical.

## What the evidence does and does not establish

Independent reference vectors check the JavaScript implementation against
separate implementations and the pinned native vocabulary tokenizer. Local
runtime checks compare exact token IDs,
not merely counts. Every normal network job also rechecks the quoted prompt's
exact token IDs in the provider runtime before inference proceeds.

These checks do not establish model quality, latency, hardware costs or readiness
of an offline provider. No new candidate is marked production-approved by the
preparation tools. Keep the exact package/model hash, complete tariff policy,
runtime identity and fresh signed qualification as separate admission checks.
