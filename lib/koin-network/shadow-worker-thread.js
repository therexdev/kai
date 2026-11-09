"use strict";
const { isMainThread, parentPort, workerData } = require("node:worker_threads"), Protocol = require("./shadow-worker-protocol");
function startShadowWorker() {
  if (isMainThread || !parentPort) throw Error("Shadow storage worker thread required");
  let engine, now = Protocol.time(workerData.now), closed = false;
  // Production uses the host wall clock at the actual verification/commit
  // boundary, including IPC delay. Injected clocks remain deterministic.
  const clock = () => workerData.advanceClock === true ? Date.now() : now;
  const send = message => parentPort.postMessage(message);
  try {
    const { ShadowStore } = require("./shadow-store"), { ShadowWorkerEngine } = require("./shadow-worker-engine");
    const store = new ShadowStore(workerData.directory, { ...workerData.storeOptions, clock });
    try { engine = new ShadowWorkerEngine(store, { clock, limits: workerData.limits }); send({ type: "ready", ...engine.initialize() }); }
    catch (error) { store.close(); throw error; }
  } catch (error) { send({ type: "fatal", error: Protocol.serializeError(error, { uncertain: false }) }); parentPort.close(); process.exitCode = 1; return; }
  parentPort.on("message", message => {
    if (closed) return;
    if (message?.method === "close") {
      closed = true;
      try { engine.close(); send({ type: "closed", id: message.id, ok: true }); }
      catch (error) { send({ type: "closed", id: message.id, ok: false, error: Protocol.serializeError(error) }); process.exitCode = 1; }
      finally { parentPort.close(); }
      return;
    }
    try {
      now = Protocol.time(message?.now);
      if (!Number.isSafeInteger(message?.id) || message.id < 1) throw Protocol.failure("SHADOW_PROTOCOL_ERROR", "Valid shadow request ID required");
      const result = engine.execute(message.method, message.args);
      send({ type: result.fatal ? "fatal" : "result", id: message.id, ...result });
    } catch (error) { engine.failed = true; send({ type: "fatal", id: message?.id, error: Protocol.serializeError(error, { uncertain: Protocol.MUTATIONS.has(message?.method) }) }); }
  });
}
if (!isMainThread) startShadowWorker();
module.exports = { startShadowWorker };
