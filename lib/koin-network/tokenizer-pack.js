"use strict";
// Explicit preparation only. Runtime startup never downloads model artifacts.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { hash } = require("./job-protocol");
const { loadTokenizer, manifestIdentity, LIMITS } = require("./tokenizer");
const GGUF = require("./gguf-tokenizer");

async function boundedBody(response, limit) {
  const declared = response.headers?.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); throw Error("Tokenizer download too large"); }
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw Error("Tokenizer download too large"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function derivedArtifacts(manifest, fetchImpl) {
  const source = GGUF.sourceIdentity(manifest.artifactSource), last = source.prefixBytes - 1;
  const response = await fetchImpl(`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${source.filename}`,
    { headers: { Range: `bytes=0-${last}`, "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(60000) });
  if (response.status !== 206 || response.headers?.get("content-range") !== `bytes 0-${last}/${source.modelSize}`) {
    await response.body?.cancel(); throw Error("Pinned GGUF bounded range response required");
  }
  const artifacts = GGUF.derive(await boundedBody(response, source.prefixBytes), source);
  if (source.configSource) {
    const config = source.configSource;
    const response = await fetchImpl(`https://huggingface.co/${config.repository}/resolve/${config.revision}/tokenizer_config.json`,
      { signal: AbortSignal.timeout(60000) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Pinned tokenizer configuration HTTP ${response.status}`); }
    const bytes = await boundedBody(response, LIMITS.config);
    if (hash(bytes) !== config.sha256 || config.sha256 !== manifest.configHash) throw Error("Pinned tokenizer configuration hash mismatch");
    artifacts["tokenizer_config.json"] = bytes;
  }
  return artifacts;
}

function existing(file, expected, limit) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > limit) throw Error("Invalid installed tokenizer artifact");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try { if (fs.fstatSync(fd).size > limit) throw Error("Invalid installed tokenizer artifact"); bytes = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  if (bytes.length > limit || hash(bytes) !== expected) throw Error("Installed tokenizer checksum changed");
  return true;
}

async function install(directory, manifest, { fetchImpl = fetch } = {}) {
  manifestIdentity(manifest);
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw Error("Tokenizer directory must not traverse a symbolic link");
  let derived;
  for (const [name, expected, limit] of [["tokenizer.json", manifest.tokenizerHash, LIMITS.tokenizer], ["tokenizer_config.json", manifest.configHash, LIMITS.config]]) {
    const file = path.join(directory, name);
    if (existing(file, expected, limit)) continue;
    let bytes;
    if (manifest.artifactSource) {
      derived ||= await derivedArtifacts(manifest, fetchImpl);
      bytes = derived[name];
      if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw Error("Derived tokenizer artifact too large");
    } else {
      const response = await fetchImpl(`https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${name}`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) { await response.body?.cancel(); throw Error(`Pinned tokenizer download HTTP ${response.status}`); }
      bytes = await boundedBody(response, limit);
    }
    if (hash(bytes) !== expected) throw Error("Downloaded tokenizer hash mismatch");
    const temp = path.join(directory, ".tokenizer-" + crypto.randomBytes(12).toString("hex"));
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, file); }
    catch (e) { if (e.code !== "EEXIST" || !existing(file, expected, limit)) throw e; }
    finally { fs.unlinkSync(temp); }
  }
  return loadTokenizer(directory, manifest);
}
module.exports = { install };
