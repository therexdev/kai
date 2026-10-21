# All-model credit pricing review — October 21, 2026 (UTC)

The owner approved this complete 15-model introductory rate schedule and the
1,000 credits/$1 denomination on October 20, 2026 (America/Chicago). It replaces
the Fast-only tariff proposal. Commercial approval does not mark deployment or
model qualification complete. No live balances or funds have changed.

## OpenAI comparison

Official pricing was checked on October 21, 2026:

- [ChatGPT Work/Codex credits](https://learn.chatgpt.com/docs/pricing): purchase
  prices and discounts depend on the plan/agreement. Published desktop voice
  rates of $0.05/minute and 1.25 credits/minute imply a $0.04-per-credit reference.
  This calculation does not establish a universal checkout price. Included
  subscription limits do not map directly to purchased credits.
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing): Standard,
  short-context, uncached text rates per million input/output tokens are
  GPT-6 Luna $0.10/$0.50, GPT-6.1 Sol $2/$10 and GPT-6 Astra $10/$50. These are
  useful usage-cost benchmarks; they do not establish equal model capability.

Keep the existing KAI denomination: **1,000 credits = $1**, so one credit is
$0.001. At the calculated OpenAI reference, one OpenAI credit represents the
same dollars as 40 KAI credits. The number printed as “credits” is a unit;
competitive pricing comes from lower charges for the actual workload.

## Approved introductory text rate schedule

All amounts below are per **one million AI tokens**, input / output. KAI credits
are account spending units; AI tokens measure text. Prices target introductory
competitiveness against OpenAI Standard text rates. Provider operating costs,
capacity and reward subsidy sustainability must be measured before claiming
these are sustainable long-term rates.

