"use strict";
const path = require("path"), express = require("express");
module.exports = function producerSigner(publicDir) {
  const router = express.Router();
  // Koilib's ABI serializer generates protobuf functions. Eval is scoped to
  // this page, whose ABIs are pinned local assets, never supplied by the file.
  router.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self'; connect-src https://api.koinos.io; img-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  for (const name of ["koinos.min.js", "koinos.min.js.LICENSE.txt"]) {
    router.get("/" + name, (_req, res) => {
      if (require("koilib/package.json").version !== "9.3.0") return res.status(503).send("Signer library needs verification.");
      res.sendFile(path.join(path.dirname(require.resolve("koilib/package.json")), "dist", name));
    });
  }
  router.use(express.static(path.join(publicDir, "producer-signer"), { etag: false, lastModified: false }));
  router.use((_req, res) => res.status(404).type("text/plain").send("Signer file not found."));
  return router;
};
