# Developer Tools — build your own agent systems

**Developer Tools** (v0.30.0+) is its own section in the sidebar, for people who want more than the built-in team templates: design your own multi-agent systems — named agents that talk to each other, use tools, and even pause to ask *you* — then run them live.

## Turn it on

1. Open **Local API** and flip the **Developer tools** switch at the bottom.
2. **Developer Tools** appears in the sidebar. Click it.

You should see: a page with five sections along the top — **Multi-agent**, **Playground**, **Pipelines**, **Koinos Code**, **Benchmark**.

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

## Koinos Code — the coding agent, in the app (v0.32.0+)

![Koinos Code in the app — point it at a project folder](img/devtools-code.png)

The same coding agent that ships as the [terminal CLI](#koinos-code), pointed at one of **your** folders — no terminal needed:

1. Type the project folder's absolute path and a task, click **Run**.
2. The agent reads freely inside that folder; its steps stream live.
3. Every file change appears as a **card with its diff**, every command as a card with the exact line — and nothing happens until you press **Apply edit** / **Run command** on that card. Deny leaves the disk untouched and the agent is told honestly. A card nobody answers times out as a deny after five minutes.

There is deliberately no "approve everything" switch in the app: every card is answered by you. If the folder has a `KOINOS.md`, its notes guide the agent here exactly as in the terminal.

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
