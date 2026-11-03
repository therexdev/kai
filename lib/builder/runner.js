"use strict";
const crypto = require("node:crypto");
const { fail } = require("./store"), config = require("./build-config");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function verifiedResult(value, job) {
  if (!value || typeof value.ok !== "boolean" || value.sourceHash !== job.sourceHash || value.target !== job.target.id || value.operation !== job.operation || value.profile !== config.PROFILE || value.runtime !== "runsc" || !/^sha256:[a-f0-9]{64}$/.test(value.image || "")) throw fail("The build result did not match this source and toolchain.", 502);
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 2 || typeof value.logs !== "string" || value.logs.length > 60000) throw fail("Invalid build result.", 502);
  const artifacts = [];
  for (const artifact of value.artifacts) {
    if (!value.ok || job.operation !== "compile" || !["contract.wasm", "contract.abi.json"].includes(artifact.name) || artifacts.some(a => a.name === artifact.name) || typeof artifact.base64 !== "string" || artifact.base64.length > 2800000) throw fail("Invalid build artifact.", 502);
    const bytes = Buffer.from(artifact.base64, "base64");
    if (!bytes.length || bytes.length > 2000000 || bytes.length !== artifact.bytes || bytes.toString("base64") !== artifact.base64 || hash(bytes) !== artifact.sha256) throw fail("Build artifact checksum mismatch.", 502);
    if (artifact.name.endsWith(".wasm") && !bytes.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) throw fail("Invalid compiled WASM.", 502);
    if (artifact.name.endsWith(".json")) {
      let abi; try { abi = JSON.parse(bytes.toString()); } catch { throw fail("Invalid compiled ABI.", 502); }
      if (JSON.stringify(abi.methods) !== JSON.stringify(job.target.methods) || !abi.koilib_types || typeof abi.types !== "string") throw fail("Compiled ABI does not match this build target.", 502);
    }
    artifacts.push({ name: artifact.name, sha256: artifact.sha256, bytes: bytes.length, base64: artifact.base64 });
  }
  if (value.ok && job.operation === "compile" && artifacts.length !== 2) throw fail("Compilation did not return both WASM and ABI.", 502);
  return { ok: value.ok, sourceHash: job.sourceHash, target: job.target.id, operation: job.operation, profile: config.PROFILE, image: value.image, runtime: "runsc", durationMs: Math.min(180000, Math.max(0, Number(value.durationMs) || 0)), logs: value.logs.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""), artifacts };
}
class RunnerClient {
  constructor({ url = process.env.KAI_BUILD_RUNNER_URL, token = process.env.KAI_BUILD_RUNNER_TOKEN, fetchImpl = fetch } = {}) { this.url = url; this.token = token; this.fetch = fetchImpl; }
  get configured() { return !!(this.url && this.token); }
  endpoint(route) {
    if (!this.configured) throw fail("Build worker is not configured. The administrator needs to install the isolated runner; source editing and export remain available.", 503);
    const url = new URL(this.url);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) throw fail("Invalid build worker configuration.", 503);
    return new URL(route, url);
  }
  async request(route, body) {
    const response = await this.fetch(this.endpoint(route), { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body ? 155000 : 10000), redirect: "error" });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 6500000) throw fail("Build worker response too large.", 502); chunks.push(Buffer.from(chunk)); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("Invalid build worker response.", 502); }
    if (!response.ok) throw fail(response.status === 429 ? "Build worker is busy. Try again after the current run." : "Build worker is unavailable. Check its service and pinned image.", response.status === 429 ? 429 : 503);
    return value;
  }
  async run(input) { const job = config.job(input); return verifiedResult(await this.request("/run", { ...input, files: job.files }), job); }
  async health() { const state = await this.request("/health"); if (!state.ok || state.profile !== config.PROFILE || state.runtime !== "runsc" || !/^sha256:[a-f0-9]{64}$/.test(state.image || "")) throw fail("The runner has an incompatible profile.", 503); return { ready: true, profile: state.profile, runtime: state.runtime, busy: state.busy === true }; }
}
module.exports = { RunnerClient, verifiedResult };
