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

## Useful options

| Option | What it does |
| --- | --- |
| `--dir <path>` | work on a different folder than the current one |
| `--model <alias>` | pick a model (default: first one your gateway lists) |
| `--url <base>` | a different gateway (default `http://127.0.0.1:41100`) |
| `--key <secret>` | your API key, if you created keys in the app |
| `--max-steps <n>` | tool-step budget per task (default 25) |

## What to expect from small models

Koinos Code is honest about its engine: a 1–4 GB local model handles small, concrete tasks ("add a flag", "find where X is set", "write a README section") and will stumble on large refactors. Two ways up:

- Set your privacy mode to Local-First or Network and pass `--model koinos-network` — the same task runs on the network's larger models and settles in KAI.
- Keep tasks small and specific. The agent reads before it writes, so "change the timeout in the fetch helper to 30s" beats "make networking better".

## Troubleshooting

- **"cannot reach the Koinos AI gateway"** — the app isn't running, or it's on a different port. Start the app, or pass `--url`.
- **"the gateway lists no models"** — download a model in the app's Models view first.
- **Edits are refused with "no terminal to ask on"** — you piped the CLI or ran it from a script; pass `--yes` to pre-approve edits there.
