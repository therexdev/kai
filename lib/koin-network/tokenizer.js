"use strict";
const fs = require("fs"), path = require("path");
const { Tokenizer } = require("@huggingface/tokenizers");
const { Template } = require("@huggingface/jinja");
const { hash, digest, messages } = require("./job-protocol");

// No network or remote code loading. Startup checks the exact bytes it then
// parses, avoiding a hash/read race. Only explicitly installed packs are used.
function loadTokenizer(directory, manifest) {
  if (!manifest || manifest.schema !== 1 || manifest.mode !== "shadow" ||
      !/^[a-f0-9]{40}$/.test(manifest.revision)) throw Error("Pinned tokenizer manifest required");
  const read = (name, expected, max) => {
    digest(expected);
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > max) throw Error("Invalid tokenizer artifact");
    const data = fs.readFileSync(file);
    if (data.length > max || hash(data) !== expected) throw Error("Tokenizer artifact hash mismatch: " + name);
    return JSON.parse(data);
  };
  digest(manifest.modelHash); digest(manifest.templateHash);
  const json = read("tokenizer.json", manifest.tokenizerHash, 16000000);
  const config = read("tokenizer_config.json", manifest.configHash, 131072);
  if (typeof config.chat_template !== "string" || hash(config.chat_template) !== manifest.templateHash) throw Error("Chat template hash mismatch");
  const tokenizer = new Tokenizer(json, config), template = new Template(config.chat_template);
  const encode = (text) => tokenizer.encode(text, { add_special_tokens: false }).ids;
  const render = (input) => template.render({ messages: messages(input), add_generation_prompt: true,
    tools: null, bos_token: config.bos_token ?? "", eos_token: config.eos_token ?? "" });
  const adapter = Object.freeze({ modelHash: manifest.modelHash, tokenizerHash: manifest.tokenizerHash,
    templateHash: manifest.templateHash, render, encode, input: (m) => encode(render(m)).length,
    output: (s) => encode(s).length });
  if (!Array.isArray(manifest.vectors) || manifest.vectors.length < 3) throw Error("Tokenizer calibration vectors required");
  for (const v of manifest.vectors) {
    const text = v.messages ? render(v.messages) : v.text;
    if (typeof text !== "string" || hash(JSON.stringify(encode(text))) !== v.idsHash || encode(text).length !== v.count ||
        (v.promptHash && hash(text) !== v.promptHash)) throw Error("Tokenizer calibration mismatch");
  }
  return adapter;
}
module.exports = { loadTokenizer };
