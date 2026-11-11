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
  providerDevices,
  storage,
  identity,
  workerOptions,
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
  const durable = storage?.mode === "sqlite-shadow";
  if (storage && !["legacy", "sqlite-shadow"].includes(storage.mode)) throw Error("Unknown shadow storage mode");
  const ledger = durable ? require("./shadow-worker-ledger").createWorkerLedger({
    storage, identity, audience, clock, providerDevices, workerOptions,
  }) : new KoinShadow(dataDir, { clock });
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
      if (size > 16384) throw Error("Request too large");
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
        send(res, 200, { ok: true, ...await ledger.status(address) });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/koin/presence") {
        const b = await body(req);
        if (durable) {
          // Acceptance, durable replay, projection publication and the tick
          // share one ordering owner. A lost commit reply is never HTTP 200.
          if (typeof b.signature === "string" && b.signature.startsWith("pd1.")) await ledger.acceptDelegated(b);
          else await ledger.acceptLegacy(b);
        } else if (typeof b.signature === "string" && b.signature.startsWith("pd1.")) {
          if (!providerDevices) throw Error("Delegated provider presence is unavailable");
          providerDevices.observePresence(b.signature, b.address, b.report);
          // Individual device evidence is retained above. The existing reward
          // ledger has one effective wallet slot and its own rate/replay bound.
          const previous = ledger.getPresence(b.address);
          // Device preparation precedes qualification. A verified presence is
          // acknowledged even while it cannot yet contribute reward capacity.
          // Otherwise the first model would wait for a qualification that
          // itself cannot start until this presence is acknowledged.
          const rewardQualified = ledger.hasQualifiedCapacity(b.address, clock());
          if (rewardQualified && (!previous || (clock() - previous.at >= 10000 && b.report.at > previous.signedAt &&
              (b.report.session !== previous.session || b.report.sequence > previous.sequence)))) ledger.observe(b.address, b.report);
        } else ledger.observe(b.address, verifyPresence(b, audience, clock()));
        if (!durable) await ledger.tick();
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
        await ledger.qualify(await body(req));
      else if (req.method === "POST" && url.pathname === "/koin/shadow/open") {
        const b = await body(req);
        await ledger.open(b.balance, { liabilities: b.liabilities });
      } else if (
        req.method === "GET" &&
        url.pathname === "/koin/shadow/manifest"
      ) {
        send(res, 200, {
          ok: true,
          ...await ledger.manifest(Number(url.searchParams.get("epoch"))),
        });
        return true;
      } else {
        send(res, 404, { ok: false, error: "Unknown shadow route" });
        return true;
      }
      send(res, 200, { ok: true, mode: "shadow" });
    } catch (e) {
      const unavailable = e.status === 503 || ["SHADOW_WRITE_UNCERTAIN", "SHADOW_WORKER_UNAVAILABLE", "SHADOW_STORAGE_UNAVAILABLE", "SHADOW_QUEUE_FULL", "SHADOW_STORAGE_BACKPRESSURE"].includes(e.code);
      send(res, unavailable ? 503 : 400, { ok: false,
        error: unavailable ? "Reward storage is temporarily unavailable. Retry the same report shortly." : String(e.message).slice(0, 200) });
    }
    return true;
  }
  return { handle, ledger };
}
module.exports = { createShadowRouter };