The legacy source already prices all 15 public aliases. At about 04:03 UTC,
[the public roster](https://koinosai.com/scheduler/network/models) advertised 11
of them across six providers. [Legacy prices](https://koinosai.com/scheduler/pricing)
are explicitly PROVISIONAL and feed legacy billing; they are not the new
prepaid product's approved rate schedule. Counts below are a historical snapshot,
not current availability or proof of prepaid qualification.

| Model | Approved USD input / output | Approved KAI credits input / output | Existing provisional USD input / output | Advertised providers |
| --- | ---: | ---: | ---: | ---: |
| Koinos Fast (`koinos-fast`) | $0.01 / $0.04 | 10 / 40 | $0.1 / $0.4 | 5 |
| Koinos Balanced (`koinos-balanced`) | $0.015 / $0.060 | 15 / 60 | $0.15 / $0.6 | 2 |
| Gemma 3 4B (`gemma3-4b`) | $0.02 / $0.08 | 20 / 80 | $0.2 / $0.8 | 3 |
| Koinos Smart (`koinos-smart`) | $0.025 / $0.100 | 25 / 100 | $0.25 / $1 | 1 |
| Mistral 7B (`mistral-7b`) | $0.025 / $0.100 | 25 / 100 | $0.25 / $1 | 1 |
| Qwen Coder 7B (`qwen-coder-7b`) | $0.025 / $0.100 | 25 / 100 | $0.25 / $1 | 1 |
| Llama 3.1 8B (`llama31-8b`) | $0.025 / $0.100 | 25 / 100 | $0.25 / $1 | 1 |
| Gemma 3 12B (`gemma3-12b`) | $0.035 / $0.140 | 35 / 140 | $0.4 / $1.6 | 1 |
| Qwen 2.5 14B (`qwen25-14b`) | $0.04 / $0.16 | 40 / 160 | $0.5 / $2 | 1 |
| Phi-4 14B (`phi-4`) | $0.04 / $0.16 | 40 / 160 | $0.5 / $2 | 1 |
| Mistral Small 24B (`mistral-small-24b`) | $0.06 / $0.24 | 60 / 240 | $0.7 / $2.8 | 0 |
| Gemma 3 27B (`gemma3-27b`) | $0.07 / $0.28 | 70 / 280 | $0.8 / $3.2 | 0 |
| Qwen 2.5 32B (`qwen25-32b`) | $0.08 / $0.32 | 80 / 320 | $1 / $4 | 1 |
| Qwen Coder 32B (`qwen-coder-32b`) | $0.08 / $0.32 | 80 / 320 | $1 / $4 | 0 |
| DeepSeek R1 32B (`deepseek-r1-32b`) | $0.08 / $0.32 | 80 / 320 | $1 / $4 | 0 |

All packages are the catalog's Q4_K_M variants. Exact package hashes, integer
USD atom rates and source identity are in
[model-rates.proposal.json](model-rates.proposal.json). The four models without
advertised providers remain priced and can be shown as unavailable. None should
accept payment for inference until qualified capacity is present.

Even the highest approved introductory tier is 20% below Luna's Standard input rate and 36%
below its output rate. This is a dollar-cost comparison, not a claim that these
models match Luna's quality, context, latency or features. It is not a comparison
against every other host or discounted/cached/batch pricing.

For 1,000 input and 250 output tokens, Fast costs $0.00002 (0.02 KAI credits),
and the 32B tier costs $0.00016 (0.16 credits), before integer USD-atom rounding.
Actual input includes the metered context/history, so message length alone does
not determine the bill. Keep fractional credits; do not round each request up
to one credit or hide a small nonzero debit as zero.

The previous free allowance proposal remains 7.5 credits/account/day, with
300 credits/network/day and 22.5 credits/origin/day, and is still unapproved.
At lower tariffs it buys more inference: 187,500 output-only Fast tokens for
7.5 credits, before shared caps and input charges. It no longer corresponds to
25,000 output tokens. Free eligibility, concurrency and funded sponsorship must
be explicit; pricing a model does not automatically make it free-eligible.

## Customer experience

- One visible purchased-credit balance with its USD equivalent, a separate
  clear daily-free indicator, and one Buy credits action.
- One model picker using the approved catalog. Show availability and a small
  input/output price description, with details available on demand.
- Buy any supported pack using the current native KOIN quote. Purchased credits
  work across every admitted network model without additional KOIN reservations.
- Meter the selected model at the rate shown for that request. Preserve fractional
  credits and show actual spend in usage history. Never silently substitute a
  different model. An offline model stays visible as unavailable.
- Provider ONLINE means that provider has at least one freshly qualified,
  currently ready model. Its model list must show readiness separately for
  each model; an installed file alone is not online capacity.

## Required implementation before multi-model acceptance

| Area | Gap identified before this implementation | Required change and acceptance evidence |
| --- | --- | --- |
| Catalog and policy | Legacy has 15 aliases; the new path has one tariff | One versioned rate catalog covering all 15 exact package identities; reject unknown/dev/private-API entries; validate all rates and selected-model policy identity |
| Metering | All 15 candidate manifests have reference-verified metering; loaded-runtime admission remains pending | Calibrate tokenizer, template, context and output counting for each admitted package against the actual runtime; no estimated token charging |
| Runtime and installer | `test-config.js`, `test-runtime.js`, `setup.js` construct one tariff/tokenizer | Accept and validate the full collection; preserve existing single-model compatibility and signed intent; never rewrite recovery records |
| Qualification and readiness | Qualification uses `meter.tariffs()[0]`; status and overview assume `config.tariff` | Qualify each provider/model pair and renew it; count a model ready only while its pinned package, runtime, signatures and freshness pass |
| Desktop and signing | Chat forces `config.model`; prepaid verification expects a single tariff policy | Use selected network model; verify the full authorized catalog and selected entry; preserve account, model, rate and version in request/recovery identity |
| Billing and free usage | Core Meter/router already support multiple tariffs, but wiring restricts them | Prove distinct rates debit the shared balance correctly, free-first eligibility is model-specific, and retries/restarts/partial replies cannot double-charge or switch models |
| Normal product use | No real multi-model prepaid two-computer acceptance | Use normal Chat on independently owned buyer/provider accounts for each admitted available model; verify balances, model switching between requests, offline behavior and exact receipts |
| Economics | No measured provider cost/revenue model for this ladder | Measure throughput, capacity cost and free usage; review how Master inflows and the separate finite reward seed cover the intended cohort without calling subsidies permanent profitability |

The full catalog must be represented in the implementation and rate UI. A model
is selectable for paid use only after its own metering and qualification pass.
An offline model's missing live acceptance must remain explicit; a mocked result
cannot mark it ready. Large-model failure must not reduce the product to Fast
without an explicit scope decision.

## Delivery order

1. Implement the versioned catalog, multi-tariff configuration and matching
   desktop policy verification as one compatible change.
2. Calibrate each admitted package and add per-model readiness/qualification,
   catalog display and selection. Validate complete catalog coverage plus
   meaningful cross-model billing and recovery behavior.
3. Prepare the exact deployment, signed model policy, free-eligible model set,
   native purchase-price policy and complete budget for review together.
4. Deploy the separate credit service and publish its verified desktop pins;
   run normal two-computer Buy credits / Chat / Share tests across available
   admitted models. Keep unavailable models labeled accurately.
5. Finish existing launch acceptance, including three closed reward days and
   real payouts, with a measured operating budget.

See [ACTIVATION_REVIEW.md](ACTIVATION_REVIEW.md) for preserved authentication,
contract, purchase-pricing, funding and deployment work. Preparing auth is
complete; another auth-preparation loop is not part of this change.


## Implementation following owner approval

Multi-model runtime/configuration, authenticated full-catalog pricing, model
selection and saved-answer verification, per-model provider readiness, and
installation of per-alias tokenizer packs are now implemented in source.
The table above records the limitations found at the initial review; it is not
a claim that those source gaps remain unchanged. Runtime model calibration,
reviewed qualification criteria, live deployment and two-computer acceptance
remain open. Ten reference packs passed 79 independent vectors; five
Llama/Gemma packs need further preparation. See
[TOKENIZER_PREPARATION.md](TOKENIZER_PREPARATION.md) for exact model status.
