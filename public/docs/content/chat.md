# Chat & local models

## Picking a model

The model picker in the composer lists what's downloaded. The catalog ladder:

- **Koinos Fast** (~1 GB) — quick answers on any machine, needs ~3 GB RAM.
- **Koinos Balanced** (~2 GB) — smarter, still CPU-friendly, 8 GB RAM.
- **Koinos Smart** (~4.7 GB) — the strongest local default, 12 GB RAM.
- Plus gemma3, mistral, qwen-coder, llama31 and larger classes for bigger machines.

Models are verified by SHA-256 against a pinned catalog before they load — a corrupted or swapped file refuses to run.

## Vision

`gemma3-4b` can see. Attach an image with the paperclip and ask about it. Vision runs locally like everything else.

## Voice

- **Voice input**: the mic button records, a local Whisper model transcribes — audio never leaves the machine. First use offers a one-click setup.
- **Read aloud**: the speaker icon on any reply.

## Web search in chat

Toggle the 🌐 button in the composer to let the model search and read pages before answering (needs Local-First or Network privacy mode). **Deep Research** runs multi-round research with visible sources.

## Importing your own models

Models → Import lets you load any GGUF file. Private imports stay private: they never advertise to the network and never earn — by design.

## Chats

Pin favorites, rename, delete. History is stored locally on your disk, nowhere else.
