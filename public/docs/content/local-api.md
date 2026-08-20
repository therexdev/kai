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

A settings toggle for developer tools, JSON team specs, and a benchmark runner are on the roadmap — see `docs/ai-teams-design.md` in the app repo.
