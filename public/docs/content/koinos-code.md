# Koinos Code — a coding agent, in the app and in your terminal

**Koinos Code** is a coding agent in the mold of tools like Claude Code — except the model is **yours**: a model running on your own machine, in your Koinos AI app. No cloud account, no per-token bill, and — unlike Chat — no option to send the work to the Koinos Network, because the agent reads your project's files into every prompt. **Which model does the work**, below, says why.

You point it at a project folder, give it a task in plain words, and it reads your files, proposes edits, and runs commands — with you approving every change.

There are two ways in, and they are the same agent:

- **In the app (v0.35.0+)** — its own **Koinos Code** item in the sidebar, with your projects, their sessions, and GitHub. Turn it on in **Settings → Koinos Code**. Start here.
- **In your terminal** — the `koinos-code` command, for when you are already in a shell.

## In the app

Flip the **Koinos Code** switch in Settings and a **Koinos Code** entry appears in the sidebar.

### Starting: pick a folder, or clone one

Open **Koinos Code** and you get your projects and a **New chat** button. A new chat asks for a folder, two ways:

- **Select a folder** — opens your computer's own folder picker. Choose one and you go straight into the conversation.
- **Clone from GitHub** — give `owner/name` or a URL, then click **Select a folder…** for where it should go. The same folder window as above, not a path you have to type. It creates the folder, clones the repository, and opens it as a project. If you have connected an account it lists the repositories it can see, so you do not have to remember names.

### Projects

Each folder you pick becomes a project, and the agent works inside it — never outside it.

- Add as many as you like and click between them.
- **Rename** gives a project a friendlier name than its folder.
- **Forget** removes a project from the list. It does **not** delete the folder or anything in it.
- If a project's folder is moved or deleted, it stays in the list marked *folder not found*, rather than quietly disappearing.

### Sessions

Each project keeps **sessions** — threads of what you asked and what it answered. A session remembers, so the second instruction can build on the first: ask it to rename something, then say *"now do the same in the tests"*, and it knows what you mean.

Click **New** for a fresh thread, or click an old session to read it back. Sessions are titled by the first thing you asked.

### Approving changes

Unchanged, and it will stay unchanged: **every file change appears as a card with its diff, every command as a card with the exact line, and nothing happens until you press the button.** Deny leaves the disk untouched and the agent is told honestly. A card nobody answers times out as a deny after five minutes. There is deliberately no "approve everything" switch in the app.

### Plan first (v0.38.0+)

Tick **Plan first** under the message box and Koinos Code reads your project and writes a numbered plan *before* changing anything. Approve the plan and it does the work; discard it and nothing happened.

It cannot make changes while planning — in that mode it simply has no tools that write files or run commands. This is the single best thing you can do for answer quality with a smaller local model: one that reads and thinks first goes wrong far less often than one improvising step by step.

### Slash commands (v0.39.0+)

Put a markdown file in `.koinos/commands/` inside your project and it becomes a command. `.koinos/commands/review.md` gives you `/review`; type `/` in the message box to see what a project has.

```
# Review a file
Read $ARGUMENTS and list any bugs, unclear names, or missing error handling.
```

`$ARGUMENTS` is replaced by whatever you type after the command. If a template does not mention `$ARGUMENTS`, what you typed is added at the end, so it is never silently dropped.

**A command is a prompt, not a program.** It changes what Koinos Code is *asked* — it cannot run anything or unlock anything by itself. Every file change and command it then proposes still comes to you as a card. That matters because these files travel inside repositories: opening someone else's project can never execute their instructions.

### Which model does the work (v0.40.0+)

The **Model** box next to the message box says which model is doing the work, and lets you change it. Each project remembers its own choice, so a large repository can use a bigger model than a scratch folder. Leave it on **App default** and it follows whatever Chat is set to.

Only models on **this machine** are offered, and that is deliberate — it is the one place Koinos Code does *not* copy Chat. The coding agent reads your project's files into every prompt it sends, so offering the Koinos Network here would put your private source on other people's computers as a side effect of picking a faster box. If you pin a model and later delete it, the run says so and falls back to the app's model rather than refusing to start.

### Tools (v0.38.0+)

**Tools…** next to the message box lends this project tools from the rest of the app — MCP servers you have added, memory, and the built-ins.

Off by default, and you pick per project. There is a limit of 8, deliberately: a small local model cannot hold thirty tool descriptions *and* your actual task in its context, so handing it everything makes it worse rather than better. Anything marked **asks first** still shows you a card before it runs, and in Local-Only mode tools that would leave your machine are not offered at all.

