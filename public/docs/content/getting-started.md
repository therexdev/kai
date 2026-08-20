# Getting started

Koinos AI is a private AI app that runs models on your own machine — and lets that same machine earn KAI by serving the network when you're not using it.

## Install

**Windows** — download `Koinos-AI-Setup-<version>.exe` from the [latest release](https://github.com/therexdev/kaiapp/releases/latest) and run it. There is also a portable `.exe` that runs without installing.

**Linux** — download the `.AppImage`, make it executable, run it:

```
chmod +x Koinos-AI-*.AppImage
./Koinos-AI-*.AppImage
```

**Raspberry Pi / headless** — run Core from source (Node.js 22+):

```
git clone https://github.com/therexdev/kaiapp
cd kaiapp && npm install
npm run core
```

Then open `http://localhost:41100` in a browser — the full app UI works there.

> The app updates itself on Windows and Linux desktop builds. On a Pi, update with `git pull` + restart.

## First run

1. Open the **Models** tab and download a model. **Koinos Fast** (~1 GB) runs on nearly anything, including a 4 GB Pi.
2. Chat. Everything runs locally — nothing leaves your machine unless you turn it on.
3. Check **Settings → Privacy**. `Local-Only` means zero network egress, ever. `Local-First` and `Network` unlock web search, network AI and earning.

## The one-minute tour

- **Chat** — talk to your local model, or the network's bigger ones.
- **Earn** — serve models to the network for KAI, plus your mainnet wallet.
- **Models** — download, import, remove models.
- **Tools & accounts** — agent tools, MCP servers, email, calendar.
- **Network** — live view of the whole compute network.
