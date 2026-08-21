# Developer Tools — build your own agent systems

**Developer Tools** (v0.30.0+) is its own section in the sidebar, for people who want more than the built-in team templates: design your own multi-agent systems — named agents that talk to each other, use tools, and even pause to ask *you* — then run them live.

## Turn it on

1. Open **Local API** and flip the **Developer tools** switch at the bottom.
2. **Developer Tools** appears in the sidebar. Click it.

You should see: a page with four sections along the top — **Multi-agent**, **Playground**, **Pipelines**, **Benchmark**. (Koinos Code used to be a fifth tab here; since v0.35.0 it is its own sidebar item with its own switch.)

![Developer Tools — the Multi-agent builder](img/api-dev.png)

## Multi-agent — teams that converse

Unlike the simple pipelines, a multi-agent team is a **conversation**: named agents share one transcript and take turns.

1. Give the team a name and pick how the floor moves:
   - **Round robin** — agents speak in order, cycling.
   - **Selector** — a model moderator reads the conversation and picks who speaks next.
   - **Handoff** — the current speaker keeps the floor until it passes it by name.
2. Add agents with **+ Add agent**. Each has a name, role instructions, and its own tools. Tick **human (asks you)** to put *yourself* in the team — when your turn comes, the run pauses and waits for your words.
3. Set when it ends: a message limit, a model-call limit, and an end phrase (an agent saying "TERMINATE" stops the run).
4. **Write the JSON below** turns the form into the spec — the JSON box is always what actually runs. **Save team** keeps it for later.

Rules that always hold, whatever the spec says: at most 8 agents, 60 messages, 120 model calls, and 6 tool actions per turn — budgets only go *down*. A team with `run_code` still asks you before any code executes, exactly like everywhere else in the app.

## Playground — watch it run

![The Playground — a live team conversation](img/devtools-playground.png)

1. Pick a team (the JSON in the builder, or a saved one), type a task, click **Run**.
2. Each agent's turn appears as a named bubble; tool calls show underneath in small text.
3. When a **human** agent's turn comes, an input box appears — the run waits for you (up to its timeout, 5 minutes by default). **Stop** ends a run at any time.

You should see: the conversation building live, then a final line like `ended: "TERMINATE" spoken — 7 model calls`.

## Pipelines — the simple track

![Pipelines — the one-line team spec](img/devtools-pipelines.png)

The original custom-team format: one pipeline of typed stages (plan → work → write → critique → revise) with a small JSON spec. Budgets cap at 4 sub-tasks, 4 actions per worker, 24 model calls. Good for jobs that don't need a conversation — research-and-summarize, compute-and-explain.

## Koinos Code moved (v0.35.0+)

Koinos Code used to live here as a tab. It is now **its own item in the sidebar**, with projects, sessions and GitHub, behind its own switch in **Settings → Koinos Code**.

If you turned Developer tools on to get Koinos Code, you keep it — the new switch starts on for you. Everything about it is on its own page: **Koinos Code** in this sidebar.

## Benchmark — score your model

Runs a fixed suite of ten objective tasks (arithmetic, exact instruction following, JSON output, extraction, counting, a tool-using agent case) and scores mechanically. Same tasks every run, so scores compare across models and app versions.

## For apps: the same power over HTTP

Everything this page does, your own programs can do against the local API (all endpoints need the Developer tools switch on):

- `POST /core/agents/run` — run a multi-agent spec; the conversation streams back as server-sent events, including `input-request` events when a human agent must speak.
- `POST /core/agents/input` — answer a pending human turn.
- `GET/POST/DELETE /core/agents/defs` — saved team definitions.
- `POST /core/teams/run` — the simple pipeline track.
- `POST /core/code/run` — the coding agent against a project folder; file edits and commands stream out as `approval-request` events, answered at `POST /core/code/approve` — nothing touches disk unapproved.
- `POST /core/bench/run` — the benchmark.

### If you put a reverse proxy in front of Core (v0.33.1+)

Core binds to `127.0.0.1` only, so on a normal desktop install nothing outside your machine can reach these endpoints. Headless operators sometimes front Core with nginx or Caddy to reach it from elsewhere on their network — and that is the one shape where a request arrives from off-machine.

The coding-agent endpoints treat that case differently from the rest, because they are different: teams' `run_code` is sandboxed to the app's workspace, while `POST /core/code/run` writes files anywhere you point it and runs shell commands as your user. So from v0.33.1, any request to `/core/code/*` that carries proxy headers (`X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Forwarded`) is **refused with 403 unless `KAI_CORE_TOKEN` is set** on the Core process. Set the token, send it as `Authorization: Bearer …`, and the endpoints work through your proxy as before.

Nothing changes for ordinary desktop use — a direct loopback call sends no forwarded headers and never sees this.
