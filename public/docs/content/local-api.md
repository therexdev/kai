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

### Grounded answers — `koinos.ground` (v0.34.0+)

Building a support bot usually means building a retrieval pipeline first: search, fetch pages, chunk them, assemble a prompt. You can skip that. Add an optional `koinos.ground` block and your Core does the retrieval before answering:

```
curl http://localhost:41100/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "koinos-fast",
    "messages": [{"role": "user", "content": "Is the venue open tomorrow?"}],
    "koinos": { "ground": {
      "sources": ["https://help.acme.com/**"],
      "web": true,
      "max_pages": 4
    }}
  }'
```

**Two sources, one block, and the useful case is both at once.**

- **`sources`** — an allowlist of URL patterns over *your own* material. Only matching pages are ever read. `**` matches any path depth, `*` stops at a `/`. Each pattern must name one concrete host: `https://help.acme.com/**` works, `https://*.acme.com/**` is refused (a wildcard host would quietly turn an allowlist into open-web access while still reading like a restriction — if you want the open web, ask for it with `web`).
- **`web: true`** — the open web, for questions no static page answers: today's news, the weather, whether a service is down.
- **Both** — your docs are consulted first and the web fills what is left. That is the shape most support bots want.
- **`max_pages`** — how many pages to read. Default 3, hard ceiling 8.

**What comes back.** A normal OpenAI-shaped response, plus the sources it used. Non-streaming calls get a `koinos` field in the body; every call, streaming included, gets an `x-koinos-grounding` response header carrying the same thing:

```json
"koinos": {
  "grounding": { "status": "ok", "pages_read": 2 },
  "citations": [
    { "n": 1, "title": "Hours — Acme", "url": "https://help.acme.com/hours" },
    { "n": 2, "title": "Weather", "url": "https://news.example/weather" }
  ]
}
```

`status` is honest about what happened: `ok`, `no_results`, or `search_unavailable`. If the web is unreachable your bot still answers — ungrounded, saying so — rather than failing with a 502.

### What grounding does and does not do

**It runs on your machine only.** Combining `koinos.ground` with `"model": "koinos-network"` is refused, permanently. A network request executes on a **volunteer operator's** computer; fetching caller-chosen URLs there would make their machine an open proxy for your users — pointed at their home network, with the traffic logged against their IP, returning results nobody can verify. Use a local model for grounded answers.

**It respects the privacy switch.** In Local-Only, grounding is refused before anything is fetched, like every other feature that would leave the machine.

**It only reaches public addresses.** Every fetch is checked: no `localhost`, no `192.168.x`, no `169.254.169.254`, no internal hostnames. It cannot be turned inward at your own network.

**It has no tools.** The loop is search → read → answer, and nothing else — no file access, no commands, no memory. Web pages are untrusted text, and a page that says "ignore your instructions" is being read by something that has nothing to act with. That is the real containment; the prompt framing on top of it is a second layer, not the only one.

**It searches once, and the model never writes the query** — your user's question is the query, used exactly once. Letting a page we just read shape the *next* search would be a way for text on that page to smuggle your conversation into an outbound request. Multi-round research is a separate, human-supervised feature in the app.

**One thing to know before you turn on `web`.** With `sources`, you decide what may be fetched and your users cannot change it. With `web: true`, your users' questions steer what your machine reads from the public internet. That is what open-web grounding means everywhere, not a quirk here — it is capped, off by default, and feeds a loop that can only produce text. If your bot only needs your own material, `sources` alone is the tighter setting.

**It never pushes past your model's context.** The retrieved material is budgeted against the context your model actually has, so grounding can't be the reason a prompt stops fitting.

Send no `koinos` block and nothing above applies — the response is byte-for-byte what it was before.

## For developers: the control plane

The localhost control plane (`/core/...`) drives everything the UI does — and the newest engine surfaces land there first:

- `GET /core/teams` — list the AI Team templates.
- `POST /core/teams/run` — run a team; the whole trace streams back as server-sent events.

Everything under `/core/` is unauthenticated by default — it is the app talking to
itself over loopback. Set `KAI_CORE_TOKEN` and every `/core/*` call must then send
`Authorization: Bearer <token>`; use that if you drive the app programmatically.

### Memory

A local notebook of facts, capped at 2000 entries and 500 characters each. Never
leaves the machine.

- `GET /core/memory` → `{ ok, memories: [...] }`, newest first.
- `GET /core/memory?q=<text>&k=4` → the top `k` relevant entries instead of all of
  them. Returns `[]` rather than noise when nothing genuinely matches.
- `POST /core/memory` with `{ "text": "...", "source": "user" }` → `{ ok, memory }`.
  Remembering the same text twice does **not** duplicate it: the existing entry has
  its timestamp refreshed and is returned instead.
- `DELETE /core/memory/<id>` → `{ ok: true }`, or 404 if there is no such entry.
- `DELETE /core/memory/all` → **wipes every memory.** `all` is a reserved id, not a
  memory called "all". Worth a confirmation step in anything you build on it.

A memory is `{ id, text, ts, source? }` — `id` is a 12-character hex string and `ts`
is epoch milliseconds.

### Voice input

Speech-to-text runs entirely locally through whisper; audio never leaves the machine,
so this works the same in Local-Only mode.

- `GET /core/voice` → `{ ok, available, engine, model, installable, downloadBytes, setup }`.
  `available` is the one to branch on — it means both the engine and the model are
  present. `downloadBytes` is the one-time cost of whatever is still missing, which is
  what you would show in a confirm dialog.
- `POST /core/voice/setup` → starts the download **in the background and returns the
  current status immediately.** It does not wait, and a successful response does not
  mean voice is ready. Poll `GET /core/voice` until `available` is true; a failure
  lands in `setup` rather than in the response you already received.
- `POST /core/transcribe` with the **raw WAV bytes as the request body** — not JSON,
  not multipart. 16 kHz mono 16-bit, under 10 MB (~5 minutes). Returns
  `{ ok, text, ms }`. Returns 503 when voice is not set up yet and 400 for audio it
  cannot read, so those two cases are worth handling differently.

## Developer tools (v0.30.0+)

At the bottom of the Local API view there is a **Developer tools** switch. It ships **off**; flip it and a **Developer Tools** section appears in the sidebar — its own page with four parts: build full multi-agent teams (named agents that converse, use tools, and can pause to ask you), watch them run in a live playground, define simple pipeline teams, and benchmark your model on a fixed objective suite.

The whole area is documented on its own page: **Developer Tools** in this sidebar. **Koinos Code** has its own switch right below it, and its own page. The switch reveals capability, not permission — anything involving `run_code` still asks you before code executes, and every tool call obeys the same privacy rules as the rest of the app.
