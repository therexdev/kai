"use strict";
const { readScope } = require("./rpc-scheduler");

// A failed parallel observation owns all its sibling reads. Cancel them and
// drain their caller promises before another observation enters the RPC queue.
// The provider retains each occupied socket slot until transport close.
// This helper neither retries requests nor accepts partial financial evidence.
async function readGroup(provider, reads) {
  const controller = new AbortController();
  const run = async () => {
    const pending = reads.map(read => {
      try { return Promise.resolve(read()); }
      catch (error) { return Promise.reject(error); }
    });
    try { return await Promise.all(pending); }
    catch (error) {
      controller.abort();
      await Promise.allSettled(pending);
      throw error;
    } finally { controller.abort(); }
  };
  // Injected isolated providers need no network cancellation. Preserve their
  // caller's existing transport scope while still draining every child read.
  return readScope("interactive", () => typeof provider?.withSignal === "function"
    ? provider.withSignal(controller.signal, run) : run());
}

module.exports = { readGroup, version: 1 };
