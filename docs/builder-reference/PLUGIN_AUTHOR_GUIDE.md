# Build a KAI Foundation plugin

A plugin owns its feature UI, logic, assets, dependencies and saved data. Foundation provides shared models, network policy, reviewed credit operations, OS encryption, desktop integration, plugin lifecycle and declared local service calls. These interfaces are available to every publisher; an official plugin ID does not unlock a private feature API.

There are two distinct version numbers: the signed package uses **schema 2 / `apiVersion: 3`**, and its native service receives **`api.version === 1`**. The TypeScript contract is [api-v1.d.ts](api-v1.d.ts). The implementations are `electron/foundation-api.js`, `electron/foundation-plugin-services.js`, `electron/core-plugin-host.js` and `core/lib/plugins/package.js`.

## Choose a runtime

| Runtime | What runs | Trust and limits |
| --- | --- | --- |
| `sandboxed` | Packaged HTML, CSS and JavaScript in a sandboxed renderer | No Node, direct network access, frames, popups or arbitrary IPC. Uses the public renderer methods below. No native service entry. |
| `native` | Sandboxed UI plus a CommonJS service in Electron's main process | Explicit installation approval trusts code with **KAI's operating-system permissions**. Native code can access files and app data available to KAI, execute programs, use Electron and affect Core. A crash or blocking loop can affect the whole application. |

Native execution is not an OS sandbox. The documented capability checks and plugin directories help avoid mistakes and keep normal API use consistent; they do not confine malicious native code. Native plugins do not automatically gain administrator/root access or bypass OS protections, but share any rights already held by KAI. A signature identifies a publisher and detects changed package bytes. It does not mean KAI reviewed that publisher. The GitHub owner shown on a plugin card is repository attribution from the catalog; it is not a separate verification of the publisher's signing key.

Start with [`examples/sandboxed-notes`](../../examples/sandboxed-notes) for a small UI-only plugin, or [`examples/native-counter`](../../examples/native-counter) for a native service that owns its state and exposes a local read API. Both examples are dependency-free.

## Manifest and package layout

```json
{
  "schema": 2,
  "apiVersion": 3,
  "id": "example.counter",
  "version": "1.0.0",
  "name": "Example Counter",
  "description": "A native counter with plugin-owned state.",
  "entry": "index.html",
  "runtime": "native",
  "service": "service/index.js",
  "permissions": ["native.execute", "storage.read", "storage.write", "services.provide"],
  "provides": ["example.counter"],
  "consumes": []
}
```

The manifest accepts only the fields shown above. `description`, `provides` and `consumes` are optional. A native service requires `native.execute` and a `.js` or `.cjs` service entry. A sandboxed manifest omits `service`, cannot grant `native.execute` and cannot provide a native service. The UI entry must be a packaged `.html` file.

IDs and service names contain lowercase letters, digits and dot/hyphen-separated segments, start with a letter and are at most 100 characters. Versions are three numeric components such as `1.0.0`; prerelease suffixes are not currently accepted. The package verifier rejects unknown manifest fields and permissions.

A `.kaiplugin` file is signed JSON with exactly `manifest`, `files`, `publicKey` and `signature`. Files are keyed by relative path. Text uses UTF-8; binary assets use canonical base64. The Ed25519 signature covers `signingPayload(manifest, files)`: canonical JSON of `{domain: "kai-plugin-package-v3", manifest, files: [...]}`. The `files` array is sorted by path; each entry contains `{path, encoding, bytes, sha256}` where encoding is `utf8` or `base64`, and length/hash are computed from the decoded file bytes. Every packaged byte is therefore bound without constructing another enormous base64 signing buffer. The verifier recomputes this table; publishers do not supply an unchecked table.

The v3 package digest is SHA-256 of `"kai-plugin-package-digest-v3\0" + signingPayload + "\0" + publicKey + "\0" + signature`, using UTF-8. Old schema 1 packages used a different format and are not accepted by Foundation. Use Core's exported helpers and packer rather than implementing a different signing format.

Package limits are 512 MiB of encoded JSON and 16,384 files. Paths are at most 240 characters and may contain letters, digits, `_`, `-`, `.`, and `@` within slash-separated components. Absolute paths, `..`, case collisions, Windows reserved names, symlinks, conflicting file/directory names and trailing dots/spaces are rejected. File extensions are allowlisted in `core/lib/plugins/package.js`; they include JS/CJS/MJS, HTML/CSS/JSON/text, common images/fonts/media, WASM, model files and native binaries. Store extensionless dependency licenses as `.txt`.

