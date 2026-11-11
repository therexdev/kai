"use strict";

// Only immutable verification results are reused. Every lookup supplies the
// current database identity, exact saved bytes, epoch and saved digest; neither
// a claimed digest nor a caller-owned object can stand in for those bytes.
// Account status returns at most 64 historical claims. Retain that many small
// manifests so a full history read does not evict itself on every refresh.
const MAX_ENTRIES = 64, MAX_BYTES = 4 * 1024 * 1024;
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
class VerifiedManifestCache {
  #identity; #verify; #entries = new Map(); #bytes = 0; #maxEntries; #maxBytes; #error;
  constructor({ identity, verify, error = "Damaged reward manifest", maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES }) {
    if (typeof identity !== "string" || !identity || typeof verify !== "function" ||
        !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 128 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024)
      throw Error("Invalid verified manifest cache");
    this.#identity = identity; this.#verify = verify; this.#maxEntries = maxEntries; this.#maxBytes = maxBytes; this.#error = error;
  }
  read({ identity, epoch, hash, data }) {
    if (identity !== this.#identity || typeof epoch !== "string" || typeof hash !== "string" || typeof data !== "string")
      throw Error(this.#error);
    const previous = this.#entries.get(epoch);
    if (previous && previous.hash === hash && previous.data === data) {
      this.#entries.delete(epoch); this.#entries.set(epoch, previous);
      return previous.value;
    }
    const value = this.#verify(JSON.parse(data));
    if (value.hash !== hash || value.envelope.manifest.epoch !== epoch) throw Error(this.#error);
    freeze(value);
    // Count both retained input and verified output, including generated Merkle
    // proofs. Oversized manifests still verify normally but are not retained.
    const bytes = Buffer.byteLength(data) + Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(epoch) + Buffer.byteLength(hash);
    if (previous) { this.#entries.delete(epoch); this.#bytes -= previous.bytes; }
    if (bytes <= this.#maxBytes) {
      while (this.#entries.size >= this.#maxEntries || this.#bytes + bytes > this.#maxBytes) {
        const oldest = this.#entries.keys().next().value;
        this.#bytes -= this.#entries.get(oldest).bytes; this.#entries.delete(oldest);
      }
      this.#entries.set(epoch, { data, hash, value, bytes }); this.#bytes += bytes;
    }
    return value;
  }
}
module.exports = { VerifiedManifestCache, MAX_ENTRIES, MAX_BYTES, version: 1 };