### Helpers (v0.39.0+)

For big jobs, Koinos Code can hand a self-contained piece of work to a helper that reports back one answer — useful when something needs a lot of reading that would otherwise crowd out the task.

A helper is always *less* able than the agent that called it: its file changes still come to **you** as cards in the same conversation, it does not get the tools you lent the project, and it cannot spawn helpers of its own.

## GitHub (v0.36.0+)

Connect a GitHub account and Koinos Code can clone repositories and publish work back.

**Connect** — click **Connect** under GitHub in the sidebar and paste a personal access token (GitHub → Settings → Developer settings → Personal access tokens). Give it access to the repositories you want to work on.

**What happens to your token:** it is stored on **this machine only**, in a file only your user account can read. It is never put in a command line, never written into the repository's config, never shown again in the app, and never sent anywhere except github.com. Disconnect deletes it.

**Clone a repo** — click **Clone a repo**, give it `owner/name` (or the GitHub URL) and a folder to clone into. It becomes a project automatically. Public repositories can be cloned without connecting; private ones need the token.

**Working with a repo** — when a project is a git repository, a bar appears above the transcript showing the branch and what has changed:

- **Branch** — make or switch to a branch.
- **Commit** — stage everything and commit with a message you write.
- **Push** — push the current branch, setting its upstream the first time.
- **Pull request** — open a PR from the current branch against the default branch.

Each of these happens because you clicked it. The agent proposes edits through its approval cards; committing and publishing are separate, deliberate acts that it never takes on your behalf.

## How this compares to Claude Code

The shape matches, and as of v0.40.0 so does most of the substance: its own place in the app, many projects, sessions that remember, plan mode, MCP tools, slash commands, helpers, a per-project model, an agent that edits and runs commands behind approval gates, a terminal CLI, and GitHub.

Two differences remain, both on purpose:

- **Background tasks** — a run that keeps going after you close the window. Not built yet.
- **Hooks** — commands that fire automatically at certain moments. **Deliberately not built.** A hooks file would live inside a repository, so cloning someone else's project could run their commands on your machine before you had read a line of it. If you want "always run the tests after an edit", write it as a note in `KOINOS.md` and Koinos Code will propose it as a command you approve.

The other real difference is the model. Koinos Code runs on whatever your local gateway serves. That is the point — your machine, your model, no bill — but a small local model genuinely behaves differently from a large hosted one. Give it smaller, clearer tasks and the results are much better.

## In your terminal

1. Make sure the Koinos AI app is running (Koinos Code talks to the app's local API).
2. Open a terminal **in your project folder**.
3. On **Windows with the app installed (v0.33.0+)**, just run it — the installer put `koinos-code` on your PATH (open a *new* terminal after installing):

```
koinos-code "add a --help flag to my script"
```

On Linux, or without the installer, run it with the Node.js on your machine:

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

**A note on what small models get wrong, and what v0.40.0 does about it.** To use a tool the model has to write a small piece of JSON, and asking a 4B model to fit an entire HTML page inside one — escaping every quote and newline by hand — is asking for something it cannot reliably do. When it got that wrong the old behaviour was bad: the half-written instruction was printed at you as though it were the answer, no approval card ever appeared, and nothing was written. Worse, the model would then tell you the file existed.

Now the instruction is repaired and carried out, so you get the approval card you were always supposed to get. And if the agent ever claims to have written a file when nothing reached your disk, the answer says so plainly. **Your approval is still the only thing that writes anything** — a repaired instruction shows you the same full diff as any other, so if the repair got it wrong, you see wrong content and say no.

## Prefer no terminal? It's in the app too (v0.32.0+)

The same agent lives under **Developer Tools → Koinos Code** in the app: point it at a project folder, type the task, and approve each diff or command as a card instead of a `[y/N]` prompt. See the **Developer Tools** page in this sidebar.

## Troubleshooting

- **"cannot reach the Koinos AI gateway"** — the app isn't running, or it's on a different port. Start the app, or pass `--url`.
- **"the gateway lists no models"** — download a model in the app's Models view first.
- **Edits are refused with "no terminal to ask on"** — you piped the CLI or ran it from a script; pass `--yes` to pre-approve edits there.
- **It answered with a block of JSON instead of doing anything** — fixed in v0.40.0. Update the app. If you still see it, the tool it reached for genuinely does not exist (for example an editing tool while **Plan first** is ticked), and it will now say so instead of printing the attempt.
- **It said it created a file that isn't there** — also v0.40.0. The answer now tells you outright when nothing was written. A file only ever appears after you approve its card.