## Sandboxed renderer API

Only `window.kai` is exposed. It has `apiVersion: 3`, `call(method, input)`, `onEvent(channel, callback)`, and themed dialogs on Core 0.7.3 or later; the event subscription returns a disposer.

Use `await window.kai.dialogs.confirm(message, { title?, detail?, confirmLabel?, cancelLabel? })` for a boolean choice, and `await window.kai.dialogs.alert(message, { title?, detail?, buttonLabel? })` for a notice. Default buttons are Cancel/Continue and OK. These methods are available to both sandboxed and native plugin renderers without another permission. Declare Core 0.7.3 as the catalog minimum when using them. Message and detail are plain text (up to 16,000 characters each), titles up to 180 characters, and button labels up to 80 characters. HTML is never rendered; the dialog identifies the installed plugin. One renderer dialog may be pending per plugin.

Dialogs require the current visible plugin document. Closing the dialog, pressing Escape, hiding/reloading the plugin, closing to tray, disabling the plugin or quitting cancels the choice. Always await confirmation; a Promise is not approval. Renderer dialogs are presentation only and do not replace `api.desktop.confirm`, wallet reviews, or other native authorization checks. Native services calling Electron's asynchronous `dialog.showMessageBox` also receive Core's themed dialog. OS file choosers and system permission prompts retain their platform interfaces.

| Method | Required permission | Input and result |
| --- | --- | --- |
| `models.list` | `models.read` | `{}` → `[{alias, label, status}]` |
| `inference.local` | `inference.local` | `{model, prompt, maxTokens?}` → `{text}` |
| `storage.get` | `storage.read` | `{key}` → stored JSON value or `null` |
| `storage.set` | `storage.write` | `{key, value}` → `true` |

The local prompt limit is 16,000 characters, `maxTokens` is 1–4,096, and the model must be installed and ready. Calls do not fall back to paid network inference. Inference has a three-minute timeout and bounded concurrency. Renderer storage keys are 1–80 letters/digits/underscores/hyphens; the store allows 1,024 keys and 16 MiB in total. Storage is separate for each plugin.

The renderer cannot fetch arbitrary URLs or load a script from a CDN. Package scripts and assets. Use external script files; inline JavaScript is blocked. Camera/microphone use additionally requires `desktop.media` and the user's runtime permission. Avoid HTML injection: use `textContent` for model, network and user content.

A native plugin may call other names, such as `counter.increment`. They dispatch only to **that plugin's** `service.call`; Foundation does not implement those feature methods. Validate each method and input yourself. The renderer-call input limit is 1 MiB for sandboxed plugins and 24 MiB for native plugins.

## Native service lifecycle

Export `create(api)` from the service entry. It may return a promise. Return an object implementing `call(method, input, signal)` and optionally `startBackground()`, `privacyChanged(mode)`, `windowClosed()` and `dispose({reason})`.

`api.plugin` contains the ID, version, immutable code `root` and writable `dataDir`. `api.signal` is revoked when the service stops. Combine it with operation signals, stop timers and requests on cancellation, and make disposal safe to call again. Finish cleanup if one resource fails; throw an error if a process cannot actually stop. Register resources inside `try` and clean them up if `create()` fails before it can return a service.

`api.paths.protected` is a read-only list containing the Foundation profile directory. File editors and project tools should exclude these paths from user-selected workspaces so they cannot accidentally change application state. This list is a safety aid for trusted plugin code, not filesystem confinement.

Opening another page or hiding KAI in the tray does not dispose a plugin. Enabled native services can start before their UI opens. `startBackground()` must resume only work the user explicitly enabled; installation is not consent to send data, spend credits or start a remote listener. Native file dialogs and attended reviews need an available visible Core window. Do not assume a renderer exists during background startup. `desktop.openCore("settings", "website-account")` or `"credit-account"` can open the relevant account section; section arguments are otherwise rejected.

Disable, removal, update, rollback and application shutdown revoke the prior service. An update must stop the old instance before the replacement is loaded. A disposal failure blocks a clean transition and must be resolved instead of running a second copy.

Never write into `api.plugin.root`. Code is materialized from the signed package and checked before loading; modified or extra files cause rejection. Dependencies must be bundled inside this verified directory. The loader allows Node builtins and Electron, but ordinary package imports outside the plugin are rejected. This is a dependency-ownership check, not native-code confinement.

