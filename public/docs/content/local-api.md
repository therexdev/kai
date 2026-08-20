# Local API & privacy

The **Local API** view is the app's control room: the privacy switch, your local OpenAI-compatible API, API keys, and the feedback box.

![The Local API view — privacy mode, endpoint, API keys](img/api.png)

## Network & privacy — the one switch that governs everything

- **Local-Only** — nothing leaves this machine, ever. Web search, network AI, email/calendar, earning and chain reads are all off, and every feature that needs them says so in words instead of failing quietly.
- **Local-First** — local by default, network features work when you invoke them.
- **Network** — everything enabled.

Every tool and feature in the app passes through this one policy — there is no side door.

## Your local OpenAI-compatible API

The app serves an OpenAI-shaped API on localhost — point any OpenAI-compatible client or SDK at it:

- `GET /v1/models` — your downloaded models (plus `koinos-network` when network mode allows).
- `POST /v1/chat/completions` — chat, streaming and non-streaming.
- `POST /v1/embeddings` — embeddings from the local engine.

Create a key under **API keys**, then:

```
curl http://localhost:41100/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "koinos-fast", "messages": [{"role": "user", "content": "hello"}]}'
```

Using `"model": "koinos-network"` routes the same request to the network's models and settles in KAI — your self-hosted gateway to paid inference.

## For developers: the control plane

The localhost control plane (`/core/...`) drives everything the UI does — and the newest engine surfaces land there first:

- `GET /core/teams` — list the AI Team templates.
- `POST /core/teams/run` — run a team; the whole trace streams back as server-sent events.

## Developer tools (v0.28.9+)

At the bottom of the Local API view there is a **Developer tools** switch. It ships **off**; flip it and a panel appears with two things:

![Developer tools on — the custom team spec box and the benchmark](img/api-dev.png)

### Custom team (JSON spec)

Instead of the built-in team templates, define your own pipeline as JSON — which stages run (`plan`, `work`, `write`, `critique`, `revise`), which tools the workers may use, budget limits, and extra per-role instructions. The box comes prefilled with a working example:

1. Click the **Developer tools** switch. The panel opens with an example spec.
2. Edit the spec (or keep it), type a task in **Task for the team**, and click **Run team**.
3. Watch the live trace — every stage and tool call prints as it happens, then the answer.

Rules that always hold, whatever the spec says:

- Budgets only go **down**: 4 sub-tasks, 4 actions per worker, and 24 model calls are hard ceilings.
- Your role instructions are **added to** the built-in ones, never replacing them.
- The switch reveals capability, not permission — a spec that includes `run_code` still asks you before anything executes, exactly like the Analyst template.

Apps can POST the same spec to `POST /core/teams/run` (as `{"spec": {...}, "question": "...", "model": "..."}`).

### Benchmark

**Run benchmark** scores the current model on a fixed suite of ten objective tasks — arithmetic, exact instruction following, JSON output, extraction, counting, and a tool-using agent case. Every check is mechanical (a regex, a substring, a JSON shape), so the score is honest and comparable across models and app versions.

You should see: a ✓/✗ line per task as it finishes, then a score line like `Score: 6/10 on "core" with koinos-fast`. Small local models fail some of these — that is the point of measuring. The last report is also saved to `bench-last.json` in the app's data folder, and the same suite is available at `POST /core/bench/run`.
