"use strict";
const crypto = require("crypto");
const { utils, Signer } = require("koilib");

// These bytes cannot authorize a chain transaction, purchase, or job charge.
// The configured scheduler URL is part of the signature domain.
function presenceHash(address, audience, report) {
  if (
    !utils.isChecksumAddress(address) ||
    typeof audience !== "string" ||
    audience.length > 300
  )
    throw Error("Invalid presence identity");
  if (
    !report ||
    Object.keys(report).sort().join() !==
      "at,model,modelHash,ready,schema,sequence,session" ||
    report.schema !== 1 ||
    !Number.isSafeInteger(report.at) ||
    report.at < 0 ||
    !Number.isSafeInteger(report.sequence) ||
    report.sequence < 0 ||
    !/^[a-f0-9]{32}$/.test(report.session) ||
    typeof report.model !== "string" ||
    report.model.length > 100 ||
    !(report.modelHash === "" || /^[a-f0-9]{64}$/.test(report.modelHash)) ||
    typeof report.ready !== "boolean"
  )
    throw Error("Invalid presence report");
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        "KAI-KOIN-PRESENCE-V1",
        audience,
        address,
        report.schema,
        report.session,
        report.sequence,
        report.at,
        report.model,
        report.modelHash,
        report.ready,
      ]),
    )
    .digest();
}
function verifyPresence(body, audience, now = Date.now()) {
  if (
    !body ||
    typeof body.signature !== "string" ||
    Buffer.from(body.signature, "base64").length !== 65 ||
    Math.abs(body.report?.at - now) > 60000
  )
    throw Error("Expired or unsigned presence");
  if (
    Signer.recoverAddress(
      presenceHash(body.address, audience, body.report),
      Buffer.from(body.signature, "base64"),
    ) !== body.address
  )
    throw Error("Presence signer mismatch");
  return body.report;
}
module.exports = { presenceHash, verifyPresence };
