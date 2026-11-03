"use strict";
const crypto = require("node:crypto");
// Packages contain code, assets and prebuilt dependencies. Nothing is downloaded
// or installed by a package's scripts on the user's computer.
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 16384;
const TEXT = /\.(?:html|js|cjs|mjs|css|svg|json|txt|md|map|xml|csv|yaml|yml|conf|pem)$/i;
const BINARY = /\.(?:png|jpg|jpeg|webp|gif|ico|icns|wav|ogg|mp3|mp4|webm|woff2?|ttf|otf|wasm|node|onnx|bin|exe|dll|so(?:\.\d+)*|dylib|dat|ort|model|pb)$/i;
const PERMISSIONS = Object.freeze([
  "native.execute", "models.read", "models.manage", "inference.local", "inference.network",
  "storage.read", "storage.write", "network.status", "network.fetch", "network.configure", "desktop.media",
  "desktop.external", "desktop.navigate", "desktop.preferences", "desktop.windows",
  "wallet.read", "wallet.authorize", "account.request", "secrets.use", "services.call", "services.provide",
]);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function safeId(value) { return typeof value === "string" && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value) && value.length <= 100 && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value); }
function safeFile(value) {
  return typeof value === "string" && value.length <= 240 && value.split("/").every(p => /^[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]*$/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) && (TEXT.test(value) || BINARY.test(value));
}
function strings(value, name, accepts, limit = 100) {
  if (!Array.isArray(value) || value.length > limit || new Set(value).size !== value.length || value.some(v => !accepts(v))) throw Error(`Invalid ${name}`);
}
function verifyPackage(input) {
  if (typeof input === "string" && Buffer.byteLength(input) > MAX_BYTES) throw Error("Plugin package exceeds 512 MB");
  const source = typeof input === "string" ? JSON.parse(input) : input;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw Error("Invalid plugin package");
  const { manifest: m, files, publicKey, signature } = source;
  if (Object.keys(source).sort().join() !== "files,manifest,publicKey,signature") throw Error("Invalid plugin package fields");
  if (!m || m.schema !== 2 || m.apiVersion !== 3 || !safeId(m.id) || typeof m.version !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(m.version) || typeof m.name !== "string" || !m.name.trim() || m.name.length > 100) throw Error("Invalid or incompatible plugin manifest; Foundation requires schema 2 / API 3");
  if (Object.keys(m).some(k => !["schema", "apiVersion", "id", "version", "name", "description", "entry", "permissions", "runtime", "service", "provides", "consumes"].includes(k))) throw Error("Unknown manifest field");
  if (m.description !== undefined && (typeof m.description !== "string" || m.description.length > 1000)) throw Error("Invalid description");
  if (!["sandboxed", "native"].includes(m.runtime)) throw Error("Unsupported plugin runtime");
  strings(m.permissions, "plugin permissions", p => PERMISSIONS.includes(p));
  strings(m.provides ?? [], "provided services", safeId);
  strings(m.consumes ?? [], "consumed services", safeId);
  if (m.runtime === "native" && (!m.permissions.includes("native.execute") || !safeFile(m.service) || !/\.(?:c?js)$/.test(m.service))) throw Error("Native plugins require a service entry and explicit native.execute trust");
  if (m.runtime === "sandboxed" && (m.service !== undefined || m.permissions.includes("native.execute") || (m.provides?.length || 0))) throw Error("Sandboxed plugins cannot load native services");
  if (!files || Array.isArray(files) || typeof files !== "object" || Object.keys(files).length < 1 || Object.keys(files).length > MAX_FILES) throw Error("Invalid plugin files");
  let encodedBytes = Buffer.byteLength(JSON.stringify({ manifest: m, files: {}, publicKey, signature }));
  const lower = new Set();
  for (const [name, content] of Object.entries(files)) {
    if (!safeFile(name) || lower.has(name.toLowerCase()) || typeof content !== "string") throw Error("Invalid or duplicate plugin file");
    if (BINARY.test(name) && !canonicalBase64(content)) throw Error("Binary plugin assets must use canonical base64");
    encodedBytes += Buffer.byteLength(JSON.stringify(name)) + 1 + (BINARY.test(name) ? content.length + 2 : Buffer.byteLength(JSON.stringify(content))) + (lower.size ? 1 : 0);
    if (encodedBytes > MAX_BYTES) throw Error("Plugin package exceeds 512 MB");
    lower.add(name.toLowerCase());
  }
  // A file cannot also be an ancestor directory on any supported platform.
  for (const name of lower) { const parts = name.split("/"); parts.pop(); while (parts.length) { if (lower.has(parts.join("/"))) throw Error("Conflicting plugin file paths"); parts.pop(); } }
  if (!safeFile(m.entry) || !m.entry.endsWith(".html") || !Object.hasOwn(files, m.entry)) throw Error("Plugin UI entry is missing");
  if (m.runtime === "native" && !Object.hasOwn(files, m.service)) throw Error("Plugin service entry is missing");
  if (typeof publicKey !== "string" || publicKey.length > 200 || typeof signature !== "string" || signature.length > 200 || Buffer.from(publicKey, "base64").toString("base64") !== publicKey || Buffer.from(signature, "base64").toString("base64") !== signature) throw Error("Invalid publisher signature");
  if (Object.values(m).some(value => value === undefined)) throw Error("Manifest fields cannot be undefined");
  const payload = signingPayload(m, files);
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64"))) throw Error("Plugin signature verification failed");
  const fingerprint = crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
  // Publisher ownership is bound on first install, equally for every author.
  const manifest = Object.freeze(Object.fromEntries(Object.entries(m).map(([name,value]) => [name,Array.isArray(value) ? Object.freeze([...value]) : value])));
  const pkg = Object.freeze({ manifest, files: Object.freeze({ ...files }), publicKey, signature });
  return { package: pkg, fingerprint, manifest, digest: packageDigest(pkg, payload) };
}
function canonicalBase64(content) {
  if (!content || content.length % 4 || /[^A-Za-z0-9+/=]/.test(content)) return false;
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  if (content.slice(0, content.length-padding).includes("=")) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return !padding || (alphabet.indexOf(content[content.length-padding-1]) & (padding === 2 ? 15 : 3)) === 0;
}
function signingPayload(manifest, files) {
  const table = Object.keys(files).sort().map(name => {
    const encoding = BINARY.test(name) ? "base64" : "utf8", content = files[name];
    return { path: name, encoding, bytes: Buffer.byteLength(content, encoding), sha256: crypto.createHash("sha256").update(content, encoding).digest("hex") };
  });
  return canonical({ domain: "kai-plugin-package-v3", manifest, files: table });
}
function packageDigest(pkg, payload = signingPayload(pkg.manifest, pkg.files)) {
  return crypto.createHash("sha256").update("kai-plugin-package-digest-v3\0").update(payload).update("\0").update(pkg.publicKey).update("\0").update(pkg.signature).digest("hex");
}
module.exports = { canonical, signingPayload, packageDigest, safeId, safeFile, verifyPackage, MAX_BYTES, MAX_FILES, PERMISSIONS, TEXT, BINARY };