## Native API map

| API | Permission | Behavior |
| --- | --- | --- |
| `api.settings.get/set` | `storage.read/write` | Plugin-scoped JSON preferences; atomic writes, 4 MiB total. Dot-separated keys address nested objects. This is distinct from renderer `storage.get/set`. |
| `api.models.list`, `api.runtime.status` | `models.read` | Shared model/runtime snapshots. |
| `api.models.ensure({alias}, signal?)` | `models.manage` | Requests a model load with a user review. The optional AbortSignal cancels the review and this caller’s preparation. |
| `api.models.request/chat` | `inference.local` or `inference.network` | OpenAI-style messages. `request` returns a `Response`; `chat` returns parsed JSON and throws for failed responses. |
| `api.models.embeddings` | `inference.local` | Text/token embeddings from a ready local model; no network aliases. |
| `api.network.status/configure` | `network.status/configure` | Read privacy status or request a reviewed change. |
| `api.network.fetch` | `network.fetch` | Public HTTPS only; DNS-checked destination, no credentials in URLs, no redirects. Local-Only blocks it. |
| `api.network.models` | `inference.network` | Shared network model discovery for the current installed plugin context. |
| `api.secrets.*` | `secrets.use` | OS encryption availability/backend and string encryption/decryption for plugin-owned records. Reject insecure or unavailable storage for secrets. |
| `api.desktop.hostWindowId/rendererId/send/on` | `desktop.windows` | Numeric Electron IDs, messages to your renderer, Core-window lifecycle events. IDs can be `null` before a view exists. |
| `api.desktop.openPlugin/openCore` | `desktop.navigate` | Open an installed plugin or supported Core page. |
| `api.desktop.openExternal` | `desktop.external` | Reviewed HTTPS URL opening. |
| `api.locale.get/onChange` | None | Read the shared Core language and subscribe to saved changes. |
| `api.desktop.preferences/setPreferences` | `desktop.preferences` | Read shared language/theme; change theme. Language changes belong to Core Settings. |
| `api.desktop.isVisible/confirm` | Native runtime | Visibility and a consistent attended approval. Cancel or a hidden window yields `false`. |
| `api.account.status/request` | `account.request` | Current KAI account metadata and same-origin requests without returning its token. Local-Only blocks requests. |
| `api.wallet.summary/authorize` | `wallet.read/authorize` | Shared wallet summary and the supported reviewed credit operations below. No private-key export. |
| `api.services.provide/call` | `services.provide/call` | Declared local services; method allowlists, cancellation and caller identity. |
| `api.log` | Native runtime | Scoped `info`, `warn` or `error`; do not log secrets, prompts or private data. |

Model inputs are bounded at 16 MiB. Network request bodies are bounded at 16 MiB and response bodies at 32 MiB. Network fetch options are limited to `method`, `headers`, `body` and `signal`; redirects are denied without a `redirect` option. A request body may be a string, bytes, a readable stream or an async iterable of byte/string chunks; GET and HEAD requests cannot have a body. Account request/response bodies are limited to 4 MiB and are cancelled if the account or privacy mode changes. Consume or cancel returned response bodies so request tracking can finish. The common network/model timeout is three minutes. The network broker blocks Local-Only traffic and cancels tracked requests when privacy changes.

`account.request` is a broad grant to the signed-in KAI account API at its configured origin, including endpoints that can change account state. It is not a per-endpoint or read-only account scope. A plugin must obtain clear authorization for the action it performs; keeping the bearer token out of API results does not make the requested account operation harmless. The native runtime itself still has the user's computer authority.

The package permission vocabulary includes some descriptive permissions such as `files.read`, `files.write`, `process.execute` and `desktop.notifications`. API v1 does not expose a generic file/process/notification broker for those names. Do not assume a permission string creates an API method or confines native Node/Electron access. File/process behavior belongs to the native plugin and must use its own clear, bounded user approvals.

## Shared language and localization (Core 0.7.17+)

Core asks for a language on first launch and saves it in the current Core profile.
Settings → Language lets the user change it with **Save language**. A new plugin
must follow this preference instead of displaying another first-run picker or
saving its own language. The supported values are `en`, `es`, `pt-BR`, `fr`, and
`de`; first launch suggests a supported OS language and falls back to English.
A dismissed picker is shown again next launch until a choice is saved.

