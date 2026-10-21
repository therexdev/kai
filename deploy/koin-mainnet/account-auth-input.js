"use strict";
// Shared credential shape/serialization only; no repository or npm dependencies.
const AUTH_KEYS = new Set(["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
const MAX_ACCOUNT_AUTH_BYTES = 16384;

function accountEnvironmentValues(auth, required = true) {
  if (!auth || Array.isArray(auth) || typeof auth !== "object" || Object.keys(auth).some(key => !AUTH_KEYS.has(key)) ||
      Object.values(auth).some(value => typeof value !== "string" || !value.length || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) {
    throw Error("Account-auth accepts only nonempty SMTP and Google string settings");
  }
  if (Buffer.byteLength(JSON.stringify(auth, null, 2) + "\n") > MAX_ACCOUNT_AUTH_BYTES) throw Object.assign(Error("Account-auth input exceeds the private file limit"), { code: "AUTH_INPUT_TOO_LARGE" });
  if (!required) throw Error("Account-auth settings are only accepted for public accounts");
  const smtp = Object.keys(auth).some(key => key.startsWith("SMTP_"));
  const google = Object.keys(auth).some(key => key.startsWith("GOOGLE_"));
  if (smtp && (!auth.SMTP_HOST || !/^[a-zA-Z0-9.:[\]-]+$/.test(auth.SMTP_HOST) || !(auth.SMTP_FROM || auth.SMTP_USER) ||
      Boolean(auth.SMTP_USER) !== Boolean(auth.SMTP_PASS) ||
      (auth.SMTP_PORT && (!/^\d{1,5}$/.test(auth.SMTP_PORT) || Number(auth.SMTP_PORT) < 1 || Number(auth.SMTP_PORT) > 65535)) ||
      (auth.SMTP_SECURE && !["true", "false"].includes(auth.SMTP_SECURE)))) throw Error("Complete SMTP host, sender and paired authentication settings are required");
  if (google && (!auth.GOOGLE_CLIENT_ID || !auth.GOOGLE_CLIENT_SECRET)) throw Error("Both Google client settings are required");
  if (!smtp && !google) throw Error("Configure email or Google sign-in for public accounts");
  // systemd EnvironmentFile quoting, not a shell script. Newlines/control
  // characters and arbitrary environment names are rejected above.
  const quote = value => '"' + value.replace(/[\\"`$]/g, character => "\\" + character) + '"';
  return "# Generated from the reviewed private account-auth JSON.\n" +
    Object.entries(auth).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${quote(value)}`).join("\n") + "\n";
}

module.exports = { accountEnvironmentValues, AUTH_KEYS, MAX_ACCOUNT_AUTH_BYTES };
