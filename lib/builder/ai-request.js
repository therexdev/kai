"use strict";
const { fail } = require("./store");
const { setTimeout: sleep } = require("node:timers/promises");
const token = (value) => typeof value === "string" && !/^sk-/i.test(value) && /^[a-zA-Z0-9_.:[\]-]{1,120}$/.test(value) ? value : "";
const error = (message, code, details = {}, retryable = false) =>
  Object.assign(fail(message, 502), { code, details, retryable });

// Only this read/generate API request is retried. Tools execute once, after a
// complete response arrives; no wallet, chain write or publication is retried.
async function aiRequest({ fetchImpl, key, body, signal, timeoutMs = 180000, onStage = () => {}, pause = sleep }) {
  const payload = JSON.stringify(body);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw error("The AI edit was cancelled.", "AI_CANCELLED");
    let requestId = "", retryAfter = 0;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: payload,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      requestId = token(res.headers?.get("x-request-id"));
      const after = res.headers?.get("retry-after");
      if (after) retryAfter = /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now());
      let data;
      try { data = await res.json(); }
      catch (e) {
        if (e.name === "TimeoutError" || e.name === "AbortError") throw e;
        throw error("The AI service returned an incomplete or unreadable response.", "AI_RESPONSE", { requestId, httpStatus: res.status, causeCode: token(e.cause?.code || e.code) }, res.ok || res.status >= 500);
      }
      if (!data || typeof data !== "object")
        throw error("The AI service returned an unreadable response.", "AI_RESPONSE", { requestId, httpStatus: res.status }, res.ok || res.status >= 500);
      if (res.ok) return data;
      const apiCode = token(data.error?.code), param = token(data.error?.param);
      const details = { requestId, httpStatus: res.status, apiCode, param };
      if ([401, 403].includes(res.status))
        throw error("The server's OpenAI credentials or model permissions need attention.", "AI_ACCESS", details);
      if (/quota|billing|credit|spend_limit|usage_limit/.test(apiCode) || data.error?.type === "insufficient_quota")
        throw error("The server's OpenAI credits or spending limit need attention.", "AI_BILLING", details);
      if (res.status === 429)
        throw error("OpenAI temporarily limited this request.", "AI_RATE_LIMIT", details, true);
      if ([408, 409].includes(res.status) || res.status >= 500)
        throw error("The AI service could not complete this request.", "AI_UNAVAILABLE", details, true);
      throw error("OpenAI rejected the builder request" + (param ? " at " + param : "") + (apiCode ? " (" + apiCode + ")" : "") + ".", "AI_REQUEST", details);
    } catch (caught) {
      let e = caught;
      if (signal?.aborted) throw error("The AI edit was cancelled.", "AI_CANCELLED");
      if (!e.code?.startsWith?.("AI_")) {
        const timedOut = ["TimeoutError", "AbortError"].includes(e.name);
        e = error(timedOut ? "The AI response timed out." : "The builder lost its connection to the AI service.", timedOut ? "AI_TIMEOUT" : "AI_CONNECTION", {
          requestId, causeCode: token(e.cause?.code || e.code),
        }, true);
      }
      e.details = { ...e.details, attempt };
      if (!e.retryable || attempt === 3 || retryAfter > 30000) throw e;
      onStage(e.message + " Retrying AI request (" + (attempt + 1) + "/3)");
      try {
        await pause(Math.max(retryAfter || 0, 1000 * 2 ** (attempt - 1)), undefined, signal ? { signal } : undefined);
      } catch (waitError) {
        if (signal?.aborted) throw error("The AI edit was cancelled.", "AI_CANCELLED");
        throw waitError;
      }
    }
  }
}

function jobFailure(e, job, stage) {
  const details = {
    jobId: job.id, kind: job.kind, stage: String(stage).slice(0, 120),
    name: token(e.name), code: token(e.code) || "BUILD_INTERNAL",
    causeCode: token(e.details?.causeCode || e.cause?.code),
    requestId: token(e.details?.requestId), apiCode: token(e.details?.apiCode),
    param: token(e.details?.param),
    httpStatus: Number.isSafeInteger(e.details?.httpStatus) ? e.details.httpStatus : null,
    attempt: Number.isSafeInteger(e.details?.attempt) ? e.details.attempt : null,
    // A local source location helps locate programming errors without storing
    // arbitrary exception text, stacks, request bodies or credentials.
    location: String(e.stack || "").match(/(?:lib\/builder\/|node:)[\w./:-]+:\d+/)?.[0] || "",
  };
  const reason = e.status ? e.message : ["TimeoutError", "AbortError"].includes(e.name)
    ? "The request timed out during " + stage + "."
    : "The builder encountered " + (details.name || "an internal error") + " during " + stage + ".";
  return {
    details,
    message: reason + (job.kind === "edit" ? " Your saved version is unchanged. Use Retry saved edit to resume. " : " Your publishing request is saved. ") +
      "Reference: " + job.id + " · " + details.code +
      (details.causeCode ? " · " + details.causeCode : "") +
      (details.requestId ? " · " + details.requestId : ""),
  };
}
module.exports = { aiRequest, jobFailure };
