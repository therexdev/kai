# AI Teams & run code

## Run code — the sandboxed script tool

In agent mode the AI can write and run short Node.js scripts to do what a language model can't do in its head: exact math, parsing files, bulk transforms over workspace data. Every run is sandboxed, in layers:

- The script can read and write **only the agent workspace folder**. Your wallet, keys and documents are unreachable — enforced by the Node runtime's permission model, not by politeness.
- **No network** inside the sandbox, no launching other programs, hard time (30s) and memory limits, output capped.
- **The code is always shown to you and confirmed before it runs.** Every time. No trusted shortcut exists for code.
- If a machine's runtime can't provide the jail, code execution switches itself off rather than run unjailed.

The tool composes with the file tools: ask the agent to save a CSV to its workspace, compute over it with code, and report — the whole loop is visible in the trace.

## AI Teams

Teams put several AI roles on one task, every stage visible:

- **Research team** — a planner splits the question, researchers search and read, a writer synthesizes, a critic checks the draft and can demand one revision.
- **Analyst** — a planner scopes the job, a coder computes with sandboxed scripts, an explainer reports in plain language.
- **Write & review** — drafter, critic, reviser. No tools; a pure quality loop.

Teams are strictly budgeted — bounded sub-tasks, bounded tool calls per worker, one revision, a hard ceiling on total model calls — so they always finish. They add **zero** new permissions: every tool call passes the same policy gates as solo agent mode, and a team that wants to run code asks for your consent up front, once, visibly.

> The Team picker is landing in the chat composer in an upcoming build; the engine is already live for developers via the local API (see **Local API & privacy**).