All publishers, including sandboxed plugins with no extra permissions, use the
same read-only renderer API:

```js
let revision = 0;
const applyLanguage = ({ language, direction }) => {
  document.documentElement.lang = language;
  document.documentElement.dir = direction;
  renderInterfaceLabels(language); // Preserve inputs and running operations.
};
const unsubscribe = window.kai.locale.onChange(state => {
  revision++;
  applyLanguage(state);
});
const initialRevision = revision;
const initial = await window.kai.locale.get();
if (revision === initialRevision) applyLanguage(initial);
window.addEventListener("pagehide", unsubscribe, { once: true });
```

`window.kai.call("locale.get")` is the equivalent low-level call. The state is
`{ language, direction, selected, languages: [{code, name}] }`. Subscribe before
reading to avoid a delayed read overwriting a newer change. Notifications reach
open views, including hidden views; newly opened views read the latest choice.
Sender/main-frame, installed-content and revocation checks still apply.

Native services use synchronous `api.locale.get()` and
`api.locale.onChange(callback)`. The returned disposer removes the listener;
Core also removes it when the service's abort signal fires. Forward the state to
plugin-owned auxiliary windows only after validating their exact sender/frame.
The Assistant uses this to keep its floating companion in sync. No additional
permission, account sign-in, or network request is needed.

Core owns this setting. `api.desktop.preferences().language` remains a read
compatibility alias; `api.desktop.setPreferences({language: ...})` now rejects
with directions to Core Settings. Theme updates remain supported. Do not store
language in plugin `preferences.json` or browser `localStorage`.

Bundle your own offline dictionaries with the signed plugin. Translate explicit
interface labels, placeholders, accessible labels and status templates. Keep
user notes, chats, generated output, code, filenames, addresses, keys, model names
and identifiers literal. Pass dynamic values as interpolation parameters and
escape at the output sink; do not translate whole DOM trees after user data is
rendered. Missing keys fall back to their English source. Use the language with
`Intl.NumberFormat` and `Intl.DateTimeFormat` for display, never for protocol
amounts, addresses or serialized transaction fields. An interface language does
not override a user's requested output language or silently translate documents.

[`examples/localized-notes`](../../examples/localized-notes) is a complete small
sandboxed example with all five languages and a live subscription. Its draft is
preserved when the language changes. The shipped `core-language.js` adapter can
also be copied into a plugin that uses the offline `KaiI18n` engine; it is a
plugin-owned build asset, not a runtime import from Core.

Core translates its dialog controls. Plugins must localize their own dialog messages
and reviewed details before calling the dialog API; Core keeps that caller-supplied
content literal. Do the same for prompts created by a native service using
`api.locale.get().language`. Logs and upstream diagnostics can keep their original text.

Publish these plugin versions with catalog `minCoreVersion: "0.7.17"` or newer.
The catalog is the compatibility gate; `minCoreVersion` is **not** a manifest
field. Publish Core first, then signed immutable plugin versions, then a newly
signed catalog pointing to the exact package bytes. Keep prior release assets
unchanged. Check initial selection, restart persistence, all five languages,
live/hidden views, draft preservation, failed writes, and missing-key fallback
before release. Native error details and upstream diagnostics may remain in
English; never hide an actionable error because a translation is missing.

## Local inference, network inference and credits

Use an explicit installed local alias with `api.models.chat({model, messages, max_tokens})` for local work. No network fallback is implicit. For streaming local responses, use `api.models.request({...input, stream: true}, signal)` and consume/cancel its body. Pass a per-operation AbortSignal to model requests and loads so Stop cancels work before headers, during preparation, and while queued. Local generations run one at a time in request order. Cancelling one caller never cancels a load another caller still needs. `api.runtime.status()` includes `loadingAlias`, `loadingStage`, and `inference: {activeAlias, queued}` for preparation and queue feedback.

Local model metadata includes its catalog `blurb` and expected weights `sizeBytes`. Core 0.7.5 adds `downloadSizeBytes` for the full expected weights/projector bundle and `diskBytes` for current local files, including partial downloads. `diskBytes: 0` means no files are present; `null` means the size is unknown. Imported models are measured at their existing referenced file, without copying it. These sizes are file lengths, displayed as decimal GB in Core, and do not establish model verification or readiness.

