# AI Teams & run code

## Run code (sandboxed)

Agents can write and run short Node.js scripts to do what a language model can't do in its head: exact math, parsing files, bulk transforms. Every run is sandboxed:

- Scripts see **only the agent workspace folder** — your wallet, keys and documents are unreachable, enforced by the runtime itself.
- **No network** inside the sandbox, no launching other programs, hard time and memory limits.
- The code is **always shown to you and confirmed before it runs**. No exceptions, no "trusted" shortcut.

If a machine's runtime can't provide the sandbox, code execution turns itself off rather than run unjailed.

## AI Teams

Teams put several roles on one task, each stage visible in the trace:

- **Research team** — a planner splits the question, researchers search and read, a writer synthesizes, a critic checks it and can demand one revision.
- **Analyst** — a planner scopes the job, a coder computes with sandboxed scripts, an explainer reports in plain language.
- **Write & review** — drafter, critic, reviser. No tools, pure quality loop.

Teams are strictly budgeted — bounded sub-tasks, bounded tool calls, one revision — so they finish, always. They add **zero** new permissions: every tool call passes the same policy gates as everywhere else, and code-running teams ask for your consent up front.

## For developers

The same engine is scriptable on the local API: `GET /core/teams` lists templates, `POST /core/teams/run` streams the whole trace as server-sent events. A JSON team-spec format, a benchmark runner and API keys for external apps are on the roadmap (see the design doc in the repo).
