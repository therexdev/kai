"use strict";
// Only this bounded vocabulary crosses the provider/ledger/report boundary.
// Never retain raw response bodies, exception messages, prompts or credentials.
const crypto = require("node:crypto");
const codes = Object.freeze({
  unavailable: "The selected model service is unavailable.",
  upstream_http: "The model service returned an HTTP error.",
  transport_error: "The connection to the model service failed.",
  timeout: "The model service did not finish before the request deadline.",
  cancelled: "The model request was cancelled.",
  response_too_large: "The model service response exceeded the supported size.",
  invalid_json: "The model service returned invalid JSON.",
  invalid_response: "The model service returned an unsupported response structure.",
  empty_output: "The model service returned no answer text.",
  reasoning_only: "The model exhausted its output allowance on reasoning without producing an answer.",
  output_exhausted: "The model reached its output limit without producing an answer.",
  unsupported_finish: "The model service returned an unsupported finish reason.",
  unexpected_tool_calls: "The model service returned tool calls instead of answer text.",
  missing_usage: "The model service omitted token usage.",
  input_usage_out_of_range: "The reported input usage exceeded the reservation or was invalid.",
  output_usage_out_of_range: "The reported output usage exceeded the requested limit or was invalid.",
  cached_usage_out_of_range: "The reported cached usage was invalid.",
  inconsistent_usage: "The reported token usage totals did not agree.",
  usage_validation_failed: "The model service usage could not be validated.",
  dispatch_failed: "The model request could not be dispatched.",
  receipt_signing_failed: "The response receipt could not be signed.",
  receipt_validation_failed: "The response receipt could not be verified.",
  internal_error: "The model request failed inside the service."
});
const enums = {
  stage: ["availability", "dispatch", "request", "response_body", "response_validation", "usage_validation", "receipt_signing", "receipt_validation"],
  finishReason: ["stop", "length", "tool_calls", "function_call", "content_filter", "missing", "other"],
  contentType: ["missing", "null", "string", "array", "object", "number", "boolean", "other"],
  upstreamCategory: ["context_limit", "invalid_parameter", "chat_template", "authentication", "quota", "rate_limit", "content_filter", "unknown"],
  transportCode: ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]
};
const numbers = ["at", "elapsedMs", "requestBytes", "messageCount", "reservedInputTokens", "requestedOutputTokens", "allowedContextTokens", "upstreamStatus", "responseBytes", "contentChars", "reasoningChars", "toolCallCount", "inputTokens", "outputTokens", "totalTokens", "cachedTokens", "reasoningTokens"];
function clean(value) {
  if (!value || !Object.hasOwn(codes, value.code)) return null;
  const result = { schema: 1, provider: "akashml", code: value.code };
  for (const [key, allowed] of Object.entries(enums)) if (allowed.includes(value[key])) result[key] = value[key];
  for (const key of numbers) if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= (key === "at" ? 1e15 : 1e9)) result[key] = value[key];
  for (const key of ["requestId", "upstreamIdHash"]) if (typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(value[key])) result[key] = value[key];
  return result;
}
function upstreamId(value) {
  // Hash even plausible IDs: a supplier can echo arbitrary content in a header.
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? crypto.createHash("sha256").update(value).digest("hex") : undefined;
}
function responseShape(value) {
  const choice = value?.choices?.[0], message = choice?.message, content = message?.content, usage = value?.usage;
  return {
    finishReason: enums.finishReason.includes(choice?.finish_reason) ? choice.finish_reason : choice?.finish_reason == null ? "missing" : "other",
    contentType: content === undefined ? "missing" : content === null ? "null" : Array.isArray(content) ? "array" : enums.contentType.includes(typeof content) ? typeof content : "other",
    contentChars: typeof content === "string" ? content.length : undefined,
    reasoningChars: typeof message?.reasoning_content === "string" ? message.reasoning_content.length : typeof message?.reasoning === "string" ? message.reasoning.length : undefined,
    toolCallCount: Array.isArray(message?.tool_calls) ? message.tool_calls.length : undefined,
    inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, totalTokens: usage?.total_tokens,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens
  };
}
function error(code, diagnostics = {}) {
  const details = clean({ ...diagnostics, code }) || clean({ code: "internal_error" });
  return Object.assign(Error(codes[details.code]), { status: details.code === "timeout" ? 504 : 502, inferenceFailure: details });
}
function fromJob(job) {
  const details = clean(job?.inferenceFailure);
  if (!details || job.state !== "cancelled" || job.delivered) return null;
  const result = error(details.code, { ...details, requestId: job.id });
  result.message += " No credits were charged for this request.";
  return result;
}
function envelope(value, requestId) {
  const details = clean(value);
  if (!details) return null;
  const e = error(details.code, details);
  return { message: e.message, type: "server_error", code: "managed_" + details.code, status: e.status,
    source: "managed_provider", ...(typeof requestId === "string" && /^[a-f0-9]{64}$/.test(requestId) ? { request_id: requestId } : {}), diagnostics: details };
}
// Read at most 8 KiB for 250 ms to classify an upstream HTTP rejection. Text
// is inspected in memory only and never returned, persisted or logged.
async function httpCategory(response) {
  const reader = response.body?.getReader?.(); if (!reader) return "unknown";
  let timer;
  try {
    const body = await Promise.race([
      (async () => { const parts = []; let size = 0; while (size <= 8192) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 8192) return ""; parts.push(Buffer.from(r.value)); } return Buffer.concat(parts).toString("utf8").toLowerCase(); })(),
      new Promise(resolve => { timer = setTimeout(() => resolve(""), 250); })
    ]);
    for (const [category, pattern] of [
      ["context_limit", /context.{0,30}(limit|length|window)|too many tokens/], ["chat_template", /chat.template|roles must alternate|system role/],
      ["invalid_parameter", /invalid.parameter|unsupported.parameter|max_completion_tokens|max_tokens/], ["authentication", /invalid.api.key|authentication|unauthorized/],
      ["quota", /insufficient.quota|insufficient.credit|insufficient.balance/], ["rate_limit", /rate.limit/], ["content_filter", /content.filter/]
    ]) if (pattern.test(body)) return category;
    return "unknown";
  } catch { return "unknown"; }
  finally { clearTimeout(timer); reader.cancel().catch(() => {}); }
}
module.exports = { version: 1, clean, error, fromJob, envelope, upstreamId, responseShape, httpCategory };
