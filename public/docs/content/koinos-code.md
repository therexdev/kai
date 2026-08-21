# Koinos Code — a coding agent in your terminal

**Koinos Code** (v0.29.0+) is a command-line coding agent, in the mold of tools like Claude Code — except the model is **yours**: the local model running in your Koinos AI app, or the Koinos Network class when your privacy mode allows it. No cloud account, no per-token bill.

It ships inside the app. You point it at a project folder, give it a task in plain words, and it reads your files, proposes edits, and runs commands — with you approving every change.

## Start it

1. Make sure the Koinos AI app is running (Koinos Code talks to the app's local API).
2. Open a terminal **in your project folder**.
3. Run it with the Node.js that's on your machine:

```
npx koinos-code "add a --help flag to my script"
```

or, from a clone of the app repo:

```
npm run code -- "add a --help flag to my script"
```

Run it with no task to get an interactive session — type tasks one after another, `exit` to leave:

```
npx koinos-code
koinos-code> rename the config file loader to loadConfig everywhere
```

You should see: a header naming the model and project folder, then a dim line for every tool step the agent takes (`» read_file …`, `» search_files …`), and finally its answer.

## The permission model — one sentence

**Reads are free inside the project, writes show a diff and ask, commands always ask.**

- Before any file is changed, you see a diff — added lines with `+`, removed with `-` — and a `[y/N]` prompt. Nothing is written until you say `y`.
- Before any shell command runs, you see the exact command and a `[y/N]` prompt. Every time.
- The agent cannot touch anything outside the project folder you started it in. Paths like `../` are refused automatically.

Two flags relax this for scripted use, one gate each:

- `--yes` pre-approves **file edits** (commands still ask).
- `--allow-commands` lets **commands** run without a prompt (for CI). There is deliberately no flag that silences both.

## Project notes: KOINOS.md (v0.31.0+)

Put a `KOINOS.md` file in your project root and its contents ride along with **every** task — house rules, build commands, "never touch the vendor folder", whatever the agent should always know. It's re-read each task, so edits apply immediately. Koinos Code tells you at startup when it found one:

```
context: KOINOS.md found — its notes ride along on every task
```

## Surgical edits (v0.31.0+)

The agent now prefers a precise `edit_file` step — replace one exact piece of text — over rewriting whole files. You still see the same diff and the same `[y/N]` before anything is written; the diffs just get much smaller. If the text it targets isn't unique, the edit is refused and the agent is told to be more specific — nothing half-applies.

## Hand a big thinking job to a team (v0.31.0+)

For jobs that are more thinking than typing — "plan this refactor", "research the options", "review this design" — hand the task to the app's **AI Teams**:

```
koinos-code --team review "plan how to split app.js into modules"
```

or in the interactive session: `/team research what test framework fits this project?`

Templates: **review** (draft → critique → revise; the default), **research** (searches and reads the web), **analyst** (computes by running sandboxed code — asks you first, since it executes code). The team's conversation streams live as `[stage]` lines, then its answer.

One honest boundary: the team works in the **app's** workspace, not your project folder. It thinks — plans, findings, reviews; the normal agent loop is what edits your files.

## Useful options

- `--dir <path>` — work on a different folder than the current one.
- `--model <alias>` — pick a model (default: the first one your gateway lists).
- `--url <base>` — a different gateway (default `http://127.0.0.1:41100`).
- `--key <secret>` — your API key, if you created keys in the app.
- `--max-steps <n>` — tool-step budget per task (default 25).
- `--team <template>` — hand the task to an AI Team (`research`, `analyst`, `review`).

## What to expect from small models

Koinos Code is honest about its engine: a 1–4 GB local model handles small, concrete tasks ("add a flag", "find where X is set", "write a README section") and will stumble on large refactors. Two ways up:

- Set your privacy mode to Local-First or Network and pass `--model koinos-network` — the same task runs on the network's larger models and settles in KAI.
- Keep tasks small and specific. The agent reads before it writes, so "change the timeout in the fetch helper to 30s" beats "make networking better".

## Prefer no terminal? It's in the app too (v0.32.0+)

The same agent lives under **Developer Tools → Koinos Code** in the app: point it at a project folder, type the task, and approve each diff or command as a card instead of a `[y/N]` prompt. See the **Developer Tools** page in this sidebar.

## Troubleshooting

- **"cannot reach the Koinos AI gateway"** — the app isn't running, or it's on a different port. Start the app, or pass `--url`.
- **"the gateway lists no models"** — download a model in the app's Models view first.
- **Edits are refused with "no terminal to ask on"** — you piped the CLI or ran it from a script; pass `--yes` to pre-approve edits there.
