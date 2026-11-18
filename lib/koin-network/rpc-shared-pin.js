"use strict";
// Only overlapping chain-ID probes in the same trusted read owner share work.
// Never cache a completed response or share financial state / transaction calls.
class SharedPins {
  #owners = new WeakMap();
  join(owner, endpoint, signal, start, stopped, copyError) {
    signal.throwIfAborted();
    let flights = this.#owners.get(owner);
    if (!flights) { flights = new Map(); this.#owners.set(owner, flights); }
    let flight = flights.get(endpoint);
    if (!flight || flight.controller.signal.aborted) {
      flight = { controller: new AbortController(), users: 0 };
      flights.set(endpoint, flight);
      const cleanup = () => { if (flights.get(endpoint) === flight) flights.delete(endpoint); };
      flight.work = Promise.resolve().then(() => start(flight.controller.signal));
      flight.settled = flight.work.then(cleanup, cleanup);
    }
    // Sharing must not turn a bounded owner queue into unlimited subscribers.
    if (flight.users >= 16) throw Object.assign(Error("RPC read queue is full"), { code: "rpc_queue_full" });
    flight.users++;
    const result = new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return; done = true;
        signal.removeEventListener("abort", abort);
        if (--flight.users === 0) flight.controller.abort();
        if (error) reject(copyError(error)); else resolve(structuredClone(value));
      };
      const abort = () => finish(stopped());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      flight.work.then(value => finish(null, value), error => finish(error));
    });
    // The originating endpoint lease must stay open until the physical probe
    // settles, even if that caller times out while another subscriber remains.
    return { result, settled: flight.settled };
  }
}
module.exports = { SharedPins };
