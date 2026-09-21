"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    slug = location.pathname.split("/").filter(Boolean)[1],
    base = "/build/public/" + encodeURIComponent(slug);
  let project;
  const status = (s) => {
    $("host-status").textContent = s;
    $("host-status").hidden = false;
  };
  async function request(url, body) {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await r.json(); }
    catch { throw Object.assign(Error("The app server returned an unreadable response (HTTP " + r.status + ")."), { code: "SERVER_RESPONSE" }); }
    if (!r.ok) throw Object.assign(Error(data.error || "This request did not finish."), {
      status: r.status, code: data.code, retryable: data.retryable === true,
    });
    return data;
  }
  KaiBuildBridge.create($("app-frame"), {
    mode: "live",
    getProject: () => project,
    onError: status,
    onDiagnostic: (entry) => {
      if (!project) return;
      const phase = { connect: "Wallet connection", prepare: "Preparing the app action", sign: "Wallet approval", submit: "Submitting the app action", read: "Reading app data" }[entry.phase];
      const message = phase ? phase + ": " + entry.message : entry.message;
      if (entry.kind === "bridge") status(message);
      // The endpoint records reports only for this project's signed-in owner.
      request(base + "/diagnostics", {
        revision: project.live_revision, errors: [entry],
      }).then((data) => {
        if (!data.recorded || $("host-status").textContent !== message) return;
        const link = document.createElement("a");
        link.href = "/build?project=" + encodeURIComponent(project.id);
        link.textContent = "Open in KAI to fix";
        $("host-status").append(document.createTextNode(" "), link);
      }).catch(() => {});
    },
    api: async (action, args) => {
      if (action === "read")
        return (
          await request(
            base +
              "/read/" +
              encodeURIComponent(args.method) +
              "?args=" +
              encodeURIComponent(JSON.stringify(args.args || {})),
          )
        ).result;
      if (action === "prepare") return request(base + "/prepare", args);
      return request(base + "/submit/" + encodeURIComponent(args.draftId), {
        transaction: args.transaction,
      });
    },
  });
  request(base)
    .then((data) => {
      project = data.project;
      document.title = project.title + " · Koinos AI";
      $("app-title").textContent = project.title;
      $("app-network").textContent = project.network;
      $("app-contract").textContent = project.contract_id;
      $("app-frame").src = "/apps/" + encodeURIComponent(slug) + "/content";
    })
    .catch((e) => status(e.message));
})();
