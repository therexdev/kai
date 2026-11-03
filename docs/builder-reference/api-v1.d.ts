/** KAI Foundation native API v1; package manifest schema 2 / API version 3.
 * Native extensions run as trusted code in Electron's main process.
 * These types describe the public SDK; they do not imply OS isolation.
 */
import type { Buffer } from "node:buffer";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type Permission =
  | "native.execute" | "models.read" | "models.manage" | "inference.local" | "inference.network"
  | "storage.read" | "storage.write" | "network.status" | "network.fetch" | "network.configure"
  | "desktop.media" | "desktop.external" | "desktop.navigate" | "desktop.notifications"
  | "desktop.preferences" | "desktop.windows" | "files.read" | "files.write" | "process.execute"
  | "secrets.read" | "secrets.write" | "secrets.use" | "wallet.read" | "wallet.authorize"
  | "account.request" | "services.call" | "services.provide";

export interface BaseManifest {
  schema: 2;
  apiVersion: 3;
  id: string;
  version: string;
  name: string;
  description?: string;
  entry: string;
  permissions: Permission[];
  provides?: string[];
  consumes?: string[];
}
export type PluginManifest = BaseManifest & (
  | { runtime: "sandboxed"; service?: never }
  | { runtime: "native"; service: string }
);

export interface ModelAlias {
  alias: string;
  label?: string;
  status: string;
  blurb?: string;
  /** Expected weights-file size, excluding any vision projector. */
  sizeBytes?: number | null;
  /** Core 0.7.5+: expected weights plus projector; null when unknown. */
  downloadSizeBytes?: number | null;
  /** Core 0.7.5+: current local file bytes, including partial/projector files.
   * Zero means no files present; null means size could not be determined. */
  diskBytes?: number | null;
  [key: string]: unknown;
}
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }
export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [option: string]: unknown;
}
export interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{ index?: number; message?: { role?: string; content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  [key: string]: unknown;
}
export type PrivacyMode = "local-only" | "local-first" | "network";
export interface NetworkStatus { privacyMode: PrivacyMode; [key: string]: unknown; }
export type InterfaceLanguage = "en" | "es" | "pt-BR" | "fr" | "de";
export interface LocaleState {
  language: InterfaceLanguage;
  /** False until a supported language has been saved in Core Settings. */
  selected: boolean;
  direction: "ltr";
  languages: Array<{ code: InterfaceLanguage; name: string }>;
}
/** Available to every installed plugin renderer on Core 0.7.17+. */
export interface RendererLocale {
  get(): Promise<LocaleState>;
  onChange(callback: (value: LocaleState) => void): () => void;
}
export interface DesktopPreferences { language: string; theme: "light" | "dark" | "system"; }
export type CoreView = "chat" | "models" | "plugins" | "wallet" | "credits" | "buy-credits" | "earning" | "network" | "settings";
export interface ServiceContext {
  readonly caller: string;
  readonly remote: false;
  readonly signal: AbortSignal;
}
export interface ProvidedService {
  methods: string[];
  call(method: string, input: JSONValue, context: ServiceContext): JSONValue | Promise<JSONValue>;
}
export interface NetworkFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string | Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;
  signal?: AbortSignal;
}
export type CreditAction =
  | "credit-status" | "chat-info" | "chat-estimate" | "chat-completion" | "chat-ack"
  | "chat-recover" | "stop" | "run-open" | "run-chat" | "run-list" | "run-status" | "run-stop";

