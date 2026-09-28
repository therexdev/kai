"use strict";
const crypto = require("crypto"),
  { utils } = require("koilib");
const { KoinShadow } = require("./shadow");
const { verifyPresence } = require("./presence");

// Opt-in mount for the canonical master. Has no signer or settlement client.
// Call before the scheduler's regular routes. Never deploy the test fixture.
function createShadowRouter({
  dataDir,
  operatorSecret,
  audience,
  clock = Date.now,
}) {
  if (!operatorSecret || !audience)
    throw Error(
      "Shadow verifier requires a secret and an explicit audience URL",
    );
  const parsed = new URL(audience);
  if (
    (parsed.protocol !== "https:" &&
      !["127.0.0.1", "localhost"].includes(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw Error("Invalid shadow audience");
  const ledger = new KoinShadow(dataDir, { clock });
  const digest = (x) =>
    crypto
      .createHash("sha256")
      .update(String(x || ""))
      .digest();
  const send = (res, code, data) => {
    res.writeHead(code, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    // Express may have parsed the body before handing off the scheduler.
    if (req.body) {
      if (Buffer.byteLength(JSON.stringify(req.body)) > 4096)
        throw Error("Request too large");
      return req.body;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw Error("Request too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }
  async function handle(req, res) {
    const url = new URL(req.url, "http://scheduler");
    if (!url.pathname.startsWith("/koin/")) return false;
    try {
      if (req.method === "GET" && url.pathname === "/koin/status") {
        const address = url.searchParams.get("address");
        if (!utils.isChecksumAddress(address || ""))
          throw Error("Valid address required");
        send(res, 200, { ok: true, ...ledger.status(address) });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/koin/presence") {
        const b = await body(req);
        ledger.observe(b.address, verifyPresence(b, audience, clock()));
        ledger.tick();
        send(res, 200, { ok: true, mode: "shadow" });
        return true;
      }
      if (
        !crypto.timingSafeEqual(
          digest(req.headers["x-operator-secret"]),
          digest(operatorSecret),
        )
      ) {
        send(res, 403, {
          ok: false,
          error: "Operator authentication required",
        });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/koin/shadow/qualify")
        ledger.qualify(await body(req));
      else if (req.method === "POST" && url.pathname === "/koin/shadow/open") {
        const b = await body(req);
        ledger.open(b.balance, { liabilities: b.liabilities });
      } else if (
        req.method === "GET" &&
        url.pathname === "/koin/shadow/manifest"
      ) {
        send(res, 200, {
          ok: true,
          ...ledger.manifest(Number(url.searchParams.get("epoch"))),
        });
        return true;
      } else {
        send(res, 404, { ok: false, error: "Unknown shadow route" });
        return true;
      }
      send(res, 200, { ok: true, mode: "shadow" });
    } catch (e) {
      send(res, 400, { ok: false, error: String(e.message).slice(0, 200) });
    }
    return true;
  }
  return { handle, ledger };
}
module.exports = { createShadowRouter };
