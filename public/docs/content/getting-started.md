# Getting started

Koinos AI is a private AI app that runs models on your own machine — and lets that same machine earn KAI by serving the network when you're not using it. This page takes you from download to your first chat in about five minutes.

## Step 1 — Install

### Windows
1. Go to the [latest release](https://github.com/therexdev/kaiapp/releases/latest).
2. Download **Koinos-AI-Setup-\<version\>.exe** and run it. It installs in one click and starts automatically.
   - Prefer not to install? The plain **Koinos-AI-\<version\>.exe** is portable — it runs from anywhere, including a USB stick.

### Linux
1. Download **Koinos-AI-\<version\>.AppImage** from the same releases page.
2. Make it executable and run it:

```
chmod +x Koinos-AI-*.AppImage
./Koinos-AI-*.AppImage
```

### Raspberry Pi / headless server
Run Core from source (needs Node.js 22+):

```
git clone https://github.com/therexdev/kaiapp
cd kaiapp && npm install
npm run core
```

Then open **http://localhost:41100** in any browser — the complete app runs there, same features, same look.

> Desktop builds update themselves when a new version ships. On a Pi, update with `git pull` and restart (exact commands on the Troubleshooting page).

## Step 2 — Get a model

1. Click **Models** in the left sidebar.
2. Pick a model that fits your machine and click its download button. If you're not sure, start with **Koinos Fast** — it's about 1 GB and runs on nearly anything, including a 4 GB Raspberry Pi.
3. Wait for the download to verify (every model is checked against a pinned SHA-256 fingerprint — a corrupted file refuses to load).

**You should see** the model marked ready, and the status pill in the bottom-left corner read "Model loaded".

![The Models view — the catalog with size and memory requirements per model](img/models.png)

## Step 3 — Chat

Click **Chat** in the sidebar and type. Everything runs on your machine — nothing leaves it unless you switch it on yourself.

![A fresh chat — model picker and tool toggles live in the composer](img/chat.png)

## Step 4 — Know your privacy switch (30 seconds, worth it)

The whole app obeys one switch: **Local API → Network & privacy**.

- **Local-Only** — zero network egress, ever. Web search, network AI, earning and chain reads are all physically off.
- **Local-First** — local by default; network features available when you use them.
- **Network** — everything on.

Every page of these docs that mentions the internet assumes you've left Local-Only.

## Where to next

- Put your idle machine to work → **Earn — serve the network**
- Send and receive real KOIN → **Wallet — KOIN & VHP**
- Give your AI abilities (files, search, code) → **Tools, agents & MCP**