export interface FoundationApi {
  readonly version: 1;
  readonly plugin: Readonly<{ id: string; version: string; root: string; dataDir: string }>;
  /** Profile directories an editor should exclude; not a native-code security boundary. */
  readonly paths: { readonly protected: readonly string[] };
  readonly signal: AbortSignal;
  readonly settings: {
    get<T = JSONValue>(key: string, fallback?: T): T;
    set<T extends JSONValue>(key: string, value: T): T;
  };
  /** Read-only shared interface preference, no additional permission required. */
  readonly locale: {
    get(): LocaleState;
    onChange(callback: (value: LocaleState) => void): () => void;
  };
  readonly models: {
    list(): ModelAlias[];
    ensure(input: { alias: string }): Promise<unknown>;
    /** Native Response. A local streaming body must be consumed or cancelled. */
    request(input: ModelRequest, signal?: AbortSignal): Promise<Response>;
    chat(input: ModelRequest, signal?: AbortSignal): Promise<ChatCompletion>;
    embeddings(input: { model: string; input: string | string[] | number[] | number[][]; [key: string]: unknown }, signal?: AbortSignal): Promise<JSONValue>;
  };
  readonly runtime: { status(): Record<string, unknown> };
  readonly network: {
    status(): NetworkStatus;
    configure(input: { privacyMode: PrivacyMode }): Promise<NetworkStatus>;
    models(): Promise<ModelAlias[]>;
    fetch(url: string, options?: NetworkFetchOptions): Promise<Response>;
  };
  readonly secrets: {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend(): string;
    encryptString(text: string): Buffer;
    decryptString(bytes: Uint8Array): string;
  };
  readonly desktop: {
    hostWindowId(): number | null;
    rendererId(): number | null;
    isVisible(): boolean;
    send(channel: string, value: unknown): void;
    openPlugin(id: string, section?: string): Promise<unknown>;
    openCore(view: CoreView, section?: "website-account" | "credit-account"): Promise<unknown>;
    openExternal(url: string): Promise<{ opened?: true; cancelled?: true }>;
    confirm(title: string, detail: unknown): Promise<boolean>;
    preferences(): DesktopPreferences;
    setPreferences(input: Partial<Pick<DesktopPreferences, "theme">>): DesktopPreferences;
    on(event: "show" | "hide" | "closed" | "focus" | "blur", handler: (...args: unknown[]) => void): () => void;
  };
  readonly account: {
    /** No account token is returned. Binding changes with the current session. */
    status(): { origin: string; signedIn: boolean; binding: string };
    request(path: string, options?: { method?: string; body?: JSONValue; signal?: AbortSignal }): Promise<Response>;
  };
  readonly wallet: {
    summary(): Promise<Record<string, unknown>>;
    /** Reviewed shared credit operations; not arbitrary signing or key export. */
    authorize(action: CreditAction, input?: JSONValue, signal?: AbortSignal): Promise<unknown>;
  };
  readonly services: {
    provide(name: string, definition: ProvidedService): () => void;
    call<T extends JSONValue = JSONValue>(name: string, method: string, input?: JSONValue, options?: { signal?: AbortSignal }): Promise<T>;
  };
  log(level: "info" | "warn" | "error", message: unknown): void;
}
export interface NativeService {
  call(method: string, input: JSONValue, signal: AbortSignal): JSONValue | Promise<JSONValue>;
  startBackground?(): void | Promise<void>;
  privacyChanged?(mode: PrivacyMode): void | Promise<void>;
  windowClosed?(): void | Promise<void>;
  dispose?(options: { reason: string }): void | Promise<void>;
}
export interface NativeServiceModule {
  create(api: FoundationApi): NativeService | Promise<NativeService>;
}

export interface KaiRenderer {
  readonly apiVersion: 3;
  /** Core 0.7.3+: themed presentation, never a native payment/service authorization. */
  readonly dialogs: {
    confirm(message: string, options?: { title?: string; detail?: string; confirmLabel?: string; cancelLabel?: string }): Promise<boolean>;
    alert(message: string, options?: { title?: string; detail?: string; buttonLabel?: string }): Promise<void>;
  };
  call(method: "models.list", input?: Record<string, never>): Promise<ModelAlias[]>;
  call(method: "inference.local", input: { model: string; prompt: string; maxTokens?: number }): Promise<{ text: string }>;
  call<T extends JSONValue = JSONValue>(method: "storage.get", input: { key: string }): Promise<T | null>;
  call(method: "storage.set", input: { key: string; value: JSONValue }): Promise<true>;
  /** Other methods are available only on native plugins and reach their own service. */
  call<T = unknown>(method: string, input?: JSONValue): Promise<T>;
  onEvent(channel: string, callback: (value: unknown) => void): () => void;
}
declare global { interface Window { kai: KaiRenderer } }
