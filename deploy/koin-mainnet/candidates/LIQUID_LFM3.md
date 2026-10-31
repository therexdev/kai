# Liquid LFM3 1.7B network admission candidate

The model has passed local technical preparation. The additive server rollout and matching Core catalog are implemented in [the activation guide](../LIQUID_CATALOG_UPDATE.md). Merging source alone does not install it on the live service or qualify any provider.

The exact Core model is `lfm3-1.7b`, package `liquid-lfm3-1.7b-q4_k_m@1`, official LiquidAI GGUF revision `bad5729bba61d076fff20d2548e62526665af215`, SHA-256 `3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4`.

## Prompt and tokenizer

`lfm2-bpe-no-thinking-v1` derives the tokenizer directly from a hash-pinned 16 MB GGUF prefix. It preserves the GGUF vocabulary, merges, special/user-defined token types, Unicode behavior and native Llama-style pre-tokenization. The original template body is retained verbatim, preceded by `{%- set enable_thinking = false -%}`. This selects the template's supported non-thinking branch and is committed in a distinct `templateHash`. Providers receive and execute the exact quoted token IDs.

Default thinking mode was tested first: it emitted a reasoning continuation ending with `</think>`, which fails the current strict readiness answer parser. The non-thinking choice avoids altering the parser or stripping unmetered output. It also matches this model's intended low-latency role.

## Evidence and repeatable check

`liquid-lfm3-1.7b.observation.json` records full-weight and runtime hash verification, ten multilingual/special-token/chat calibration vectors and five rounds of both randomized readiness challenges. All ten completions passed, naturally ending within the 256-token and 30-second limits. These are local Linux CPU observations, not a throughput promise or live provider qualification.

With the pinned GGUF and the official llama.cpp b11960 Linux x64 archive unpacked:

```sh
node scripts/measure-koin-lfm3-readiness.js /path/LFM3-1.7B-Q4_K_M.gguf /path/llama-server /path/new-measurement-directory
```

The script rejects different model/runtime hashes, compares native IDs against the backend tokenizer, and records the exact generation results. It does not contact the scheduler or create transactions. The proposed tariff is the same as the existing Qwen 1.5B entry: 10 input / 40 output credits per million tokens, 4,096 context tokens and 256 maximum output tokens. Pricing is staged, not installed.

## Activation

Use the reviewed additive updater in the activation guide. It retains the original account/provider identity, base tariffs, journals and readiness evidence. New clients negotiate the extended catalog; old clients retain their original catalog. The exact new model still requires signed readiness checks on each device.

The existing deployment is the separate `kai-koin-prepaid.service` on the scheduler host, not the Hostinger website deployment. Server access was not available in this editing session. No live installation was attempted.

Upstream uses the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-1.7B/blob/ac2586a34f1a1c03329dbdcdefabd8b6478ddaa7/LICENSE), including redistribution notices and its commercial-use revenue threshold; retain the license when distributing model/tokenizer artifacts.
