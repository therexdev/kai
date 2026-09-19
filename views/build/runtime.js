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
        }, 600000);
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
      connect: (wallet) => request("connect", { wallet }),
      disconnect: () => request("disconnect", {}),
      read: (method, args = {}) => request("read", { method, args }),
      call: (method, args = {}) => request("call", { method, args }),
    }),
    writable: false,
  });
  // Some wallet extensions inject into every frame and reject on startup.
  // Only ignore errors whose source is an extension; generated app errors
  // (including unsupported wallet code) must remain visible.
  const extensionError = (e) =>
    /(?:chrome|moz|safari-web)-extension:\/\//i.test(
      String(e.filename || "") +
        " " +
        String(e.error?.stack || e.reason?.stack || ""),
    );
  window.addEventListener("error", (e) => {
    if (extensionError(e)) return;
    parent.postMessage(
      {
        type: "kai-app-error",
        kind: "javascript",
        message: String(e.message).slice(0, 500),
        line: e.lineno,
        column: e.colno,
      },
      "*",
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (extensionError(e)) return;
    parent.postMessage(
      {
        type: "kai-app-error",
        kind: "promise",
        message: String(e.reason?.message || e.reason).slice(0, 500),
      },
      "*",
    );
  });
  window.addEventListener("securitypolicyviolation", (e) => {
    if (
      extensionError({
        filename: String(e.sourceFile || "") + " " + String(e.blockedURI || ""),
      })
    )
      return;
    const directive = String(e.effectiveDirective || "unknown").slice(0, 80);
    parent.postMessage(
      {
        type: "kai-app-error",
        kind: "policy",
        action: directive,
        message:
          directive === "form-action"
            ? "Direct form submission was blocked. Handle the form's submit event, call event.preventDefault() before any await, and use kai.call() for wallet actions."
            : "The app tried an operation blocked by its content policy (" +
              directive +
              "). Use the supported kai bridge and local HTML, CSS and JavaScript.",
        line: e.lineNumber,
        column: e.columnNumber,
      },
      "*",
    );
  });
})();
