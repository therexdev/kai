"use strict";
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30000;

// Keep only a bounded duration, never the upstream header or other metadata.
// HTTP dates use the IMF-fixdate form; malformed, duplicate and past values
// fall back to the local backoff policy.
function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || value.length > 128 || !Number.isFinite(now)) return null;
  const text = value.trim();
  if (/^\d{1,10}$/.test(text)) return Math.min(MAX_RETRY_AFTER_MS, Number(text) * 1000);
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at) || new Date(at).toUTCString() !== text || at <= now) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(at - now));
}
function retryDelayMs(response) {
  if (Number.isSafeInteger(response?.retryAfterMs) && response.retryAfterMs >= 0 && response.retryAfterMs <= MAX_RETRY_AFTER_MS)
    return response.retryAfterMs;
  try { return retryAfterMs(response?.headers?.get?.("retry-after")); } catch { return null; }
}
function backoffMs(failures, random = Math.random) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(5, Math.max(0, failures - 1)));
  let jitter; try { jitter = random(); } catch { jitter = 0; }
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) jitter = 0;
  return Math.min(MAX_BACKOFF_MS, Math.ceil(base * (1 + jitter * 0.25)));
}
module.exports = { retryAfterMs, retryDelayMs, backoffMs, MAX_RETRY_AFTER_MS };
