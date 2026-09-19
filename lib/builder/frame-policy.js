"use strict";
// allow-forms enables validation and submit handlers. form-action still blocks
// native form navigation/submission; chain writes must use the wallet bridge.
const FRAME_SANDBOX = "allow-scripts allow-forms";
const FRAME_CONTENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src data:; base-uri 'none'; form-action 'none'";
const FRAME_CSP =
  "sandbox " +
  FRAME_SANDBOX +
  "; " +
  FRAME_CONTENT_CSP +
  "; frame-ancestors 'self'";
module.exports = { FRAME_SANDBOX, FRAME_CONTENT_CSP, FRAME_CSP };
