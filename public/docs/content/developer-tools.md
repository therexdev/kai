# Build with KAI Core

Every publisher uses the same public plugin SDK. Core supplies generic models, lifecycle and reviewed services; each plugin owns its feature UI, dependencies and saved work.

## Build a plugin

- [Step-by-step plugin quickstart](https://github.com/therexdev/kai-core/blob/docs/plugin-quickstart/docs/foundation/PLUGIN_QUICKSTART.md)
- [Full author guide](https://github.com/therexdev/kai-core/blob/main/docs/foundation/PLUGIN_AUTHOR_GUIDE.md)
- [Public API types](https://github.com/therexdev/kai-core/blob/main/docs/foundation/api-v1.d.ts)
- [Sandboxed notes example](https://github.com/therexdev/kai-core/tree/main/examples/sandboxed-notes)
- [Native counter example](https://github.com/therexdev/kai-core/tree/main/examples/native-counter)

Start sandboxed for packaged browser UI, plugin storage and local inference. Native services run trusted code with full application and computer access available to KAI. Signatures identify publishers; they do not certify code safety.

Packages use manifest schema 2 and API 3. The native SDK version is 1. Bundle dependencies before signing; Core does not run npm on a user's computer.

## Install developer tools

Use **Tools** for developer utilities and MCP, **Koinos Code** for projects, **Workflows** for visual agents and approvals, and **Remote Access** for local API and gateway configuration. Install only what you need through Core's Plugins page.
