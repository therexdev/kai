"use strict";
const fs = require("fs"), path = require("path");
const { Tokenizer } = require("@huggingface/tokenizers");
const { Template } = require("@huggingface/jinja");
const { hash, digest, messages, integer } = require("./job-protocol");
const LIMITS = Object.freeze({ tokenizer: 64000000, config: 2000000, manifest: 2000000 });

function manifestIdentity(manifest) {
  if (!manifest || manifest.schema !== 1 || manifest.mode !== "shadow" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(manifest.model || "") ||
      !/^[a-f0-9]{40}$/.test(manifest.revision || "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.repository || "") ||
      Buffer.byteLength(JSON.stringify(manifest)) > LIMITS.manifest) throw Error("Pinned tokenizer manifest required");
  for (const key of ["modelHash", "tokenizerHash", "configHash", "templateHash"]) digest(manifest[key]);
  if (manifest.artifactSource !== undefined) require("./gguf-tokenizer").sourceIdentity(manifest.artifactSource);
  if (!Array.isArray(manifest.vectors) || manifest.vectors.length < 3 || manifest.vectors.length > 128) throw Error("Tokenizer calibration vectors required");
  for (const v of manifest.vectors) {
    if (!v || Boolean(v.messages) === (typeof v.text === "string") || !Number.isSafeInteger(v.count) || v.count < 0 || v.count > 2000000) throw Error("Invalid tokenizer reference vector");
    digest(v.idsHash);
    if (v.at !== undefined) integer(v.at, 0, 253402300799999);
    if (v.messages) { messages(v.messages); digest(v.promptHash); }
    else if (Buffer.byteLength(v.text) > 1048576) throw Error("Tokenizer reference text too large");
  }
  return manifest;
}

function readArtifact(directory, name, expected, max) {
  digest(expected);
  const file = path.join(directory, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw Error("Invalid tokenizer artifact");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let data;
  try { if (fs.fstatSync(fd).size > max) throw Error("Invalid tokenizer artifact"); data = fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
  if (data.length > max || hash(data) !== expected) throw Error("Tokenizer artifact hash mismatch: " + name);
  return JSON.parse(data);
}

// No network or remote code loading. Startup checks the exact bytes it then
// parses, avoiding a hash/read race. Only explicitly installed packs are used.
function loadTokenizer(directory, manifest) {
  manifestIdentity(manifest);
  const json = readArtifact(directory, "tokenizer.json", manifest.tokenizerHash, LIMITS.tokenizer);
  const config = readArtifact(directory, "tokenizer_config.json", manifest.configHash, LIMITS.config);
  if (typeof config.chat_template !== "string" || hash(config.chat_template) !== manifest.templateHash) throw Error("Chat template hash mismatch");
  const tokenizer = new Tokenizer(json, config), template = new Template(config.chat_template);
  // The upstream helper reads local wall time. Redirect only its parsed
  // identifier to an explicit UTC quote-time function; no template text is
  // edited and the original template SHA remains the source commitment.
  const clockName = "__kai_quote_utc_date_v1";
  function quoteClock(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier") {
      if (node.value === clockName) throw Error("Reserved template clock identifier");
      if (node.value === "strftime_now") node.value = clockName;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(quoteClock);
      else if (value && typeof value === "object") quoteClock(value);
    }
  }
  quoteClock(template.parsed);
  const encode = (text) => tokenizer.encode(text, { add_special_tokens: false }).ids;
  const tokenText = value => typeof value === "string" ? value : typeof value?.content === "string" ? value.content : "";
  const render = (input, at) => template.render({ messages: messages(input), add_generation_prompt: true,
    tools: null, bos_token: tokenText(config.bos_token), eos_token: tokenText(config.eos_token),
    [clockName]: format => {
      if (format !== "%Y-%m-%d" && format !== "%d %b %Y") throw Error("Unsupported template date format");
      integer(at, 0, 253402300799999);
      const date = new Date(at);
      if (format === "%Y-%m-%d") return date.toISOString().slice(0, 10);
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return String(date.getUTCDate()).padStart(2, "0") + " " + months[date.getUTCMonth()] + " " + String(date.getUTCFullYear()).padStart(4, "0");
    } });
  const adapter = Object.freeze({ modelHash: manifest.modelHash, tokenizerHash: manifest.tokenizerHash,
    templateHash: manifest.templateHash, render, encode, input: (m, at) => encode(render(m, at)).length,
    output: (s) => encode(s).length });
  for (const v of manifest.vectors) {
    const text = v.messages ? render(v.messages, v.at) : v.text;
    if (typeof text !== "string" || hash(JSON.stringify(encode(text))) !== v.idsHash || encode(text).length !== v.count ||
        (v.promptHash && hash(text) !== v.promptHash)) throw Error("Tokenizer calibration mismatch");
  }
  return adapter;
}
module.exports = { loadTokenizer, manifestIdentity, LIMITS };
