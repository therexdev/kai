"use strict";
const crypto = require("node:crypto");
const P = require("./job-protocol");

// A fresh inference/transport check, not a knowledge, quality or system-role
// benchmark. Original catalog tokenizers/templates still render these messages.
const KIND = "runtime-readiness", VERSION = 1;
const CASES = Object.freeze([Object.freeze({ id: "echo-label", maxOutput: 256 }), Object.freeze({ id: "recall-label", maxOutput: 256 })]);
const LABEL = /^KAI-[A-F0-9]{16}$/;
function isPolicy(p) { return p?.schema === 2 && p.kind === KIND; }
function validateCases(p, tariff) {
  if (!isPolicy(p) || p.minPass !== CASES.length || JSON.stringify(p.cases) !== JSON.stringify(CASES) ||
      p.cases.some(c => c.maxOutput > tariff.maxOutputTokens)) throw Error("Exact reviewed runtime-readiness cases required");
}
function challenge(id, nonce = "KAI-" + crypto.randomBytes(8).toString("hex").toUpperCase()) {
  if (!CASES.some(c => c.id === id) || !LABEL.test(nonce)) throw Error("Invalid runtime-readiness challenge");
  const messages = id === "echo-label" ? [{ role: "user", content: "Copy the following label exactly. Reply with only the label, without explanation.\nLabel: " + nonce }] : [
    { role: "user", content: "Remember this label for the next message: " + nonce },
    { role: "assistant", content: "I will remember the label." },
    { role: "user", content: "What label did I ask you to remember? Reply with only the label, without explanation." }
  ];
  return { schema: VERSION, id, nonce, messages };
}
function answer(output, nonce) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 16384 || !LABEL.test(nonce)) return false;
  let text = output.trim();
  // Some native reasoning templates emit a closed thinking prefix. Its content
  // is not the answer and cannot satisfy the check. Never accept an unfinished
  // reasoning block, an arbitrary substring, or unrelated surrounding prose.
  if (text.startsWith("<think>")) {
    const end = text.indexOf("</think>");
    if (end < 0 || text.slice(7, end).includes("<think>")) return false;
    text = text.slice(end + 8).trim();
  }
  if (text.includes("<think>") || text.includes("</think>")) return false;
  const fenced = /^```(?:text|plaintext)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(?:The label is|Label)\s*:\s*/i, "");
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith("`") && text.endsWith("`"))) text = text.slice(1, -1);
  return text === nonce;
}
function validatePending(value, c, job) {
  if (!value || Object.keys(value).sort().join() !== "id,messages,nonce,schema" || value.schema !== VERSION || value.id !== c.id ||
      !LABEL.test(value.nonce) || JSON.stringify(value) !== JSON.stringify(challenge(c.id, value.nonce)) ||
      job.challenge.quote.requestHash !== P.hash(JSON.stringify(value.messages))) throw Error("Runtime-readiness challenge changed");
  return value;
}
function verifyEvidence(result) {
  const r = result?.readiness;
  if (!r || Object.keys(r).sort().join() !== "kind,nonce,output,quote,schema" || r.schema !== VERSION) throw Error("Exact runtime-readiness evidence required");
  const generated = challenge(r.kind, r.nonce), quote = P.validateQuote(r.quote);
  if (quote.hash !== result.signedMaterial?.quoteHash || quote.domain !== result.signedMaterial?.target?.domain ||
      quote.policyHash !== result.signedMaterial?.target?.policyHash || quote.requestHash !== P.hash(JSON.stringify(generated.messages)) ||
      quote.maxOutput !== CASES.find(c => c.id === r.kind).maxOutput || P.hash(r.output) !== result.outputHash ||
      result.caseId !== r.kind || result.passed !== answer(r.output, r.nonce)) throw Error("Runtime-readiness evidence changed");
  return true;
}
module.exports = { KIND, VERSION, CASES, isPolicy, validateCases, challenge, answer, validatePending, verifyEvidence };