Network aliases use the `koinos-network` prefix. Native `models.request/chat` routes them through the shared reviewed credit service and currently returns a completed JSON response, even if `stream: true` was supplied. This requires both `inference.network` and `wallet.authorize`. A plugin must have its trusted UI available for an attended credit operation; do not start paid work invisibly from a startup timer.

The supported `wallet.authorize` actions are `credit-status`, `chat-info`, `chat-estimate`, `chat-completion`, `chat-ack`, `chat-recover`, `stop`, `run-open`, `run-chat`, `run-list`, `run-status` and `run-stop`. Preserve each service response and error rather than substituting a successful placeholder. `authorize` is not an arbitrary transaction signer, token-transfer API or key-export API. Opening a plugin UI does not authorize payment.

A workflow may group explicitly reviewed network work using the credit service's run actions. Keep the run identifier and lifecycle scoped to that plugin, respect returned budgets, stop the run on cancellation, and never treat a local inference grant as network spending authority.

## Declare and consume local services

A provider declares `provides: ["example.counter"]` and `services.provide`, then registers:

```js
const remove = api.services.provide("example.counter", {
  methods: ["read"],
  call(method, input, context) {
    context.signal.throwIfAborted();
    if (method !== "read" || context.remote) throw Error("Local reads only");
    return { count: api.settings.get("count", 0) };
  }
});
```

A consumer declares `consumes: ["example.counter"]` and `services.call`, then uses:

```js
const value = await api.services.call("example.counter", "read", {}, { signal });
```

Provide names and method names are exact. Missing providers produce an installation/enablement error. Multiple enabled providers of an unstarted service produce an ambiguity error; choose one. Only declared methods are callable. Payloads and results are copied and bounded to 24 MiB. A provider receives `{caller, remote: false, signal}`; cancellation combines the caller, provider and operation lifetimes. Recursive dependency cycles are rejected.

This bus is for local installed plugins. It does not accept a `remote` or delegated context option. **Do not forward remote job input into this bus or hand a native API object to a rented agent.** A fully trusted native plugin could bypass such conventions, so isolation of remote jobs must be implemented by that plugin using a restricted runtime and explicit data/capability boundaries. Agent Network's job engine, for example, accepts only a validated local graph and JSON data and exposes no service SDK to job code.

Do not expose a whole database, secret store or generic `execute` method as a convenience. Export deliberate operations, validate input, check the caller where appropriate, and require approvals for changes with outside effects. Copying a workflow for an isolated service is different from running the user's private workflow with all its ambient integrations.

## Build, sign, verify and install

Build dependencies on the publisher's machine with a lockfile. Include only the resolved runtime closure and assets in the plugin source directory. Include dependency licenses. Native addons must be prebuilt for the Electron ABI and target platform; there is no installation-time compilation or npm hook. Keep package size and supported platforms explicit. The package schema does not currently support arbitrary extra platform metadata fields.

Keep the Ed25519 publisher private key outside every repository and package. From the Core repository, pack one example with an existing author key:

```sh
node scripts/core/pack-plugin.js examples/native-counter ../publisher-private-key.pem /tmp/example-counter-1.0.0.kaiplugin
```

The packer validates paths, manifest, signature and limits before writing. It refuses to replace an existing output file. To verify an existing package without executing it:

```sh
node -e 'const fs=require("node:fs"); const {verifyPackage}=require("./core/lib/plugins/package"); const p=verifyPackage(fs.readFileSync(process.argv[1],"utf8")); console.log(p.manifest.id,p.manifest.version,p.fingerprint)' /tmp/example-counter-1.0.0.kaiplugin
```

Run `node --test examples/test/*.test.js` for the included example checks. Test your own service against a temporary data directory and fake Foundation interfaces; then test the signed package in the actual desktop runtime on every supported platform. Unit tests do not prove native addons, camera permissions, OS encryption, or installer behavior work on a different OS.

Install the package from Plugins → Install 3rd Party Plugins using a local file or approved package URL. Review the displayed publisher fingerprint and capabilities. Native packages require the explicit full-access notice. Updates must retain the same publisher key for an existing plugin ID; Core binds that ID to its first installed publisher. Use a new immutable version for each release.

Foundation stores verified packages, materialized code and per-plugin writable data under its new `plugins-v3` directory. Remove/disable stops a service; removing an installation does not silently delete its retained saved data or publisher binding. This architecture does not read or migrate the old app's documents, connected accounts or plugin state.
