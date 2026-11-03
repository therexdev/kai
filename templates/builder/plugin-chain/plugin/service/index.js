"use strict";
const crypto = require("node:crypto"), chain = require("../chain.json");
// This is trusted native code when installed in Core. It only reads public data.
// Keep the decoder and entrypoint aligned with the reviewed contract build's ABI.
function validAddress(value) {
  if (typeof value !== "string" || !/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const decoded = Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), n ? Buffer.from(hex, "hex") : Buffer.alloc(0)]);
  if (decoded.length !== 25 || decoded[0] !== 0) return false;
  const sha = bytes => crypto.createHash("sha256").update(bytes).digest();
  return decoded.subarray(21).equals(sha(sha(decoded.subarray(0, 21))).subarray(0, 4));
}
function decodeCount(encoded) {
  if (typeof encoded !== "string" || encoded.length > 16 || !/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) throw Error("Invalid counter response");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded.replace(/=+$/, "")) throw Error("Invalid counter encoding");
  if (!bytes.length) return 0; // Protobuf's absent uint32 field is zero.
  if (bytes[0] !== 8) throw Error("Counter ABI mismatch");
  let count = 0n;
  for (let i = 1; i < bytes.length && i <= 5; i++) {
    count |= BigInt(bytes[i] & 127) << BigInt(7 * (i - 1));
    if (!(bytes[i] & 128)) {
      if (i !== bytes.length - 1 || count > 4294967295n) throw Error("Counter ABI mismatch");
      return Number(count);
    }
  }
  throw Error("Incomplete counter response");
}
function create(api) {
  if (api.version !== 1) throw Error("This plugin requires Core native API v1");
  const controller = new AbortController();
  let remove, closed = false;
  const active = signal => { api.signal.throwIfAborted(); signal?.throwIfAborted(); if (closed) throw Error("Plugin stopped"); };
  const config = () => {
    const address = api.settings.get("counterAddress", chain.contractId);
    if (address !== "" && !validAddress(address)) throw Error("Saved contract address is invalid; it was preserved. Review the plugin configuration.");
    return { address, rpc: chain.rpc, chainId: chain.chainId, network: chain.network, service: api.plugin.id + ".counter" };
  };
  async function rpc(method, params, signal) {
    active(signal);
    const response = await api.network.fetch(chain.rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal });
    const text = await response.text(); active(signal);
    if (!response.ok) throw Error("The configured Koinos RPC returned HTTP " + response.status);
    if (text.length > 65536) throw Error("The RPC response is too large");
    const data = JSON.parse(text);
    if (data.error) throw Error("Koinos RPC: " + String(data.error.message || "read failed").slice(0, 300));
    if (data.jsonrpc !== "2.0" || data.id !== 1 || !data.result || typeof data.result !== "object") throw Error("Invalid RPC response");
    return data.result;
  }
  async function read(operationSignal) {
    const signal = AbortSignal.any([api.signal, controller.signal, operationSignal || new AbortController().signal, AbortSignal.timeout(15000)]);
    active(signal);
    const { address } = config();
    if (!address) throw Error("Build and deploy the included counter on testnet, then save its contract address");
    const remote = await rpc("chain.get_chain_id", {}, signal);
    if (remote.chain_id !== chain.chainId) throw Error("The RPC is on a different chain; the contract was not read");
    const entry = chain.abi?.methods?.get_count;
    if (!entry?.read_only || !Number.isInteger(entry.entry_point) || entry.entry_point < 0 || entry.entry_point > 4294967295) throw Error("Review the counter ABI configuration");
    const response = await rpc("chain.read_contract", { contract_id: address, entry_point: entry.entry_point, args: "" }, signal);
    if (!Object.hasOwn(response, "result")) throw Error("The RPC omitted the contract result");
    return { count: decodeCount(response.result), address, chainId: chain.chainId, observedAt: Date.now() };
  }
  function dispose() {
    if (closed) return;
    closed = true; controller.abort(); api.signal.removeEventListener("abort", dispose); remove?.();
  }
  try {
    active(); config();
    remove = api.services.provide(api.plugin.id + ".counter", { methods: ["read"], call(method, _input, context) {
      active(context.signal);
      if (context.remote || method !== "read") throw Error("Only local public counter reads are supported");
      return read(context.signal);
    } });
    api.signal.addEventListener("abort", dispose, { once: true });
    return { async call(method, input, signal) {
      active(signal);
      if (method === "counter.config") return config();
      if (method === "counter.read") return read(signal);
      if (method === "counter.configure") {
        if (!input || Object.keys(input).join() !== "address" || !validAddress(input.address)) throw Error("Supply a valid Koinos contract address");
        api.settings.set("counterAddress", input.address); return config();
      }
      throw Error("Unknown counter operation");
    }, dispose };
  } catch (error) { dispose(); throw error; }
}
module.exports = { create, validAddress, decodeCount };
