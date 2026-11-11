"use strict";
const MiB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ queueLimit: 64, queueBytes: 8 * MiB, maxRequestBytes: 4 * MiB,
  maxResponseBytes: 16 * MiB, maxProjectionBytes: 32 * MiB, maxRows: 10000, maxTickIntervals: 8, projectionMaxAgeMs: 30000 });
const MUTATIONS = new Set(["open", "importBudget", "qualify", "expireQualifications", "applyQualificationRefresh", "retireUnmatchedQualifications", "observe", "ingestPresence", "ingestPresenceBatch", "acceptLegacyPresence", "tick", "commitWork", "markSealed", "markSealedMany"]);
const READS = new Set(["readBudget", "readDayProgress", "readQualification", "readQualifications", "readAvailability", "readUnsealedEpochs", "readManifest", "getManifestEvidence", "qualificationProjection", "refreshProjection"]);
const METHODS = new Set([...MUTATIONS, ...READS]);
function failure(code, message, extra = {}) { return Object.assign(Error(message), { code, ...extra }); }
function limits(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(DEFAULT_LIMITS, k))) throw Error("Known shadow worker limits required");
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key]) throw Error("Bounded shadow worker limit required: " + key);
  if (result.maxRequestBytes > result.queueBytes) throw Error("Shadow request limit exceeds queue capacity");
  return Object.freeze(result);
}
function bytes(value, maximum, label) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw failure("SHADOW_INVALID_ARGUMENT", "Serializable shadow " + label + " required"); }
  if (encoded === undefined) throw failure("SHADOW_INVALID_ARGUMENT", "Serializable shadow " + label + " required");
  const count = Buffer.byteLength(encoded);
  if (count > maximum) throw failure("SHADOW_PAYLOAD_LIMIT", "Shadow " + label + " exceeds " + maximum + " byte limit", { limitBytes: maximum });
  return count;
}
function time(value) { if (!Number.isSafeInteger(value) || value < 0) throw failure("SHADOW_INVALID_ARGUMENT", "Valid shadow clock required"); return value; }
function epoch(value) { const n = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value; return time(n); }
function serializeError(error, extra = {}) { return { code: typeof error?.code === "string" ? error.code : "SHADOW_COMMAND_REJECTED", message: String(error?.message || error).slice(0, 240), ...extra }; }
module.exports = { DEFAULT_LIMITS, MUTATIONS, READS, METHODS, failure, limits, bytes, time, epoch, serializeError };
