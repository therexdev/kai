"use strict";
const { isIP } = require("node:net");
const CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const PHASES = new Set(["lookup", "connect", "tls", "response", "body", "complete"]);
const OUTCOMES = new Set(["started", "timeout", "failed", "connected"]);
const SYSCALLS = new Set(["connect", "read", "write", "getaddrinfo"]);
function duration(value) { return Number.isFinite(value) && value >= 0 ? Math.min(3600000, Math.round(value)) : undefined; }
function networkCodes(values) { return Array.isArray(values) ? [...new Set(values.slice(0, 8).filter(code => CODES.has(code)))] : []; }
function addressAttempt(value) {
  if (!value || typeof value.address !== "string" || value.address.length > 45 || value.address.includes("%") || !isIP(value.address)) return null;
  const result = { address: value.address, family: isIP(value.address) };
  if (Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) result.port = value.port;
  if (CODES.has(value.code)) result.code = value.code;
  if (SYSCALLS.has(value.syscall)) result.syscall = value.syscall;
  if (OUTCOMES.has(value.outcome)) result.outcome = value.outcome;
  if (duration(value.elapsedMs) !== undefined) result.elapsedMs = duration(value.elapsedMs);
  return result;
}
function transportDetails(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  if (PHASES.has(value.phase)) result.phase = value.phase;
  for (const key of ["elapsedMs", "lookupMs", "connectMs", "tlsMs", "firstByteMs", "addressAttemptTimeoutMs"])
    if (duration(value[key]) !== undefined) result[key] = duration(value[key]);
  if (Number.isSafeInteger(value.bytesReceived) && value.bytesReceived >= 0) result.bytesReceived = Math.min(value.bytesReceived, 16 * 1024 * 1024 + 1);
  if (Array.isArray(value.attempts)) result.attempts = value.attempts.slice(0, 4).map(addressAttempt).filter(Boolean);
  return Object.keys(result).length ? result : undefined;
}
function networkDetails(error) {
  const queue = [error], visited = new Set(), codes = [], attempts = [];
  // Native HTTPS emits AggregateError.errors directly; fetch-style wrappers
  // may put the same aggregate under cause. Walk at most eight distinct nodes.
  for (let i = 0; i < queue.length && visited.size < 8; i++) {
    const item = queue[i];
    if (!item || typeof item !== "object" || visited.has(item)) continue;
    visited.add(item); const code = item.code; codes.push(code);
    const attempt = addressAttempt({ address: item.address, port: item.port, code, syscall: item.syscall });
    if (attempt) attempts.push(attempt);
    if (queue.length < 16 && item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) for (const child of item.errors.slice(0, 8)) { if (queue.length >= 16) break; queue.push(child); }
  }
  const transport = transportDetails(error?.rpcTransport);
  return { networkCodes: networkCodes(codes), ...(attempts.length ? { networkAttempts: attempts.slice(0, 8) } : {}),
    ...(transport ? { transport } : {}) };
}
module.exports = { networkCodes, networkDetails, transportDetails, addressAttempt, duration };
