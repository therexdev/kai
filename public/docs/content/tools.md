# Tools, agents & MCP

**Tools & accounts** (the **Tools** sidebar item) is where your AI gains abilities beyond talking: tool servers, a memory that lasts across chats, and your email & calendar.

![Tools & accounts — the tool-server catalog, memory, email and calendar](img/tools.png)

## Agent mode

Turn on agent mode with the robot icon in the chat composer. The model can then use tools — search the web, read pages, save and read workspace files, remember facts, run code — with **every step shown in a visible trace**. Nothing happens off-screen.

## The tool policy (the two rules everything obeys)

- **egress** — the tool sends data off this machine. Refused entirely in Local-Only privacy mode.
- **sensitive** — the tool changes something or exposes private data. It requires your explicit yes *every time*, shown before it runs, enforced in Core rather than trusted to the UI.

## The agent workspace

File tools operate in one dedicated scratch folder — never your real documents. `write_file`, `read_file`, `list_files` and `run_code` all share it, so work composes: save data → run code over it → read the result.

## Adding tool servers (MCP) — step by step

1. Open **Tools** and find **Tool servers (Model Context Protocol)**.
2. Pick a catalog entry from the dropdown — for example **Your files (folders you pick)** — and click **Add**.
3. That entry needs one input: a native folder picker opens; choose the folder the AI may use. (Cancel and nothing happens.)
4. **You should see** the server appear in your list, and the entry leave the dropdown — installed entries don't show twice.

Notes that save head-scratching:

- Entries marked as needing Node.js get it provisioned automatically — the line under the dropdown says which runtime is being used.
- **Add your own** takes any Streamable-HTTP URL, or a stdio command (advanced — it runs a program on your machine and the app says so plainly).
- Every server's tools obey the same policy: ask-before-use until you mark that server trusted.

## Memory

The **Memory** section shows everything the AI remembers across chats — all stored on this machine. Pin a message with 📌 to remember it, add facts manually, delete any entry. Relevant memories are injected automatically when they help.
