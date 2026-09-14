"use strict";
(() => {
  const pending = new Map();
  let sequence = 0;
  function request(method, args) {
    return new Promise((resolve, reject) => {
      const id = String(++sequence),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(
            Error(
              "The app request timed out. Check the wallet prompt and try again.",
            ),
          );
        }, 180000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ type: "kai-app-request", id, method, args }, "*");
    });
  }
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== "kai-app-response")
      return;
    const p = pending.get(event.data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(event.data.id);
    event.data.error
      ? p.reject(Error(event.data.error))
      : p.resolve(event.data.result);
  });
  Object.defineProperty(window, "kai", {
    value: Object.freeze({
      connect: () => request("connect", {}),
      read: (method, args = {}) => request("read", { method, args }),
      call: (method, args = {}) => request("call", { method, args }),
    }),
    writable: false,
  });
  window.addEventListener("error", (e) =>
    parent.postMessage(
      { type: "kai-app-error", message: String(e.message).slice(0, 500) },
      "*",
    ),
  );
  window.addEventListener("unhandledrejection", (e) =>
    parent.postMessage(
      {
        type: "kai-app-error",
        message: String(e.reason?.message || e.reason).slice(0, 500),
      },
      "*",
    ),
  );
})();
