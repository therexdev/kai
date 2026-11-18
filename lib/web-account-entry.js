"use strict";
// The credit service owns network identity, credits and API keys. Keep its
// host-only cookies separate from the legacy website account during rollout.
const express = require("express");
function webAccountEntry() {
  const router = express.Router();
  const redirect = destination => (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, "https://credits.koinosai.com" + destination);
  };
  router.get(["/platform", "/platform/"], redirect("/platform"));
  router.get("/platform/docs", redirect("/platform/docs"));
  return router;
}
module.exports = { webAccountEntry };
