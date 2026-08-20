# Chat & local models

## Picking a model

The model picker sits in the chat composer. It lists what's downloaded; the catalog ladder in **Models** is:

- **Koinos Fast** (~1 GB, needs ~3 GB RAM) — quick answers on any machine, Pi included.
- **Koinos Balanced** (~2 GB, 8 GB RAM) — noticeably smarter, still CPU-friendly.
- **Koinos Smart** (~4.7 GB, 12 GB RAM) — the strongest local default.
- Larger classes (gemma3-12b, qwen2.5-14b, mistral-small-24b, …) for big machines.

Each catalog entry shows its download size and the memory it needs — the same rule the network uses when your machine serves (see Earn).

## Vision — chat with images

1. Download **gemma3-4b** from Models (it's the vision-capable class).
2. In a chat with gemma3-4b selected, click the paperclip and attach an image.
3. Ask anything about it. The image is processed locally like everything else.

## Voice

- **Talk instead of typing**: click the microphone in the composer. The first use offers a one-click setup of a local Whisper model; after that your speech is transcribed on-device — audio never leaves the machine.
- **Hear replies**: click the speaker icon on any assistant message.

## Web search in chat

Toggle the **🌐** button in the composer (needs Local-First or Network privacy). The model then searches and reads pages before answering, and shows what it looked at. **Deep Research** (in the composer's mode menu) runs multiple search-read-refine rounds and cites sources.

## Compare models

The **Compare** view in the sidebar sends one prompt to two models side by side — the honest way to feel the difference between Fast and Smart, or local versus network, before you commit to one.

![Compare — one prompt, two models, side by side](img/compare.png)

## Chat with your documents

The **Docs** view (sidebar) lets you add documents and chat about their contents — summaries, questions, extractions — all local.

## Scheduled tasks

The **Tasks** view runs a prompt on a schedule — a morning summary, a recurring check — and drops each result into your chat history. Disabled tasks never run; re-enabling restarts the clock rather than bursting.

![Scheduled tasks — a prompt on a timer, results land in chat](img/tasks.png)

## Importing your own models

**Models → Import** loads any GGUF file. Private imports stay private: they never advertise to the network and never earn — by design, so unvetted weights can't ride the paid network.

## Housekeeping

Pin favorite chats, rename or delete them from the chat list. History is a local file on your disk, nowhere else.
