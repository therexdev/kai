# Tools, agents & MCP

## Agent mode

The robot icon in the composer turns on **agent mode**: the model can use tools — search the web, read pages, save and read workspace files, remember things — with every step shown in a visible trace. Nothing is hidden; you watch it think.

## The tool policy (read this once)

Two flags govern every tool, enforced in Core, not the UI:

- **egress** — the tool sends data off this machine. Refused entirely in Local-Only mode.
- **sensitive** — the tool changes something or exposes private data. It requires your explicit confirmation *every time*, shown before it runs.

## The agent workspace

File tools operate in one dedicated scratch folder — never your real documents. `write_file`, `read_file`, `list_files` and `run_code` all share it, so they compose: save data, run code over it, read the result.

## Adding tool servers (MCP)

**Tools & accounts → Tool servers** connects Model Context Protocol servers:

1. **Catalog** — one click. "Your files (folders you pick)" opens a native folder picker and gives the AI access to exactly that folder. Installed entries leave the dropdown.
2. **Paste a URL** — any Streamable-HTTP MCP server.
3. **Paste a command** — any stdio server (advanced; runs a program on your machine and says so).

Every server's tools land in the same policy layer: ask-before-use until you mark that server trusted. Servers needing Node.js get it provisioned automatically — one click, no manual install.

## Memory

The AI can save and recall notes about your preferences and projects — stored locally, viewable and deletable in the Memory panel, auto-injected only when relevant.
